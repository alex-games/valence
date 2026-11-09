//! Vault KV v2 storage for the authoritative user game state.
//!
//! The VM's Vault is the source of truth for **user state**; PostgreSQL holds the
//! sidechain (edits, accounts, shard tips and anchors). A warm-boot VM snapshot
//! therefore restores both because both live in the guest's persistent tree.
//!
//! This is deliberately a tiny HTTP client rather than a Vault SDK: the VM is
//! memory-capped, Vault is loopback-only, and the only operations are one KV v2
//! read and one write. The token is read from `VAULT_TOKEN` and never logged.
//! In the guest that is the scoped `game-token`, not the root token.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

#[derive(Clone, Debug)]
pub struct VaultStateStore {
    host: String,
    port: u16,
    token: String,
    path: String,
}

impl VaultStateStore {
    /// `None` when Vault is not configured; the file store remains the fallback.
    ///
    /// The VM's file-backend Vault is the default address. The scoped
    /// `game-token` is preferred; the root token remains a fallback for an
    /// older image and for a host that only has one token. On a host, point
    /// `VAULT_ADDR`/`VAULT_TOKEN` at the dev server or leave both unset for
    /// file-only play.
    pub fn from_env() -> Option<Self> {
        let addr = std::env::var("VAULT_ADDR").unwrap_or_else(|_| "http://127.0.0.1:8200".into());
        let token = std::env::var("VAULT_TOKEN")
            .ok()
            .or_else(|| std::fs::read_to_string("/var/lib/vault/game-token").ok())
            .or_else(|| std::fs::read_to_string("/var/lib/vault/root-token").ok())
            .map(|token| token.trim().to_owned())
            .filter(|token| !token.is_empty())?;
        let (host, port) = parse_addr(&addr)?;
        let path = std::env::var("NAUTILUS_VAULT_PATH")
            .unwrap_or_else(|_| "secret/data/nautilus/game/assistant".into());
        Some(Self {
            host,
            port,
            token,
            path,
        })
    }

    #[cfg(test)]
    pub(crate) fn test_store(host: &str, port: u16) -> Self {
        Self {
            host: host.into(),
            port,
            token: "test".into(),
            path: "secret/data/nautilus/game/assistant".into(),
        }
    }

    pub fn load(&self) -> Option<String> {
        self.get_path(&self.path)
    }

    pub fn save(&self, state_json: &str) -> bool {
        self.put_path(&self.path, state_json).is_some()
    }

    /// Read `state` from an arbitrary KV v2 path.
    pub fn get_path(&self, path: &str) -> Option<String> {
        let body = self.request_at("GET", path, None)?;
        parse_state(&body)
    }

    /// Write `state` to an arbitrary KV v2 path. Returns the new Vault version.
    pub fn put_path(&self, path: &str, state_json: &str) -> Option<u64> {
        let body = serde_json::json!({
            "data": { "state": state_json }
        })
        .to_string();
        let response = self.request_at("POST", path, Some(&body))?;
        let value: serde_json::Value = serde_json::from_str(&response).ok()?;
        value.get("data")?.get("version")?.as_u64()
    }

    fn request_at(&self, method: &str, path: &str, body: Option<&str>) -> Option<String> {
        let mut stream = TcpStream::connect((self.host.as_str(), self.port)).ok()?;
        stream.set_read_timeout(Some(Duration::from_secs(3))).ok()?;
        stream
            .set_write_timeout(Some(Duration::from_secs(3)))
            .ok()?;
        let body = body.unwrap_or("");
        let request = format!(
            "{method} /v1/{} HTTP/1.1\r\nHost: {}:{}\r\nX-Vault-Token: {}\r\n\
             Content-Type: application/json\r\nContent-Length: {}\r\n\
             Connection: close\r\n\r\n{body}",
            path.trim_start_matches('/'),
            self.host,
            self.port,
            self.token,
            body.len()
        );
        stream.write_all(request.as_bytes()).ok()?;
        let mut response = Vec::new();
        stream.read_to_end(&mut response).ok()?;
        let split = response
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .map(|i| i + 4)?;
        let head = String::from_utf8_lossy(&response[..split]);
        if !head.starts_with("HTTP/1.1 2") && !head.starts_with("HTTP/1.0 2") {
            return None;
        }
        Some(String::from_utf8_lossy(&response[split..]).to_string())
    }
}

fn parse_state(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    value
        .get("data")?
        .get("data")?
        .get("state")?
        .as_str()
        .map(str::to_owned)
}

fn parse_addr(addr: &str) -> Option<(String, u16)> {
    let addr = addr.trim();
    let addr = addr.strip_prefix("http://").unwrap_or(addr);
    let addr = addr.split('/').next().unwrap_or(addr);
    let (host, port) = addr.rsplit_once(':')?;
    Some((host.to_owned(), port.parse().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn parses_loopback_addr() {
        assert_eq!(
            parse_addr("http://127.0.0.1:8200"),
            Some(("127.0.0.1".into(), 8200))
        );
        assert_eq!(
            parse_addr("127.0.0.1:8200"),
            Some(("127.0.0.1".into(), 8200))
        );
        assert_eq!(parse_addr("bad"), None);
    }

    #[test]
    fn reads_the_kv_v2_envelope() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let _ = stream.read(&mut buf);
            let body = r#"{"data":{"data":{"state":"{\"version\":1}"}}}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(response.as_bytes());
        });
        let store = VaultStateStore {
            host: "127.0.0.1".into(),
            port,
            token: "test".into(),
            path: "secret/data/nautilus/game/assistant".into(),
        };
        assert_eq!(store.load().as_deref(), Some("{\"version\":1}"));
    }

    #[test]
    fn writes_the_kv_v2_envelope() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = std::sync::mpsc::channel();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 8192];
            let n = stream.read(&mut buf).unwrap();
            let request = String::from_utf8_lossy(&buf[..n]).to_string();
            tx.send(request).ok();
            let body = r#"{"data":{"version":2}}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(response.as_bytes());
        });
        let store = VaultStateStore {
            host: "127.0.0.1".into(),
            port,
            token: "test".into(),
            path: "secret/data/nautilus/game/assistant".into(),
        };
        assert!(store.save("{\"version\":1}"));
        let request = rx.recv().unwrap();
        assert!(request.starts_with("POST /v1/secret/data/nautilus/game/assistant HTTP/1.1"));
        assert!(request.contains("\"state\":\"{\\\"version\\\":1}\""));
    }
}
