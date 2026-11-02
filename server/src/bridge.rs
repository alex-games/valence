//! MQTT v5 C2 bridge for Nautilus Craft.
//!
//! The browser is the MQTT publisher/subscriber for player C2; this process is
//! the single writer for the shared map, the NPC state and the level ledger.
//!
//!   wa/v1/c2/torrance/map/block          client → bridge   (QoS 1)
//!   wa/v1/c2/torrance/map/state          bridge → clients  (retained)
//!   wa/v1/c2/torrance/npc/<id>/state     bridge → clients  (retained)
//!   wa/v1/c2/torrance/ledger/side/<n>    bridge → clients  (retained)
//!   wa/v1/c2/torrance/ledger/anchor      bridge → clients  (retained)
//!
//! Each block edit is appended to the sidechain of the consistent-hash shard
//! that owns its coordinates. Every ten seconds an anchor commits all four
//! sidechain tips to the level anchor chain (the CC-compatible `level.anchor`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rumqttc::v5::mqttbytes::v5::Packet;
use rumqttc::v5::mqttbytes::QoS;
use rumqttc::v5::{Client, Event, MqttOptions};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::Hub;

use std::io::{Read, Write};
use std::net::TcpStream;

use k256::elliptic_curve::sec1::ToEncodedPoint;
use k256::SecretKey;
use rand_core::OsRng;
use ripemd::Ripemd160;

/// A player account is a Bitcoin testnet wallet. The private key is written to
/// the VM's Vault (KV v2 at `secret/nautilus/players/<pid>`); only the address
/// is published and committed to the account sidechain.
#[derive(Clone)]
struct Account {
    pid: String,
    name: String,
    color: u8,
    quests: i32,
    tokens: i32,
    address: Option<String>,
    network: String,
    mmr: Mmr,
    root: String,
    events: u64,
    events_log: Vec<String>,
}

impl Account {
    fn new(pid: &str) -> Self {
        let mmr = Mmr::new();
        let root = hex(&mmr.bagged_root());
        Self {
            pid: pid.to_string(), name: "Traveler".into(), color: 0,
            quests: 0, tokens: 0, address: None, network: "testnet".into(),
            mmr, root, events: 0, events_log: Vec::new(),
        }
    }
    fn append(&mut self, event: &str) -> String {
        self.mmr.append(leaf_hash(event));
        self.events += 1;
        self.events_log.push(event.to_string());
        self.root = hex(&self.mmr.bagged_root());
        self.root.clone()
    }
}

struct Wallet {
    address: String,
    wif: String,
    private_hex: String,
}

fn base58check(payload: &[u8]) -> String {
    let mut v = payload.to_vec();
    let d1 = Sha256::digest(payload);
    let d2 = Sha256::digest(&d1);
    v.extend_from_slice(&d2[..4]);
    bs58::encode(v).into_string()
}

fn make_wallet() -> Option<Wallet> {
    let secret = SecretKey::random(&mut OsRng);
    let public = secret.public_key().to_encoded_point(true);
    let mut sha = Sha256::new();
    sha.update(public.as_bytes());
    let digest = sha.finalize();
    let mut rip = Ripemd160::new();
    rip.update(&digest);
    let h160 = rip.finalize();
    let mut p2pkh = vec![0x6f]; // testnet P2PKH
    p2pkh.extend_from_slice(&h160);
    let address = base58check(&p2pkh);
    let private = secret.to_bytes();
    let mut wif_payload = vec![0xef]; // testnet WIF
    wif_payload.extend_from_slice(&private);
    wif_payload.push(0x01); // compressed public key
    let wif = base58check(&wif_payload);
    Some(Wallet { address, wif, private_hex: hex(&private) })
}

