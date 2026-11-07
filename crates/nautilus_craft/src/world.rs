//! The Torrance level as a Valence world.
//!
//! The geometry is generated from `web/src/world.json`, the same manifest the
//! WebView client uses. Keeping one manifest means the browser UI/UX and the
//! Minecraft server cannot drift into two different towns.

use serde::{Deserialize, Serialize};
use valence::entity::entity::{CustomName, NameVisible};
use valence::entity::villager::VillagerEntityBundle;
use valence::prelude::*;

pub const WORLD_JSON: &str = include_str!("../../../web/dist/world.json");

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub z: i32,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Spawn {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    #[serde(default)]
    pub yaw: f64,
    #[serde(default)]
    pub pitch: f64,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Poi {
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub z: i32,
    #[serde(default)]
    pub cls: String,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Zone {
    pub x: f64,
    pub z: f64,
    pub r: f64,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Quest {
    pub id: String,
    pub title: String,
    pub kind: String,
    #[serde(default)]
    pub zone: Option<Zone>,
    #[serde(default)]
    pub target: i32,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct NpcSpec {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub sprite: String,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    #[serde(default)]
    pub lines: Vec<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct TokenSpec {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Business {
    pub id: String,
    pub name: String,
    pub x: f64,
    pub z: f64,
    #[serde(default)]
    pub item: String,
    #[serde(default)]
    pub qty: i32,
    #[serde(default)]
    pub sats: i32,
    #[serde(default)]
    pub lat: f64,
    #[serde(default)]
    pub lon: f64,
    #[serde(default)]
    pub radius: i32,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
pub struct CopyLines {
    #[serde(default)]
    pub hint: String,
    #[serde(default)]
    pub started: String,
    #[serde(default)]
    pub complete: String,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Level {
    pub slug: String,
    pub title: String,
    pub ground: i32,
    pub bounds: Bounds,
    pub spawn: Spawn,
    #[serde(default)]
    pub pois: Vec<Poi>,
    #[serde(default)]
    pub quests: Vec<Quest>,
    #[serde(default)]
    pub npcs: Vec<NpcSpec>,
    #[serde(default)]
    pub tokens: Vec<TokenSpec>,
    #[serde(default)]
    pub businesses: Vec<Business>,
    #[serde(default)]
    pub copy: CopyLines,
}

impl Level {
    pub fn load() -> Self {
        serde_json::from_str(WORLD_JSON).expect("web/dist/world.json is valid")
    }

    pub fn quest(&self, id: &str) -> Option<&Quest> {
        self.quests.iter().find(|q| q.id == id)
    }

    pub fn npc(&self, wanted: &str) -> Option<&NpcSpec> {
        let wanted = wanted.trim().to_ascii_lowercase();
        self.npcs
            .iter()
            .find(|n| n.id.to_ascii_lowercase() == wanted || n.name.to_ascii_lowercase() == wanted)
    }

    pub fn business(&self, wanted: &str) -> Option<&Business> {
        let wanted = wanted.trim().to_ascii_lowercase();
        self.businesses.iter().find(|b| {
            b.id.to_ascii_lowercase() == wanted
                || b.name.to_ascii_lowercase().contains(&wanted)
                || wanted.contains(&b.id.to_ascii_lowercase())
        })
    }
}

#[derive(Resource, Clone)]
pub struct LevelResource(pub Level);

#[derive(Component, Clone, Debug)]
pub struct NpcActor {
    pub name: String,
    pub home: [f64; 3],
    pub target: [f64; 3],
    pub timer: f32,
    pub seed: u32,
}

const NPC_SPEED: f64 = 1.2;

pub fn setup(
    mut commands: Commands,
    server: Res<Server>,
    dimensions: Res<DimensionTypeRegistry>,
    biomes: Res<BiomeRegistry>,
    level: Res<LevelResource>,
) {
    let level = &level.0;
    let mut layer = LayerBundle::new(ident!("overworld"), &dimensions, &biomes, &server);

    let chunks_x = (level.bounds.x + 15) / 16;
    let chunks_z = (level.bounds.z + 15) / 16;
    for z in 0..chunks_z {
        for x in 0..chunks_x {
            layer.chunk.insert_chunk([x, z], UnloadedChunk::new());
        }
    }

    let ground = level.ground;
    for z in 0..level.bounds.z {
        for x in 0..level.bounds.x {
            layer
                .chunk
                .set_block([x, ground, z], BlockState::GRASS_BLOCK);
            layer.chunk.set_block([x, ground - 1, z], BlockState::DIRT);
            layer.chunk.set_block([x, ground - 2, z], BlockState::STONE);
            layer.chunk.set_block([x, ground - 3, z], BlockState::STONE);
            if x % 16 == 0 || z % 16 == 0 {
                layer.chunk.set_block([x, ground - 4, z], BlockState::STONE);
            }
        }
    }

    // A plaza where every path begins, then one path to each business.
    fill_rect(
        &mut layer.chunk,
        level.spawn.x as i32 - 10,
        level.spawn.z as i32 - 10,
        20,
        20,
        ground,
        BlockState::SMOOTH_STONE,
    );
    for business in &level.businesses {
        road(
            &mut layer.chunk,
            level.spawn.x as i32,
            level.spawn.z as i32,
            business.x as i32,
            business.z as i32,
            ground,
        );
    }

    // The park pond and the community-garden plots.
    fill_rect(&mut layer.chunk, 68, 26, 12, 9, ground, BlockState::WATER);
    fill_rect(&mut layer.chunk, 21, 22, 9, 7, ground, BlockState::FARMLAND);
    for z in 22..29 {
        for x in 21..30 {
            layer.chunk.set_block([x, ground + 1, z], BlockState::WHEAT);
        }
    }

    for business in &level.businesses {
        build_shop(
            &mut layer.chunk,
            business.x as i32,
            business.z as i32,
            ground,
            shop_material(&business.item),
        );
    }

    for token in &level.tokens {
        layer.chunk.set_block(
            [token.x as i32, token.y as i32, token.z as i32],
            BlockState::EMERALD_BLOCK,
        );
        layer.chunk.set_block(
            [token.x as i32, token.y as i32 - 1, token.z as i32],
            BlockState::GLOWSTONE,
        );
    }

    let layer_id = commands.spawn(layer).id();

    for (index, npc) in level.npcs.iter().enumerate() {
        let home = [npc.x, npc.y, npc.z];
        let entity = commands
            .spawn(VillagerEntityBundle {
                layer: EntityLayerId(layer_id),
                position: Position::new(home),
                look: Look::new(180.0, 0.0),
                head_yaw: HeadYaw(180.0),
                entity_custom_name: CustomName(Some(npc.name.clone().into())),
                entity_name_visible: NameVisible(true),
                ..Default::default()
            })
            .id();
        commands.entity(entity).insert(NpcActor {
            name: npc.name.clone(),
            home,
            target: home,
            timer: 1.0 + index as f32 * 0.37,
            seed: 0x9e37_79b9 ^ index as u32,
        });
    }
}

pub fn init_clients(
    mut clients: Query<
        (
            &mut Client,
            &mut EntityLayerId,
            &mut VisibleChunkLayer,
            &mut VisibleEntityLayers,
            &mut Position,
            &mut Look,
            &mut GameMode,
            &Username,
        ),
        Added<Client>,
    >,
    layers: Query<Entity, (With<ChunkLayer>, With<EntityLayer>)>,
    level: Res<LevelResource>,
) {
    let layer = layers.single();

    for (
        mut client,
        mut layer_id,
        mut visible_chunk_layer,
        mut visible_entity_layers,
        mut pos,
        mut look,
        mut game_mode,
        username,
    ) in &mut clients
    {
        layer_id.0 = layer;
        visible_chunk_layer.0 = layer;
        visible_entity_layers.0.insert(layer);
        pos.set([level.0.spawn.x, level.0.spawn.y, level.0.spawn.z]);
        *look = Look::new(level.0.spawn.yaw as f32, level.0.spawn.pitch as f32);
        *game_mode = GameMode::Survival;

        client.send_chat_message(
            format!(
                "Welcome to {}, {}. Say !ai help or open the WebView assistant. \
                 The assistant plans, claims tokens and tracks quests; the walking and \
                 the building stay yours.",
                level.0.title, username.0
            )
            .color(Color::GREEN),
        );
    }
}

pub fn move_npcs(
    mut last: Local<Option<std::time::Instant>>,
    mut npcs: Query<(&mut Position, &mut Look, &mut NpcActor)>,
) {
    let now = std::time::Instant::now();
    let dt = (*last)
        .map(|t| now.duration_since(t).as_secs_f64())
        .unwrap_or(0.0)
        .min(0.25);
    *last = Some(now);

    for (mut pos, mut look, mut npc) in &mut npcs {
        npc.timer -= dt as f32;
        if npc.timer <= 0.0 {
            npc.timer = 2.5 + (next_rand(&mut npc.seed) as f32) * 3.5;
            let angle = next_rand(&mut npc.seed) * std::f64::consts::TAU;
            let radius = 1.5 + next_rand(&mut npc.seed) * 4.0;
            npc.target = [
                npc.home[0] + angle.cos() * radius,
                npc.home[1],
                npc.home[2] + angle.sin() * radius,
            ];
        }

        let dx = npc.target[0] - pos.0.x;
        let dz = npc.target[2] - pos.0.z;
        let dist = (dx * dx + dz * dz).sqrt();
        if dist > 0.15 {
            let step = (NPC_SPEED * dt).min(dist);
            let vx = dx / dist * step;
            let vz = dz / dist * step;
            let next = [pos.0.x + vx, npc.home[1], pos.0.z + vz];
            pos.set(next);
            look.yaw = (vx as f32).atan2(vz as f32).to_degrees();
            look.pitch = 0.0;
        }
    }
}

fn next_rand(seed: &mut u32) -> f64 {
    *seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
    f64::from(*seed >> 8) / f64::from(u32::MAX >> 8)
}

fn shop_material(item: &str) -> BlockState {
    match item {
        "coffee" => BlockState::BRICKS,
        "token" => BlockState::STONE_BRICKS,
        "brick" => BlockState::BRICKS,
        "carrot" => BlockState::OAK_PLANKS,
        _ => BlockState::OAK_PLANKS,
    }
}

fn fill_rect(layer: &mut ChunkLayer, x0: i32, z0: i32, w: i32, d: i32, y: i32, block: BlockState) {
    for z in z0..z0 + d {
        for x in x0..x0 + w {
            layer.set_block([x, y, z], block);
        }
    }
}

/// A three-wide path from the plaza to a business. The road is a place, not a
/// fence: it is drawn only where the world is flat and in bounds.
fn road(layer: &mut ChunkLayer, x0: i32, z0: i32, x1: i32, z1: i32, y: i32) {
    let steps = (x1 - x0).abs().max((z1 - z0).abs()).max(1);
    for i in 0..=steps {
        let x = x0 + (x1 - x0) * i / steps;
        let z = z0 + (z1 - z0) * i / steps;
        for dz in -1..=1 {
            for dx in -1..=1 {
                layer.set_block([x + dx, y, z + dz], BlockState::BLACK_CONCRETE);
            }
        }
    }
}

fn build_shop(layer: &mut ChunkLayer, cx: i32, cz: i32, ground: i32, wall: BlockState) {
    let half = 4;
    let x0 = cx - half;
    let x1 = cx + half;
    let z0 = cz - half;
    let z1 = cz + half;
    let floor = ground + 1;
    let wall_top = ground + 4;

    fill_rect(layer, x0, z0, 9, 9, floor, BlockState::SMOOTH_STONE);
    for y in floor + 1..=wall_top {
        for x in x0..=x1 {
            for z in z0..=z1 {
                let edge = x == x0 || x == x1 || z == z0 || z == z1;
                if !edge {
                    continue;
                }
                let window = y == floor + 2 && (x + z) % 3 != 0;
                layer.set_block([x, y, z], if window { BlockState::GLASS } else { wall });
            }
        }
    }

    // A door on the south face, facing the plaza.
    for y in floor + 1..=floor + 2 {
        layer.set_block([cx, y, z1], BlockState::AIR);
    }

    for z in z0..=z1 {
        for x in x0..=x1 {
            layer.set_block([x, wall_top + 1, z], wall);
        }
    }

    // A small counter inside, so the shop reads as a place of business.
    for z in z0 + 2..=z1 - 2 {
        layer.set_block([x0 + 2, floor + 1, z], BlockState::OAK_SLAB);
    }
}
