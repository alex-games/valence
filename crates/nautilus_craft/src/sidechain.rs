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
    State {
        pid: String,
        name: String,
        revision: u64,
        hash: String,
        quests: i32,
        tokens: i32,
        day: i64,
    },
}

impl SidechainHandle {
    /// `None` when PostgreSQL is not configured; file-only play is still valid.
    pub fn from_env() -> Option<Self> {
        let url = db_url_from_env();
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

    pub fn record_state(
        &self,
        pid: &str,
        name: &str,
        revision: u64,
        hash: &str,
        quests: i32,
        tokens: i32,
        day: i64,
    ) {
        let _ = self.tx.send(Job::State {
            pid: pid.to_owned(),
            name: name.to_owned(),
            revision,
            hash: hash.to_owned(),
            quests,
            tokens,
            day,
        });
    }
}

/// The PostgreSQL URL, shared by the writer, the outbox reader and tests.
pub(crate) fn db_url_from_env() -> String {
    std::env::var("NAUTILUS_DB").unwrap_or_else(|_| {
        let host = std::env::var("PGHOST").unwrap_or_else(|_| "127.0.0.1".into());
        let port = std::env::var("PGPORT").unwrap_or_else(|_| "5432".into());
        let user = std::env::var("PGUSER").unwrap_or_else(|_| "craft".into());
        let pass = std::env::var("PGPASSWORD").unwrap_or_else(|_| "craft".into());
        let db = std::env::var("PGDATABASE").unwrap_or_else(|_| "nautilus_craft".into());
        format!("host={host} port={port} user={user} password={pass} dbname={db} connect_timeout=2")
    })
}

/// One queued outbox row, as returned by `GET /api/outbox`.
#[derive(serde::Serialize)]
pub struct OutboxRow {
    pub seq: i64,
    pub topic: String,
    pub payload: serde_json::Value,
    pub created_at: i64,
}

/// Pull up to `limit` queued rows. A short-lived connection per call keeps the
/// HTTP thread independent of the sidechain writer; outbox polling is low rate.
pub fn read_outbox(limit: i64) -> Result<Vec<OutboxRow>, String> {
    let mut db = Client::connect(&db_url_from_env(), NoTls).map_err(|e| e.to_string())?;
    let rows = db
        .query(
            "SELECT seq,topic,payload,created_at FROM game_outbox
             WHERE status='queued' ORDER BY seq LIMIT $1",
            &[&limit.clamp(1, 500)],
        )
        .map_err(|e| e.to_string())?;
    Ok(rows
        .iter()
        .map(|row| OutboxRow {
            seq: row.get(0),
            topic: row.get(1),
            payload: row.get(2),
            created_at: row.get(3),
        })
        .collect())
}

/// Mark rows delivered. Only `queued` rows change, so an overlapping ack is
/// idempotent and cannot erase a later event that reused a seq.
pub fn ack_outbox(seqs: &[i64]) -> Result<u64, String> {
    if seqs.is_empty() {
        return Ok(0);
    }
    let mut db = Client::connect(&db_url_from_env(), NoTls).map_err(|e| e.to_string())?;
    db.execute(
        "UPDATE game_outbox SET status='sent' WHERE seq = ANY($1) AND status='queued'",
        &[&seqs],
    )
    .map_err(|e| e.to_string())
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
            let failed = match job {
                Job::Edit { x, y, z, block, by } => {
                    let result = db.execute(
                        "INSERT INTO game_edits(world,x,y,z,block,updated_by) VALUES($1,$2,$3,$4,$5,$6)
                         ON CONFLICT(world,x,y,z) DO UPDATE SET block=EXCLUDED.block,
                           updated_by=EXCLUDED.updated_by, updated_at=now()",
                        &[&WORLD, &x, &y, &z, &block, &by],
                    );
                    if result.is_ok() {
                        let payload = json!({
                            "x": x, "y": y, "z": z, "block": block, "by": by
                        });
                        if let Err(e) = db.execute(
                            "INSERT INTO game_outbox(topic,payload,created_at) VALUES($1,$2,$3)",
                            &[&"game.edit", &payload, &now()],
                        ) {
                            eprintln!("[sidechain] edit outbox insert: {e}");
                        }
                    }
                    result.is_err()
                },
                Job::State {
                    pid,
                    name,
                    revision,
                    hash,
                    quests,
                    tokens,
                    day,
                } => {
                    let at = now();
                    let _ = db.execute(
                        "INSERT INTO game_state_index(pid,revision,state_hash,updated_at)
                         VALUES($1,$2,$3,$4)
                         ON CONFLICT(pid) DO UPDATE SET revision=EXCLUDED.revision,
                           state_hash=EXCLUDED.state_hash, updated_at=EXCLUDED.updated_at",
                        &[&pid, &(revision as i64), &hash, &at],
                    );
                    let payload = json!({
                        "revision": revision, "hash": hash, "day": day,
                        "quests": quests, "tokens": tokens
                    });
                    let _ = db.execute(
                        "INSERT INTO game_events(pid,kind,payload,at) VALUES($1,'state',$2,$3)",
                        &[&pid, &payload, &at],
                    );
                    let _ = db.execute(
                        "INSERT INTO game_accounts(player_id,name,quests,tokens,updated_at)
                         VALUES($1,$2,$3,$4,now())
                         ON CONFLICT(player_id) DO UPDATE SET name=EXCLUDED.name,
                           quests=EXCLUDED.quests, tokens=EXCLUDED.tokens,
                           updated_at=now()",
                        &[&pid, &name, &quests, &tokens],
                    );

                    // One shard sidechain per consistent-hash lane; the state hash is
                    // the leaf root, the revision is the append height.
                    let shard = shard_of(&hash);
                    let prev: Option<(i64, String)> = db
                        .query_opt(
                            "SELECT height,hash FROM game_side_blocks
                             WHERE world=$1 AND shard=$2 ORDER BY height DESC LIMIT 1",
                            &[&WORLD, &shard],
                        )
                        .ok()
                        .flatten()
                        .map(|row| (row.get(0), row.get(1)));
                    let height = prev.as_ref().map(|(h, _)| h + 1).unwrap_or(1);
                    let parent = prev.map(|(_, h)| h).unwrap_or_default();
                    // `edits` is `int`; passing an i64 here is a ToSql type
                    // error that the old code discarded, which is why the
                    // account row appeared and the shard row silently did not
                    // (D77).
                    if let Err(e) = db.execute(
                        "INSERT INTO game_side_blocks(world,shard,height,hash,parent,root,edits,at)
                         VALUES($1,$2,$3,$4,$5,$6,$7,$8)
                         ON CONFLICT(world,shard,height) DO NOTHING",
                        &[
                            &WORLD,
                            &shard,
                            &height,
                            &hash,
                            &parent,
                            &hash,
                            &(revision as i32),
                            &at,
                        ],
                    ) {
                        eprintln!("[sidechain] side block insert: {e}");
                    }

                    let tips = match db.query(
                        "SELECT shard,height,hash,root FROM game_side_blocks s
                         WHERE world=$1 AND height = (
                           SELECT max(height) FROM game_side_blocks t
                           WHERE t.world=s.world AND t.shard=s.shard
                         ) ORDER BY shard",
                        &[&WORLD],
                    ) {
                        Ok(rows) => rows,
                        Err(e) => {
                            eprintln!("[sidechain] side tips query: {e}");
                            Vec::new()
                        }
                    };
                    let mut anchor_height: Option<i64> = None;
                    if !tips.is_empty() {
                        let roots: Vec<serde_json::Value> = tips
                            .iter()
                            .map(|row| {
                                json!({
                                    "shard": row.get::<_, i32>(0),
                                    "height": row.get::<_, i64>(1),
                                    "hash": row.get::<_, String>(2),
                                    "root": row.get::<_, String>(3),
                                })
                            })
                            .collect();
                        let roots_json = serde_json::to_string(&roots).unwrap_or_else(|_| "[]".into());
                        let last: Option<(i64, String)> = db
                            .query_opt(
                                "SELECT height,hash FROM game_anchors
                                 WHERE world=$1 ORDER BY height DESC LIMIT 1",
                                &[&WORLD],
                            )
                            .ok()
                            .flatten()
                            .map(|row| (row.get(0), row.get(1)));
                        let a_height = last.as_ref().map(|(h, _)| h + 1).unwrap_or(1);
                        let a_parent = last.map(|(_, h)| h).unwrap_or_default();
                        let a_hash = anchor_hash(a_height, &a_parent, &roots_json, at);
                        if let Err(e) = db.execute(
                            "INSERT INTO game_anchors(world,height,hash,parent,roots,at)
                             VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(world,height) DO NOTHING",
                            &[
                                &WORLD,
                                &a_height,
                                &a_hash,
                                &a_parent,
                                &serde_json::Value::Array(roots),
                                &at,
                            ],
                        ) {
                            eprintln!("[sidechain] anchor insert: {e}");
                        } else {
                            anchor_height = Some(a_height);
                        }
                    }

                    // Durable outbox: the state save is the event a relay or the
                    // CC must deliver. Writing it beside the sidechain rows means
                    // a broker outage delays it, never loses it.
                    let outbox = json!({
                        "pid": pid, "revision": revision, "hash": hash, "day": day,
                        "quests": quests, "tokens": tokens,
                        "shard": shard, "shard_height": height,
                        "anchor_height": anchor_height
                    });
                    if let Err(e) = db.execute(
                        "INSERT INTO game_outbox(topic,payload,created_at) VALUES($1,$2,$3)",
                        &[&format!("game.state.{pid}"), &outbox, &at],
                    ) {
                        eprintln!("[sidechain] state outbox insert: {e}");
                    }
                    false
                }
            };
            if failed {
                client = None;
                break;
            }
        }
    }
}