fn vault_store(pid: &str, wallet: &Wallet) -> bool {
    let base = std::env::var("NC_VAULT").unwrap_or_else(|_| "http://127.0.0.1:8200".into());
    let token = std::env::var("NC_VAULT_TOKEN").unwrap_or_else(|_| "nautilus-dev".into());
    let addr = base.trim_start_matches("http://").trim_start_matches("https://").trim_end_matches('/');
    let body = json!({
        "data": {
            "pid": pid,
            "address": wallet.address,
            "wif": wallet.wif,
            "private_key_hex": wallet.private_hex,
            "network": "testnet",
            "created_at": now()
        }
    })
    .to_string();
    let path = format!("/v1/secret/data/nautilus/players/{pid}");
    http_json(addr, "POST", &path, &token, &body).is_some()
}

fn http_json(addr: &str, method: &str, path: &str, token: &str, body: &str) -> Option<String> {
    let host = addr.split(':').next().unwrap_or("127.0.0.1");
    let mut stream = TcpStream::connect(addr).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(3))).ok();
    stream.set_write_timeout(Some(Duration::from_secs(3))).ok();
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {host}\r\nX-Vault-Token: {token}\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).ok()?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response).ok()?;
    let text = String::from_utf8_lossy(&response).to_string();
    if text.starts_with("HTTP/1.1 2") {
        Some(text)
    } else {
        eprintln!("[vault] {}", text.lines().next().unwrap_or("no response"));
        None
    }
}


const BASE: &str = "wa/v1/c2/torrance";
const MAP_SHARDS: usize = 4;
const SIDECHAINS: usize = 4;
const GENESIS: &str = "0000000000000000000000000000000000000000000000000000000000000000";

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn hex(bytes: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(H[(b >> 4) as usize] as char);
        s.push(H[(b & 15) as usize] as char);
    }
    s
}

fn hash(s: &str) -> String {
    hex(&Sha256::digest(s.as_bytes()))
}

