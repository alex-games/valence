//! PostgreSQL sidechain writer.
//!
//! Vault holds **user state**; this module holds the shared, append-only
//! sidechain: block edits, account projections, shard tips, anchors and the
//! per-player state index. It is deliberately a background writer with a bounded
//! channel: a database connection must never block the Bevy tick loop.
//!
//! The tables are the same names the browser bridge used (`game_edits`,
//! `game_accounts`, `game_side_blocks`, `game_anchors`) plus the state/outbox
//! tables the distributed design needs.

use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use postgres::{Client, NoTls};
use serde_json::json;
use sha2::{Digest, Sha256};

const WORLD: &str = "torrance";

#[derive(Clone)]
pub struct SidechainHandle {
    tx: Sender<Job>,
}

enum Job {
    Edit { x: i32, y: i32, z: i32, block: i32, by: String },
    State { pid: String, revision: u64, hash: String },
}

impl SidechainHandle {
    /// `None` when PostgreSQL is not configured; file-only play is still valid.
    pub fn from_env() -> Option<Self> {
        let url = std::env::var("NAUTILUS_DB").unwrap_or_else(|_| {
            let host = std::env::var("PGHOST").unwrap_or_else(|_| "127.0.0.1".into());
            let port = std::env::var("PGPORT").unwrap_or_else(|_| "5432".into());
            let user = std::env::var("PGUSER").unwrap_or_else(|_| "craft".into());
            let pass = std::env::var("PGPASSWORD").unwrap_or_else(|_| "craft".into());
            let db = std::env::var("PGDATABASE").unwrap_or_else(|_| "nautilus_craft".into());
            format!("host={host} port={port} user={user} password={pass} dbname={db} connect_timeout=2")
        });
        let mut client = Client::connect(&url, NoTls).ok()?;
        init(&mut client).ok()?;
        let (tx, rx) = mpsc::channel();
        thread::Builder::new()
            .name("nautilus-sidechain".into())
            .spawn(move || writer(rx, url))
            .ok()?;
        Some(Self { tx })
    }

    pub fn record_edit(&self, x: i32, y: i32, z: i32, block: i32, by: &str) {
        let _ = self.tx.send(Job::Edit {
            x,
            y,
            z,
            block,
            by: by.to_owned(),
        });
    }

    pub fn record_state(&self, pid: &str, revision: u64, hash: &str) {
        let _ = self.tx.send(Job::State {
            pid: pid.to_owned(),
            revision,
            hash: hash.to_owned(),
        });
    }

}

fn init(client: &mut Client) -> Result<(), postgres::Error> {
    client.batch_execute(
        "CREATE TABLE IF NOT EXISTS game_edits (
           world text NOT NULL, x int NOT NULL, y int NOT NULL, z int NOT NULL,
           block int NOT NULL, updated_by text, updated_at timestamptz NOT NULL DEFAULT now(),
           PRIMARY KEY (world, x, y, z)
         );
         CREATE TABLE IF NOT EXISTS game_accounts (
           player_id text PRIMARY KEY, name text NOT NULL,
           color int NOT NULL DEFAULT 0, quests int NOT NULL DEFAULT 0,
           tokens int NOT NULL DEFAULT 0, address text,
           network text NOT NULL DEFAULT 'testnet',
           mmr_root text NOT NULL DEFAULT '', mmr_events bigint NOT NULL DEFAULT 0,
           updated_at timestamptz NOT NULL DEFAULT now()
         );
         CREATE TABLE IF NOT EXISTS game_side_blocks (
           world text NOT NULL, shard int NOT NULL, height bigint NOT NULL,
           hash text NOT NULL, parent text NOT NULL, root text NOT NULL,
           edits int NOT NULL, at bigint NOT NULL,
           PRIMARY KEY (world, shard, height)
         );
         CREATE TABLE IF NOT EXISTS game_anchors (
           world text NOT NULL, height bigint NOT NULL,
           hash text NOT NULL, parent text NOT NULL, roots jsonb NOT NULL, at bigint NOT NULL,
           PRIMARY KEY (world, height)
         );
         CREATE TABLE IF NOT EXISTS game_state_index (
           pid text PRIMARY KEY, revision bigint NOT NULL,
           state_hash text NOT NULL, updated_at bigint NOT NULL
         );
         CREATE TABLE IF NOT EXISTS game_events (
           seq bigserial PRIMARY KEY, pid text, kind text NOT NULL,
           payload jsonb NOT NULL, at bigint NOT NULL
         );
         CREATE TABLE IF NOT EXISTS game_outbox (
           seq bigserial PRIMARY KEY, topic text NOT NULL, payload jsonb NOT NULL,
           status text NOT NULL DEFAULT 'queued', created_at bigint NOT NULL
         );",
    )
}

fn writer(rx: Receiver<Job>, url: String) {
    let mut client: Option<Client> = None;
    let mut pending: Vec<Job> = Vec::new();
    loop {
        match rx.recv_timeout(Duration::from_millis(450)) {
            Ok(job) => pending.push(job),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if pending.is_empty() {
            continue;
        }
        if client.is_none() {
            client = Client::connect(&url, NoTls).ok();
        }
        let Some(db) = client.as_mut() else {
            // Keep the queue bounded; a broker/DB outage must not grow memory.
            if pending.len() > 10_000 {
                pending.drain(0..5_000);
            }
            continue;
        };
        let jobs = std::mem::take(&mut pending);
        for job in jobs {
            let result = match job {
                Job::Edit { x, y, z, block, by } => db.execute(
                    "INSERT INTO game_edits(world,x,y,z,block,updated_by) VALUES($1,$2,$3,$4,$5,$6)
                     ON CONFLICT(world,x,y,z) DO UPDATE SET block=EXCLUDED.block,
                       updated_by=EXCLUDED.updated_by, updated_at=now()",
                    &[&WORLD, &x, &y, &z, &block, &by],
                ),
                Job::State { pid, revision, hash } => {
                    let at = now();
                    let _ = db.execute(
                        "INSERT INTO game_state_index(pid,revision,state_hash,updated_at)
                         VALUES($1,$2,$3,$4)
                         ON CONFLICT(pid) DO UPDATE SET revision=EXCLUDED.revision,
                           state_hash=EXCLUDED.state_hash, updated_at=EXCLUDED.updated_at",
                        &[&pid, &(revision as i64), &hash, &at],
                    );
                    let payload = json!({"revision": revision, "hash": hash});
                    db.execute(
                        "INSERT INTO game_events(pid,kind,payload,at) VALUES($1,'state',$2,$3)",
                        &[&pid, &payload, &at],
                    )
                }
            };
            if result.is_err() {
                client = None;
                break;
            }
        }
    }
}

pub fn state_hash(player_json: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(player_json.as_bytes());
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::state_hash;

    #[test]
    fn state_hash_is_stable_and_player_specific() {
        let a = state_hash("{\"name\":\"a\",\"credits\":1}");
        let b = state_hash("{\"name\":\"a\",\"credits\":1}");
        let c = state_hash("{\"name\":\"a\",\"credits\":2}");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_eq!(a.len(), 64);
    }
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
