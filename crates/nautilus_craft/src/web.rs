//! The WebView origin.
//!
//! The mobile UI/UX is a `WKWebView`, not a native voxel client. This module is
//! the same page the phone already ships, served by the Valence process so the
//! WebView and the Minecraft server share one `world.json`, one quest board and
//! one assistant. It is deliberately a small HTTP/1.1 server with no framework:
//! the VM is memory-capped, and a page plus four endpoints does not need one.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};

use serde_json::json;

use crate::ai::Assistant;
use crate::world::Level;

const INDEX: &[u8] = include_bytes!("../../../web/dist/index.html");
const MAP: &[u8] = include_bytes!("../../../web/dist/torrance-map.svg");
const README: &[u8] = include_bytes!("../../../web/dist/README.txt");
const CREDITS: &[u8] = include_bytes!("../../../web/dist/CREDITS.txt");
const BIRDS: &[u8] = include_bytes!("../../../web/assets/audio/birds.mp3");

const MAX_BODY: usize = 16 * 1024;

pub fn spawn(addr: String, ai: Arc<Mutex<Assistant>>, level: Level) {
    std::thread::Builder::new()
        .name("nautilus-web".into())
        .spawn(move || {
            let listener = match TcpListener::bind(&addr) {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("[web] bind {addr}: {e}");
                    return;
                }
            };
            eprintln!("[web] WebView origin on http://{addr}");
            for incoming in listener.incoming() {
                match incoming {
                    Ok(stream) => {
                        let ai = ai.clone();
                        let level = level.clone();
                        std::thread::spawn(move || handle(stream, ai, level));
                    }
                    Err(e) => eprintln!("[web] accept: {e}"),
                }
            }
        })
        .ok();
}

fn parse_escrow_auth(value: &serde_json::Value, op: &str) -> crate::ai::EscrowAuth {
    fn text(value: &serde_json::Value, key: &str) -> String {
        value
            .get(key)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_owned()
    }
    crate::ai::EscrowAuth {
        op: op.to_owned(),
        id: text(value, "id"),
        source: text(value, "source"),
        dest: text(value, "dest"),
        from: text(value, "from"),
        to: text(value, "to"),
        amount: value.get("amount").and_then(|v| v.as_i64()).unwrap_or(0),
        expires_at: value
            .get("expires_at")
            .and_then(|v| v.as_i64())
            .unwrap_or(0),
        nonce: text(value, "nonce"),
        sig: text(value, "sig"),
    }
}

fn escrow_error_status(error: &str) -> &'static str {
    if error.contains("signature")
        || error.contains("coordinator")
        || error.contains("expired")
        || error.contains("operation")
    {
        "401 Unauthorized"
    } else {
        "400 Bad Request"
    }
}

