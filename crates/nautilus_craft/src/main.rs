//! Nautilus Craft — Torrance.
//!
//! One binary that is three things at once:
//!   * a real Valence Minecraft: Java Edition server (the authoritative world,
//!     NPCs, block edits and quests);
//!   * the same game's WebView origin, so the phone's UI/UX is HTML in a
//!     `WKWebView` and not a second native client;
//!   * the embedded `gameAssistant`: a closed-set, on-device-style voice router
//!     and utility planner that removes the management toil.
//!
//! The browser game in `web/` and the Java server share `web/dist/world.json`.
//! That is the only way the two views of Torrance can stay one level.

use std::sync::{Arc, Mutex};

use valence::prelude::*;

mod ai;
#[cfg(feature = "c2")]
mod c2;
mod web;
mod world;

fn main() {
    let level = world::Level::load();
    let assistant = Arc::new(Mutex::new(ai::Assistant::new(level.clone())));

    let web_addr = std::env::var("NAUTILUS_WEB_ADDR").unwrap_or_else(|_| "127.0.0.1:8082".into());
    web::spawn(web_addr, assistant.clone(), level.clone());

    #[cfg(feature = "c2")]
    if let Ok(broker) = std::env::var("NAUTILUS_MQTT") {
        let client_id =
            std::env::var("NAUTILUS_MQTT_ID").unwrap_or_else(|_| "nautilus-craft".into());
        c2::spawn(broker, client_id, assistant.clone());
    }

    let mut app = App::new();
    // A second process (the live MQTT validation) must not fight the first for
    // 25565. The address is otherwise Valence's default.
    if let Ok(address) = std::env::var("NAUTILUS_MC_ADDR") {
        if let Ok(address) = address.parse() {
            let mut settings = valence::network::NetworkSettings::default();
            settings.address = address;
            app.insert_resource(settings);
        }
    }
    app.add_plugins(DefaultPlugins)
        .insert_resource(world::LevelResource(level))
        .insert_resource(ai::AiHandle(assistant))
        .add_systems(Startup, world::setup)
        .add_systems(
            Update,
            (
                world::init_clients,
                ai::chat_system,
                ai::briefing_system,
                ai::zone_system,
                ai::place_system,
                ai::break_system,
                ai::npc_talk_system,
                world::move_npcs,
                despawn_disconnected_clients,
            ),
        )
        .run();
}
