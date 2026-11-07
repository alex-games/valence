//! MQTT v5 control plane, compiled only with `--features c2`.
//!
//! The game C2 tree is the same shape as the phone tree:
//!
//! ```text
//! wa/v1/c2/torrance/assistant/intent      phone / WebView -> assistant
//! wa/v1/c2/torrance/assistant/reply       assistant -> phone / CC
//! wa/v1/c2/torrance/cc/cmd                command centre -> server
//! wa/v1/c2/torrance/player/<pid>/score    server -> everyone (retained)
//! ```
//!
//! It is anonymous LAN MQTT, exactly like `game-c2.md` says. The signed child
//! key belongs on the phone/CC side; this process is the VM's single writer and
//! must sit behind nginx and a broker password before it leaves the LAN.

use std::sync::{Arc, Mutex};

use rumqttc::{Client, Event, Incoming, MqttOptions, QoS};
use serde_json::Value;

use crate::ai::Assistant;

const ROOT: &str = "wa/v1/c2/torrance";

pub fn spawn(broker: String, client_id: String, ai: Arc<Mutex<Assistant>>) {
    std::thread::Builder::new()
        .name("nautilus-c2".into())
        .spawn(move || run(broker, client_id, ai))
        .ok();
}

fn run(broker: String, client_id: String, ai: Arc<Mutex<Assistant>>) {
    let (host, port) = match broker.rsplit_once(':') {
        Some((host, port)) => (host.to_owned(), port.parse::<u16>().unwrap_or(1883)),
        None => (broker, 1883),
    };
    let mut options = MqttOptions::new(client_id, host, port);
    options.set_keep_alive(std::time::Duration::from_secs(20));
    let (client, mut connection) = Client::new(options, 64);

    // The root is overridable so a validation run on a public broker can use
    // a unique namespace instead of mixing with every other `torrance`.
    let root = std::env::var("NAUTILUS_MQTT_ROOT").unwrap_or_else(|_| ROOT.into());
    client
        .subscribe(format!("{root}/assistant/intent"), QoS::AtLeastOnce)
        .ok();
    client
        .subscribe(format!("{root}/cc/cmd"), QoS::AtLeastOnce)
        .ok();

    for event in connection.iter() {
        let Ok(Event::Incoming(Incoming::Publish(publish))) = event else {
            continue;
        };
        let value: Value = serde_json::from_slice(&publish.payload).unwrap_or_default();
        let player = value
            .get("player")
            .or_else(|| value.get("pid"))
            .and_then(|v| v.as_str())
            .unwrap_or("cc")
            .to_owned();
        let pos = value.get("pos").and_then(|v| v.as_array()).and_then(|a| {
            Some([
                a.first()?.as_f64()?,
                a.get(1)?.as_f64()?,
                a.get(2)?.as_f64()?,
            ])
        });

        let text = if publish.topic.ends_with("/cc/cmd") {
            match value.get("cmd").and_then(|v| v.as_str()) {
                Some("pause") => "pause".to_owned(),
                Some("resume") => "resume".to_owned(),
                Some("daily") => "run the day".to_owned(),
                Some("status") => "status".to_owned(),
                Some(other) => other.to_owned(),
                None => continue,
            }
        } else {
            value
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_owned()
        };
        if text.is_empty() {
            continue;
        }

        let reply = ai
            .lock()
            .expect("assistant mutex")
            .handle(&player, &text, pos);
        // The assistant's closed tools become real C2 intents. The CC NPC
        // consumes cc/task; the commerce engine consumes commerce/order.
        match &reply.action {
            Some(crate::ai::Action::Delegate { task, topic }) => {
                let body = serde_json::json!({
                    "task": task,
                    "player": player,
                    "at": std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0),
                });
                client
                    .publish(topic.clone(), QoS::AtLeastOnce, false, body.to_string())
                    .ok();
            }
            Some(crate::ai::Action::Order {
                side,
                item,
                qty,
                price,
                region,
            }) => {
                let body = serde_json::json!({
                    "pid": player, "side": side, "item": item, "qty": qty,
                    "price": price, "region": region,
                });
                client
                    .publish(
                        format!("{root}/commerce/order"),
                        QoS::AtLeastOnce,
                        false,
                        body.to_string(),
                    )
                    .ok();
            }
            _ => {}
        }
        let payload = serde_json::to_vec(&reply).unwrap_or_default();
        client
            .publish(
                format!("{root}/assistant/reply"),
                QoS::AtLeastOnce,
                false,
                payload,
            )
            .ok();
        if let Some(progress) = serde_json::to_vec(&reply.progress).ok() {
            client
                .publish(
                    format!("{root}/player/{player}/score"),
                    QoS::AtLeastOnce,
                    true,
                    progress,
                )
                .ok();
        }
    }
}