fn handle(mut stream: TcpStream, ai: Arc<Mutex<Assistant>>, level: Level) {
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(15)))
        .ok();
    let mut buf = Vec::new();
    let mut temp = [0u8; 4096];
    let header_end = loop {
        match stream.read(&mut temp) {
            Ok(0) => return,
            Ok(n) => {
                buf.extend_from_slice(&temp[..n]);
                if let Some(pos) = find(&buf, b"\r\n\r\n") {
                    break pos + 4;
                }
                if buf.len() > MAX_BODY + 8192 {
                    return;
                }
            }
            Err(_) => return,
        }
    };

    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let mut lines = head.split("\r\n");
    let request = lines.next().unwrap_or("");
    let mut parts = request.split_whitespace();
    let method = parts.next().unwrap_or("GET");
    let raw_path = parts.next().unwrap_or("/");
    let path = raw_path.split('?').next().unwrap_or("/");
    let query = raw_path.split_once('?').map(|(_, q)| q).unwrap_or("");
    let head_only = method == "HEAD";

    let mut content_length = 0usize;
    for line in lines {
        if let Some((key, value)) = line.split_once(':') {
            if key.eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse().unwrap_or(0);
            }
        }
    }
    let mut body = buf[header_end..].to_vec();
    while body.len() < content_length {
        match stream.read(&mut temp) {
            Ok(0) => break,
            Ok(n) => body.extend_from_slice(&temp[..n]),
            Err(_) => break,
        }
    }

    let cors = "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: content-type\r\n";

    match (method, path) {
        ("GET" | "HEAD", "/") | ("GET" | "HEAD", "/index.html") | ("GET" | "HEAD", "/embed/") => {
            let world = serde_json::to_string(&level).unwrap_or_else(|_| "{}".into());
            let page = inject_world(INDEX, &world);
            write_response(
                &mut stream,
                "200 OK",
                "text/html; charset=utf-8",
                &page,
                cors,
                head_only,
            );
        }
        ("GET" | "HEAD", "/healthz") => {
            let (paused, players) = {
                let ai = ai.lock().expect("assistant mutex");
                (ai.paused(), 0)
            };
            let payload = json!({
                "status": "ok",
                "game": "nautilus-craft",
                "engine": "valence",
                "level": level.slug.clone(),
                "minecraft": format!("{}:25565", std::env::var("NAUTILUS_MC_HOST").unwrap_or_else(|_| "127.0.0.1".into())),
                "ai": if paused { "paused" } else { "ready" },
                "players": players,
                "quests": level.quests.len(),
                "tokens": level.tokens.len()
            })
            .to_string();
            write_response(
                &mut stream,
                "200 OK",
                "application/json",
                payload.as_bytes(),
                cors,
                head_only,
            );
        }
        ("GET" | "HEAD", "/api/world") => {
            let payload = serde_json::to_string(&level).unwrap_or_else(|_| "{}".into());
            write_response(
                &mut stream,
                "200 OK",
                "application/json",
                payload.as_bytes(),
                cors,
                head_only,
            );
        }
        ("GET" | "HEAD", "/api/quests") => {
            let payload = serde_json::to_string(&level.quests).unwrap_or_else(|_| "[]".into());
            write_response(
                &mut stream,
                "200 OK",
                "application/json",
                payload.as_bytes(),
                cors,
                head_only,
            );
        }
        ("GET" | "HEAD", "/api/npcs") => {
            let payload = serde_json::to_string(&level.npcs).unwrap_or_else(|_| "[]".into());
            write_response(
                &mut stream,
                "200 OK",
                "application/json",
                payload.as_bytes(),
                cors,
                head_only,
            );
        }
        ("GET" | "HEAD", "/api/briefing") => {
            let player = query_value(query, "player").unwrap_or_else(|| "webview".into());
            let pos = parse_pos(query);
            let text = ai
                .lock()
                .expect("assistant mutex")
                .briefing_if_due(&player, pos);
            let payload = json!({ "briefing": text }).to_string();
            write_response(
                &mut stream,
                "200 OK",
                "application/json",
                payload.as_bytes(),
                cors,
                head_only,
            );
        }
        ("GET" | "HEAD", "/api/progress") => {
            let player = query_value(query, "player").unwrap_or_else(|| "webview".into());
            let pos = parse_pos(query);
            let progress = ai.lock().expect("assistant mutex").progress(&player, pos);
            let payload = json!({ "progress": progress }).to_string();
            write_response(
                &mut stream,
                "200 OK",
                "application/json",
                payload.as_bytes(),
                cors,
                head_only,
            );
        }
        ("GET" | "HEAD", "/api/outbox") => {
            let limit = query_value(query, "limit")
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(50);
            match crate::sidechain::read_outbox(limit) {
                Ok(rows) => {
                    let payload = json!({ "rows": rows }).to_string();
                    write_response(
                        &mut stream,
                        "200 OK",
                        "application/json",
                        payload.as_bytes(),
                        cors,
                        head_only,
                    );
                }
                Err(e) => {
                    let payload = json!({ "error": e }).to_string();
                    write_response(
                        &mut stream,
                        "503 Service Unavailable",
                        "application/json",
                        payload.as_bytes(),
                        cors,
                        head_only,
                    );
                }
            }
        }
        ("POST", "/api/outbox/ack") => {
            let text = String::from_utf8_lossy(&body);
            let value: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
            let seqs: Vec<i64> = value
                .get("seqs")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|v| v.as_i64()).collect())
                .unwrap_or_default();
            match crate::sidechain::ack_outbox(&seqs) {
                Ok(acked) => {
                    let payload = json!({ "acked": acked }).to_string();
                    write_response(
                        &mut stream,
                        "200 OK",
                        "application/json",
                        payload.as_bytes(),
                        cors,
                        head_only,
                    );
                }
                Err(e) => {
                    let payload = json!({ "error": e }).to_string();
                    write_response(
                        &mut stream,
                        "503 Service Unavailable",
                        "application/json",
                        payload.as_bytes(),
                        cors,
                        head_only,
                    );
                }
            }
        }
        ("POST", "/api/outbox/replay") => {
            let text = String::from_utf8_lossy(&body);
            let value: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
            let seqs: Vec<i64> = value
                .get("seqs")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|v| v.as_i64()).collect())
                .unwrap_or_default();
            match crate::sidechain::replay_outbox(&seqs) {
                Ok(replayed) => {
                    let payload = json!({ "replayed": replayed }).to_string();
                    write_response(
                        &mut stream,
                        "200 OK",
                        "application/json",
                        payload.as_bytes(),
                        cors,
                        head_only,
                    );
                }
                Err(e) => {
                    let payload = json!({ "error": e }).to_string();
                    write_response(
                        &mut stream,
                        "503 Service Unavailable",
                        "application/json",
                        payload.as_bytes(),
                        cors,
                        head_only,
                    );
                }
            }
        }
        ("GET" | "HEAD", "/api/escrow/list") => {
            let rows = ai.lock().expect("assistant mutex").escrow_list();
            let payload = json!({ "escrows": rows }).to_string();
            write_response(
                &mut stream,
                "200 OK",
                "application/json",
                payload.as_bytes(),
                cors,
                head_only,
            );
        }
        ("POST", "/api/escrow/open") => {
            let text = String::from_utf8_lossy(&body);
            let value: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
            let from = value.get("from").and_then(|v| v.as_str()).unwrap_or("");
            let to = value.get("to").and_then(|v| v.as_str()).unwrap_or("");
            let amount = value.get("amount").and_then(|v| v.as_i64()).unwrap_or(0);
            let result = ai
                .lock()
                .expect("assistant mutex")
                .escrow_open(from, to, amount);
            let (status, payload) = match result {
                Ok(escrow) => ("200 OK", json!({ "escrow": escrow }).to_string()),
                Err(error) => ("400 Bad Request", json!({ "error": error }).to_string()),
            };
            write_response(
                &mut stream,
                status,
                "application/json",
                payload.as_bytes(),
                cors,
                head_only,
            );
        }
        ("POST", "/api/escrow/commit") | ("POST", "/api/escrow/cancel") => {
            let text = String::from_utf8_lossy(&body);
            let value: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
            let id = value.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let mut assistant = ai.lock().expect("assistant mutex");
            let result = if path.ends_with("commit") {
                assistant.escrow_commit(id)
            } else {
                assistant.escrow_cancel(id)
            };
            let (status, payload) = match result {
                Ok(escrow) => ("200 OK", json!({ "escrow": escrow }).to_string()),
                Err(error) => ("400 Bad Request", json!({ "error": error }).to_string()),
            };
            write_response(
                &mut stream,
                status,
                "application/json",
                payload.as_bytes(),
                cors,
                head_only,
            );
        }
        ("POST", "/api/escrow/settle") => {
            let text = String::from_utf8_lossy(&body);
            let value: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
            let auth = parse_escrow_auth(&value, "settle");
            let result = ai.lock().expect("assistant mutex").escrow_settle(&auth);
            let (status, payload) = match result {
                Ok(escrow) => ("200 OK", json!({ "escrow": escrow }).to_string()),
                Err(error) => (
                    escrow_error_status(&error),
                    json!({ "error": error }).to_string(),
                ),
            };
            write_response(
                &mut stream,
                status,
                "application/json",
                payload.as_bytes(),
                cors,
                head_only,
            );
        }
        ("POST", "/api/escrow/deposit") => {
            let text = String::from_utf8_lossy(&body);
            let value: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
            let auth = parse_escrow_auth(&value, "deposit");
            let result = ai.lock().expect("assistant mutex").escrow_deposit(&auth);
            let (status, payload) = match result {
                Ok(deposit) => ("200 OK", json!({ "deposit": deposit }).to_string()),
                Err(error) => (
                    escrow_error_status(&error),
                    json!({ "error": error }).to_string(),
                ),
            };
            write_response(
                &mut stream,
                status,
                "application/json",
                payload.as_bytes(),
                cors,
                head_only,
            );
        }
        ("POST", "/api/assistant") => {
            let text = String::from_utf8_lossy(&body);
            let value: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
            let player = value
                .get("player")
                .and_then(|v| v.as_str())
                .filter(|v| !v.is_empty())
                .unwrap_or("webview")
                .to_owned();
            let text = value
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_owned();
            let pos = value.get("pos").and_then(|v| v.as_array()).and_then(|a| {
                Some([
                    a.first()?.as_f64()?,
                    a.get(1)?.as_f64()?,
                    a.get(2)?.as_f64()?,
                ])
            });
            let reply = ai
                .lock()
                .expect("assistant mutex")
                .handle(&player, &text, pos);
            let payload = serde_json::to_string(&reply).unwrap_or_else(|_| "{}".into());
            write_response(
                &mut stream,
                "200 OK",
                "application/json",
                payload.as_bytes(),
                cors,
                head_only,
            );
        }
        ("OPTIONS", _) => {
            let headers = format!("{cors}Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n");
            write_response(
                &mut stream,
                "204 No Content",
                "text/plain",
                b"",
                &headers,
                head_only,
            );
        }
        ("GET" | "HEAD", "/assets/audio/birds.mp3") | ("GET" | "HEAD", "/audio/birds.mp3") => {
            write_response(&mut stream, "200 OK", "audio/mpeg", BIRDS, cors, head_only);
        }
        ("GET" | "HEAD", "/torrance-map.svg") => {
            write_response(&mut stream, "200 OK", "image/svg+xml", MAP, cors, head_only);
        }
        ("GET" | "HEAD", "/README.txt") => {
            write_response(
                &mut stream,
                "200 OK",
                "text/plain; charset=utf-8",
                README,
                cors,
                head_only,
            );
        }
        ("GET" | "HEAD", "/CREDITS.txt") => {
            write_response(
                &mut stream,
                "200 OK",
                "text/plain; charset=utf-8",
                CREDITS,
                cors,
                head_only,
            );
        }
        _ => {
            write_response(
                &mut stream,
                "404 Not Found",
                "text/plain; charset=utf-8",
                b"not found\n",
                cors,
                head_only,
            );
        }
    }
}

