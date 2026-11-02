//! Nautilus Craft — Torrance.
//!
//! One static i686-musl binary that:
//!   * serves `/` and `/embed/` with the level manifest injected from PostgreSQL;
//!   * writes/reads every game asset in `nautilus_craft.game_assets`;
//!   * runs the multiplayer hub on `/ws` (positions, chat, shared block edits);
//!   * keeps shared edits in `game_edits` and the leaderboard in `game_scores`.
//!
//! The VM starts it on 127.0.0.1:8081; nginx owns :80 and :8080 and proxies
//! both HTTP and the WebSocket upgrade.

use std::collections::{HashMap, VecDeque};
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::{json, Value};
use sha1::{Digest, Sha1};

mod bridge;

// ---------------------------------------------------------------- embedded --
const INDEX: &[u8] = include_bytes!("../../web/dist/index.html");
const WORLD: &str = include_str!("../../web/dist/world.json");
const MAP: &[u8] = include_bytes!("../../web/dist/torrance-map.svg");
const README: &[u8] = include_bytes!("../../web/dist/README.txt");
const CREDITS: &[u8] = include_bytes!("../../web/dist/CREDITS.txt");
const BIRDS: &[u8] = include_bytes!("../../web/assets/audio/birds.mp3");

const ASSET_VERSION: &str = "torrance-3";
const WORLD_SLUG: &str = "torrance";
const MAX_BODY: usize = 64 * 1024;
const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// ---------------------------------------------------------- play shards -----
// The 96×96 level is a 2×2 grid of four play shards, matching the four
// consistent-hash ordering lanes. **A shard is a place, not a fence.** An NPC's
// events stay ordered in its own `npc:<id>` lane, but the entity may walk into
// any play shard, and it maps every shard it enters into `game_npc_roam`.
const PLAY_SHARDS: usize = 4;
const SHARD_HALF: f32 = 48.0;

// ------------------------------------------------------------------- store ---
struct Store {
    url: String,
    conn: Mutex<Option<postgres::Client>>,
}

impl Store {
    fn new(url: String) -> Self {
        Self { url, conn: Mutex::new(None) }
    }

    fn with<T>(&self, f: impl FnOnce(&mut postgres::Client) -> Result<T, postgres::Error>) -> Option<T> {
        let mut guard = self.conn.lock().ok()?;
        let reconnect = match guard.as_ref() {
            Some(c) => c.is_closed(),
            None => true,
        };
        if reconnect {
            match postgres::Client::connect(&self.url, postgres::NoTls) {
                Ok(c) => *guard = Some(c),
                Err(e) => {
                    eprintln!("[db] connect: {e}");
                    return None;
                }
            }
        }
        let client = guard.as_mut()?;
        match f(client) {
            Ok(v) => Some(v),
            Err(e) => {
                eprintln!("[db] query: {e}");
                *guard = None;
                None
            }
        }
    }

    fn init(&self) -> Result<(), String> {
        self.with(|c| {
            c.batch_execute(
                "CREATE TABLE IF NOT EXISTS game_assets (
                   path text PRIMARY KEY,
                   content_type text NOT NULL,
                   body bytea NOT NULL,
                   updated_at timestamptz NOT NULL DEFAULT now()
                 );
                 CREATE TABLE IF NOT EXISTS game_world (
                   slug text PRIMARY KEY,
                   title text NOT NULL,
                   data jsonb NOT NULL,
                   updated_at timestamptz NOT NULL DEFAULT now()
                 );
                 CREATE TABLE IF NOT EXISTS game_meta (
                   key text PRIMARY KEY,
                   value text NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS game_edits (
                   world text NOT NULL,
                   x int NOT NULL,
                   y int NOT NULL,
                   z int NOT NULL,
                   block int NOT NULL,
                   updated_by text,
                   updated_at timestamptz NOT NULL DEFAULT now(),
                   PRIMARY KEY (world, x, y, z)
                 );
                 CREATE TABLE IF NOT EXISTS game_scores (
                   player_id text PRIMARY KEY,
                   name text NOT NULL,
                   quests int NOT NULL DEFAULT 0,
                   tokens int NOT NULL DEFAULT 0,
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
                   hash text NOT NULL, parent text NOT NULL,
                   roots jsonb NOT NULL, at bigint NOT NULL,
                   PRIMARY KEY (world, height)
                 );
                 CREATE TABLE IF NOT EXISTS game_accounts (
                   player_id text PRIMARY KEY, name text NOT NULL,
                   color int NOT NULL DEFAULT 0, quests int NOT NULL DEFAULT 0,
                   tokens int NOT NULL DEFAULT 0, address text,
                   network text NOT NULL DEFAULT 'testnet',
                   mmr_root text NOT NULL DEFAULT '', mmr_events bigint NOT NULL DEFAULT 0,
                   updated_at timestamptz NOT NULL DEFAULT now()
                 );
                 CREATE TABLE IF NOT EXISTS game_account_events (
                   player_id text NOT NULL, seq bigint NOT NULL,
                   leaf text NOT NULL, event text NOT NULL, at bigint NOT NULL,
                   PRIMARY KEY (player_id, seq)
                 );
                 CREATE TABLE IF NOT EXISTS game_npc_roam (
                   world text NOT NULL, npc text NOT NULL, shard int NOT NULL,
                   first_seen bigint NOT NULL, last_seen bigint NOT NULL,
                   visits int NOT NULL DEFAULT 1,
                   PRIMARY KEY (world, npc, shard)
                 );",
            )?;

            let version: Option<String> = c
                .query_opt("SELECT value FROM game_meta WHERE key = 'asset_version'", &[])?
                .map(|r| r.get(0));
            if version.as_deref() != Some(ASSET_VERSION) {
                eprintln!("[db] seeding assets {ASSET_VERSION}");
                let title = serde_json::from_str::<Value>(WORLD)
                    .ok()
                    .and_then(|v| v.get("title").and_then(|t| t.as_str()).map(str::to_owned))
                    .unwrap_or_else(|| "Torrance".into());
                let assets: [(&str, &str, &[u8]); 5] = [
                    ("/index.html", "text/html; charset=utf-8", INDEX),
                    ("/torrance-map.svg", "image/svg+xml", MAP),
                    ("/README.txt", "text/plain; charset=utf-8", README),
                    ("/CREDITS.txt", "text/plain; charset=utf-8", CREDITS),
                    ("/audio/birds.mp3", "audio/mpeg", BIRDS),
                ];
                for (path, mime, body) in assets {
                    c.execute(
                        "INSERT INTO game_assets(path, content_type, body) VALUES($1,$2,$3)
                         ON CONFLICT(path) DO UPDATE SET content_type=EXCLUDED.content_type,
                           body=EXCLUDED.body, updated_at=now()",
                        &[&path, &mime, &body.to_vec()],
                    )?;
                }
                c.execute(
                    "INSERT INTO game_world(slug, title, data) VALUES($1,$2,$3::jsonb)
                     ON CONFLICT(slug) DO UPDATE SET title=EXCLUDED.title, data=EXCLUDED.data,
                       updated_at=now()",
                    &[&WORLD_SLUG, &title, &WORLD],
                )?;
                c.execute(
                    "INSERT INTO game_meta(key, value) VALUES('asset_version',$1)
                     ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
                    &[&ASSET_VERSION],
                )?;
            }
            Ok(())
        })
        .ok_or_else(|| "database unavailable".to_string())
    }

    fn asset(&self, path: &str) -> Option<(String, Vec<u8>)> {
        self.with(|c| {
            Ok(c.query_opt(
                "SELECT content_type, body FROM game_assets WHERE path = $1",
                &[&path],
            )?
            .map(|r| (r.get::<_, String>(0), r.get::<_, Vec<u8>>(1))))
        })
        .flatten()
    }