fn shard_of(hash: &str) -> i32 {
    i32::from(u8::from_str_radix(&hash[..2.min(hash.len())], 16).unwrap_or(0) % 4)
}

fn anchor_hash(height: i64, parent: &str, roots_json: &str, at: i64) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{height}|{parent}|{roots_json}|{at}").as_bytes());
    format!("{:x}", hasher.finalize())
}

pub fn state_hash(player_json: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(player_json.as_bytes());
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::{anchor_hash, shard_of, state_hash, OutboxRow};

    #[test]
    fn outbox_row_keeps_the_topic_and_payload_shape() {
        let row = OutboxRow {
            seq: 3,
            topic: "game.state.outbox-p1".into(),
            payload: serde_json::json!({"revision": 1, "pid": "outbox-p1"}),
            created_at: 10,
        };
        let value = serde_json::to_value(&row).expect("serialize outbox row");
        assert_eq!(value["seq"], 3);
        assert_eq!(value["topic"], "game.state.outbox-p1");
        assert_eq!(value["payload"]["revision"], 1);
    }

    #[test]
    fn state_hash_is_stable_and_player_specific() {
        let a = state_hash("{\"name\":\"a\",\"credits\":1}");
        let b = state_hash("{\"name\":\"a\",\"credits\":1}");
        let c = state_hash("{\"name\":\"a\",\"credits\":2}");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_eq!(a.len(), 64);
    }

    #[test]
    fn shard_and_anchor_are_deterministic() {
        let h = state_hash("{\"name\":\"a\"}");
        assert!((0..4).contains(&shard_of(&h)));
        assert_eq!(shard_of(&h), shard_of(&h));
        let a = anchor_hash(1, "", "[{\"shard\":0}]", 10);
        let b = anchor_hash(1, "", "[{\"shard\":0}]", 10);
        assert_eq!(a, b);
        assert_ne!(a, anchor_hash(2, &a, "[{\"shard\":0}]", 10));
    }
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