fn inject_world(index: &[u8], world: &str) -> Vec<u8> {
    let html = String::from_utf8_lossy(index);
    let script =
        format!("<script>window.__WORLD__={world};window.__NAUTILUS_SERVER__=true;</script>");
    if let Some(pos) = html.to_ascii_lowercase().find("</head>") {
        let mut out = String::with_capacity(html.len() + script.len());
        out.push_str(&html[..pos]);
        out.push_str(&script);
        out.push_str(&html[pos..]);
        out.into_bytes()
    } else {
        format!("{script}\n{html}").into_bytes()
    }
}

fn write_response(
    stream: &mut TcpStream,
    status: &str,
    content_type: &str,
    body: &[u8],
    extra: &str,
    head_only: bool,
) {
    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\
         Cache-Control: no-store\r\nConnection: close\r\n{extra}\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    if !head_only {
        let _ = stream.write_all(body);
    }
    let _ = stream.flush();
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn query_value(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        let Some((k, v)) = pair.split_once('=') else {
            continue;
        };
        if k == key {
            return Some(percent_decode(v));
        }
    }
    None
}

fn parse_pos(query: &str) -> Option<[f64; 3]> {
    let x = query_value(query, "x")?.parse().ok()?;
    let y = query_value(query, "y")?.parse().ok()?;
    let z = query_value(query, "z")?.parse().ok()?;
    Some([x, y, z])
}

fn percent_decode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&value[i + 1..i + 3], 16) {
                out.push(byte as char);
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'+' {
            out.push(' ');
        } else {
            out.push(bytes[i] as char);
        }
        i += 1;
    }
    out
}