    fn world(&self) -> Option<String> {
        self.with(|c| {
            Ok(c.query_opt(
                "SELECT data::text FROM game_world WHERE slug = $1",
                &[&WORLD_SLUG],
            )?
            .map(|r| r.get::<_, String>(0)))
        })
        .flatten()
    }

    fn edits(&self) -> Vec<((i32, i32, i32), i32)> {
        self.with(|c| {
            let rows = c.query(
                "SELECT x,y,z,block FROM game_edits WHERE world = $1",
                &[&WORLD_SLUG],
            )?;
            Ok(rows
                .into_iter()
                .map(|r| {
                    (
                        (r.get::<_, i32>(0), r.get::<_, i32>(1), r.get::<_, i32>(2)),
                        r.get::<_, i32>(3),
                    )
                })
                .collect())
        })
        .unwrap_or_default()
    }

    fn save_edit(&self, x: i32, y: i32, z: i32, block: i32, by: &str) {
        self.with(|c| {
            c.execute(
                "INSERT INTO game_edits(world,x,y,z,block,updated_by) VALUES($1,$2,$3,$4,$5,$6)
                 ON CONFLICT(world,x,y,z) DO UPDATE SET block=EXCLUDED.block,
                   updated_by=EXCLUDED.updated_by, updated_at=now()",
                &[&WORLD_SLUG, &x, &y, &z, &block, &by],
            )?;
            Ok(())
        });
    }

    fn scores(&self) -> Vec<ScoreRow> {
        self.with(|c| {
            let rows = c.query(
                "SELECT player_id, name, quests, tokens FROM game_scores
                 ORDER BY quests DESC, tokens DESC, updated_at DESC LIMIT 64",
                &[],
            )?;
            Ok(rows
                .into_iter()
                .map(|r| ScoreRow {
                    pid: r.get(0),
                    name: r.get(1),
                    quests: r.get(2),
                    tokens: r.get(3),
                    color: hash_color(&r.get::<_, String>(1)),
                })
                .collect())
        })
        .unwrap_or_default()
    }

    fn save_score(&self, pid: &str, name: &str, quests: i32, tokens: i32) {
        self.with(|c| {
            c.execute(
                "INSERT INTO game_scores(player_id,name,quests,tokens) VALUES($1,$2,$3,$4)
                 ON CONFLICT(player_id) DO UPDATE SET name=EXCLUDED.name, quests=EXCLUDED.quests,
                   tokens=EXCLUDED.tokens, updated_at=now()",
                &[&pid, &name, &quests, &tokens],
            )?;
            Ok(())
        });
    }

    fn health(&self) -> Option<(i64, i64, i64)> {
        self.with(|c| {
            let assets: i64 = c.query_one("SELECT count(*) FROM game_assets", &[])?.get(0);
            let edits: i64 = c.query_one("SELECT count(*) FROM game_edits", &[])?.get(0);
            let scores: i64 = c.query_one("SELECT count(*) FROM game_scores", &[])?.get(0);
            Ok((assets, edits, scores))
        })
    }

    /// Persist one play-shard visit. Discovery is append-only at the shard
    /// level: the first sighting and the last sighting are both kept.
    fn save_npc_roam(&self, npc: &str, shard: usize, at: i64) {
        self.with(|c| {
            c.execute(
                "INSERT INTO game_npc_roam(world,npc,shard,first_seen,last_seen,visits)
                 VALUES($1,$2,$3,$4,$4,1)
                 ON CONFLICT(world,npc,shard) DO UPDATE SET last_seen=EXCLUDED.last_seen,
                   visits=game_npc_roam.visits+1",
                &[&WORLD_SLUG, &npc, &(shard as i32), &at],
            )?;
            Ok(())
        });
    }

    /// Load the shard bitmask each NPC has already mapped.
    fn npc_roam(&self) -> HashMap<String, u8> {
        let mut out: HashMap<String, u8> = HashMap::new();
        self.with(|c| {
            let rows = c.query(
                "SELECT npc, shard FROM game_npc_roam WHERE world=$1",
                &[&WORLD_SLUG],
            )?;
            for row in rows {
                let npc: String = row.get(0);
                let shard: i32 = row.get(1);
                if (0..PLAY_SHARDS as i32).contains(&shard) {
                    *out.entry(npc).or_insert(0u8) |= 1 << shard;
                }
            }
            Ok(())
        });
        out
    }

    fn save_side(&self, shard: i32, height: i64, hash: &str, parent: &str, root: &str, edits: i32, at: i64) {
        self.with(|c| {
            c.execute(
                "INSERT INTO game_side_blocks(world,shard,height,hash,parent,root,edits,at)
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8)
                 ON CONFLICT(world,shard,height) DO UPDATE SET hash=EXCLUDED.hash,
                   parent=EXCLUDED.parent, root=EXCLUDED.root, edits=EXCLUDED.edits, at=EXCLUDED.at",
                &[&WORLD_SLUG, &shard, &height, &hash, &parent, &root, &edits, &at],
            )?;
            Ok(())
        });
    }

    fn save_anchor(&self, height: i64, hash: &str, parent: &str, roots: &str, at: i64) {
        self.with(|c| {
            c.execute(
                "INSERT INTO game_anchors(world,height,hash,parent,roots,at)
                 VALUES($1,$2,$3,$4,$5::jsonb,$6)
                 ON CONFLICT(world,height) DO UPDATE SET hash=EXCLUDED.hash,
                   parent=EXCLUDED.parent, roots=EXCLUDED.roots, at=EXCLUDED.at",
                &[&WORLD_SLUG, &height, &hash, &parent, &roots, &at],
            )?;
            Ok(())
        });
    }

    fn latest_sides(&self) -> Vec<(i32, i64, String, String)> {
        self.with(|c| {
            let rows = c.query(
                "SELECT DISTINCT ON (shard) shard,height,hash,root FROM game_side_blocks
                 WHERE world=$1 ORDER BY shard, height DESC",
                &[&WORLD_SLUG],
            )?;
            Ok(rows.into_iter().map(|r| (r.get(0), r.get(1), r.get(2), r.get(3))).collect())
        })
        .unwrap_or_default()
    }

    fn latest_anchor(&self) -> Option<(i64, String, String, String, i64)> {
        self.with(|c| {
            Ok(c.query_opt(
                "SELECT height,hash,parent,roots::text,at FROM game_anchors
                 WHERE world=$1 ORDER BY height DESC LIMIT 1",
                &[&WORLD_SLUG],
            )?
            .map(|r| (r.get(0), r.get(1), r.get(2), r.get(3), r.get(4))))
        })
        .flatten()
    }

    fn save_account(&self, pid: &str, name: &str, color: i32, quests: i32, tokens: i32,
                    address: Option<&str>, network: &str, root: &str, events: i64) {
        self.with(|c| {
            c.execute(
                "INSERT INTO game_accounts(player_id,name,color,quests,tokens,address,network,mmr_root,mmr_events)
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
                 ON CONFLICT(player_id) DO UPDATE SET name=EXCLUDED.name, color=EXCLUDED.color,
                   quests=EXCLUDED.quests, tokens=EXCLUDED.tokens, address=EXCLUDED.address,
                   network=EXCLUDED.network, mmr_root=EXCLUDED.mmr_root,
                   mmr_events=EXCLUDED.mmr_events, updated_at=now()",
                &[&pid, &name, &color, &quests, &tokens, &address, &network, &root, &events],
            )?;
            Ok(())
        });
    }

    fn accounts(&self) -> Vec<(String, String, i32, i32, i32, Option<String>, String, String, i64)> {
        self.with(|c| {
            let rows = c.query(
                "SELECT player_id,name,color,quests,tokens,address,network,mmr_root,mmr_events
                 FROM game_accounts ORDER BY player_id",
                &[],
            )?;
            Ok(rows.into_iter().map(|r| (
                r.get(0), r.get(1), r.get(2), r.get(3), r.get(4),
                r.get(5), r.get(6), r.get(7), r.get(8),
            )).collect())
        })
        .unwrap_or_default()
    }

    fn save_account_event(&self, pid: &str, seq: i64, leaf: &str, event: &str, at: i64) {
        self.with(|c| {
            c.execute(
                "INSERT INTO game_account_events(player_id,seq,leaf,event,at) VALUES($1,$2,$3,$4,$5)
                 ON CONFLICT(player_id,seq) DO NOTHING",
                &[&pid, &seq, &leaf, &event, &at],
            )?;
            Ok(())
        });
    }

    fn account_events(&self) -> Vec<(String, i64, String, String)> {
        self.with(|c| {
            let rows = c.query(
                "SELECT player_id,seq,leaf,event FROM game_account_events ORDER BY player_id, seq",
                &[],
            )?;
            Ok(rows.into_iter().map(|r| (r.get(0), r.get(1), r.get(2), r.get(3))).collect())
        })
        .unwrap_or_default()
    }
}