fn node_hash(a: [u8; 32], b: [u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(a);
    h.update(b);
    let mut out = [0u8; 32];
    out.copy_from_slice(&h.finalize());
    out
}

fn leaf_hash(event: &str) -> [u8; 32] {
    let d = Sha256::digest(event.as_bytes());
    let mut out = [0u8; 32];
    out.copy_from_slice(&d);
    out
}

/// An append-only Merkle Mountain Range. The bagged root hashes the peaks
/// high-to-low, starting from SHA256("mmr"), so a player's account history is
/// one bagged MMR and the anchor commits its root.
#[derive(Clone)]
struct Mmr {
    peaks: Vec<Option<[u8; 32]>>,
    size: u64,
}

impl Mmr {
    fn new() -> Self { Self { peaks: Vec::new(), size: 0 } }
    fn append(&mut self, leaf: [u8; 32]) {
        let mut node = leaf;
        let mut level = 0;
        while level < self.peaks.len() && self.peaks[level].is_some() {
            let left = self.peaks[level].take().unwrap();
            node = node_hash(left, node);
            level += 1;
        }
        if level == self.peaks.len() { self.peaks.push(Some(node)); } else { self.peaks[level] = Some(node); }
        self.size += 1;
    }
    fn bagged_root(&self) -> [u8; 32] {
        let d = Sha256::digest(b"mmr");
        let mut acc = [0u8; 32];
        acc.copy_from_slice(&d);
        for peak in self.peaks.iter().rev().flatten() {
            acc = node_hash(acc, *peak);
        }
        acc
    }
}

#[derive(Clone)]
struct SideTip {
    height: u64,
    hash: String,
    root: String,
}

fn edit_hash(x: i32, y: i32, z: i32, id: i32) -> [u8; 32] {
    let d = Sha256::digest(format!("{x},{y},{z},{id}").as_bytes());
    let mut out = [0u8; 32];
    out.copy_from_slice(&d);
    out
}

fn merkle_root(edits: &[(i32, i32, i32, i32)]) -> String {
    let mut level: Vec<[u8; 32]> = edits.iter().map(|&(x, y, z, id)| edit_hash(x, y, z, id)).collect();
    if level.is_empty() {
        return hash("empty");
    }
    while level.len() > 1 {
        let mut next = Vec::with_capacity((level.len() + 1) / 2);
        for pair in level.chunks(2) {
            let a = pair[0];
            let b = if pair.len() > 1 { pair[1] } else { pair[0] };
            let mut h = Sha256::new();
            h.update(a);
            h.update(b);
            let mut out = [0u8; 32];
            out.copy_from_slice(&h.finalize());
            next.push(out);
        }
        level = next;
    }
    hex(&level[0])
}

fn merkle_root_hashes(hashes: &[String]) -> String {
    let mut level: Vec<[u8; 32]> = hashes.iter().filter_map(|h| {
        if h.len() != 64 { return None; }
        let mut out = [0u8; 32];
        for i in 0..32 {
            out[i] = u8::from_str_radix(&h[i * 2..i * 2 + 2], 16).ok()?;
        }
        Some(out)
    }).collect();
    if level.is_empty() { return hash("empty"); }
    while level.len() > 1 {
        let mut next = Vec::with_capacity((level.len() + 1) / 2);
        for pair in level.chunks(2) {
            let a = pair[0];
            let b = if pair.len() > 1 { pair[1] } else { pair[0] };
            let mut h = Sha256::new();
            h.update(a);
            h.update(b);
            let mut out = [0u8; 32];
            out.copy_from_slice(&h.finalize());
            next.push(out);
        }
        level = next;
    }
    hex(&level[0])
}

struct LevelLedger {
    tips: Vec<SideTip>,
    mmrs: Vec<Mmr>,
    mmr_events: Vec<Vec<String>>,
    dirty: Vec<bool>,
    anchor: Option<Value>,
    last_roots: String,
    revision: u64,
}

impl LevelLedger {
    fn new() -> Self {
        Self {
            tips: (0..SIDECHAINS).map(|_| SideTip { height: 0, hash: GENESIS.into(), root: hash("genesis") }).collect(),
            mmrs: (0..SIDECHAINS).map(|_| Mmr::new()).collect(),
            mmr_events: (0..SIDECHAINS).map(|_| Vec::new()).collect(),
            dirty: vec![false; SIDECHAINS],
            anchor: None,
            last_roots: String::new(),
            revision: 0,
        }
    }

    fn load(hub: &Arc<Hub>) -> Self {
        let mut ledger = Self::new();
        for (shard, height, tip_hash, root) in hub.store.latest_sides() {
            if shard >= 0 && (shard as usize) < SIDECHAINS {
                ledger.tips[shard as usize] = SideTip { height: height as u64, hash: tip_hash, root };
            }
        }
        if let Some((height, anchor_hash, parent, roots, at)) = hub.store.latest_anchor() {
            let roots_value: Value = serde_json::from_str(&roots).unwrap_or_else(|_| json!([]));
            ledger.anchor = Some(json!({
                "v": 1, "kind": "level.anchor", "level": "torrance",
                "height": height, "hash": anchor_hash, "parent": parent,
                "roots": roots_value, "at": at
            }));
            ledger.last_roots = roots;
        }
        ledger
    }

    /// Append one event to the local sidechain that owns the shard. The
    /// sidechain is a bagged MMR; its root is what the anchor commits.
    fn record(&mut self, shard: usize, event: &str) {
        if shard < self.mmrs.len() {
            self.mmrs[shard].append(leaf_hash(event));
            self.mmr_events[shard].push(event.to_string());
            self.dirty[shard] = true;
        }
    }

    fn record_account(&mut self, shard: usize, pid: &str, root: &str, events: u64) {
        self.record(shard, &format!("account|{pid}|{root}|{events}"));
    }

    fn flush(&mut self, at: i64) -> Vec<(usize, Value)> {
        let mut out = Vec::new();
        for shard in 0..self.tips.len() {
            if !self.dirty[shard] {
                continue;
            }
            self.dirty[shard] = false;
            let root = hex(&self.mmrs[shard].bagged_root());
            let count = self.mmrs[shard].size as usize;
            let parent = self.tips[shard].hash.clone();
            let height = self.tips[shard].height + 1;
            let block_hash = hash(&format!("{height}|{parent}|{root}|{count}|{at}"));
            self.tips[shard] = SideTip { height, hash: block_hash.clone(), root: root.clone() };
            self.revision += count as u64;
            out.push((shard, json!({
                "shard": shard, "height": height, "hash": block_hash, "parent": parent,
                "root": root, "edits": count, "at": at,
                "leaves": self.mmr_events[shard]
            })));
        }
        out
    }

    fn anchor(&mut self, at: i64) -> Option<Value> {
        let roots: Vec<Value> = self.tips.iter().enumerate().map(|(shard, tip)| json!({
            "shard": shard, "height": tip.height, "hash": tip.hash, "root": tip.root
        })).collect();
        let roots_json = serde_json::to_string(&roots).ok()?;
        if self.anchor.is_some() && roots_json == self.last_roots {
            return None;
        }
        let parent = self.anchor.as_ref()
            .and_then(|a| a.get("hash")).and_then(|v| v.as_str()).unwrap_or(GENESIS).to_string();
        let height = self.anchor.as_ref()
            .and_then(|a| a.get("height")).and_then(|v| v.as_u64()).unwrap_or(0) + 1;
        let anchor_hash = hash(&format!("{height}|{parent}|{roots_json}|{at}"));
        let value = json!({
            "v": 1, "kind": "level.anchor", "level": "torrance",
            "height": height, "hash": anchor_hash, "parent": parent,
            "roots": roots, "at": at
        });
        self.anchor = Some(value.clone());
        self.last_roots = roots_json;
        Some(value)
    }
}

fn map_state(hub: &Hub, ledger: &Mutex<LevelLedger>, at: i64) -> Value {
    let (edits, anchor, revision) = {
        let g = ledger.lock().unwrap();
        let edits: Vec<Value> = {
            let e = hub.edits.lock().unwrap();
            e.iter().map(|((x, y, z), id)| json!([x, y, z, id])).collect()
        };
        (edits, g.anchor.clone(), g.revision)
    };
    json!({
        "v": 1, "revision": revision, "edits": edits, "anchor": anchor, "at": at
    })
}

fn publish_map(client: &Client, hub: &Hub, ledger: &Mutex<LevelLedger>) {
    let value = map_state(hub, ledger, now());
    if let Ok(body) = serde_json::to_string(&value) {
        let _ = client.publish(format!("{BASE}/map/state"), QoS::AtLeastOnce, true, body.into_bytes());
    }
}

fn publish_npcs(client: &Client, hub: &Hub) {
    for npc in hub.npcs_snapshot() {
        if let Some(id) = npc.get("id").and_then(|v| v.as_str()) {
            if let Ok(body) = serde_json::to_string(&npc) {
                let _ = client.publish(format!("{BASE}/npc/{id}/state"), QoS::AtLeastOnce, true, body.into_bytes());
            }
        }
    }
}

fn publish_account(client: &Client, account: &Account, shard: usize) {
    let body = json!({
        "pid": account.pid, "name": account.name, "color": account.color,
        "address": account.address, "network": account.network,
        "quests": account.quests, "tokens": account.tokens,
        "mmrRoot": account.root, "mmrEvents": account.events,
        "shard": shard, "events": account.events_log
    }).to_string();
    let _ = client.publish(
        format!("{BASE}/player/{}/account", account.pid),
        QoS::AtLeastOnce, true, body.into_bytes(),
    );
}

fn load_accounts(hub: &Arc<Hub>) -> HashMap<String, Account> {
    let mut accounts: HashMap<String, Account> = HashMap::new();
    for (pid, name, color, quests, tokens, address, network, root, events) in hub.store.accounts() {
        let mut account = Account::new(&pid);
        account.name = name;
        account.color = color.clamp(0, 7) as u8;
        account.quests = quests;
        account.tokens = tokens;
        account.address = address;
        account.network = network;
        account.root = root;
        account.events = events.max(0) as u64;
        accounts.insert(pid, account);
    }
    for (pid, _seq, _leaf, event) in hub.store.account_events() {
        if let Some(account) = accounts.get_mut(&pid) {
            account.mmr.append(leaf_hash(&event));
            account.events_log.push(event);
        }
    }
    for account in accounts.values_mut() {
        account.root = hex(&account.mmr.bagged_root());
        account.events = account.mmr.size;
    }
    accounts
}

fn handle_publish(client: &Client, hub: &Arc<Hub>, ledger: &Mutex<LevelLedger>, accounts: &Arc<Mutex<HashMap<String, Account>>>, dirty: &AtomicBool, packet: &rumqttc::v5::mqttbytes::v5::Publish) {
    let topic = String::from_utf8_lossy(&packet.topic).to_string();
    let payload = String::from_utf8_lossy(&packet.payload).to_string();
    if topic == format!("{BASE}/map/block") {
        let value: Value = match serde_json::from_str(&payload) {
            Ok(v) => v,
            Err(_) => return,
        };
        let x = value.get("x").and_then(|v| v.as_i64()).unwrap_or(-1) as i32;
        let y = value.get("y").and_then(|v| v.as_i64()).unwrap_or(-1) as i32;
        let z = value.get("z").and_then(|v| v.as_i64()).unwrap_or(-1) as i32;
        let id = value.get("id").and_then(|v| v.as_i64()).unwrap_or(-1) as i32;
        let by = value.get("by").and_then(|v| v.as_str()).unwrap_or("?").to_string();
        if x < 0 || x >= 96 || y < 0 || y >= 48 || z < 0 || z >= 96 || id < 0 || id > 64 {
            return;
        }
        hub.edits.lock().unwrap().insert((x, y, z), id);
        hub.store.save_edit(x, y, z, id, &by);
        let shard = hub.shards.hash.shard_for(&format!("block:{x}:{z}"));
        ledger.lock().unwrap().record(shard, &format!("map|{x}|{y}|{z}|{id}|{by}"));
        dirty.store(true, Ordering::Relaxed);
        return;
    }
    if topic.starts_with(BASE) && topic.ends_with("/score") {
        let parts: Vec<&str> = topic.split('/').collect();
        if parts.len() >= 7 {
            let pid = parts[5].to_string();
            let value: Value = match serde_json::from_str(&payload) {
                Ok(v) => v,
                Err(_) => return,
            };
            let quests = value.get("quests").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let tokens = value.get("tokens").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let (root, events, event, snapshot) = {
                let mut book = accounts.lock().unwrap();
                let account = book.entry(pid.clone()).or_insert_with(|| Account::new(&pid));
                account.quests = quests.clamp(0, 99);
                account.tokens = tokens.clamp(0, 99);
                let event = format!(
                    "score|{pid}|{}|{}|{}",
                    account.quests, account.tokens,
                    account.address.clone().unwrap_or_default()
                );
                let root = account.append(&event);
                let events = account.events;
                (root, events, event, account.clone())
            };
            let shard = hub.shards.hash.shard_for(&format!("player:{pid}"));
            ledger.lock().unwrap().record_account(shard, &pid, &root, events);
            publish_account(client, &snapshot, shard);
            hub.store.save_account(
                &pid, &snapshot.name, snapshot.color as i32, snapshot.quests, snapshot.tokens,
                snapshot.address.as_deref(), &snapshot.network, &snapshot.root, snapshot.events as i64,
            );
            hub.store.save_account_event(&pid, events as i64, &hex(&leaf_hash(&event)), &event, now());
            hub.store.save_score(&pid, &snapshot.name, snapshot.quests, snapshot.tokens);
            hub.upsert_score(&pid, &snapshot.name, snapshot.quests, snapshot.tokens);
        }
        return;
    }
    if topic.starts_with(BASE) && topic.ends_with("/presence") {
        let parts: Vec<&str> = topic.split('/').collect();
        if parts.len() >= 7 {
            let pid = parts[5].to_string();
            if payload.is_empty() {
                hub.presence.lock().unwrap().remove(&pid);
                return;
            }
            let value: Value = match serde_json::from_str(&payload) {
                Ok(v) => v,
                Err(_) => return,
            };
            let name = value.get("name").and_then(|v| v.as_str()).unwrap_or("Traveler").to_string();
            let color = value.get("color").and_then(|v| v.as_u64()).unwrap_or(0) as u8 % 8;
            let snapshot = {
                let mut book = accounts.lock().unwrap();
                let account = book.entry(pid.clone()).or_insert_with(|| Account::new(&pid));
                account.name = name.clone();
                account.color = color;
                if account.address.is_none() {
                    if let Some(wallet) = make_wallet() {
                        if vault_store(&pid, &wallet) {
                            account.address = Some(wallet.address.clone());
                            eprintln!("[vault] wallet {pid} {}", wallet.address);
                        }
                    }
                }
                let event = format!(
                    "presence|{pid}|{}|{}|{}|{}|{}",
                    account.name, account.color, account.quests, account.tokens,
                    account.address.clone().unwrap_or_default()
                );
                let root = account.append(&event);
                let events = account.events;
                let snapshot = account.clone();
                (root, events, event, snapshot)
            };
            let (root, events, event, snapshot) = snapshot;
            hub.presence.lock().unwrap().insert(pid.clone(), snapshot.name.clone());
            let shard = hub.shards.hash.shard_for(&format!("player:{pid}"));
            ledger.lock().unwrap().record_account(shard, &pid, &root, events);
            hub.store.save_account(
                &pid, &snapshot.name, snapshot.color as i32, snapshot.quests, snapshot.tokens,
                snapshot.address.as_deref(), &snapshot.network, &snapshot.root, snapshot.events as i64,
            );
            hub.store.save_account_event(&pid, events as i64, &hex(&leaf_hash(&event)), &event, now());
            hub.upsert_score(&pid, &snapshot.name, snapshot.quests, snapshot.tokens);
            publish_account(client, &snapshot, shard);
        }
        return;
    }
}

fn publisher(client: Client, hub: Arc<Hub>, ledger: Arc<Mutex<LevelLedger>>, dirty: Arc<AtomicBool>, stop: Arc<AtomicBool>) {
    let mut last_side = std::time::Instant::now();
    let mut last_anchor = std::time::Instant::now() - Duration::from_secs(60);
    let mut last_map = std::time::Instant::now() - Duration::from_secs(60);
    while !stop.load(Ordering::Relaxed) {
        thread::sleep(Duration::from_millis(500));
        publish_npcs(&client, &hub);
        if dirty.swap(false, Ordering::Relaxed) || last_map.elapsed() > Duration::from_secs(3) {
            publish_map(&client, &hub, &ledger);
            last_map = std::time::Instant::now();
        }
        if last_side.elapsed() > Duration::from_secs(2) {
            let at = now();
            let flushed = { ledger.lock().unwrap().flush(at) };
            for (shard, value) in flushed {
                if let Ok(body) = serde_json::to_string(&value) {
                    let _ = client.publish(format!("{BASE}/ledger/side/{shard}"), QoS::AtLeastOnce, true, body.into_bytes());
                }
                if let (Some(h), Some(hash), Some(parent), Some(root), Some(edits)) = (
                    value.get("height").and_then(|v| v.as_i64()),
                    value.get("hash").and_then(|v| v.as_str()),
                    value.get("parent").and_then(|v| v.as_str()),
                    value.get("root").and_then(|v| v.as_str()),
                    value.get("edits").and_then(|v| v.as_i64()),
                ) {
                    hub.store.save_side(shard as i32, h, hash, parent, root, edits as i32, at);
                }
            }
            last_side = std::time::Instant::now();
        }
        if last_anchor.elapsed() > Duration::from_secs(10) {
            let at = now();
            let value = { ledger.lock().unwrap().anchor(at) };
            if let Some(value) = value {
                if let Ok(body) = serde_json::to_string(&value) {
                    let _ = client.publish(format!("{BASE}/ledger/anchor"), QoS::AtLeastOnce, true, body.into_bytes());
                }
                if let (Some(h), Some(hash), Some(parent), Some(roots)) = (
                    value.get("height").and_then(|v| v.as_i64()),
                    value.get("hash").and_then(|v| v.as_str()),
                    value.get("parent").and_then(|v| v.as_str()),
                    value.get("roots"),
                ) {
                    if let Ok(roots_json) = serde_json::to_string(roots) {
                        hub.store.save_anchor(h, hash, parent, &roots_json, at);
                    }
                }
            }
            last_anchor = std::time::Instant::now();
        }
    }
}

fn run(hub: Arc<Hub>, ledger: Arc<Mutex<LevelLedger>>, accounts: Arc<Mutex<HashMap<String, Account>>>, dirty: Arc<AtomicBool>) -> Result<(), String> {
    let host = std::env::var("NC_MQTT_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port: u16 = std::env::var("NC_MQTT_PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(1883);
    let mut options = MqttOptions::new("nautilus-bridge", host, port);
    options.set_keep_alive(Duration::from_secs(20));
    let (client, mut connection) = Client::new(options, 64);
    let stop = Arc::new(AtomicBool::new(false));
    {
        let client = client.clone();
        let hub = hub.clone();
        let ledger = ledger.clone();
        let dirty = dirty.clone();
        let stop = stop.clone();
        thread::Builder::new()
            .name("mqtt-publisher".into())
            .spawn(move || publisher(client, hub, ledger, dirty, stop))
            .ok();
    }

    for event in connection.iter() {
        match event {
            Ok(Event::Incoming(Packet::ConnAck(_))) => {
                for filter in [
                    format!("{BASE}/map/block"),
                    format!("{BASE}/player/+/score"),
                    format!("{BASE}/player/+/presence"),
                ] {
                    if let Err(e) = client.subscribe(&filter, QoS::AtLeastOnce) {
                        eprintln!("[mqtt] subscribe {filter}: {e}");
                    }
                }
                eprintln!("[mqtt] connected to {}:{}", std::env::var("NC_MQTT_HOST").unwrap_or_else(|_| "127.0.0.1".into()), std::env::var("NC_MQTT_PORT").unwrap_or_else(|_| "1883".into()));
                publish_map(&client, &hub, &ledger);
                publish_npcs(&client, &hub);
            }
            Ok(Event::Incoming(Packet::Publish(p))) => {
                handle_publish(&client, &hub, &ledger, &accounts, &dirty, &p);
            }
            Ok(_) => {}
            Err(e) => {
                eprintln!("[mqtt] {e}");
                break;
            }
        }
    }
    stop.store(true, Ordering::Relaxed);
    Err("mqtt connection closed".into())
}

pub fn spawn(hub: Arc<Hub>) {
    let accounts = Arc::new(Mutex::new(load_accounts(&hub)));
    let ledger = Arc::new(Mutex::new(LevelLedger::load(&hub)));
    let dirty = Arc::new(AtomicBool::new(true));
    thread::Builder::new()
        .name("mqtt-bridge".into())
        .spawn(move || loop {
            if let Err(e) = run(hub.clone(), ledger.clone(), accounts.clone(), dirty.clone()) {
                eprintln!("[mqtt] {e}; retrying");
            }
            thread::sleep(Duration::from_secs(3));
        })
        .ok();
}