// --------------------------------------------------------------- hub state ---
#[derive(Clone)]
struct PlayerState {
    id: u64,
    pid: String,
    name: String,
    color: u8,
    x: f32,
    y: f32,
    z: f32,
    yaw: f32,
    quests: i32,
    tokens: i32,
}

#[derive(Clone)]
struct ScoreRow {
    pid: String,
    name: String,
    quests: i32,
    tokens: i32,
    color: u8,
}

enum DbJob {
    Edit { x: i32, y: i32, z: i32, block: i32, by: String },
    Score { pid: String, name: String, quests: i32, tokens: i32 },
    NpcRoam { npc: String, shard: usize, at: i64 },
}

// ---------------------------------------------------- 2× rings + hash shards --
//
// Network reader threads and the NPC ticker are **producers**. Each entity is
// assigned to a shard by a consistent hash of its identity, so every event for
// one player or NPC lands in the same ring and is handled in order. Each shard
// owns a double ring: producers fill the active ring while the consumer drains
// the other, and a single atomic swap replaces the pair every tick. That keeps
// the network threads off the simulation lock and gives the consumer a stable
// snapshot per tick.

#[derive(Debug)]
enum Event {
    Join { id: u64, pid: String, name: String, color: u8, quests: i32, tokens: i32 },
    Pos { id: u64, x: f32, y: f32, z: f32, yaw: f32 },
    Block { id: u64, x: i32, y: i32, z: i32, block: i32 },
    Chat { id: u64, text: String },
    Score { id: u64, quests: i32, tokens: i32 },
    Leave { id: u64 },
    NpcTick { id: String, dt: f32 },
}

struct Ring<T> {
    slots: Vec<Option<T>>,
    head: usize,
    tail: usize,
    len: usize,
}

impl<T> Ring<T> {
    fn new(capacity: usize) -> Self {
        let capacity = capacity.max(1);
        let mut slots = Vec::with_capacity(capacity);
        for _ in 0..capacity {
            slots.push(None);
        }
        Self { slots, head: 0, tail: 0, len: 0 }
    }
    fn push(&mut self, item: T) -> Result<(), T> {
        if self.len == self.slots.len() {
            return Err(item);
        }
        self.slots[self.tail] = Some(item);
        self.tail = (self.tail + 1) % self.slots.len();
        self.len += 1;
        Ok(())
    }
    fn pop(&mut self) -> Option<T> {
        if self.len == 0 {
            return None;
        }
        let item = self.slots[self.head].take();
        self.head = (self.head + 1) % self.slots.len();
        self.len -= 1;
        item
    }
}

struct DoubleRing<T> {
    rings: [Mutex<Ring<T>>; 2],
    active: AtomicUsize,
    dropped: AtomicU64,
}

impl<T> DoubleRing<T> {
    fn new(capacity: usize) -> Self {
        Self {
            rings: [Mutex::new(Ring::new(capacity)), Mutex::new(Ring::new(capacity))],
            active: AtomicUsize::new(0),
            dropped: AtomicU64::new(0),
        }
    }
    fn push(&self, item: T) {
        let i = self.active.load(Ordering::Relaxed) & 1;
        if let Ok(mut ring) = self.rings[i].lock() {
            if ring.push(item).is_err() {
                let n = self.dropped.fetch_add(1, Ordering::Relaxed) + 1;
                if n % 1000 == 1 {
                    eprintln!("[ring] full; dropped {n} event(s)");
                }
            }
        }
    }
    fn drain(&self, f: &mut dyn FnMut(T)) {
        let old = self.active.fetch_xor(1, Ordering::SeqCst) & 1;
        if let Ok(mut ring) = self.rings[old].lock() {
            while let Some(item) = ring.pop() {
                f(item);
            }
        }
    }
}

fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

fn shard_at(x: f32, z: f32) -> usize {
    let sx = usize::from(x >= SHARD_HALF);
    let sz = usize::from(z >= SHARD_HALF);
    (sz * 2 + sx).min(PLAY_SHARDS - 1)
}

fn shard_center(shard: usize) -> (f32, f32) {
    let sx = (shard & 1) as f32;
    let sz = ((shard >> 1) & 1) as f32;
    (SHARD_HALF * 0.5 + sx * SHARD_HALF, SHARD_HALF * 0.5 + sz * SHARD_HALF)
}

fn epoch_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

struct HashRing {
    vnodes: Vec<(u64, usize)>,
    shards: usize,
}

impl HashRing {
    fn new(shards: usize) -> Self {
        let shards = shards.max(1);
        let mut vnodes = Vec::with_capacity(shards * 64);
        for s in 0..shards {
            for v in 0..64 {
                vnodes.push((fnv1a(&format!("shard-{s}-vnode-{v}")), s));
            }
        }
        vnodes.sort_by_key(|(h, _)| *h);
        Self { vnodes, shards }
    }
    fn shard_for(&self, key: &str) -> usize {
        let h = fnv1a(key);
        match self.vnodes.binary_search_by_key(&h, |(vh, _)| *vh) {
            Ok(i) => self.vnodes[i].1,
            Err(i) => {
                if i >= self.vnodes.len() { self.vnodes[0].1 } else { self.vnodes[i].1 }
            }
        }
    }
    fn shards(&self) -> usize { self.shards }
}

struct Shards {
    hash: HashRing,
    rings: Vec<DoubleRing<Event>>,
}

impl Shards {
    fn new(shards: usize, capacity: usize) -> Self {
        let mut rings = Vec::with_capacity(shards);
        for _ in 0..shards {
            rings.push(DoubleRing::new(capacity));
        }
        Self { hash: HashRing::new(shards), rings }
    }
    fn player_shard(&self, id: u64) -> usize {
        self.hash.shard_for(&format!("player:{id}"))
    }
    fn npc_shard(&self, id: &str) -> usize {
        self.hash.shard_for(&format!("npc:{id}"))
    }
    fn push_player(&self, id: u64, event: Event) {
        let s = self.player_shard(id);
        self.rings[s].push(event);
    }
    fn push_npc(&self, id: &str, event: Event) {
        let s = self.npc_shard(id);
        self.rings[s].push(event);
    }
    fn drain(&self, shard: usize, f: &mut dyn FnMut(Event)) {
        if let Some(ring) = self.rings.get(shard) {
            ring.drain(f);
        }
    }
}

struct NpcState {
    id: String,
    name: String,
    sprite: String,
    home: (f32, f32),
    shard: usize,
    seen: u8,
    target_shard: usize,
    x: f32,
    y: f32,
    z: f32,
    tx: f32,
    tz: f32,
    yaw: f32,
    size: (f32, f32),
    speed: f32,
    pause_until: std::time::Instant,
    rng: u64,
}

impl NpcState {
    fn rand(&mut self) -> f32 {
        let mut x = self.rng;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.rng = x;
        ((x >> 40) as f32) / ((1u64 << 24) as f32)
    }
    fn tick(&mut self, dt: f32) {
        let now = std::time::Instant::now();
        if now < self.pause_until {
            return;
        }
        let dx = self.tx - self.x;
        let dz = self.tz - self.z;
        let d = (dx * dx + dz * dz).sqrt();
        if d < 0.10 {
            self.shard = shard_at(self.x, self.z);
            self.seen |= 1 << self.shard;
            // No geofence: pick the next play shard round-robin so every shard
            // is entered and mapped, then a random point inside it. The NPC is
            // not pulled back to `home`; `home` is only its spawn.
            self.target_shard = (self.target_shard + 1) % PLAY_SHARDS;
            let (cx, cz) = shard_center(self.target_shard);
            let a = self.rand() * std::f32::consts::TAU;
            let r = 4.0 + self.rand() * 16.0;
            self.tx = clamp_f(cx + a.cos() * r, 2.0, 94.0);
            self.tz = clamp_f(cz + a.sin() * r, 2.0, 94.0);
            let pause = 500 + (self.rand() * 1500.0) as u64;
            self.pause_until = now + Duration::from_millis(pause);
            return;
        }
        let step = (self.speed * dt).min(d);
        self.x += dx / d * step;
        self.z += dz / d * step;
        self.yaw = dx.atan2(-dz);
        let here = shard_at(self.x, self.z);
        if here != self.shard {
            self.shard = here;
            self.seen |= 1 << here;
        }
    }
}

fn load_npcs(roam: &HashMap<String, u8>) -> Vec<NpcState> {
    let value: Value = serde_json::from_str(WORLD).unwrap_or_else(|_| json!({}));
    let arr = value.get("npcs").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    arr.iter()
        .filter_map(|n| {
            let id = n.get("id")?.as_str()?.to_string();
            let name = n.get("name").and_then(|v| v.as_str()).unwrap_or("Neighbour").to_string();
            let sprite = n.get("sprite").and_then(|v| v.as_str()).unwrap_or("gardener").to_string();
            let x = n.get("x")?.as_f64()? as f32;
            let y = n.get("y").and_then(|v| v.as_f64()).unwrap_or(9.0) as f32;
            let z = n.get("z")?.as_f64()? as f32;
            let size = n.get("size").and_then(|v| v.as_array()).map(|a| {
                (
                    a.first().and_then(|v| v.as_f64()).unwrap_or(1.5) as f32,
                    a.get(1).and_then(|v| v.as_f64()).unwrap_or(2.0) as f32,
                )
            }).unwrap_or((1.5, 2.0));
            let shard = shard_at(x, z);
            Some(NpcState {
                id: id.clone(),
                name,
                sprite,
                home: (x, z),
                shard,
                seen: roam.get(&id).copied().unwrap_or(0) | (1 << shard),
                target_shard: shard,
                x, y, z, tx: x, tz: z, yaw: 0.0,
                size,
                speed: 1.35,
                pause_until: std::time::Instant::now() + Duration::from_millis((fnv1a(&id) % 3000) as u64),
                rng: fnv1a(&id) | 1,
            })
        })
        .collect()
}

fn npc_json(n: &NpcState) -> Value {
    json!({
        "id": n.id, "name": n.name, "sprite": n.sprite,
        "x": n.x, "y": n.y, "z": n.z, "yaw": n.yaw,
        "size": [n.size.0, n.size.1],
        "home": [n.home.0, n.home.1],
        "shard": n.shard, "shards": n.seen, "shards_seen": n.seen.count_ones(),
        "shards_total": PLAY_SHARDS, "geofence": false
    })
}


type Writer = Arc<Mutex<TcpStream>>;

struct Hub {
    next_id: AtomicU64,
    shards: Arc<Shards>,
    actors: Mutex<HashMap<String, ActorHandle>>,
    clients: Mutex<HashMap<u64, Writer>>,
    presence: Mutex<HashMap<String, String>>,
    edits: Mutex<HashMap<(i32, i32, i32), i32>>,
    chat: Mutex<VecDeque<Value>>,
    scores: Mutex<HashMap<String, ScoreRow>>,
    store: Arc<Store>,
    db_tx: Sender<DbJob>,
    started: std::time::Instant,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ActorKind { Player, Npc }

enum PlayerMsg {
    Pos { x: f32, y: f32, z: f32, yaw: f32 },
    Block { x: i32, y: i32, z: i32, block: i32 },
    Chat { text: String },
    Score { quests: i32, tokens: i32 },
    Leave,
}

enum NpcMsg { Tick { dt: f32 } }

enum ActorMsg {
    Player(PlayerMsg),
    Npc(NpcMsg),
}

struct ActorHandle {
    tx: Sender<ActorMsg>,
    snapshot: Arc<Mutex<Value>>,
    kind: ActorKind,
}

fn publish(snapshot: &Arc<Mutex<Value>>, value: Value) {
    if let Ok(mut g) = snapshot.lock() {
        *g = value;
    }
}

fn player_actor(hub: Arc<Hub>, mut p: PlayerState, rx: mpsc::Receiver<ActorMsg>, snapshot: Arc<Mutex<Value>>) {
    publish(&snapshot, player_json(&p));
    while let Ok(msg) = rx.recv() {
        match msg {
            ActorMsg::Player(PlayerMsg::Pos { x, y, z, yaw }) => {
                p.x = clamp_f(x, 0.0, 96.0);
                p.y = clamp_f(y, 0.0, 48.0);
                p.z = clamp_f(z, 0.0, 96.0);
                p.yaw = if yaw.is_finite() { yaw } else { p.yaw };
                publish(&snapshot, player_json(&p));
            }
            ActorMsg::Player(PlayerMsg::Block { x, y, z, block }) => {
                hub.apply_block(p.id, &p.name, x, y, z, block);
            }
            ActorMsg::Player(PlayerMsg::Chat { text }) => {
                hub.apply_chat(p.id, &p.name, &text);
            }
            ActorMsg::Player(PlayerMsg::Score { quests, tokens }) => {
                p.quests = quests.clamp(0, 99);
                p.tokens = tokens.clamp(0, 99);
                publish(&snapshot, player_json(&p));
                hub.apply_score(&p.pid, &p.name, p.quests, p.tokens);
            }
            ActorMsg::Player(PlayerMsg::Leave) => break,
            ActorMsg::Npc(_) => {}
        }
    }
}

fn npc_actor(
    mut n: NpcState,
    rx: mpsc::Receiver<ActorMsg>,
    snapshot: Arc<Mutex<Value>>,
    db_tx: Sender<DbJob>,
) {
    publish(&snapshot, npc_json(&n));
    let mut shard = n.shard;
    while let Ok(msg) = rx.recv() {
        if let ActorMsg::Npc(NpcMsg::Tick { dt }) = msg {
            n.tick(dt);
            if n.shard != shard {
                shard = n.shard;
                let _ = db_tx.send(DbJob::NpcRoam {
                    npc: n.id.clone(),
                    shard,
                    at: epoch_secs(),
                });
            }
            publish(&snapshot, npc_json(&n));
        }
    }
}

fn hash_color(name: &str) -> u8 {
    let mut h: u32 = 0;
    for b in name.bytes() {
        h = h.wrapping_mul(31).wrapping_add(b as u32);
    }
    (h % 8) as u8
}

fn sanitize_name(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.chars() {
        if out.len() >= 18 {
            break;
        }
        if ch.is_ascii_alphanumeric() || ch == ' ' || ch == '_' || ch == '-' || ch == '.' {
            out.push(ch);
        }
    }
    let trimmed = out.trim();
    if trimmed.is_empty() { "Traveler".into() } else { trimmed.to_string() }
}

fn sanitize_pid(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.chars() {
        if out.len() >= 40 {
            break;
        }
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
            out.push(ch);
        }
    }
    if out.is_empty() { "anon".into() } else { out }
}

fn sanitize_chat(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.chars() {
        if out.len() >= 140 {
            break;
        }
        if ch.is_control() {
            out.push(' ');
        } else {
            out.push(ch);
        }
    }
    out.trim().to_string()
}

fn player_json(p: &PlayerState) -> Value {
    json!({
        "id": p.id, "name": p.name, "color": p.color,
        "x": p.x, "y": p.y, "z": p.z, "yaw": p.yaw,
        "quests": p.quests, "tokens": p.tokens
    })
}

impl Hub {
    fn broadcast(&self, text: &str) {
        let clients: Vec<(u64, Writer)> = {
            let g = self.clients.lock().unwrap();
            g.iter().map(|(k, v)| (*k, v.clone())).collect()
        };
        let mut dead = Vec::new();
        for (id, w) in clients {
            if !ws_send(&w, text) {
                dead.push(id);
            }
        }
        if !dead.is_empty() {
            let mut g = self.clients.lock().unwrap();
            for id in dead {
                g.remove(&id);
            }
        }
    }

    fn actors_snapshot(&self, kind: ActorKind) -> Vec<Value> {
        let handles: Vec<Arc<Mutex<Value>>> = {
            let g = self.actors.lock().unwrap();
            g.values()
                .filter(|h| h.kind == kind)
                .map(|h| h.snapshot.clone())
                .collect()
        };
        let mut all: Vec<Value> = handles
            .into_iter()
            .filter_map(|s| s.lock().ok().map(|v| v.clone()))
            .collect();
        all.sort_by(|a, b| format!("{:?}", a.get("id")).cmp(&format!("{:?}", b.get("id"))));
        all
    }

    fn players_snapshot(&self) -> Vec<Value> {
        self.actors_snapshot(ActorKind::Player)
    }

    fn npcs_snapshot(&self) -> Vec<Value> {
        self.actors_snapshot(ActorKind::Npc)
    }

    fn players_count(&self) -> usize {
        let g = self.actors.lock().unwrap();
        g.values().filter(|h| h.kind == ActorKind::Player).count()
    }

    fn broadcast_state(&self) {
        let players = self.players_snapshot();
        if players.is_empty() {
            return;
        }
        let npcs = self.npcs_snapshot();
        let msg = json!({"t": "state", "players": players, "npcs": npcs}).to_string();
        self.broadcast(&msg);
    }

    fn scores_json(&self) -> Vec<Value> {
        let g = self.scores.lock().unwrap();
        let mut rows: Vec<&ScoreRow> = g.values().collect();
        rows.sort_by(|a, b| {
            b.quests.cmp(&a.quests)
                .then(b.tokens.cmp(&a.tokens))
                .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        rows.into_iter()
            .take(24)
            .map(|s| json!({"pid": s.pid, "name": s.name, "quests": s.quests, "tokens": s.tokens, "color": s.color}))
            .collect()
    }

    fn welcome(&self, id: u64) -> Value {
        let edits: Vec<Value> = {
            let g = self.edits.lock().unwrap();
            g.iter().map(|((x, y, z), b)| json!([x, y, z, b])).collect()
        };
        let chat: Vec<Value> = {
            let g = self.chat.lock().unwrap();
            g.iter().cloned().collect()
        };
        json!({
            "t": "welcome", "id": id,
            "players": self.players_snapshot(), "npcs": self.npcs_snapshot(),
            "edits": edits, "chat": chat, "scores": self.scores_json()
        })
    }

    fn send_welcome(&self, id: u64, writer: &Writer) {
        let msg = self.welcome(id).to_string();
        ws_send(writer, &msg);
    }

    fn upsert_score(&self, pid: &str, name: &str, quests: i32, tokens: i32) {
        let mut g = self.scores.lock().unwrap();
        g.insert(pid.to_string(), ScoreRow {
            pid: pid.to_string(), name: name.to_string(), quests, tokens, color: hash_color(name),
        });
    }

    fn register_actor(&self, key: String, tx: Sender<ActorMsg>, snapshot: Arc<Mutex<Value>>, kind: ActorKind) {
        self.actors.lock().unwrap().insert(key, ActorHandle { tx, snapshot, kind });
    }

    fn route_player(&self, id: u64, msg: PlayerMsg) {
        let key = format!("player:{id}");
        let tx = {
            let g = self.actors.lock().unwrap();
            g.get(&key).map(|h| h.tx.clone())
        };
        if let Some(tx) = tx {
            let _ = tx.send(ActorMsg::Player(msg));
        }
    }

    fn route_npc(&self, id: &str, msg: NpcMsg) {
        let key = format!("npc:{id}");
        let tx = {
            let g = self.actors.lock().unwrap();
            g.get(&key).map(|h| h.tx.clone())
        };
        if let Some(tx) = tx {
            let _ = tx.send(ActorMsg::Npc(msg));
        }
    }

    fn apply_block(&self, id: u64, by: &str, x: i32, y: i32, z: i32, block: i32) {
        if x < 0 || x >= 96 || y < 0 || y >= 48 || z < 0 || z >= 96 || block < 0 || block > 64 {
            return;
        }
        self.edits.lock().unwrap().insert((x, y, z), block);
        self.broadcast(&json!({"t": "block", "x": x, "y": y, "z": z, "id": block, "by": id}).to_string());
        let _ = self.db_tx.send(DbJob::Edit { x, y, z, block, by: by.to_string() });
    }

    fn apply_chat(&self, id: u64, name: &str, text: &str) {
        let text = sanitize_chat(text);
        if text.is_empty() {
            return;
        }
        {
            let mut g = self.chat.lock().unwrap();
            g.push_back(json!({"name": name, "text": text}));
            while g.len() > 30 {
                g.pop_front();
            }
        }
        self.broadcast(&json!({"t": "chat", "name": name, "text": text, "by": id}).to_string());
    }

    fn apply_score(&self, pid: &str, name: &str, quests: i32, tokens: i32) {
        self.upsert_score(pid, name, quests, tokens);
        self.broadcast(&json!({"t": "scores", "scores": self.scores_json()}).to_string());
        let _ = self.db_tx.send(DbJob::Score {
            pid: pid.to_string(), name: name.to_string(), quests, tokens,
        });
    }

    /// The shard consumer is only a **router**. Every mutation happens on the
    /// actor's own thread, so one slow player or NPC cannot hold a shard lock
    /// and the broadcast thread only reads lock-free-ish snapshots.
    fn handle_event(self: &Arc<Self>, shard: usize, event: Event) {
        match event {
            Event::Join { id, pid, name, color, quests, tokens } => {
                let pid = sanitize_pid(&pid);
                let name = sanitize_name(&name);
                let state = PlayerState {
                    id, pid: pid.clone(), name: name.clone(), color: color % 8,
                    x: 48.5, y: 9.0, z: 37.5, yaw: std::f32::consts::PI,
                    quests: quests.clamp(0, 99), tokens: tokens.clamp(0, 99),
                };
                let snapshot = Arc::new(Mutex::new(player_json(&state)));
                let (tx, rx) = mpsc::channel();
                let hub = self.clone();
                let actor_snapshot = snapshot.clone();
                thread::Builder::new()
                    .name(format!("player-{id}"))
                    .spawn(move || player_actor(hub, state, rx, actor_snapshot))
                    .ok();
                self.register_actor(format!("player:{id}"), tx, snapshot, ActorKind::Player);
                self.upsert_score(&pid, &name, quests.clamp(0, 99), tokens.clamp(0, 99));
                if let Some(writer) = self.clients.lock().unwrap().get(&id).cloned() {
                    self.send_welcome(id, &writer);
                }
                self.broadcast_state();
                self.broadcast(&json!({"t": "scores", "scores": self.scores_json()}).to_string());
                let _ = self.db_tx.send(DbJob::Score {
                    pid, name, quests: quests.clamp(0, 99), tokens: tokens.clamp(0, 99),
                });
                eprintln!("[actor] player {id} -> shard {shard}");
            }
            Event::Pos { id, x, y, z, yaw } => {
                self.route_player(id, PlayerMsg::Pos { x, y, z, yaw });
            }
            Event::Block { id, x, y, z, block } => {
                self.route_player(id, PlayerMsg::Block { x, y, z, block });
            }
            Event::Chat { id, text } => {
                self.route_player(id, PlayerMsg::Chat { text });
            }
            Event::Score { id, quests, tokens } => {
                self.route_player(id, PlayerMsg::Score { quests, tokens });
            }
            Event::Leave { id } => {
                let key = format!("player:{id}");
                let tx = {
                    let mut g = self.actors.lock().unwrap();
                    g.remove(&key).map(|h| h.tx)
                };
                if let Some(tx) = tx {
                    let _ = tx.send(ActorMsg::Player(PlayerMsg::Leave));
                }
                self.broadcast_state();
                eprintln!("[actor] player {id} left shard {shard}");
            }
            Event::NpcTick { id, dt } => {
                self.route_npc(&id, NpcMsg::Tick { dt });
            }
        }
    }
}

// --------------------------------------------------------------- websocket ---
struct Frame {
    opcode: u8,
    fin: bool,
    payload: Vec<u8>,
}

fn read_frame(stream: &mut TcpStream) -> io::Result<Frame> {
    let mut head = [0u8; 2];
    stream.read_exact(&mut head)?;
    let fin = head[0] & 0x80 != 0;
    let opcode = head[0] & 0x0f;
    let masked = head[1] & 0x80 != 0;
    let mut len = (head[1] & 0x7f) as u64;
    if len == 126 {
        let mut b = [0u8; 2];
        stream.read_exact(&mut b)?;
        len = u16::from_be_bytes(b) as u64;
    } else if len == 127 {
        let mut b = [0u8; 8];
        stream.read_exact(&mut b)?;
        len = u64::from_be_bytes(b);
    }
    if len > MAX_BODY as u64 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut mask = [0u8; 4];
    if masked {
        stream.read_exact(&mut mask)?;
    }
    let mut payload = vec![0u8; len as usize];
    stream.read_exact(&mut payload)?;
    if masked {
        for (i, byte) in payload.iter_mut().enumerate() {
            *byte ^= mask[i % 4];
        }
    }
    Ok(Frame { opcode, fin, payload })
}

fn write_frame(stream: &mut TcpStream, opcode: u8, payload: &[u8]) -> io::Result<()> {
    let mut header = Vec::with_capacity(10);
    header.push(0x80 | opcode);
    let len = payload.len();
    if len < 126 {
        header.push(len as u8);
    } else if len <= 65535 {
        header.push(126);
        header.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        header.push(127);
        header.extend_from_slice(&(len as u64).to_be_bytes());
    }
    stream.write_all(&header)?;
    stream.write_all(payload)?;
    stream.flush()
}

fn ws_send(stream: &Writer, text: &str) -> bool {
    let mut guard = match stream.lock() {
        Ok(g) => g,
        Err(_) => return false,
    };
    write_frame(&mut guard, 0x1, text.as_bytes()).is_ok()
}

fn ws_handshake(stream: &mut TcpStream, key: &str) -> io::Result<()> {
    let mut hasher = Sha1::new();
    hasher.update(key.as_bytes());
    hasher.update(WS_GUID.as_bytes());
    let accept = B64.encode(hasher.finalize());
    let response = format!(
        "HTTP/1.1 101 Switching Protocols\r\n\
         Upgrade: websocket\r\n\
         Connection: Upgrade\r\n\
         Sec-WebSocket-Accept: {accept}\r\n\r\n"
    );
    stream.write_all(response.as_bytes())?;
    stream.flush()
}

fn handle_ws(mut stream: TcpStream, hub: Arc<Hub>, head: String) {
    stream.set_read_timeout(Some(Duration::from_secs(180))).ok();
    stream.set_nodelay(true).ok();

    let mut lines = head.split("\r\n");
    let request = lines.next().unwrap_or("");
    let mut parts = request.split_whitespace();
    let _method = parts.next().unwrap_or("GET");
    let path = parts.next().unwrap_or("/").split('?').next().unwrap_or("/").to_string();
    let mut headers = HashMap::new();
    for line in lines {
        if line.is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }

    let upgrade = headers.get("upgrade").map(|s| s.eq_ignore_ascii_case("websocket")).unwrap_or(false);
    if path != "/ws" && path != "/ws/" || !upgrade {
        let _ = write_http(&mut stream, "404 Not Found", "text/plain; charset=utf-8", b"not a websocket\n", false);
        return;
    }
    let key = match headers.get("sec-websocket-key") {
        Some(k) => k.clone(),
        None => {
            let _ = write_http(&mut stream, "400 Bad Request", "text/plain; charset=utf-8", b"missing key\n", false);
            return;
        }
    };
    if ws_handshake(&mut stream, &key).is_err() {
        return;
    }

    let writer: Writer = match stream.try_clone() {
        Ok(s) => {
            s.set_write_timeout(Some(Duration::from_secs(4))).ok();
            Arc::new(Mutex::new(s))
        }
        Err(_) => return,
    };
    let id = hub.next_id.fetch_add(1, Ordering::SeqCst) + 1;
    hub.clients.lock().unwrap().insert(id, writer.clone());
    eprintln!("[ws] client {id} connected");

    let mut pending: Vec<u8> = Vec::new();
    let mut pending_op: u8 = 0;
    loop {
        let frame = match read_frame(&mut stream) {
            Ok(f) => f,
            Err(_) => break,
        };
        match frame.opcode {
            0x8 => break,
            0x9 => {
                if let Ok(mut g) = writer.lock() {
                    let _ = write_frame(&mut g, 0xA, &frame.payload);
                }
            }
            0xA => {}
            0x1 | 0x2 | 0x0 => {
                if frame.opcode != 0x0 {
                    pending_op = frame.opcode;
                    pending.clear();
                }
                pending.extend_from_slice(&frame.payload);
                if pending.len() > MAX_BODY {
                    break;
                }
                if frame.fin {
                    if pending_op == 0x1 {
                        let text = String::from_utf8_lossy(&pending).to_string();
                        handle_client_text(&hub, id, &writer, &text);
                    }
                    pending.clear();
                    pending_op = 0;
                }
            }
            _ => {}
        }
    }

    hub.clients.lock().unwrap().remove(&id);
    hub.shards.push_player(id, Event::Leave { id });
    eprintln!("[ws] client {id} disconnected");
}

fn handle_client_text(hub: &Arc<Hub>, id: u64, writer: &Writer, text: &str) {
    let value: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return,
    };
    let kind = value.get("t").and_then(|v| v.as_str()).unwrap_or("");
    match kind {
        "join" => {
            let name = sanitize_name(value.get("name").and_then(|v| v.as_str()).unwrap_or("Traveler"));
            let color = (value.get("color").and_then(|v| v.as_u64()).unwrap_or(hash_color(&name) as u64) % 8) as u8;
            let quests = value.get("quests").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let tokens = value.get("tokens").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let pid = value.get("pid").and_then(|v| v.as_str()).map(sanitize_pid)
                .unwrap_or_else(|| format!("client-{id}"));
            hub.shards.push_player(id, Event::Join { id, pid, name, color, quests, tokens });
        }
        "pos" => {
            let x = value.get("x").and_then(|v| v.as_f64()).unwrap_or(48.5) as f32;
            let y = value.get("y").and_then(|v| v.as_f64()).unwrap_or(9.0) as f32;
            let z = value.get("z").and_then(|v| v.as_f64()).unwrap_or(37.5) as f32;
            let yaw = value.get("yaw").and_then(|v| v.as_f64()).unwrap_or(std::f32::consts::PI as f64) as f32;
            hub.shards.push_player(id, Event::Pos { id, x, y, z, yaw });
        }
        "block" => {
            let x = value.get("x").and_then(|v| v.as_i64()).unwrap_or(-1);
            let y = value.get("y").and_then(|v| v.as_i64()).unwrap_or(-1);
            let z = value.get("z").and_then(|v| v.as_i64()).unwrap_or(-1);
            let block = value.get("id").and_then(|v| v.as_i64()).unwrap_or(-1);
            if x < 0 || x >= 96 || y < 0 || y >= 48 || z < 0 || z >= 96 || block < 0 || block > 64 {
                return;
            }
            hub.shards.push_player(id, Event::Block { id, x: x as i32, y: y as i32, z: z as i32, block: block as i32 });
        }
        "chat" => {
            let text = sanitize_chat(value.get("text").and_then(|v| v.as_str()).unwrap_or(""));
            if !text.is_empty() {
                hub.shards.push_player(id, Event::Chat { id, text });
            }
        }
        "score" => {
            let quests = (value.get("quests").and_then(|v| v.as_i64()).unwrap_or(0) as i32).clamp(0, 99);
            let tokens = (value.get("tokens").and_then(|v| v.as_i64()).unwrap_or(0) as i32).clamp(0, 99);
            hub.shards.push_player(id, Event::Score { id, quests, tokens });
        }
        "ping" => {
            ws_send(writer, &json!({"t":"pong"}).to_string());
        }
        _ => {}
    }
}

fn clamp_f(v: f32, lo: f32, hi: f32) -> f32 {
    if v.is_nan() { lo } else { v.max(lo).min(hi) }
}

// ------------------------------------------------------------------- http ----
fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn write_http(stream: &mut TcpStream, status: &str, mime: &str, body: &[u8], head_only: bool) -> io::Result<()> {
    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\n\
         Cache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(header.as_bytes())?;
    if !head_only {
        stream.write_all(body)?;
    }
    stream.flush()
}

fn inject_world(html: &str, world: &str) -> String {
    let script = format!("<script>window.__WORLD__={world};</script>");
    let lower = html.to_ascii_lowercase();
    if let Some(pos) = lower.find("</head>") {
        let mut out = String::with_capacity(html.len() + script.len());
        out.push_str(&html[..pos]);
        out.push_str(&script);
        out.push_str(&html[pos..]);
        out
    } else {
        format!("{script}\n{html}")
    }
}

fn embedded_asset(path: &str) -> Option<(&'static str, &'static [u8])> {
    match path {
        "/index.html" | "/" => Some(("text/html; charset=utf-8", INDEX)),
        "/torrance-map.svg" => Some(("image/svg+xml", MAP)),
        "/README.txt" => Some(("text/plain; charset=utf-8", README)),
        "/CREDITS.txt" => Some(("text/plain; charset=utf-8", CREDITS)),
        "/audio/birds.mp3" | "/assets/audio/birds.mp3" => Some(("audio/mpeg", BIRDS)),
        _ => None,
    }
}

fn serve_http(mut stream: TcpStream, hub: Arc<Hub>, head: String) {
    let mut lines = head.split("\r\n");
    let request = lines.next().unwrap_or("");
    let mut parts = request.split_whitespace();
    let method = parts.next().unwrap_or("GET").to_string();
    let raw_path = parts.next().unwrap_or("/").to_string();
    let path = raw_path.split('?').next().unwrap_or("/").to_string();
    let head_only = method == "HEAD";

    if method != "GET" && method != "HEAD" {
        let _ = write_http(&mut stream, "405 Method Not Allowed", "text/plain; charset=utf-8", b"GET or HEAD\n", head_only);
        return;
    }

    if path == "/healthz" {
        let health = hub.store.health();
        let (db, assets, edits, scores) = match health {
            Some((a, e, s)) => ("up", a, e, s),
            None => ("down", 0, 0, 0),
        };
        let players = hub.presence.lock().unwrap().len();
        let body = json!({
            "status": "ok",
            "game": "nautilus-craft",
            "level": WORLD_SLUG,
            "db": db,
            "database": "nautilus_craft",
            "assets": assets,
            "edits": edits,
            "scores": scores,
            "players": players,
            "assetVersion": ASSET_VERSION,
            "uptimeSeconds": hub.started.elapsed().as_secs()
        })
        .to_string();
        let _ = write_http(&mut stream, "200 OK", "application/json", body.as_bytes(), head_only);
        return;
    }

    if path == "/api/world" {
        let world = hub.store.world().unwrap_or_else(|| WORLD.to_string());
        let _ = write_http(&mut stream, "200 OK", "application/json", world.as_bytes(), head_only);
        return;
    }

    if path == "/api/edits" {
        let edits: Vec<Value> = {
            let g = hub.edits.lock().unwrap();
            g.iter().map(|((x, y, z), b)| json!([x, y, z, b])).collect()
        };
        let body = json!({"world": WORLD_SLUG, "edits": edits, "players": hub.players_count()}).to_string();
        let _ = write_http(&mut stream, "200 OK", "application/json", body.as_bytes(), head_only);
        return;
    }

    if path == "/db" {
        let (db, assets, edits, scores) = match hub.store.health() {
            Some((a, e, s)) => ("up", a, e, s),
            None => ("down", 0, 0, 0),
        };
        let body = json!({
            "database": "nautilus_craft", "db": db, "assets": assets,
            "edits": edits, "scores": scores,
            "tables": ["game_assets", "game_world", "game_meta", "game_edits", "game_scores"]
        })
        .to_string();
        let _ = write_http(&mut stream, "200 OK", "application/json", body.as_bytes(), head_only);
        return;
    }

    if path == "/" || path == "/index.html" || path == "/embed" || path == "/embed/" {
        let world = hub.store.world().unwrap_or_else(|| WORLD.to_string());
        let (html, source) = match hub.store.asset("/index.html") {
            Some((_, body)) => (String::from_utf8_lossy(&body).to_string(), "postgres"),
            None => (String::from_utf8_lossy(INDEX).to_string(), "embedded"),
        };
        let page = inject_world(&html, &world);
        let mut body = page.into_bytes();
        if source == "embedded" {
            body.extend_from_slice(b"\n<!-- asset source: embedded fallback -->\n");
        }
        let _ = write_http(&mut stream, "200 OK", "text/html; charset=utf-8", &body, head_only);
        return;
    }

    let asset_path = path.strip_prefix("/assets").unwrap_or(&path);
    if let Some((mime, body)) = embedded_asset(asset_path) {
        let _ = write_http(&mut stream, "200 OK", mime, body, head_only);
        return;
    }
    if let Some((mime, body)) = hub.store.asset(asset_path) {
        let _ = write_http(&mut stream, "200 OK", &mime, &body, head_only);
        return;
    }
    let _ = write_http(&mut stream, "404 Not Found", "text/plain; charset=utf-8", b"not found\n", head_only);
}

fn handle_conn(mut stream: TcpStream, hub: Arc<Hub>) {
    stream.set_read_timeout(Some(Duration::from_secs(20))).ok();
    let mut buf = Vec::new();
    let mut temp = [0u8; 2048];
    let end = loop {
        match stream.read(&mut temp) {
            Ok(0) => return,
            Ok(n) => {
                buf.extend_from_slice(&temp[..n]);
                if let Some(pos) = find_bytes(&buf, b"\r\n\r\n") {
                    break pos + 4;
                }
                if buf.len() > 32768 {
                    return;
                }
            }
            Err(_) => return,
        }
    };
    let head = String::from_utf8_lossy(&buf[..end]).to_string();
    let upgrade = head.to_ascii_lowercase().contains("upgrade: websocket");
    if upgrade {
        // the browser waits for 101 before sending frames, so the header read
        // above is the whole handshake and no frame bytes are lost.
        let _ = stream.set_read_timeout(Some(Duration::from_secs(180)));
        handle_ws(stream, hub, head);
    } else {
        serve_http(stream, hub, head);
    }
}

// ------------------------------------------------------------------- main ----
fn db_url() -> String {
    if let Ok(v) = std::env::var("NC_DB") {
        return v;
    }
    let host = std::env::var("PGHOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port = std::env::var("PGPORT").unwrap_or_else(|_| "5432".into());
    let user = std::env::var("PGUSER").unwrap_or_else(|_| "craft".into());
    let pass = std::env::var("PGPASSWORD").unwrap_or_else(|_| "craft".into());
    let db = std::env::var("PGDATABASE").unwrap_or_else(|_| "nautilus_craft".into());
    format!(
        "host={host} port={port} user={user} password={pass} dbname={db} \
         connect_timeout=2 application_name=nautilus-craft"
    )
}

fn db_writer(rx: mpsc::Receiver<DbJob>, store: Arc<Store>) {
    let mut edits: HashMap<(i32, i32, i32), (i32, String)> = HashMap::new();
    let mut scores: HashMap<String, (String, i32, i32)> = HashMap::new();
    let mut roam: HashMap<(String, usize), i64> = HashMap::new();
    let mut last_flush = std::time::Instant::now();
    loop {
        match rx.recv_timeout(Duration::from_millis(450)) {
            Ok(DbJob::Edit { x, y, z, block, by }) => {
                edits.insert((x, y, z), (block, by));
            }
            Ok(DbJob::Score { pid, name, quests, tokens }) => {
                scores.insert(pid, (name, quests, tokens));
            }
            Ok(DbJob::NpcRoam { npc, shard, at }) => {
                roam.insert((npc, shard), at);
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        // A slow NPC changes shard rarely; flush on a timer as well as on size,
        // otherwise a discovery could sit in memory for the whole session.
        let due = last_flush.elapsed() >= Duration::from_secs(2);
        if edits.len() >= 40 || scores.len() >= 40 || roam.len() >= 40 || due {
            last_flush = std::time::Instant::now();
            for ((x, y, z), (block, by)) in edits.drain() {
                store.save_edit(x, y, z, block, &by);
            }
            for (pid, (name, quests, tokens)) in scores.drain() {
                store.save_score(&pid, &name, quests, tokens);
            }
            for ((npc, shard), at) in roam.drain() {
                store.save_npc_roam(&npc, shard, at);
            }
        }
    }
    for ((x, y, z), (block, by)) in edits.drain() {
        store.save_edit(x, y, z, block, &by);
    }
    for (pid, (name, quests, tokens)) in scores.drain() {
        store.save_score(&pid, &name, quests, tokens);
    }
    for ((npc, shard), at) in roam.drain() {
        store.save_npc_roam(&npc, shard, at);
    }
}

fn main() {
    let mut addr = "127.0.0.1:8081".to_string();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--addr" => {
                if let Some(v) = args.next() {
                    addr = v;
                }
            }
            "--assets" => {
                let _ = args.next();
            }
            "--help" | "-h" => {
                println!("minecraft-server [--addr 127.0.0.1:8081]");
                return;
            }
            _ => {}
        }
    }

    let store = Arc::new(Store::new(db_url()));
    let mut ready = false;
    let db_disabled = std::env::var("NC_DB_DISABLE").ok().as_deref() == Some("1");
    for attempt in 1..=(if db_disabled { 0 } else { 30 }) {
        match store.init() {
            Ok(()) => {
                ready = true;
                eprintln!("[db] ready after {attempt} attempt(s)");
                break;
            }
            Err(e) => {
                eprintln!("[db] init attempt {attempt}: {e}");
                thread::sleep(Duration::from_millis(500));
            }
        }
    }
    if !ready {
        eprintln!("[db] unavailable; serving embedded assets until it returns");
    }

    let edits: HashMap<(i32, i32, i32), i32> = store.edits().into_iter().collect();
    let scores: HashMap<String, ScoreRow> = store
        .scores()
        .into_iter()
        .map(|s| (s.pid.clone(), s))
        .collect();
    let roam = if ready { store.npc_roam() } else { HashMap::new() };
    eprintln!(
        "[db] loaded {} edits, {} scores, {} roaming npc(s)",
        edits.len(),
        scores.len(),
        roam.len()
    );

    let (db_tx, db_rx) = mpsc::channel();
    let writer_store = store.clone();
    thread::spawn(move || db_writer(db_rx, writer_store));

    const SHARDS: usize = PLAY_SHARDS;
    let shards = Arc::new(Shards::new(SHARDS, 4096));
    let hub = Arc::new(Hub {
        next_id: AtomicU64::new(0),
        shards: shards.clone(),
        actors: Mutex::new(HashMap::new()),
        clients: Mutex::new(HashMap::new()),
        presence: Mutex::new(HashMap::new()),
        edits: Mutex::new(edits),
        chat: Mutex::new(VecDeque::new()),
        scores: Mutex::new(scores),
        store,
        db_tx,
        started: std::time::Instant::now(),
    });

    // One thread per NPC. The consistent hash gives each NPC an *ordering lane*
    // (`npc:<id>`) so its ticks stay serialised; it does not fence the entity
    // into that shard. The actor roams every play shard and maps each one.
    for npc in load_npcs(&roam) {
        let npc_id = npc.id.clone();
        let key = format!("npc:{npc_id}");
        let shard = shards.npc_shard(&npc_id);
        let snapshot = Arc::new(Mutex::new(npc_json(&npc)));
        let (tx, rx) = mpsc::channel();
        let actor_snapshot = snapshot.clone();
        let actor_db = hub.db_tx.clone();
        thread::Builder::new()
            .name(key.clone())
            .spawn(move || npc_actor(npc, rx, actor_snapshot, actor_db))
            .ok();
        hub.register_actor(key, tx, snapshot, ActorKind::Npc);
        eprintln!("[actor] npc {npc_id} -> lane {shard} (free roam, {PLAY_SHARDS} shards)");
    }

    // One consumer per shard. It never mutates state; it swaps the double ring
    // and routes each event to the owning actor thread.
    for shard in 0..SHARDS {
        let h = hub.clone();
        thread::Builder::new()
            .name(format!("shard-{shard}"))
            .spawn(move || loop {
                thread::sleep(Duration::from_millis(40));
                let rings = h.shards.clone();
                let mut route = |event| h.handle_event(shard, event);
                rings.drain(shard, &mut route);
            })
            .ok();
    }

    // The NPC ticker is a producer: it never touches NPC state, only enqueues.
    {
        let h = hub.clone();
        thread::spawn(move || loop {
            thread::sleep(Duration::from_millis(500));
            let ids: Vec<String> = {
                let g = h.actors.lock().unwrap();
                g.keys()
                    .filter(|k| k.starts_with("npc:"))
                    .map(|k| k[4..].to_string())
                    .collect()
            };
            for id in ids {
                h.shards.push_npc(&id, Event::NpcTick { id: id.clone(), dt: 0.5 });
            }
        });
    }

    // The broadcaster only reads actor snapshots; it never blocks a game loop.
    {
        let h = hub.clone();
        thread::spawn(move || loop {
            thread::sleep(Duration::from_millis(120));
            if h.players_count() > 0 {
                h.broadcast_state();
            }
        });
    }

    // MQTT v5 C2 bridge: map, NPC state and the level ledger.
    bridge::spawn(hub.clone());

    let listener = match TcpListener::bind(&addr) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[http] bind {addr}: {e}");
            std::process::exit(1);
        }
    };
    eprintln!("[http] nautilus-craft listening on http://{addr} (and ws://{addr}/ws)");
    for incoming in listener.incoming() {
        match incoming {
            Ok(stream) => {
                let hub = hub.clone();
                thread::spawn(move || handle_conn(stream, hub));
            }
            Err(e) => eprintln!("[http] accept: {e}"),
        }
    }
}
