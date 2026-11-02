/* Nautilus Craft — Torrance beginner level.
 * A self-contained WebGL2 voxel sandbox. No external assets, no network calls.
 * Served by /usr/bin/minecraft-server (single static i686-musl binary) and by
 * nginx from /nautilus/minecraft in the Minecraft VM.
 */
(() => {
'use strict';

// ---------------------------------------------------------------- elements --
const $ = (id) => document.getElementById(id);
const canvas = $('gl');
const labelsEl = $('labels');
const coordsEl = $('coords');
const fpsEl = $('fps');
const modeEl = $('mode');
const questsEl = $('quests');
const qlistEl = $('qlist');
const qcountEl = $('qcount');
const hotbarEl = $('hotbar');
const toastEl = $('toast');
const hintEl = $('hint');
const minimapEl = $('minimap');
const mapCanvas = $('mapcanvas');
const welcomeEl = $('welcome');
const helpEl = $('help');
const completeEl = $('complete');
const completeStatsEl = $('completeStats');
const tokensEl = $('tokens');
const netEl = $('net');
const chatEl = $('chat');
const chatlogEl = $('chatlog');
const chatformEl = $('chatform');
const chatinputEl = $('chatinput');
const talkEl = $('talk');
const talkNameEl = $('talkName');
const dialogueEl = $('dialogue');
const dialogueNameEl = $('dialogueName');
const dialogueTextEl = $('dialogueText');
const dialogueNextEl = $('dialogueNext');
const playerNameEl = $('playerName');
const onlineListEl = $('onlineList');
const creditsBoxEl = $('creditsBox');
const btnChatEl = $('btnChat');
const farmEl = $('farm');
const farmNameEl = $('farmName');
const photoInput = $('photoInput');
const satsEl = $('sats');

const IS_TOUCH = matchMedia('(pointer: coarse)').matches || ('ontouchstart' in window);
if (IS_TOUCH) document.body.classList.add('touch');

// ------------------------------------------------------------------- maths --
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0]/l, v[1]/l, v[2]/l]; };
const cross3 = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const dot3 = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];

function mat4Perspective(out, fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

function mat4LookAt(out, eye, fwd, upWorld) {
  const z = norm3([-fwd[0], -fwd[1], -fwd[2]]);
  const x = norm3(cross3(upWorld, z));
  const y = cross3(z, x);
  out[0] = x[0]; out[1] = y[0]; out[2] = z[0]; out[3] = 0;
  out[4] = x[1]; out[5] = y[1]; out[6] = z[1]; out[7] = 0;
  out[8] = x[2]; out[9] = y[2]; out[10] = z[2]; out[11] = 0;
  out[12] = -dot3(x, eye); out[13] = -dot3(y, eye); out[14] = -dot3(z, eye); out[15] = 1;
  return out;
}

function mat4Multiply(out, a, b) {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r] * b[c * 4] +
        a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] +
        a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

function rng32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ blocks --
const AIR = 0;
const GRASS = 1, DIRT = 2, STONE = 3, SAND = 4, WATER = 5, ASPHALT = 6, LINE = 7;
const PATH = 8, PLANKS = 9, LOG = 10, LEAVES = 11, GLASS = 12, ROOF_RED = 13;
const ROOF_BLUE = 14, WHITE = 15, GRAY = 16, SOIL = 17, WHEAT = 18, CARROT = 19;
const FLOWER_R = 20, FLOWER_Y = 21, HEDGE = 22, SIGN = 23, AWNING = 24;
const CAR_R = 25, CAR_B = 26, CAR_S = 27, COUNTER = 28, BENCH = 29, LAMP = 30;
const PLAZA = 31, BRICK = 32, ROAD_WHITE = 33, ROOF_GREEN = 34, TUFT = 35;

const TILE_NAMES = [
  'grass_top', 'grass_side', 'dirt', 'stone', 'sand', 'water', 'asphalt', 'line',
  'path', 'planks', 'log_side', 'log_top', 'leaves', 'glass', 'roof_red', 'roof_blue',
  'white', 'gray', 'soil', 'wheat', 'carrot', 'flower_red', 'flower_yellow', 'hedge',
  'sign', 'awning', 'car_red', 'car_blue', 'car_silver', 'counter', 'bench', 'lamp',
  'plaza', 'brick', 'road_white', 'roof_green', 'tuft'
];
const TILE = {};
TILE_NAMES.forEach((n, i) => { TILE[n] = i; });

const ATLAS_COLS = 8;
const TILE_PX = 16;
const ATLAS_PX = ATLAS_COLS * TILE_PX;

const DEF = [];
function def(id, o) { o.id = id; DEF[id] = o; }
def(GRASS,      { name: 'Grass', top: 'grass_top', side: 'grass_side', bottom: 'dirt', solid: 1, opaque: 1, color: '#6fae4a' });
def(DIRT,       { name: 'Dirt', top: 'dirt', solid: 1, opaque: 1, color: '#7d5b3c' });
def(STONE,      { name: 'Stone', top: 'stone', solid: 1, opaque: 1, color: '#8b8f93' });
def(SAND,       { name: 'Sand', top: 'sand', solid: 1, opaque: 1, color: '#ddcf9b' });
def(WATER,      { name: 'Water', top: 'water', solid: 0, opaque: 0, alpha: 1, color: '#2f7fd6' });
def(ASPHALT,    { name: 'Asphalt', top: 'asphalt', solid: 1, opaque: 1, color: '#3a3f45' });
def(LINE,       { name: 'Road line', top: 'line', solid: 1, opaque: 1, color: '#e8c34a' });
def(PATH,       { name: 'Path', top: 'path', solid: 1, opaque: 1, color: '#c9b98e' });
def(PLANKS,     { name: 'Planks', top: 'planks', solid: 1, opaque: 1, color: '#a9793f' });
def(LOG,        { name: 'Log', top: 'log_top', side: 'log_side', bottom: 'log_top', solid: 1, opaque: 1, color: '#6b4a2a' });
def(LEAVES,     { name: 'Leaves', top: 'leaves', solid: 1, opaque: 1, color: '#3f7d33' });
def(GLASS,      { name: 'Glass', top: 'glass', solid: 1, opaque: 0, alpha: 1, color: '#bfe8ff' });
def(ROOF_RED,   { name: 'Red roof', top: 'roof_red', solid: 1, opaque: 1, color: '#a94438' });
def(ROOF_BLUE,  { name: 'Blue roof', top: 'roof_blue', solid: 1, opaque: 1, color: '#3f6f9e' });
def(WHITE,      { name: 'White wall', top: 'white', solid: 1, opaque: 1, color: '#dcdcd6' });
def(GRAY,       { name: 'Gray wall', top: 'gray', solid: 1, opaque: 1, color: '#8e9498' });
def(SOIL,       { name: 'Soil', top: 'soil', solid: 1, opaque: 1, color: '#4e3927' });
def(WHEAT,      { name: 'Wheat', top: 'wheat', solid: 0, opaque: 0, cross: 1, cutout: 1, color: '#b9a34a' });
def(CARROT,     { name: 'Carrots', top: 'carrot', solid: 0, opaque: 0, cross: 1, cutout: 1, color: '#5f9e3c' });
def(FLOWER_R,   { name: 'Lupine', top: 'flower_red', solid: 0, opaque: 0, cross: 1, cutout: 1, color: '#7d5fa8' });
def(FLOWER_Y,   { name: 'Dandelion', top: 'flower_yellow', solid: 0, opaque: 0, cross: 1, cutout: 1, color: '#e8c34a' });
def(TUFT,       { name: 'Grass tuft', top: 'tuft', solid: 0, opaque: 0, cross: 1, cutout: 1, color: '#5f9e3c' });
def(HEDGE,      { name: 'Hedge', top: 'hedge', solid: 1, opaque: 1, color: '#2f5f2a' });
def(SIGN,       { name: 'Sign', top: 'sign', side: 'sign', solid: 1, opaque: 1, color: '#b98a4e' });
def(AWNING,     { name: 'Awning', top: 'awning', solid: 1, opaque: 1, color: '#2f7d4f' });
def(CAR_R,      { name: 'Red car', top: 'car_red', solid: 1, opaque: 1, color: '#b23a32' });
def(CAR_B,      { name: 'Blue car', top: 'car_blue', solid: 1, opaque: 1, color: '#335f9e' });
def(CAR_S,      { name: 'Silver car', top: 'car_silver', solid: 1, opaque: 1, color: '#b9bec2' });
def(COUNTER,    { name: 'Counter', top: 'counter', solid: 1, opaque: 1, color: '#8a5f36' });
def(BENCH,      { name: 'Bench', top: 'bench', solid: 1, opaque: 1, color: '#a9793f' });
def(LAMP,       { name: 'Lamp', top: 'lamp', solid: 1, opaque: 1, color: '#f4d06a' });
def(PLAZA,      { name: 'Plaza tile', top: 'plaza', solid: 1, opaque: 1, color: '#c9c4b4' });
def(BRICK,      { name: 'Brick', top: 'brick', solid: 1, opaque: 1, color: '#9c4a3c' });
def(ROAD_WHITE, { name: 'White line', top: 'road_white', solid: 1, opaque: 1, color: '#e8e8e0' });
def(ROOF_GREEN, { name: 'Green roof', top: 'roof_green', solid: 1, opaque: 1, color: '#3f7d55' });

const NAME_TO_ID = {};
for (const d of DEF) if (d) NAME_TO_ID[d.name.toLowerCase()] = d.id;

// **The level manifest comes from Postgres.** `/usr/bin/minecraft-server` reads
// `game_world.data` (jsonb) from the `nautilus_craft` database and injects it as
// `window.__WORLD__` before serving `/` and `/embed/`. The fallback below keeps the
// page playable when it is opened as a plain file.
const FALLBACK_WORLD = {
  slug: 'torrance', version: 'torrance-2', title: 'Torrance',
  eyebrow: 'NAUTILUS · MINECRAFT VM · BEGINNER LEVEL',
  subtitle: 'COMMUNITY GARDEN · LAGO SECO PARK · THE COFFEE BEAN',
  coords: '33.8096°N 118.3547°W',
  intro: 'A quiet voxel sandbox built from the geofence the assistant measured at 33.8096°N, 118.3547°W — the Torrance Community Garden, Lago Seco Park, The Coffee Bean and Martin Chevrolet. No mobs, no damage, no hunger. Walk, build, talk to the neighbours, collect the eight emerald tokens and finish six beginner quests. Open it over HTTP to share the world with other players; the embedded WebView stays solo.',
  ground: 8,
  spawn: { x: 48.5, y: 9, z: 37.5, yaw: Math.PI, pitch: -0.1 },
  multiplayer: { enabled: true, path: '/ws', maxPlayers: 16, tickMs: 120 },
  palette: ['Grass', 'Dirt', 'Stone', 'Planks', 'Glass', 'Sand', 'Leaves', 'Asphalt', 'Brick'],
  pois: [
    { name: 'SPAWN PLAZA', x: 48, y: 15, z: 36, cls: 'green' },
    { name: 'COMMUNITY GARDEN', x: 25, y: 16, z: 25, cls: 'green' },
    { name: 'LAGO SECO PARK', x: 73, y: 16, z: 25, cls: 'blue' },
    { name: 'THE COFFEE BEAN', x: 68, y: 17, z: 65, cls: '' },
    { name: 'MARTIN CHEVROLET', x: 25, y: 16, z: 69, cls: '' },
    { name: 'FARMERS MARKET', x: 52, y: 14, z: 35, cls: 'green' },
    { name: 'FREE BUILD', x: 48, y: 14, z: 88, cls: 'green' },
    { name: 'TORRANCE BAKERY', x: 54, y: 16, z: 9, cls: 'green' },
    { name: 'RED CAR BREWERY', x: 54, y: 16, z: 15, cls: 'green' },
    { name: 'OLD TORRANCE ANTIQUES', x: 41, y: 16, z: 61, cls: 'green' },
    { name: 'MADRE!', x: 41, y: 16, z: 67, cls: 'green' }
  ],
  quests: [
    { id: 'garden', title: 'Visit the Community Garden', kind: 'zone', zone: { x: 25, z: 25, r: 14 } },
    { id: 'park', title: 'Walk the Lago Seco Park pier', kind: 'zone', zone: { x: 72.5, z: 30, r: 9 } },
    { id: 'coffee', title: 'Step into The Coffee Bean', kind: 'zone', zone: { x: 68, z: 65, r: 8 } },
    { id: 'dealer', title: 'Browse Martin Chevrolet', kind: 'zone', zone: { x: 25, z: 69, r: 12 } },
    { id: 'place', title: 'Place 10 blocks', kind: 'place', target: 10 },
    { id: 'break', title: 'Break 5 blocks', kind: 'break', target: 5 }
  ],
  npcs: [
    { id: 'mara', name: 'Mara', role: 'Community gardener', sprite: 'gardener', x: 25.5, y: 9, z: 33.5, size: [1.5, 2.05], lines: ['Welcome to the Community Garden. The wheat and carrots are yours to look at — not to eat.', 'Six raised beds, one trough, and a shed that has seen better decades.', 'If you find an emerald token, keep it. There are eight hidden around Torrance.'] },
    { id: 'noah', name: 'Noah', role: 'Barista', sprite: 'barista', x: 68.5, y: 9, z: 67.5, size: [1.5, 2.05], lines: ["The Coffee Bean is open. Today's special is a flat white and a voxel biscuit.", 'The patio is out back — the awning leaks only in imagination.', 'The Chevrolet lot across the road has a car on a podium. Very Torrance.'] },
    { id: 'june', name: 'June', role: 'Park ranger', sprite: 'ranger', x: 72.5, y: 9, z: 34.5, size: [1.5, 2.05], lines: ['Lago Seco Park. The pond is safe to swim in — nothing here bites.', 'Walk the pier to the end and look back at the gazebo.', 'Rusty the hedgehog lives near the south path. He is not a token.'] },
    { id: 'vic', name: 'Vic', role: 'Sales', sprite: 'dealer', x: 24.5, y: 9, z: 64.5, size: [1.5, 2.05], lines: ['Six cars, all of them one previous owner: me.', 'The silver one on the podium is not for sale. Probably.', 'Take a look around. The keys are imaginary.'] },
    { id: 'pip', name: 'Pip', role: 'Market vendor', sprite: 'vendor', x: 52.5, y: 9, z: 35.5, size: [1.3, 1.6], lines: ['Farmers market! Apples, bread, and a suspiciously square tomato.', 'The stalls are open all day. The gnome discount is real.', 'Eight emerald tokens are hidden. I have counted them twice.'] },
    { id: 'sol', name: 'Sol', role: 'Food truck cook', sprite: 'barista', x: 61.5, y: 9, z: 72.5, size: [1.5, 2.05], lines: ['Tacos, coffee, or a square tomato? The truck is open.', 'The Coffee Bean has the patio. I have the awning and the queue.', 'If you find the arch token, you can fly. Try it.'] },
    { id: 'rusty', name: 'Rusty', role: 'Park hedgehog', sprite: 'hedgehog', x: 67.5, y: 9, z: 37.5, size: [1.15, 0.75], lines: ['*rustle*', 'Rusty looks at you with the calm of a creature with no quests.', '*sniff sniff*'] }
  ],
  tokens: [
    { id: 'garden-shed', x: 33.5, y: 10.4, z: 14.5 },
    { id: 'gazebo', x: 82.5, y: 10.6, z: 14.5 },
    { id: 'pier', x: 72.5, y: 10.6, z: 27.5 },
    { id: 'coffee', x: 68.5, y: 10.5, z: 65.5 },
    { id: 'podium', x: 25.5, y: 12.4, z: 77.5 },
    { id: 'market', x: 52.5, y: 10.4, z: 34.5 },
    { id: 'arch', x: 48.5, y: 14.5, z: 41.5 },
    { id: 'freebuild', x: 48.5, y: 10.2, z: 88.5 }
  ],
  businesses: [
    { id: 'garden', lat: 33.8096, lon: -118.3547, radius: 300, name: 'Torrance Community Garden', x: 25.5, z: 33.5, item: 'wheat', qty: 3, sats: 20 },
    { id: 'park', lat: 33.812, lon: -118.35, radius: 300, name: 'Lago Seco Park', x: 72.5, z: 34.5, item: 'token', qty: 1, sats: 15 },
    { id: 'coffee', lat: 33.806, lon: -118.352, radius: 300, name: 'The Coffee Bean', x: 68.5, z: 67.5, item: 'coffee', qty: 2, sats: 30 },
    { id: 'dealer', lat: 33.805, lon: -118.358, radius: 300, name: 'Martin Chevrolet', x: 24.5, z: 64.5, item: 'brick', qty: 2, sats: 40 },
    { id: 'market', lat: 33.809, lon: -118.353, radius: 300, name: 'Farmers Market', x: 52.5, z: 35.5, item: 'token', qty: 1, sats: 25 },
    { id: 'bakery', lat: 33.8105, lon: -118.356, radius: 300, name: 'Torrance Bakery', x: 54.5, z: 12.5, item: 'wheat', qty: 2, sats: 20 },
    { id: 'brewery', lat: 33.811, lon: -118.355, radius: 300, name: 'Red Car Brewery', x: 54.5, z: 18.5, item: 'coffee', qty: 1, sats: 35 },
    { id: 'antiques', lat: 33.8075, lon: -118.359, radius: 300, name: 'Old Torrance Antiques', x: 41.5, z: 64.5, item: 'token', qty: 1, sats: 50 },
    { id: 'madre', lat: 33.808, lon: -118.36, radius: 300, name: 'Madre!', x: 41.5, z: 70.5, item: 'carrot', qty: 2, sats: 30 }
  ],
  copy: { hint: 'Click to look · WASD to move · E to talk · T to chat', started: 'TORRANCE · FOLLOW THE PALE PATHS · TALK TO THE NEIGHBOURS' }
};
const WORLD = (window.__WORLD__ && typeof window.__WORLD__ === 'object') ? window.__WORLD__ : FALLBACK_WORLD;
const SPAWN = Object.assign({ x: 48.5, y: 9, z: 37.5, yaw: Math.PI, pitch: -0.1 }, WORLD.spawn || {});

const faceTile = (id, f) => {
  const d = DEF[id];
  const t = f === 0 ? d.top : f === 1 ? (d.bottom || d.top) : (d.side || d.top);
  return TILE[t];
};

// -------------------------------------------------------------- atlas paint --
const atlasRng = rng32(0x7a17c0de);

const vendorImgs = {};
let vendorTotal = 0, vendorReady = 0, atlasQueued = false;
let atlas = null;

function drawVendorTiles(g) {
  const asphalt = vendorImgs['asphalt'];
  for (const [name, img] of Object.entries(vendorImgs)) {
    const i = TILE[name];
    if (i === undefined) continue;
    if (name === 'line' || name === 'road_white') continue;
    const ox = (i % ATLAS_COLS) * TILE_PX;
    const oy = Math.floor(i / ATLAS_COLS) * TILE_PX;
    g.globalAlpha = name === 'water' ? 0.82 : 1;
    g.drawImage(img, ox, oy, TILE_PX, TILE_PX);
    g.globalAlpha = 1;
    if (name === 'asphalt') { g.fillStyle = 'rgba(12,16,20,0.45)'; g.fillRect(ox, oy, TILE_PX, TILE_PX); }
    if (name === 'water') { g.fillStyle = 'rgba(30,110,210,0.38)'; g.fillRect(ox, oy, TILE_PX, TILE_PX); }
  }
  if (asphalt) {
    for (const [name, color] of [['line', '#e8c34a'], ['road_white', '#e8e8e0']]) {
      const i = TILE[name];
      if (i === undefined) continue;
      const ox = (i % ATLAS_COLS) * TILE_PX;
      const oy = Math.floor(i / ATLAS_COLS) * TILE_PX;
      g.drawImage(asphalt, ox, oy, TILE_PX, TILE_PX);
      g.fillStyle = 'rgba(12,16,20,0.45)';
      g.fillRect(ox, oy, TILE_PX, TILE_PX);
      g.fillStyle = color;
      g.fillRect(ox, oy + 7, TILE_PX, 2);
    }
  }
}

function scheduleAtlasRebuild() {
  if (atlasQueued) return;
  atlasQueued = true;
  requestAnimationFrame(() => {
    atlasQueued = false;
    rebuildAtlas();
  });
}
function rebuildAtlas() {
  atlas = buildAtlas();
  uploadAtlas();
  buildHotbar();
}
function loadVendorTextures() {
  const map = (window.__TEXTURES__ && typeof window.__TEXTURES__ === 'object') ? window.__TEXTURES__ : {};
  const entries = Object.entries(map);
  vendorTotal = entries.length;
  if (!entries.length) return;
  for (const [name, src] of entries) {
    const img = new Image();
    img.onload = () => { vendorImgs[name] = img; vendorReady++; scheduleAtlasRebuild(); };
    img.onerror = () => { vendorReady++; };
    img.src = src;
  }
}

function buildAtlas() {
  const c = document.createElement('canvas');
  c.width = ATLAS_PX; c.height = ATLAS_PX;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;

  const origin = (name) => {
    const i = TILE[name];
    return [(i % ATLAS_COLS) * TILE_PX, Math.floor(i / ATLAS_COLS) * TILE_PX];
  };
  const fill = (o, color) => { g.fillStyle = color; g.fillRect(o[0], o[1], TILE_PX, TILE_PX); };
  const px = (o, x, y, color) => { g.fillStyle = color; g.fillRect(o[0] + x, o[1] + y, 1, 1); };
  const speckle = (o, colors, n) => {
    for (let i = 0; i < n; i++) {
      px(o, (atlasRng() * 16) | 0, (atlasRng() * 16) | 0, colors[(atlasRng() * colors.length) | 0]);
    }
  };
  const rect = (o, x, y, w, h, color) => { g.fillStyle = color; g.fillRect(o[0] + x, o[1] + y, w, h); };

  let o;
  o = origin('grass_top'); fill(o, '#69a84a'); speckle(o, ['#5d9a40', '#78b955', '#86c75f', '#4f8c38'], 90);
  o = origin('dirt'); fill(o, '#7d5b3c'); speckle(o, ['#6b4c30', '#8c6848', '#5e4229', '#94714f'], 80);
  o = origin('grass_side');
  fill(o, '#7d5b3c'); speckle(o, ['#6b4c30', '#8c6848', '#5e4229'], 55);
  for (let x = 0; x < 16; x++) {
    const d = 3 + (atlasRng() < 0.45 ? 1 : 0) + (atlasRng() < 0.15 ? 1 : 0);
    for (let y = 0; y < d; y++) px(o, x, y, y === d - 1 ? '#5d9a40' : (atlasRng() < 0.3 ? '#78b955' : '#69a84a'));
  }
  o = origin('stone'); fill(o, '#8b8f93'); speckle(o, ['#7a7e82', '#9aa0a4', '#6f7377', '#a4aaae'], 70);
  for (let i = 0; i < 5; i++) { const x = (atlasRng() * 14) | 0, y = (atlasRng() * 14) | 0; px(o, x, y, '#6a6e72'); px(o, x + 1, y, '#6a6e72'); }
  o = origin('sand'); fill(o, '#ddcf9b'); speckle(o, ['#e8dcae', '#cdbf8b', '#d3c591'], 70);
  o = origin('water');
  g.clearRect(o[0], o[1], 16, 16);
  g.fillStyle = 'rgba(47,127,214,0.80)'; g.fillRect(o[0], o[1], 16, 16);
  for (let y = 2; y < 16; y += 5) {
    for (let x = (y % 2 ? 1 : 3); x < 16; x += 6) rect(o, x, y, 3, 1, 'rgba(120,190,245,0.8)');
  }
  o = origin('asphalt'); fill(o, '#3a3f45'); speckle(o, ['#444a51', '#30343a', '#4c535a'], 80);
  o = origin('line'); fill(o, '#3a3f45'); speckle(o, ['#444a51', '#30343a'], 50); rect(o, 0, 7, 16, 2, '#e8c34a');
  o = origin('road_white'); fill(o, '#3a3f45'); speckle(o, ['#444a51', '#30343a'], 50); rect(o, 0, 7, 16, 2, '#e8e8e0');
  o = origin('path'); fill(o, '#c9b98e'); speckle(o, ['#d8caa4', '#b7a67c', '#a89871', '#e0d3ae'], 80);
  o = origin('planks');
  fill(o, '#a9793f'); speckle(o, ['#9d6f38', '#b5854a'], 35);
  for (let y = 3; y < 16; y += 4) rect(o, 0, y, 16, 1, '#8a5f2f');
  rect(o, 7, 0, 1, 4, '#8a5f2f'); rect(o, 11, 4, 1, 4, '#8a5f2f'); rect(o, 4, 8, 1, 4, '#8a5f2f'); rect(o, 12, 12, 1, 4, '#8a5f2f');
  o = origin('log_side'); fill(o, '#6b4a2a');
  for (let x = 0; x < 16; x += 3) rect(o, x, 0, 1, 16, '#563a1f');
  for (let x = 1; x < 16; x += 4) rect(o, x, 0, 1, 16, '#7c5835');
  o = origin('log_top');
  fill(o, '#b08a55');
  g.strokeStyle = '#8a6a3e'; g.lineWidth = 1;
  for (let r = 2; r <= 6; r += 2) { g.beginPath(); g.arc(o[0] + 8, o[1] + 8, r, 0, Math.PI * 2); g.stroke(); }
  rect(o, 7, 7, 2, 2, '#6b4a2a');
  o = origin('leaves'); fill(o, '#3f7d33'); speckle(o, ['#356c2a', '#4c8f3e', '#2c5d23', '#589e46'], 120);
  o = origin('glass');
  g.clearRect(o[0], o[1], 16, 16);
  g.fillStyle = 'rgba(190,232,255,0.24)'; g.fillRect(o[0], o[1], 16, 16);
  rect(o, 0, 0, 16, 1, 'rgba(255,255,255,0.85)'); rect(o, 0, 15, 16, 1, 'rgba(255,255,255,0.75)');
  rect(o, 0, 0, 1, 16, 'rgba(255,255,255,0.8)'); rect(o, 15, 0, 1, 16, 'rgba(255,255,255,0.7)');
  rect(o, 3, 10, 1, 3, 'rgba(255,255,255,0.55)'); rect(o, 4, 9, 1, 1, 'rgba(255,255,255,0.55)');
  o = origin('roof_red'); fill(o, '#a94438'); for (let y = 0; y < 16; y += 4) { rect(o, 0, y, 16, 1, '#8e352b'); for (let x = (y % 8 ? 0 : 4); x < 16; x += 8) rect(o, x, y + 1, 1, 3, '#8e352b'); } speckle(o, ['#c0574a', '#7c2d25'], 30);
  o = origin('roof_blue'); fill(o, '#3f6f9e'); for (let y = 0; y < 16; y += 4) { rect(o, 0, y, 16, 1, '#345d86'); for (let x = (y % 8 ? 0 : 4); x < 16; x += 8) rect(o, x, y + 1, 1, 3, '#345d86'); } speckle(o, ['#4d80b0', '#2d5074'], 30);
  o = origin('roof_green'); fill(o, '#3f7d55'); for (let y = 0; y < 16; y += 4) { rect(o, 0, y, 16, 1, '#336847'); for (let x = (y % 8 ? 0 : 4); x < 16; x += 8) rect(o, x, y + 1, 1, 3, '#336847'); } speckle(o, ['#4d9168', '#2b5a3d'], 30);
  o = origin('white'); fill(o, '#dcdcd6'); speckle(o, ['#c9c9c3', '#efefe9', '#d2d2cc'], 40); rect(o, 0, 15, 16, 1, '#b9b9b3');
  o = origin('gray'); fill(o, '#8e9498'); speckle(o, ['#7d8387', '#9fa5a9', '#6f7579'], 50);
  o = origin('soil');
  fill(o, '#4e3927');
  for (let y = 0; y < 16; y += 4) rect(o, 0, y, 16, 1, '#3e2c1d');
  speckle(o, ['#5d452f', '#3a2919', '#6a5138'], 45);
  o = origin('wheat');
  g.clearRect(o[0], o[1], 16, 16);
  for (let x = 2; x < 16; x += 3) {
    rect(o, x, 6, 1, 10, '#7a9a3a');
    rect(o, x - 1, 4, 3, 1, '#d8b64a'); rect(o, x, 3, 1, 1, '#e8c95a');
    px(o, x + 1, 7, '#9ab84a'); px(o, x - 1, 10, '#9ab84a');
  }
  o = origin('carrot');
  g.clearRect(o[0], o[1], 16, 16);
  for (let x = 2; x < 16; x += 3) {
    rect(o, x, 8, 1, 8, '#4f8c38');
    rect(o, x - 1, 6, 1, 2, '#6fae4a'); rect(o, x + 1, 6, 1, 2, '#6fae4a');
    rect(o, x - 2, 9, 1, 1, '#6fae4a'); rect(o, x + 2, 9, 1, 1, '#6fae4a');
    px(o, x, 14, '#e08a2e'); px(o, x + 1, 15, '#e08a2e');
  }
  o = origin('flower_red');
  g.clearRect(o[0], o[1], 16, 16);
  rect(o, 7, 8, 2, 8, '#4f8c38'); rect(o, 5, 10, 2, 1, '#6fae4a'); rect(o, 9, 12, 2, 1, '#6fae4a');
  rect(o, 5, 4, 6, 4, '#c94a4a'); rect(o, 7, 3, 2, 6, '#c94a4a'); rect(o, 7, 5, 2, 2, '#f4d06a');
  o = origin('flower_yellow');
  g.clearRect(o[0], o[1], 16, 16);
  rect(o, 7, 8, 2, 8, '#4f8c38'); rect(o, 5, 11, 2, 1, '#6fae4a'); rect(o, 9, 12, 2, 1, '#6fae4a');
  rect(o, 5, 4, 6, 4, '#e8c34a'); rect(o, 7, 3, 2, 6, '#e8c34a'); rect(o, 7, 5, 2, 2, '#a8761e');
  o = origin('hedge'); fill(o, '#2f5f2a'); speckle(o, ['#285024', '#3c7134', '#22461e', '#477f3c'], 110);
  o = origin('sign');
  fill(o, '#b98a4e'); speckle(o, ['#a9793f', '#c79a5e'], 30);
  rect(o, 0, 0, 16, 1, '#6b4a2a'); rect(o, 0, 15, 16, 1, '#6b4a2a'); rect(o, 0, 0, 1, 16, '#6b4a2a'); rect(o, 15, 0, 1, 16, '#6b4a2a');
  for (let y = 4; y < 13; y += 3) { let x = 2; while (x < 14) { const w = 1 + ((atlasRng() * 3) | 0); rect(o, x, y, w, 1, '#4a3320'); x += w + 1; } }
  o = origin('awning');
  for (let x = 0; x < 16; x += 4) { rect(o, x, 0, 2, 16, '#2f7d4f'); rect(o, x + 2, 0, 2, 16, '#e8e8e0'); }
  rect(o, 0, 0, 16, 2, 'rgba(255,255,255,0.25)');
  const car = (name, body, light, dark) => {
    o = origin(name); fill(o, body); speckle(o, [light, dark], 28);
    rect(o, 0, 4, 16, 4, '#25313a'); rect(o, 1, 4, 3, 4, '#3d5566'); rect(o, 12, 4, 3, 4, '#3d5566');
    rect(o, 0, 13, 16, 2, '#d9d9d2'); rect(o, 0, 12, 2, 1, '#fff2b0'); rect(o, 14, 12, 2, 1, '#fff2b0');
  };
  car('car_red', '#b23a32', '#d9554a', '#8e2a24');
  car('car_blue', '#335f9e', '#4b7bbd', '#264a7c');
  car('car_silver', '#b9bec2', '#d5dade', '#979ca0');
  o = origin('counter');
  fill(o, '#5a3b25'); rect(o, 0, 0, 16, 4, '#8a5f36'); rect(o, 0, 4, 16, 1, '#3e2818');
  for (let x = 1; x < 16; x += 5) rect(o, x, 6, 3, 8, '#6b482c');
  speckle(o, ['#4a2f1c', '#6f4b2c'], 25);
  o = origin('bench');
  fill(o, '#a9793f');
  for (let y = 0; y < 16; y += 3) rect(o, 0, y, 16, 1, '#8a5f2f');
  rect(o, 2, 0, 1, 16, '#6b4a2a'); rect(o, 13, 0, 1, 16, '#6b4a2a');
  o = origin('lamp');
  fill(o, '#3a3f45'); rect(o, 3, 3, 10, 10, '#f4d06a'); rect(o, 5, 5, 6, 6, '#fff2b0'); rect(o, 0, 0, 2, 2, '#3a3f45'); rect(o, 14, 0, 2, 2, '#3a3f45');
  o = origin('plaza');
  fill(o, '#c9c4b4'); speckle(o, ['#d6d1c1', '#bdb8a8', '#b2ad9e'], 45);
  rect(o, 0, 0, 16, 1, '#a8a292'); rect(o, 0, 0, 1, 16, '#a8a292');
  o = origin('brick');
  fill(o, '#9c4a3c'); speckle(o, ['#8a4034', '#ad5747'], 40);
  for (let y = 0; y < 16; y += 4) rect(o, 0, y, 16, 1, '#d8cfc4');
  for (let y = 0; y < 16; y += 8) { rect(o, 7, y, 1, 4, '#d8cfc4'); rect(o, 15, y + 4, 1, 4, '#d8cfc4'); rect(o, 3, y + 4, 1, 4, '#d8cfc4'); }

  drawVendorTiles(g);
  return c;
}

// ------------------------------------------------------------------- world --
const WX = 96, WY = 48, WZ = 96, CH = 16;
const CX = WX / CH, CZ = WZ / CH;
const GROUND = 8;
const world = new Uint8Array(WX * WY * WZ);
const idx = (x, y, z) => x + WX * (z + WZ * y);
const inBounds = (x, y, z) => x >= 0 && x < WX && y >= 0 && y < WY && z >= 0 && z < WZ;

function getB(x, y, z) {
  if (!inBounds(x, y, z)) return AIR;
  return world[idx(x, y, z)];
}
function solidAt(x, y, z) {
  if (!inBounds(x, y, z)) return true;
  const d = DEF[world[idx(x, y, z)]];
  return !!(d && d.solid);
}
function setB(x, y, z, id) {
  if (!inBounds(x, y, z)) return false;
  const i = idx(x, y, z);
  if (world[i] === id) return false;
  world[i] = id;
  if (meshed) {
    const cx = (x / CH) | 0, cz = (z / CH) | 0;
    markDirty(cx, cz);
    if (x % CH === 0 && cx > 0) markDirty(cx - 1, cz);
    if (x % CH === CH - 1 && cx < CX - 1) markDirty(cx + 1, cz);
    if (z % CH === 0 && cz > 0) markDirty(cx, cz - 1);
    if (z % CH === CH - 1 && cz < CZ - 1) markDirty(cx, cz + 1);
  }
  return true;
}
function fillB(x0, y0, z0, x1, y1, z1, id) {
  const ax = Math.min(x0, x1), bx = Math.max(x0, x1);
  const ay = Math.min(y0, y1), by = Math.max(y0, y1);
  const az = Math.min(z0, z1), bz = Math.max(z0, z1);
  for (let y = ay; y <= by; y++)
    for (let z = az; z <= bz; z++)
      for (let x = ax; x <= bx; x++) setB(x, y, z, id);
}
function wall(x0, z0, x1, z1, y0, y1, id) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) { setB(x, y, z0, id); setB(x, y, z1, id); }
    for (let z = z0; z <= z1; z++) { setB(x0, y, z, id); setB(x1, y, z, id); }
  }
}

function tree(x, z, h) {
  if (!inBounds(x, GROUND + 1, z)) return;
  if (solidAt(x, GROUND + 1, z)) return;
  for (let dy = 1; dy <= h; dy++) setB(x, GROUND + dy, z, LOG);
  const top = GROUND + h;
  for (let dy = -2; dy <= 1; dy++) {
    const r = dy <= -1 ? 2 : 1;
    for (let dz = -r; dz <= r; dz++)
      for (let dx = -r; dx <= r; dx++) {
        if (dx === 0 && dz === 0 && dy <= 0) continue;
        if (Math.abs(dx) === r && Math.abs(dz) === r && r === 2) continue;
        const yy = top + dy;
        if (!solidAt(x + dx, yy, z + dz)) setB(x + dx, yy, z + dz, LEAVES);
      }
  }
}

function bench(x, z, alongX) {
  const ys = GROUND + 1;
  if (alongX) { setB(x, ys, z, BENCH); setB(x + 1, ys, z, BENCH); }
  else { setB(x, ys, z, BENCH); setB(x, ys, z + 1, BENCH); }
}
function lampPost(x, z) {
  setB(x, GROUND + 1, z, STONE); setB(x, GROUND + 2, z, LOG); setB(x, GROUND + 3, z, LOG); setB(x, GROUND + 4, z, LAMP);
}
function car(x, z, body, y) {
  const yy = y || GROUND + 1;
  for (let dz = 0; dz < 4; dz++)
    for (let dx = 0; dx < 2; dx++) {
      setB(x + dx, yy, z + dz, body);
      setB(x + dx, yy + 1, z + dz, dz === 1 || dz === 2 ? GLASS : body);
    }
  setB(x, yy + 1, z + 3, LAMP); setB(x + 1, yy + 1, z + 3, LAMP);
}

function genWorld() {
  world.fill(0);
  const rnd = rng32(20261101);

  // ground
  fillB(0, 0, 0, WX - 1, 4, WZ - 1, STONE);
  fillB(0, 5, 0, WX - 1, 7, WZ - 1, DIRT);
  fillB(0, GROUND, 0, WX - 1, GROUND, WZ - 1, GRASS);

  // sidewalks first, then the carriageway on top, so the junction is road
  fillB(0, GROUND, 42, WX - 1, GROUND, 43, PLAZA);
  fillB(0, GROUND, 50, WX - 1, GROUND, 51, PLAZA);
  fillB(42, GROUND, 0, 43, GROUND, WZ - 1, PLAZA);
  fillB(50, GROUND, 0, 51, GROUND, WZ - 1, PLAZA);

  // main street (east-west) and Western Ave (north-south)
  fillB(0, GROUND, 44, WX - 1, GROUND, 49, ASPHALT);
  fillB(0, GROUND, 46, WX - 1, GROUND, 46, LINE);
  fillB(44, GROUND, 0, 49, GROUND, WZ - 1, ASPHALT);
  fillB(46, GROUND, 0, 46, GROUND, WZ - 1, LINE);

  // spawn plaza (north of the main street); it pedestrianises Western Ave
  fillB(38, GROUND, 30, 58, GROUND, 41, PLAZA);

  // pale beginner paths
  fillB(25, GROUND, 31, 38, GROUND, 36, PATH);       // to the garden
  fillB(25, GROUND, 37, 25, GROUND, 39, PATH);
  fillB(50, GROUND, 35, 58, GROUND, 36, PATH);       // across to the park
  fillB(58, GROUND, 34, 72, GROUND, 36, PATH);
  fillB(72, GROUND, 28, 72, GROUND, 33, PATH);
  fillB(48, GROUND, 50, 48, GROUND, 83, PATH);       // to the sandbox
  fillB(49, GROUND, 52, 49, GROUND, 83, PATH);
  fillB(50, GROUND, 52, 66, GROUND, 72, PATH);       // to the coffee shop
  fillB(66, GROUND, 71, 68, GROUND, 72, PATH);
  fillB(25, GROUND, 50, 25, GROUND, 57, PATH);       // to the dealership
  fillB(26, GROUND, 52, 30, GROUND, 57, PATH);

  // zebra crossings
  for (const x of [25, 48, 52]) {
    for (let z = 44; z <= 49; z++) if (z % 2 === 0) fillB(x, GROUND, z, x + 1, GROUND, z, ROAD_WHITE);
  }
  for (let x = 44; x <= 49; x++) if (x % 2 === 0) fillB(x, GROUND, 34, x, GROUND, 35, ROAD_WHITE);

  // ---------------------------------------------------------- community garden
  const gx0 = 10, gx1 = 39, gz0 = 10, gz1 = 39;
  // hedge border with two openings
  for (let y = GROUND + 1; y <= GROUND + 2; y++) {
    for (let x = gx0; x <= gx1; x++) {
      if (!(x >= 24 && x <= 26)) { setB(x, y, gz1, HEDGE); }
      if (!(x >= 24 && x <= 26)) { setB(x, y, gz0, HEDGE); }
    }
    for (let z = gz0; z <= gz1; z++) {
      if (!(z >= 24 && z <= 26)) { setB(gx1, y, z, HEDGE); }
      if (!(z >= 24 && z <= 26)) { setB(gx0, y, z, HEDGE); }
    }
  }
  // cross paths
  fillB(24, GROUND, 12, 26, GROUND, 38, PATH);
  fillB(12, GROUND, 24, 38, GROUND, 26, PATH);
  // beds
  const beds = [[14, 14, 19, 20], [30, 14, 35, 20], [14, 30, 19, 36], [30, 30, 35, 36]];
  beds.forEach((b, bi) => {
    fillB(b[0], GROUND, b[1], b[2], GROUND, b[3], SOIL);
    for (let z = b[1] + 1; z <= b[3] - 1; z += 2) {
      for (let x = b[0] + 1; x <= b[2] - 1; x += 2) {
        setB(x, GROUND + 1, z, (bi + x + z) % 3 === 0 ? CARROT : WHEAT);
      }
    }
  });
  // trough
  fillB(21, GROUND + 1, 17, 23, GROUND + 1, 19, STONE);
  setB(22, GROUND, 18, WATER);
  setB(22, GROUND + 1, 18, AIR);
  // shed
  fillB(31, GROUND, 11, 37, GROUND, 16, PLANKS);
  fillB(31, GROUND + 1, 11, 37, GROUND + 3, 11, PLANKS);
  fillB(31, GROUND + 1, 16, 37, GROUND + 3, 16, PLANKS);
  fillB(31, GROUND + 1, 12, 31, GROUND + 3, 15, PLANKS);
  fillB(37, GROUND + 1, 12, 37, GROUND + 3, 15, PLANKS);
  fillB(34, GROUND + 1, 16, 35, GROUND + 2, 16, AIR); // door
  fillB(31, GROUND + 4, 11, 37, GROUND + 4, 16, ROOF_RED);
  setB(33, GROUND + 1, 14, COUNTER); setB(36, GROUND + 1, 14, BENCH);
  // signs and furniture
  setB(25, GROUND + 1, 38, SIGN); setB(25, GROUND + 2, 38, SIGN);
  setB(38, GROUND + 1, 25, SIGN);
  bench(20, 28, true); bench(29, 22, true);
  for (let i = 0; i < 14; i++) {
    const x = 12 + ((rnd() * 26) | 0), z = 12 + ((rnd() * 26) | 0);
    if (getB(x, GROUND, z) === GRASS && getB(x, GROUND + 1, z) === AIR)
      setB(x, GROUND + 1, z, rnd() < 0.5 ? FLOWER_R : FLOWER_Y);
  }
  tree(12, 12, 5); tree(37, 12, 5); tree(13, 27, 4); tree(36, 33, 4);

  // ------------------------------------------------------------- lago seco park
  const px = 73, pz = 25, prx = 11, prz = 8;
  for (let z = pz - prz - 2; z <= pz + prz + 2; z++) {
    for (let x = px - prx - 2; x <= px + prx + 2; x++) {
      const d = ((x - px) / prx) ** 2 + ((z - pz) / prz) ** 2;
      if (d <= 1) {
        setB(x, GROUND, z, WATER);
        setB(x, GROUND - 1, z, WATER);
        setB(x, GROUND - 2, z, WATER);
        setB(x, GROUND - 3, z, SAND);
      } else if (d <= 1.22) {
        setB(x, GROUND, z, SAND);
      }
    }
  }
  // pier
  fillB(72, GROUND + 1, 27, 73, GROUND + 1, 35, PLANKS);
  for (const zz of [28, 32, 35]) { setB(72, GROUND, zz, LOG); setB(73, GROUND, zz, LOG); }
  // gazebo
  fillB(80, GROUND, 12, 84, GROUND, 16, PLAZA);
  for (const [x, z] of [[80, 12], [84, 12], [80, 16], [84, 16]]) fillB(x, GROUND + 1, z, x, GROUND + 3, z, LOG);
  fillB(79, GROUND + 4, 11, 85, GROUND + 4, 17, ROOF_BLUE);
  fillB(80, GROUND + 5, 12, 84, GROUND + 5, 16, ROOF_BLUE);
  fillB(81, GROUND + 6, 13, 83, GROUND + 6, 15, ROOF_BLUE);
  bench(66, 30, true); bench(80, 28, true); bench(72, 19, true);
  setB(59, GROUND + 1, 33, SIGN); setB(59, GROUND + 2, 33, SIGN);
  for (let i = 0; i < 26; i++) {
    const x = 59 + ((rnd() * 28) | 0), z = 11 + ((rnd() * 28) | 0);
    if (getB(x, GROUND, z) === GRASS && getB(x, GROUND + 1, z) === AIR)
      setB(x, GROUND + 1, z, rnd() < 0.5 ? FLOWER_Y : FLOWER_R);
  }
  tree(60, 12, 5); tree(87, 12, 6); tree(60, 37, 5); tree(87, 37, 6); tree(66, 39, 4); tree(79, 39, 4); tree(61, 19, 4);

  // ------------------------------------------------------------ the coffee bean
  const cx0 = 62, cx1 = 74, cz0 = 60, cz1 = 70;
  fillB(cx0, GROUND, cz0, cx1, GROUND, cz1, PLAZA);
  // walls
  fillB(cx0, GROUND + 1, cz0, cx1, GROUND + 3, cz0, WHITE);
  fillB(cx0, GROUND + 1, cz1, cx1, GROUND + 3, cz1, WHITE);
  fillB(cx0, GROUND + 1, cz0, cx0, GROUND + 3, cz1, WHITE);
  fillB(cx1, GROUND + 1, cz0, cx1, GROUND + 3, cz1, WHITE);
  // windows
  fillB(63, GROUND + 2, cz1, 66, GROUND + 2, cz1, GLASS);
  fillB(70, GROUND + 2, cz1, 73, GROUND + 2, cz1, GLASS);
  fillB(cx0, GROUND + 2, 63, cx0, GROUND + 2, 67, GLASS);
  fillB(cx1, GROUND + 2, 63, cx1, GROUND + 2, 67, GLASS);
  // door
  fillB(68, GROUND + 1, cz1, 69, GROUND + 2, cz1, AIR);
  // roof and awning
  fillB(cx0 - 1, GROUND + 4, cz0 - 1, cx1 + 1, GROUND + 4, cz1 + 1, ROOF_GREEN);
  fillB(66, GROUND + 3, cz1 + 1, 71, GROUND + 3, cz1 + 2, AIR);
  fillB(66, GROUND + 3, cz1 + 1, 71, GROUND + 3, cz1 + 2, AWNING);
  for (const x of [66, 71]) fillB(x, GROUND + 1, cz1 + 2, x, GROUND + 2, cz1 + 2, LOG);
  // sign band
  fillB(66, GROUND + 3, cz1, 71, GROUND + 3, cz1, SIGN);
  // interior
  fillB(65, GROUND + 1, 65, 71, GROUND + 1, 65, COUNTER);
  fillB(64, GROUND + 1, 68, 66, GROUND + 1, 68, BENCH);
  fillB(70, GROUND + 1, 68, 72, GROUND + 1, 68, BENCH);
  setB(65, GROUND + 2, 65, COUNTER); setB(71, GROUND + 2, 65, COUNTER);
  setB(66, GROUND + 3, 65, LAMP); setB(70, GROUND + 3, 65, LAMP);
  // patio
  fillB(62, GROUND, 71, 74, GROUND, 76, PLAZA);
  bench(63, 74, true); bench(71, 74, true);
  fillB(62, GROUND + 1, 76, 62, GROUND + 1, 76, HEDGE); fillB(74, GROUND + 1, 76, 74, GROUND + 1, 76, HEDGE);
  lampPost(62, 71); lampPost(74, 71);
  tree(59, 59, 4); tree(77, 59, 4); tree(59, 77, 4); tree(77, 77, 4);

  // ---------------------------------------------------------- martin chevrolet
  fillB(12, GROUND, 58, 38, GROUND, 80, ASPHALT);
  for (const z of [65, 70, 75]) fillB(14, GROUND, z, 22, GROUND, z, ROAD_WHITE);
  for (const z of [65, 70, 75]) fillB(28, GROUND, z, 36, GROUND, z, ROAD_WHITE);
  // office
  fillB(14, GROUND, 58, 22, GROUND, 64, PLAZA);
  wall(14, 58, 22, 64, GROUND + 1, GROUND + 3, WHITE);
  fillB(14, GROUND + 1, 64, 22, GROUND + 2, 64, GLASS);
  fillB(17, GROUND + 1, 64, 18, GROUND + 2, 64, AIR);
  fillB(13, GROUND + 4, 57, 23, GROUND + 4, 65, GRAY);
  fillB(17, GROUND + 4, 64, 19, GROUND + 4, 64, SIGN);
  // cars
  car(16, 66, CAR_R); car(16, 71, CAR_B); car(30, 66, CAR_S); car(30, 71, CAR_R);
  car(16, 76, CAR_B); car(30, 76, CAR_S);
  // podium
  fillB(24, GROUND + 1, 76, 27, GROUND + 1, 79, BRICK);
  car(24, 76, CAR_S, GROUND + 2);
  // sign tower and flags
  fillB(13, GROUND + 1, 57, 13, GROUND + 4, 57, BRICK);
  fillB(13, GROUND + 5, 57, 13, GROUND + 5, 57, SIGN);
  for (const x of [36, 37]) { fillB(x, GROUND + 1, 58, x, GROUND + 4, 58, LOG); setB(x, GROUND + 5, 58, AWNING); }
  bench(11, 68, false); bench(39, 68, false);
  tree(11, 57, 4); tree(39, 57, 4); tree(11, 81, 4); tree(39, 81, 4);

  // -------------------------------------------------------------- free build
  fillB(40, GROUND, 84, 56, GROUND, 92, PATH);
  setB(46, GROUND + 1, 83, SIGN); setB(46, GROUND + 2, 83, SIGN);
  const samples = [GRASS, PLANKS, GLASS, BRICK];
  samples.forEach((s, i) => {
    const x = 42 + i * 4;
    fillB(x, GROUND + 1, 88, x + 1, GROUND + 1, 88, STONE);
    setB(x, GROUND + 2, 88, s);
  });

  // ---------------------------------------------------------- farmers market
  for (const z0 of [29, 36]) {
    for (const [x, z] of [[53, z0], [57, z0], [53, z0 + 4], [57, z0 + 4]])
      fillB(x, GROUND + 1, z, x, GROUND + 3, z, LOG);
    fillB(53, GROUND + 1, z0 + 3, 57, GROUND + 1, z0 + 3, PLANKS);
    fillB(53, GROUND + 4, z0 - 1, 58, GROUND + 4, z0 + 5, AWNING);
    setB(54, GROUND + 1, z0 + 1, PLANKS); setB(55, GROUND + 1, z0 + 1, PLANKS);
    setB(54, GROUND + 2, z0 + 1, WHEAT); setB(55, GROUND + 2, z0 + 1, CARROT);
    setB(56, GROUND + 1, z0 + 1, SIGN);
  }

  // ------------------------------------------------------------ plaza fountain
  fillB(40, GROUND + 1, 32, 44, GROUND + 1, 36, BRICK);
  fillB(41, GROUND + 1, 33, 43, GROUND + 1, 35, WATER);
  fillB(42, GROUND + 2, 34, 42, GROUND + 4, 34, STONE);
  setB(42, GROUND + 5, 34, LAMP);
  bench(39, 31, false); bench(45, 37, false);

  // ---------------------------------------------------------------- playground
  fillB(60, GROUND, 36, 65, GROUND, 39, SAND);
  for (const [x, z] of [[64, 36], [64, 39], [66, 36], [66, 39]])
    fillB(x, GROUND + 1, z, x, GROUND + 3, z, LOG);
  fillB(63, GROUND + 4, 35, 67, GROUND + 4, 40, PLANKS);
  setB(63, GROUND + 3, 36, PLANKS); setB(62, GROUND + 2, 36, PLANKS); setB(61, GROUND + 1, 36, PLANKS);
  fillB(60, GROUND + 1, 38, 60, GROUND + 3, 38, LOG);
  fillB(63, GROUND + 1, 38, 63, GROUND + 3, 38, LOG);
  fillB(60, GROUND + 4, 38, 63, GROUND + 4, 38, LOG);
  setB(61, GROUND + 3, 38, BENCH); setB(62, GROUND + 3, 38, BENCH);
  setB(60, GROUND + 1, 35, SIGN);

  // ------------------------------------------------------------------ bus stop
  fillB(60, GROUND + 1, 43, 63, GROUND + 3, 43, GLASS);
  fillB(60, GROUND + 1, 42, 60, GROUND + 3, 43, GLASS);
  fillB(63, GROUND + 1, 42, 63, GROUND + 3, 43, GLASS);
  fillB(60, GROUND + 4, 42, 63, GROUND + 4, 43, GRAY);
  bench(61, 42, true);
  setB(60, GROUND + 4, 42, SIGN);

  // --------------------------------------------------------------- food truck
  fillB(56, GROUND, 72, 61, GROUND, 77, PATH);
  fillB(57, GROUND + 1, 73, 60, GROUND + 2, 76, WHITE);
  fillB(60, GROUND + 2, 74, 60, GROUND + 2, 75, GLASS);
  fillB(61, GROUND + 3, 73, 61, GROUND + 3, 76, AWNING);
  setB(57, GROUND + 1, 73, ROAD_WHITE); setB(60, GROUND + 1, 76, ROAD_WHITE);
  setB(61, GROUND + 1, 72, SIGN);

  // -------------------------------------------------------------- picnic tables
  fillB(84, GROUND, 32, 87, GROUND, 35, ROOF_RED);
  fillB(85, GROUND + 1, 33, 86, GROUND + 1, 33, PLANKS);
  setB(85, GROUND + 1, 32, BENCH); setB(86, GROUND + 1, 32, BENCH);
  setB(85, GROUND + 1, 34, BENCH); setB(86, GROUND + 1, 34, BENCH);
  fillB(83, GROUND + 1, 31, 83, GROUND + 3, 31, LOG);
  fillB(82, GROUND + 4, 30, 84, GROUND + 4, 32, AWNING);
  lampPost(88, 36);

  // ------------------------------------------------------------- notice board
  fillB(38, GROUND + 1, 30, 38, GROUND + 3, 30, LOG);
  fillB(38, GROUND + 1, 32, 38, GROUND + 3, 32, LOG);
  fillB(38, GROUND + 4, 30, 38, GROUND + 4, 32, PLANKS);
  setB(38, GROUND + 3, 31, SIGN); setB(38, GROUND + 2, 31, SIGN);

  // ------------------------------------------------------------- local businesses
  const shop = (x, z, roof) => {
    fillB(x, GROUND, z, x + 3, GROUND, z + 3, PLANKS);
    fillB(x, GROUND + 1, z, x + 3, GROUND + 3, z, WHITE);
    fillB(x, GROUND + 1, z + 3, x + 3, GROUND + 3, z + 3, WHITE);
    fillB(x, GROUND + 1, z, x, GROUND + 3, z + 3, WHITE);
    fillB(x + 3, GROUND + 1, z, x + 3, GROUND + 3, z + 3, WHITE);
    fillB(x + 1, GROUND + 1, z + 3, x + 2, GROUND + 2, z + 3, AIR);
    fillB(x, GROUND + 4, z, x + 3, GROUND + 4, z + 3, roof);
    fillB(x + 1, GROUND + 3, z + 3, x + 2, GROUND + 3, z + 3, SIGN);
  };
  shop(52, 8, ROOF_RED);    // Torrance Bakery
  shop(52, 14, ROOF_BLUE);  // Red Car Brewery
  shop(39, 60, ROOF_GREEN); // Old Torrance Antiques
  shop(39, 66, ROOF_RED);   // Madre!

  // ------------------------------------------------------------------ greenery
  for (let i = 0; i < 220; i++) {
    const x = 2 + ((rnd() * (WX - 4)) | 0);
    const z = 2 + ((rnd() * (WZ - 4)) | 0);
    if (getB(x, GROUND, z) === GRASS && getB(x, GROUND + 1, z) === AIR) {
      const r = rnd();
      setB(x, GROUND + 1, z, r < 0.58 ? TUFT : r < 0.79 ? FLOWER_Y : FLOWER_R);
    }
  }

  // ------------------------------------------------------------ street furniture
  const streetTrees = [[9, 41], [21, 41], [33, 41], [59, 41], [70, 41], [82, 41],
                       [9, 52], [21, 52], [33, 52], [58, 52], [70, 52], [82, 52],
                       [41, 9], [41, 21], [41, 33], [56, 8], [52, 21], [52, 60], [43, 58], [41, 72], [52, 72]];
  streetTrees.forEach(([x, z]) => tree(x, z, 4));
  const lamps = [[7, 43], [19, 43], [31, 43], [57, 43], [69, 43], [81, 43],
                 [7, 50], [19, 50], [31, 50], [57, 50], [69, 50], [81, 50],
                 [43, 9], [43, 21], [43, 33], [50, 60], [50, 72]];
  lamps.forEach(([x, z]) => lampPost(x, z));
  bench(39, 38, true); bench(46, 39, true); bench(39, 29, true); bench(50, 29, true);

  // -------------------------------------------------------------- world border
  for (let y = GROUND + 1; y <= GROUND + 3; y++) {
    for (let x = 0; x < WX; x++) { setB(x, y, 0, HEDGE); setB(x, y, WZ - 1, HEDGE); }
    for (let z = 0; z < WZ; z++) { setB(0, y, z, HEDGE); setB(WX - 1, y, z, HEDGE); }
  }

  // -------------------------------------------------------------- spawn arch
  fillB(44, GROUND + 1, 41, 44, GROUND + 4, 41, BRICK);
  fillB(52, GROUND + 1, 41, 52, GROUND + 4, 41, BRICK);
  fillB(45, GROUND + 1, 41, 51, GROUND + 3, 41, AIR);
  fillB(44, GROUND + 5, 41, 52, GROUND + 5, 41, PLANKS);
  fillB(46, GROUND + 4, 41, 50, GROUND + 4, 41, SIGN);
  fillB(46, GROUND + 1, 30, 50, GROUND + 3, 34, AIR);
}

// ------------------------------------------------------------------ meshing --
const FACES = [
  { dir: [0, 1, 0],  shade: 1.00, uv: [[0, 0], [0, 1], [1, 1], [1, 0]], c: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] },
  { dir: [0, -1, 0], shade: 0.52, uv: [[0, 1], [1, 1], [1, 0], [0, 0]], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { dir: [0, 0, 1],  shade: 0.82, uv: [[0, 1], [1, 1], [1, 0], [0, 0]], c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
  { dir: [0, 0, -1], shade: 0.82, uv: [[0, 1], [1, 1], [1, 0], [0, 0]], c: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] },
  { dir: [1, 0, 0],  shade: 0.66, uv: [[0, 1], [1, 1], [1, 0], [0, 0]], c: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]] },
  { dir: [-1, 0, 0], shade: 0.66, uv: [[0, 1], [1, 1], [1, 0], [0, 0]], c: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] }
];

function faceVisible(nid, self) {
  if (nid === AIR) return true;
  const nd = DEF[nid];
  if (!nd) return true;
  if (nd.cross) return true;
  if (nid === self && nd.alpha) return false;
  if (nd.opaque) return false;
  return true;
}

function tileUV(name, out) {
  const i = TILE[name];
  const col = i % ATLAS_COLS, row = Math.floor(i / ATLAS_COLS);
  const pad = 0.5;
  out[0] = (col * TILE_PX + pad) / ATLAS_PX;
  out[1] = (row * TILE_PX + pad) / ATLAS_PX;
  out[2] = (TILE_PX - 2 * pad) / ATLAS_PX;
}

const _uv = [0, 0, 0];
function pushFace(arr, x, y, z, f, id) {
  const F = FACES[f];
  const name = (f === 0 ? DEF[id].top : f === 1 ? (DEF[id].bottom || DEF[id].top) : (DEF[id].side || DEF[id].top));
  tileUV(name, _uv);
  const u0 = _uv[0], v0 = _uv[1], step = _uv[2];
  const verts = [];
  for (let k = 0; k < 4; k++) {
    const c = F.c[k], uv = F.uv[k];
    verts.push([
      x + c[0], y + c[1], z + c[2],
      u0 + uv[0] * step, v0 + uv[1] * step,
      F.shade
    ]);
  }
  for (const k of [0, 1, 2, 0, 2, 3]) {
    const v = verts[k];
    arr.push(v[0], v[1], v[2], v[3], v[4], v[5]);
  }
}

function pushCross(arr, x, y, z, id) {
  const d = DEF[id];
  tileUV(d.top, _uv);
  const u0 = _uv[0], v0 = _uv[1], step = _uv[2];
  const quads = [
    [[0.15, 0, 0.15], [0.85, 0, 0.85], [0.85, 1, 0.85], [0.15, 1, 0.15]],
    [[0.85, 0, 0.15], [0.15, 0, 0.85], [0.15, 1, 0.85], [0.85, 1, 0.15]]
  ];
  const uvs = [[0, 1], [1, 1], [1, 0], [0, 0]];
  for (const q of quads) {
    const vs = q.map((c, k) => [x + c[0], y + c[1], z + c[2], u0 + uvs[k][0] * step, v0 + uvs[k][1] * step, 0.92]);
    for (const k of [0, 1, 2, 0, 2, 3]) {
      const v = vs[k];
      arr.push(v[0], v[1], v[2], v[3], v[4], v[5]);
    }
  }
}

function buildChunk(cx, cz) {
  const op = [], wa = [], cu = [];
  const x0 = cx * CH, z0 = cz * CH;
  for (let y = 0; y < WY; y++) {
    for (let z = z0; z < z0 + CH; z++) {
      for (let x = x0; x < x0 + CH; x++) {
        const id = world[idx(x, y, z)];
        if (!id) continue;
        const d = DEF[id];
        if (d.cross) { pushCross(cu, x, y, z, id); continue; }
        const arr = d.alpha ? wa : op;
        for (let f = 0; f < 6; f++) {
          const dir = FACES[f].dir;
          const nid = getB(x + dir[0], y + dir[1], z + dir[2]);
          if (faceVisible(nid, id)) pushFace(arr, x, y, z, f, id);
        }
      }
    }
  }
  return { op, wa, cu };
}

// ----------------------------------------------------------------- renderer --
const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, depth: true, powerPreference: 'high-performance' });
if (!gl) {
  document.body.innerHTML = '<div style="padding:24px;color:#fff;background:#111;font:14px monospace">WebGL2 is not available in this WebView.</div>';
  return;
}

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + '\n' + src);
  return s;
}
function program(vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

const blockProg = program(`#version 300 es
in vec3 aPos; in vec2 aUV; in float aShade;
uniform mat4 uVP; uniform vec3 uEye;
out vec2 vUV; out float vShade; out float vDist;
void main() {
  gl_Position = uVP * vec4(aPos, 1.0);
  vUV = aUV; vShade = aShade; vDist = distance(aPos, uEye);
}`, `#version 300 es
precision mediump float;
in vec2 vUV; in float vShade; in float vDist;
uniform sampler2D uTex;
uniform vec3 uFog;
uniform float uFogNear, uFogFar, uAlphaTest;
out vec4 outColor;
void main() {
  vec4 c = texture(uTex, vUV);
  if (c.a < uAlphaTest) discard;
  vec3 col = c.rgb * vShade;
  col = mix(col, uFog, smoothstep(uFogNear, uFogFar, vDist));
  outColor = vec4(col, c.a);
}`);

const skyProg = program(`#version 300 es
uniform vec3 uFwd, uRight, uUp;
uniform vec2 uTan;
out vec3 vDir;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  vDir = uFwd + uRight * p.x * uTan.x + uUp * p.y * uTan.y;
  gl_Position = vec4(p, 0.999, 1.0);
}`, `#version 300 es
precision mediump float;
in vec3 vDir;
uniform vec3 uSun;
out vec4 outColor;
void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y, -1.0, 1.0);
  vec3 zen = vec3(0.34, 0.61, 0.88);
  vec3 hor = vec3(1.00, 0.84, 0.64);
  vec3 col = mix(hor, zen, smoothstep(0.0, 0.55, h));
  float s = max(dot(d, normalize(uSun)), 0.0);
  col += vec3(1.0, 0.84, 0.48) * pow(s, 600.0) * 1.5;
  col += vec3(1.0, 0.62, 0.28) * pow(s, 12.0) * 0.14;
  if (h < 0.0) col = mix(hor, vec3(0.42, 0.50, 0.32), smoothstep(0.0, -0.35, h));
  outColor = vec4(col, 1.0);
}`);

const lineProg = program(`#version 300 es
in vec3 aPos;
uniform mat4 uVP;
void main() { gl_Position = uVP * vec4(aPos, 1.0); }`, `#version 300 es
precision mediump float;
uniform vec4 uColor;
out vec4 outColor;
void main() { outColor = uColor; }`);

const spriteProg = program(`#version 300 es
in vec2 aCorner;
uniform mat4 uVP;
uniform vec3 uCenter, uRight, uUp;
uniform vec2 uSize;
out vec2 vUV;
void main() {
  vec3 p = uCenter + uRight * (aCorner.x - 0.5) * uSize.x + uUp * (aCorner.y - 0.5) * uSize.y;
  vUV = vec2(aCorner.x, 1.0 - aCorner.y);
  gl_Position = uVP * vec4(p, 1.0);
}`, `#version 300 es
precision mediump float;
in vec2 vUV;
uniform sampler2D uTex;
uniform float uAlpha;
out vec4 outColor;
void main() {
  vec4 c = texture(uTex, vUV);
  if (c.a < 0.12) discard;
  outColor = vec4(c.rgb, c.a * uAlpha);
}`);

const spriteTex = {};
const spriteQuad = gl.createVertexArray();
{
  const v = new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]);
  gl.bindVertexArray(spriteQuad);
  const b = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, b);
  gl.bufferData(gl.ARRAY_BUFFER, v, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
}
function loadSprites() {
  const map = (window.__SPRITES__ && typeof window.__SPRITES__ === 'object') ? window.__SPRITES__ : {};
  for (const [name, src] of Object.entries(map)) {
    const img = new Image();
    img.onload = () => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      spriteTex[name] = t;
    };
    img.src = src;
  }
}
function drawBillboard(name, x, y, z, sx, sy, alpha) {
  const t = spriteTex[name];
  if (!t) return;
  gl.useProgram(spriteProg);
  gl.uniformMatrix4fv(gl.getUniformLocation(spriteProg, 'uVP'), false, vp);
  gl.uniform3f(gl.getUniformLocation(spriteProg, 'uCenter'), x, y, z);
  gl.uniform3f(gl.getUniformLocation(spriteProg, 'uRight'), right[0], right[1], right[2]);
  gl.uniform3f(gl.getUniformLocation(spriteProg, 'uUp'), up[0], up[1], up[2]);
  gl.uniform2f(gl.getUniformLocation(spriteProg, 'uSize'), sx, sy);
  gl.uniform1f(gl.getUniformLocation(spriteProg, 'uAlpha'), alpha === undefined ? 1 : alpha);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.uniform1i(gl.getUniformLocation(spriteProg, 'uTex'), 0);
  gl.bindVertexArray(spriteQuad);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  gl.bindVertexArray(null);
}

atlas = buildAtlas();
const tex = gl.createTexture();
function uploadAtlas() {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
}
uploadAtlas();
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

const skyVao = gl.createVertexArray();

function upload(arr) {
  if (!arr.length) return null;
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(arr), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 24, 12);
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 24, 20);
  gl.bindVertexArray(null);
  return { vao, buf, count: arr.length / 6 };
}

const chunks = [];
let meshed = false;
const dirty = new Set();
function markDirty(cx, cz) {
  if (cx < 0 || cx >= CX || cz < 0 || cz >= CZ) return;
  dirty.add(cz * CX + cx);
}
function freeChunk(c) {
  if (!c) return;
  for (const k of ['op', 'wa', 'cu']) if (c[k]) { gl.deleteBuffer(c[k].buf); gl.deleteVertexArray(c[k].vao); }
}
function remesh(i) {
  const cx = i % CX, cz = (i / CX) | 0;
  const data = buildChunk(cx, cz);
  const old = chunks[i];
  const c = {};
  for (const k of ['op', 'wa', 'cu']) c[k] = upload(data[k]);
  if (old) for (const k of ['op', 'wa', 'cu']) { if (old[k]) { gl.deleteBuffer(old[k].buf); gl.deleteVertexArray(old[k].vao); } }
  chunks[i] = c;
}
function meshAll() {
  for (let i = 0; i < CX * CZ; i++) remesh(i);
  dirty.clear();
  meshed = true;
  buildMapBase();
}

// ------------------------------------------------------------------- player --
const GAME_DAY_MS = 60 * 60 * 1000;
function gameDay(ms) { return Math.floor((ms === undefined ? Date.now() : ms) / GAME_DAY_MS); }
function gameDayStart(ms) { return gameDay(ms) * GAME_DAY_MS; }
function parseExifDate(text) {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(text || '');
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}

const player = {
  x: SPAWN.x, y: SPAWN.y, z: SPAWN.z,
  vx: 0, vy: 0, vz: 0,
  yaw: SPAWN.yaw, pitch: SPAWN.pitch,
  onGround: false, fly: false, inWater: false
};
const EYE = 1.62, HALF = 0.30, HEIGHT = 1.8;

function eyePos() { return [player.x, player.y + EYE, player.z]; }
function forwardVec() {
  const cp = Math.cos(player.pitch);
  return [Math.sin(player.yaw) * cp, Math.sin(player.pitch), -Math.cos(player.yaw) * cp];
}
function playerCollides() {
  if (player.x < 1.4 || player.x > WX - 1.4 || player.z < 1.4 || player.z > WZ - 1.4) return true;
  const x0 = Math.floor(player.x - HALF), x1 = Math.floor(player.x + HALF);
  const y0 = Math.floor(player.y + 0.02), y1 = Math.floor(player.y + HEIGHT - 0.02);
  const z0 = Math.floor(player.z - HALF), z1 = Math.floor(player.z + HALF);
  for (let y = y0; y <= y1; y++)
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++)
        if (solidAt(x, y, z)) return true;
  return false;
}
function moveAxis(axis, amount) {
  if (!amount) return true;
  const old = player[axis];
  player[axis] += amount;
  if (!playerCollides()) return true;
  if (axis !== 'y' && (player.onGround || player.fly) && !player.fly) {
    player.y += 1.02;
    if (!playerCollides()) return true;
    player.y -= 1.02;
  }
  player[axis] = old;
  return false;
}
function inWaterAt(x, y, z) { return getB(Math.floor(x), Math.floor(y), Math.floor(z)) === WATER; }

// -------------------------------------------------------------------- input --
const keys = Object.create(null);
let jumpHeld = false, breakHeld = false, placeHeld = false;
let actionCooldown = 0;
let pointerLocked = false;
let dragLook = false, dragId = null, dragX = 0, dragY = 0, dragTotal = 0;
const joy = { id: null, x: 0, y: 0, cx: 0, cy: 0 };
const knob = $('knob'), stick = $('stick');

function lockPointer() {
  try {
    const p = canvas.requestPointerLock?.();
    if (p && p.catch) p.catch(() => {});
  } catch (e) {}
}

function setKey(code, down) {
  keys[code] = down;
  if (down && code === 'KeyF') { player.fly = !player.fly; player.vy = 0; toast(player.fly ? 'FLY ON · Space up · Shift down' : 'FLY OFF'); }
  if (down && code === 'KeyM') toggleMap();
  if (down && code === 'KeyH') openHelp();
  if (down && code === 'KeyE') { if (dialogueNPC) advanceDialogue(); else if (nearBiz && !state.farmed.includes(nearBiz.id)) beginClaim(nearBiz); else if (nearNPC) openDialogue(nearNPC); }
  if (down && code === 'KeyT') showChat(true);
  if (down && code === 'Escape') { showChat(false); closeDialogue(); closeModals(); }
  if (down && /^Digit[1-9]$/.test(code)) selectSlot(Number(code.slice(5)) - 1);
}

addEventListener('keydown', (e) => {
  const tag = e.target && e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
  if (e.repeat) return;
  setKey(e.code, true);
  if (e.code === 'KeyW' || e.code === 'KeyA' || e.code === 'KeyS' || e.code === 'KeyD') hideHint();
});
addEventListener('keyup', (e) => setKey(e.code, false));
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === canvas;
  if (!pointerLocked) showHint(IS_TOUCH ? '' : 'Click to look around · WASD to move');
});
document.addEventListener('mousemove', (e) => {
  if (pointerLocked) {
    player.yaw -= e.movementX * 0.0023;
    player.pitch = clamp(player.pitch - e.movementY * 0.0023, -1.45, 1.45);
  }
});

canvas.addEventListener('mousedown', (e) => {
  if (e.button === 0) {
    if (!pointerLocked && !IS_TOUCH) dragLook = true;
    else breakHeld = true;
  }
  if (e.button === 2) placeHeld = true;
  dragX = e.clientX; dragY = e.clientY; dragTotal = 0;
  e.preventDefault();
});
addEventListener('mouseup', (e) => {
  if (e.button === 0) {
    breakHeld = false;
    if (dragLook && dragTotal < 4 && !IS_TOUCH) lockPointer();
    dragLook = false;
  }
  if (e.button === 2) placeHeld = false;
});
addEventListener('mousemove', (e) => {
  if (dragLook && !pointerLocked) {
    const dx = e.clientX - dragX, dy = e.clientY - dragY;
    dragTotal += Math.abs(dx) + Math.abs(dy);
    player.yaw -= dx * 0.005;
    player.pitch = clamp(player.pitch - dy * 0.005, -1.45, 1.45);
    dragX = e.clientX; dragY = e.clientY;
  }
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  if (welcomeEl.classList.contains('hidden') === false) return;
  const dir = Math.sign(e.deltaY) || 1;
  selectSlot((selected + dir + HOTBAR.length) % HOTBAR.length);
  e.preventDefault();
}, { passive: false });

// touch: left 44% is a floating joystick, the rest looks
canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse') return;
  e.preventDefault();
  if (e.clientX < innerWidth * 0.44 && joy.id === null) {
    joy.id = e.pointerId; joy.cx = e.clientX; joy.cy = e.clientY; joy.x = 0; joy.y = 0;
    stick.style.left = (e.clientX - 62) + 'px';
    stick.style.top = (e.clientY - 62) + 'px';
    stick.style.bottom = 'auto';
    knob.style.transform = 'translate(0px,0px)';
    canvas.setPointerCapture(e.pointerId);
  } else if (dragId === null) {
    dragId = e.pointerId; dragX = e.clientX; dragY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  }
}, { passive: false });
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'mouse') return;
  e.preventDefault();
  if (e.pointerId === joy.id) {
    const dx = e.clientX - joy.cx, dy = e.clientY - joy.cy;
    const r = Math.hypot(dx, dy), max = 52;
    const cl = r > max ? max / r : 1;
    joy.x = (dx * cl) / max; joy.y = (dy * cl) / max;
    knob.style.transform = `translate(${dx * cl}px,${dy * cl}px)`;
  } else if (e.pointerId === dragId) {
    player.yaw -= (e.clientX - dragX) * 0.0045;
    player.pitch = clamp(player.pitch - (e.clientY - dragY) * 0.0045, -1.45, 1.45);
    dragX = e.clientX; dragY = e.clientY;
  }
}, { passive: false });
function endPointer(e) {
  if (e.pointerId === joy.id) {
    joy.id = null; joy.x = joy.y = 0;
    stick.style.left = '';
    stick.style.top = '';
    stick.style.bottom = '';
    knob.style.transform = 'translate(0px,0px)';
  }
  if (e.pointerId === dragId) dragId = null;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

// action buttons
document.querySelectorAll('#actions button').forEach((b) => {
  const act = b.dataset.act;
  const down = (e) => {
    e.preventDefault();
    if (act === 'jump') jumpHeld = true;
    if (act === 'fly') { player.fly = !player.fly; player.vy = 0; b.classList.toggle('on', player.fly); toast(player.fly ? 'FLY ON' : 'FLY OFF'); }
    if (act === 'break') breakHeld = true;
    if (act === 'place') placeHeld = true;
  };
  const up = (e) => {
    e.preventDefault();
    if (act === 'jump') jumpHeld = false;
    if (act === 'break') breakHeld = false;
    if (act === 'place') placeHeld = false;
  };
  b.addEventListener('pointerdown', down);
  b.addEventListener('pointerup', up);
  b.addEventListener('pointercancel', up);
  b.addEventListener('pointerleave', up);
});

// --------------------------------------------------------------------- UI ----
const HOTBAR = (Array.isArray(WORLD.palette) && WORLD.palette.length ? WORLD.palette : FALLBACK_WORLD.palette)
  .map((n) => NAME_TO_ID[String(n).toLowerCase()])
  .filter((id) => typeof id === 'number')
  .slice(0, 9);
if (!HOTBAR.length) HOTBAR.push(GRASS);
let selected = 0;

function buildHotbar() {
  hotbarEl.innerHTML = '';
  HOTBAR.forEach((id, i) => {
    const d = document.createElement('button');
    d.className = 'slot' + (i === selected ? ' sel' : '');
    d.title = DEF[id].name;
    const c = document.createElement('canvas');
    c.width = 16; c.height = 16;
    const g = c.getContext('2d');
    const tile = TILE[DEF[id].top];
    g.drawImage(atlas, (tile % ATLAS_COLS) * 16, Math.floor(tile / ATLAS_COLS) * 16, 16, 16, 0, 0, 16, 16);
    d.appendChild(c);
    const n = document.createElement('span'); n.className = 'num'; n.textContent = String(i + 1);
    d.appendChild(n);
    d.addEventListener('click', (e) => { e.preventDefault(); selectSlot(i); });
    hotbarEl.appendChild(d);
  });
}
function selectSlot(i) {
  selected = clamp(i, 0, HOTBAR.length - 1);
  [...hotbarEl.children].forEach((el, k) => el.classList.toggle('sel', k === selected));
}

const QUESTS = (Array.isArray(WORLD.quests) && WORLD.quests.length ? WORLD.quests : FALLBACK_WORLD.quests)
  .filter((q) => q && q.id && q.title)
  .map((q) => Object.assign({}, q));

const POIS = (Array.isArray(WORLD.pois) && WORLD.pois.length ? WORLD.pois : FALLBACK_WORLD.pois)
  .filter((p) => p && typeof p.x === 'number' && typeof p.z === 'number')
  .map((p) => ({ name: p.name || 'LANDMARK', x: p.x, y: p.y || GROUND + 6, z: p.z, cls: p.cls || '' }));
const poiEls = POIS.map((p) => {
  const el = document.createElement('div');
  el.className = 'poi ' + p.cls;
  el.textContent = p.name;
  labelsEl.appendChild(el);
  return el;
});

const NPCS = (Array.isArray(WORLD.npcs) ? WORLD.npcs : FALLBACK_WORLD.npcs)
  .filter((n) => n && typeof n.x === 'number' && typeof n.z === 'number')
  .map((n) => ({
    id: n.id || n.name || 'npc',
    name: n.name || 'Neighbour',
    role: n.role || '',
    sprite: n.sprite || 'gardener',
    x: n.x, y: typeof n.y === 'number' ? n.y : GROUND + 1, z: n.z,
    tx: n.x, ty: typeof n.y === 'number' ? n.y : GROUND + 1, tz: n.z,
    yaw: 0,
    size: Array.isArray(n.size) ? n.size : [1.5, 2.0],
    lines: Array.isArray(n.lines) && n.lines.length ? n.lines : ['Hello, neighbour.'],
    shard: 0, seen: 1, seenCount: 1,
    bob: Math.random() * 6.28
  }));
const NPC_LABELS = NPCS.map((n) => {
  const el = document.createElement('div');
  el.className = 'poi npc';
  el.textContent = n.name.toUpperCase();
  labelsEl.appendChild(el);
  return el;
});

const BUSINESSES = (Array.isArray(WORLD.businesses) ? WORLD.businesses : FALLBACK_WORLD.businesses)
  .filter((b) => b && b.id && typeof b.x === 'number' && typeof b.z === 'number')
  .map((b) => ({
    id: b.id, name: b.name || b.id, x: b.x, z: b.z, item: b.item || 'wheat',
    qty: b.qty | 0, sats: b.sats | 0, lat: b.lat, lon: b.lon, radius: b.radius || 300
  }));
const TOKENS = (Array.isArray(WORLD.tokens) ? WORLD.tokens : FALLBACK_WORLD.tokens)
  .filter((t) => t && t.id && typeof t.x === 'number' && typeof t.z === 'number')
  .map((t) => ({ id: t.id, x: t.x, y: typeof t.y === 'number' ? t.y : GROUND + 2, z: t.z }));

const state = {
  quests: Object.create(null),
  tokens: [],
  inventory: Object.create(null),
  sats: 0,
  credits: 3000,
  shards: 0,
  citizens: [],
  relations: {},
  goal: 'growth',
  guidance: '',
  epoch: 1,
  epochStart: Date.now(),
  epochCohort: 1,
  cohortStart: Date.now(),
  epochArchive: [],
  campaign: { pve: 0, trade: 0, haul: 0, explore: 0, skirmish: 0, closed: false },
  contracts: null,
  rep: { completed: 0, failed: 0 },
  mer: { faucets: 0, sinks: 0 },
  farmDay: '',
  farmed: [],
  placed: 0,
  broken: 0,
  started: 0,
  finished: false
};
const edits = new Map();
const SAVE_KEY = 'nautilus-craft.torrance.v1';
let store = null;
try { localStorage.setItem('__nc', '1'); localStorage.removeItem('__nc'); store = localStorage; } catch (e) { store = null; }

function saveNow() {
  if (!store) return;
  try {
    const e = {};
    for (const [k, v] of edits) e[k] = v;
    store.setItem(SAVE_KEY, JSON.stringify({
      v: 1, p: [player.x, player.y, player.z], yaw: player.yaw, pitch: player.pitch,
      q: state.quests, tokens: state.tokens, inventory: state.inventory, sats: state.sats,
      credits: state.credits, shards: state.shards, citizens: state.citizens,
      relations: state.relations, goal: state.goal, guidance: state.guidance,
      epoch: state.epoch, epochStart: state.epochStart, epochCohort: state.epochCohort,
      cohortStart: state.cohortStart, epochArchive: state.epochArchive,
      campaign: state.campaign, contracts: state.contracts, rep: state.rep, mer: state.mer,
      farmDay: state.farmDay, farmed: state.farmed, placed: state.placed, broken: state.broken,
      started: state.started, finished: state.finished, edits: e
    }));
  } catch (e) {}
}
function loadSave() {
  if (!store) return;
  try {
    const raw = store.getItem(SAVE_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (!s || s.v !== 1) return;
    if (Array.isArray(s.p) && s.p.length === 3) {
      player.x = s.p[0]; player.y = s.p[1]; player.z = s.p[2];
    }
    if (typeof s.yaw === 'number') player.yaw = s.yaw;
    if (typeof s.pitch === 'number') player.pitch = s.pitch;
    state.quests = s.q || Object.create(null);
    state.tokens = Array.isArray(s.tokens) ? s.tokens.filter((x) => typeof x === 'string') : [];
    state.inventory = s.inventory && typeof s.inventory === 'object' ? s.inventory : Object.create(null);
    state.sats = typeof s.sats === 'number' ? s.sats : 0;
    state.credits = typeof s.credits === 'number' ? s.credits : 3000;
    state.shards = typeof s.shards === 'number' ? s.shards : 0;
    state.citizens = Array.isArray(s.citizens) ? s.citizens.filter((c) => c && c.id && c.kind) : [];
    state.relations = s.relations && typeof s.relations === 'object' ? s.relations : {};
    state.goal = typeof s.goal === 'string' ? s.goal : 'growth';
    state.guidance = typeof s.guidance === 'string' ? s.guidance : '';
    state.epoch = typeof s.epoch === 'number' ? s.epoch : 1;
    state.epochStart = typeof s.epochStart === 'number' ? s.epochStart : Date.now();
    state.epochCohort = typeof s.epochCohort === 'number' ? s.epochCohort : 1;
    state.cohortStart = typeof s.cohortStart === 'number' ? s.cohortStart : Date.now();
    state.epochArchive = Array.isArray(s.epochArchive) ? s.epochArchive : [];
    state.campaign = s.campaign && typeof s.campaign === 'object'
      ? { pve: 0, trade: 0, haul: 0, explore: 0, skirmish: 0, closed: false, ...s.campaign }
      : { pve: 0, trade: 0, haul: 0, explore: 0, skirmish: 0, closed: false };
    state.contracts = Array.isArray(s.contracts) ? s.contracts : null;
    state.rep = s.rep && typeof s.rep === 'object' ? s.rep : { completed: 0, failed: 0 };
    state.mer = s.mer && typeof s.mer === 'object' ? s.mer : { faucets: 0, sinks: 0 };
    state.farmDay = typeof s.farmDay === 'number' ? s.farmDay : Number(s.farmDay) || 0;
    state.farmed = Array.isArray(s.farmed) ? s.farmed.filter((x) => typeof x === 'string') : [];
    state.placed = s.placed | 0; state.broken = s.broken | 0;
    state.started = s.started | 0; state.finished = !!s.finished;
    if (s.edits) for (const k of Object.keys(s.edits)) edits.set(k, s.edits[k] | 0);
    for (const [k, v] of edits) {
      const [x, y, z] = k.split(',').map(Number);
      if (inBounds(x, y, z)) world[idx(x, y, z)] = v;
    }
  } catch (e) {}
}

let toastTimer = 0;
function toast(msg, ms = 2200) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}
let hintTimer = 0;
function showHint(msg) {
  if (!msg) { hintEl.classList.remove('show'); return; }
  hintEl.textContent = msg;
  hintEl.classList.add('show');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => hintEl.classList.remove('show'), 5500);
}
function hideHint() { hintEl.classList.remove('show'); }

function qDone(q) { return !!state.quests[q.id]; }
function questCount() { return QUESTS.filter(qDone).length; }
function tokenCount() { return state.tokens.length; }
function renderTokens() {
  if (tokensEl) tokensEl.textContent = `${tokenCount()} / ${TOKENS.length}`;
}
let netSendScore = () => {};
function collectTokens() {
  for (const t of TOKENS) {
    if (state.tokens.indexOf(t.id) !== -1) continue;
    const d = Math.hypot(player.x - t.x, (player.y + 0.9) - t.y, player.z - t.z);
    if (d > 1.55) continue;
    state.tokens.push(t.id);
    beep(880, 0.08, 'triangle', 0.025);
    setTimeout(() => beep(1320, 0.12, 'triangle', 0.02), 80);
    toast(`EMERALD TOKEN · ${tokenCount()} / ${TOKENS.length}`, 1800);
    renderTokens();
    saveSoon();
    netSendScore();
    if (tokenCount() === TOKENS.length) {
      setTimeout(() => toast('ALL EIGHT TOKENS · TORRANCE IS YOURS', 3200), 600);
      setTimeout(() => beep(1046, 0.18, 'triangle', 0.03), 700);
    }
  }
}
function renderQuests() {
  qcountEl.textContent = `${questCount()} / ${QUESTS.length}`;
  const px = player.x, pz = player.z;
  qlistEl.innerHTML = QUESTS.map((q) => {
    const done = qDone(q);
    let dist = '';
    if (!done) {
      if (q.kind === 'zone' && q.zone) {
        const d = Math.hypot(q.zone.x - px, q.zone.z - pz);
        dist = `${d < 12 ? 'here' : Math.round(d) + 'm'}`;
      } else if (q.target) {
        const have = q.kind === 'place' ? state.placed : state.broken;
        dist = `${Math.min(have, q.target)}/${q.target}`;
      }
    }
    return `<div class="q ${done ? 'done' : ''}">
      <span class="tick">${done ? '✓' : ''}</span>
      <span>${q.title}</span>
      <span class="dist">${done ? 'done' : dist}</span>
    </div>`;
  }).join('');
}
function completeQuest(q) {
  if (state.quests[q.id]) return;
  state.quests[q.id] = 1;
  beep(660, 0.09, 'square', 0.025);
  setTimeout(() => beep(990, 0.12, 'square', 0.02), 90);
  toast('QUEST COMPLETE · ' + q.title.toUpperCase(), 2400);
  renderQuests();
  saveNow();
  netSendScore();
  if (questCount() === QUESTS.length && !state.finished) {
    state.finished = true;
    saveNow();
    setTimeout(() => showComplete(), 900);
  }
}
function checkQuests() {
  for (const q of QUESTS) {
    if (qDone(q)) continue;
    if (q.kind === 'zone' && q.zone) {
      if (Math.hypot(player.x - q.zone.x, player.z - q.zone.z) <= q.zone.r) completeQuest(q);
    } else if (q.kind === 'place' && state.placed >= q.target) completeQuest(q);
    else if (q.kind === 'break' && state.broken >= q.target) completeQuest(q);
  }
}
function showComplete() {
  const secs = state.started ? Math.round((Date.now() - state.started) / 1000) : 0;
  completeStatsEl.textContent = `Six quests, ${state.placed} blocks placed, ${state.broken} broken` +
    (secs ? `, ${Math.floor(secs / 60)}m ${secs % 60}s on the tour.` : '.');
  completeEl.classList.remove('hidden');
  beep(523, 0.12, 'triangle', 0.03);
  setTimeout(() => beep(659, 0.12, 'triangle', 0.03), 130);
  setTimeout(() => beep(784, 0.2, 'triangle', 0.03), 260);
}

function openHelp() {
  helpEl.classList.remove('hidden');
  if (pointerLocked) document.exitPointerLock();
}
function closeModals() {
  helpEl.classList.add('hidden');
  completeEl.classList.add('hidden');
  closeDialogue();
}
let nearNPC = null, dialogueNPC = null, dialogueLine = 0;
function npcDistance(n) {
  return Math.hypot(player.x - n.x, (player.y + 0.9) - (n.y + n.size[1] * 0.5), player.z - n.z);
}
let nearBiz = null, pendingClaim = null;
function ensureFarmDay() {
  const day = gameDay();
  if (state.farmDay !== day) { state.farmDay = day; state.farmed = []; }
}
function farmDistance(b) { return Math.hypot(player.x - b.x, player.z - b.z); }
function renderSats() { if (satsEl) satsEl.textContent = String(state.sats); }
function renderCredits() { const el = $('credits'); if (el) el.textContent = String(state.credits); }
function countBits(n) { let c = 0; while (n) { c += n & 1; n >>>= 1; } return c; }
function renderShards() {
  const el = $('shards');
  if (!el) return;
  const here = shardAt(player.x, player.z);
  const before = state.shards;
  state.shards |= 1 << here;
  if (!(before & (1 << here))) campaignAdd('explore', 1);
  el.textContent = `${countBits(state.shards)}/${SHARD_COUNT} · S${here + 1} ${SHARD_TIERS[here]}`;
}
function epochDay() {
  return Math.max(1, Math.floor((Date.now() - state.epochStart) / GAME_DAY_MS) + 1);
}
let lastEpochLabel = '';
function renderEpoch() {
  const el = $('epoch');
  if (!el) return;
  const label = `${state.epoch} · D${epochDay()} · C${state.epochCohort}`;
  if (label !== lastEpochLabel) { lastEpochLabel = label; el.textContent = label; }
}
let restartArmedUntil = 0;
function requestRestart() {
  if (Date.now() < restartArmedUntil) { restartEpoch(); return; }
  restartArmedUntil = Date.now() + 8000;
  toast('RESTART = NEW EPOCH · NOTHING CARRIES OVER · TAP AGAIN TO CONFIRM', 4200);
}
function restartEpoch() {
  const now = Date.now();
  if (!Array.isArray(state.epochArchive)) state.epochArchive = [];
  state.epochArchive.push({
    epoch: state.epoch, cohort: state.epochCohort, day: epochDay(),
    sats: state.sats, credits: state.credits, citizens: state.citizens.length, at: now
  });
  // The new epoch shares the cohort while its 100-game-day window is open;
  // past that it starts the next cohort.
  if (now - state.cohortStart > 100 * GAME_DAY_MS) {
    state.epochCohort += 1;
    state.cohortStart = now;
  }
  state.epoch += 1;
  state.epochStart = now;
  restartArmedUntil = 0;
  resetWorld();
  renderEpoch(); renderCredits(); renderCitizens(); saveNow();
  mqttPublish('epochs/restart', {
    epoch: state.epoch, cohort: state.epochCohort, at: now,
    pid: NET.pid || 'solo', carry: 'none'
  }, 1, false);
  toast(`EPOCH ${state.epoch} · COHORT ${state.epochCohort} · FRESH TIMELINE`, 3600);
}
function renderDay() {
  const el = document.getElementById('day');
  if (!el) return;
  const left = Math.max(0, Math.ceil((gameDayStart() + GAME_DAY_MS - Date.now()) / 60000));
  el.textContent = `#${gameDay()} · ${left}m`;
}
function updateNearNPC() {
  let best = null, bd = 2.7;
  for (const n of NPCS) {
    const d = npcDistance(n);
    if (d < bd) { bd = d; best = n; }
  }
  nearNPC = best;
  ensureFarmDay();
  let biz = null, bizDist = 4.2;
  for (const b of BUSINESSES) {
    const d = farmDistance(b);
    if (d < bizDist) { bizDist = d; biz = b; }
  }
  nearBiz = biz;
  const canFarm = biz && !state.farmed.includes(biz.id) && helpEl.classList.contains('hidden');
  if (canFarm) {
    farmEl.classList.remove('hidden');
    farmNameEl.textContent = biz.name;
  } else {
    farmEl.classList.add('hidden');
  }
  if (best && !dialogueNPC && helpEl.classList.contains('hidden')) {
    talkEl.classList.remove('hidden');
    talkNameEl.textContent = best.name;
  } else {
    talkEl.classList.add('hidden');
  }
}
async function photoExif(file) {
  try {
    const b = new Uint8Array(await file.arrayBuffer());
    if (b[0] !== 0xff || b[1] !== 0xd8) return null;
    let off = 2;
    while (off + 4 < b.length) {
      if (b[off] !== 0xff) { off++; continue; }
      const marker = b[off + 1];
      if (marker === 0xda) break;
      const len = (b[off + 2] << 8) | b[off + 3];
      if (marker === 0xe1 && b[off + 4] === 0x45 && b[off + 5] === 0x78) {
        return parseTiff(b, off + 10);
      }
      off += 2 + len;
      if (len <= 0) break;
    }
  } catch (e) {}
  return null;
}
function parseTiff(b, base) {
  const le = b[base] === 0x49;
  const u16 = (o) => le ? (b[o] | (b[o + 1] << 8)) : ((b[o] << 8) | b[o + 1]);
  const u32 = (o) => le
    ? ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0)
    : (((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
  if (u16(base + 2) !== 42) return null;
  const ifd0 = base + u32(base + 4);
  const read = (off) => {
    const n = u16(off), entries = {};
    for (let i = 0; i < n; i++) {
      const p = off + 2 + i * 12;
      entries[u16(p)] = { type: u16(p + 2), count: u32(p + 4), val: u32(p + 8), p };
    }
    return entries;
  };
  const ascii = (ent) => {
    if (!ent) return '';
    const o = ent.count <= 4 ? ent.p + 8 : base + ent.val;
    let out = '';
    for (let i = 0; i < ent.count; i++) { const c = b[o + i]; if (!c) break; out += String.fromCharCode(c); }
    return out;
  };
  const rational = (o) => { const n = u32(o), d = u32(o + 4); return d ? n / d : 0; };
  const ifd = read(ifd0);
  const exif = ifd[0x8769] ? read(base + ifd[0x8769].val) : {};
  const gps = ifd[0x8825] ? read(base + ifd[0x8825].val) : {};
  const coord = (ent, ref) => {
    if (!ent || ent.count !== 3) return null;
    const o = base + ent.val;
    const d = rational(o) + rational(o + 4) / 60 + rational(o + 8) / 3600;
    return (ref === 'S' || ref === 'W') ? -d : d;
  };
  return {
    lat: coord(gps[2], ascii(gps[1]).trim()), lon: coord(gps[4], ascii(gps[3]).trim()),
    date: ascii(exif[0x9003] || ifd[0x0132]),
    make: ascii(ifd[0x010f]).trim(), model: ascii(ifd[0x0110]).trim()
  };
}
function haversine(a, b, c, d) {
  const r = 6371000, p = Math.PI / 180;
  const x = Math.sin((c - a) * p / 2) ** 2 + Math.cos(a * p) * Math.cos(c * p) * Math.sin((d - b) * p / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(x)));
}
function beginClaim(b) {
  if (!b) return;
  ensureFarmDay();
  if (state.farmed.includes(b.id)) { toast('ALREADY FARMED TODAY · COME BACK TOMORROW', 2600); return; }
  if (farmDistance(b) > 4.2) { toast('WALK TO ' + b.name.toUpperCase() + ' FIRST', 2600); return; }
  pendingClaim = b;
  photoInput.value = '';
  photoInput.click();
}
async function handlePhoto(file) {
  const b = pendingClaim;
  pendingClaim = null;
  if (!b || !file) return;
  const exif = await photoExif(file);
  window.__lastExif = exif;
  if (!exif || exif.lat === null || exif.lon === null) {
    toast('PHOTO HAS NO GPS EXIF · TAKE IT IN THE CAMERA AT THE BUSINESS', 3600); return;
  }
  ensureFarmDay();
  const takenMs = parseExifDate(exif.date);
  const start = gameDayStart();
  if (takenMs === null || takenMs < start - 300000 || takenMs > Date.now() + 300000) {
    toast('PHOTO IS NOT FROM THIS GAME DAY', 3000); return;
  }
  const d = haversine(exif.lat, exif.lon, b.lat, b.lon);
  if (d > b.radius) { toast(`PHOTO IS ${Math.round(d)} m FROM ${b.name.toUpperCase()}`, 3600); return; }
  if (farmDistance(b) > 4.2) { toast('WALK TO ' + b.name.toUpperCase() + ' FIRST', 2600); return; }
  if (state.farmed.includes(b.id)) { toast('ALREADY FARMED TODAY', 2400); return; }
  state.farmed.push(b.id);
  state.inventory[b.item] = (state.inventory[b.item] || 0) + b.qty;
  state.sats += b.sats;
  state.credits += 150;
  campaignAdd('trade', b.sats);
  merAdd(b.sats, 0);
  renderSats();
  renderCredits();
  saveSoon();
  beep(720, 0.08, 'triangle', 0.02);
  setTimeout(() => beep(1080, 0.12, 'triangle', 0.018), 90);
  toast(`FARMED ${b.name.toUpperCase()} · +${b.qty} ${b.item.toUpperCase()} · +${b.sats} SATS · PHOTO VERIFIED`, 4600);
  mqttPublish('commerce/farm', {
    id: b.id, item: b.item, qty: b.qty, sats: b.sats, day: gameDay(),
    proof: { lat: exif.lat, lon: exif.lon, distance_m: Math.round(d), taken: exif.date,
             make: exif.make, model: exif.model }
  }, 1, false);
}
function showDialogueLine() {
  if (!dialogueNPC) return;
  const line = dialogueNPC.lines[Math.min(dialogueLine, dialogueNPC.lines.length - 1)];
  dialogueNameEl.textContent = dialogueNPC.name.toUpperCase()
    + (dialogueNPC.role ? ' · ' + dialogueNPC.role.toUpperCase() : '')
    + ` · S${(dialogueNPC.shard | 0) + 1} · MAPPED ${dialogueNPC.seenCount | 0}/4`;
  dialogueTextEl.textContent = line;
  dialogueNextEl.textContent = dialogueLine >= dialogueNPC.lines.length - 1 ? 'Close' : 'Next';
}
function openDialogue(n) {
  if (!n) return;
  dialogueNPC = n;
  dialogueLine = 0;
  talkEl.classList.add('hidden');
  dialogueEl.classList.remove('hidden');
  showDialogueLine();
  if (pointerLocked) document.exitPointerLock();
  beep(520, 0.06, 'triangle', 0.015);
}
function advanceDialogue() {
  if (!dialogueNPC) return;
  dialogueLine++;
  if (dialogueLine >= dialogueNPC.lines.length) closeDialogue();
  else { showDialogueLine(); beep(560, 0.05, 'triangle', 0.012); }
}
function closeDialogue() {
  dialogueNPC = null;
  dialogueLine = 0;
  if (dialogueEl) dialogueEl.classList.add('hidden');
}
function toggleMap() {
  minimapEl.classList.toggle('show');
  $('btnMap').classList.toggle('on', minimapEl.classList.contains('show'));
}

// ------------------------------------------------------------------- audio --
let actx = null;
let muted = false;
try { muted = store && store.getItem('nc_mute') === '1'; } catch (e) {}
function audioCtx() {
  if (!actx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) { try { actx = new AC(); } catch (e) { actx = null; } }
  }
  if (actx && actx.state === 'suspended') actx.resume().catch(() => {});
  return actx;
}
function beep(freq, dur, type, gain) {
  if (muted) return;
  const a = audioCtx();
  if (!a) return;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type || 'square';
  o.frequency.value = freq;
  g.gain.setValueAtTime(gain || 0.02, a.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
  o.connect(g).connect(a.destination);
  o.start();
  o.stop(a.currentTime + dur + 0.02);
}

// ------------------------------------------------------------------ raycast --
function raycast(maxDist) {
  const o = eyePos(), d = forwardVec();
  let x = Math.floor(o[0]), y = Math.floor(o[1]), z = Math.floor(o[2]);
  const sx = d[0] > 0 ? 1 : d[0] < 0 ? -1 : 0;
  const sy = d[1] > 0 ? 1 : d[1] < 0 ? -1 : 0;
  const sz = d[2] > 0 ? 1 : d[2] < 0 ? -1 : 0;
  const dx = sx ? Math.abs(1 / d[0]) : Infinity;
  const dy = sy ? Math.abs(1 / d[1]) : Infinity;
  const dz = sz ? Math.abs(1 / d[2]) : Infinity;
  let tx = sx > 0 ? (x + 1 - o[0]) / d[0] : sx < 0 ? (o[0] - x) / -d[0] : Infinity;
  let ty = sy > 0 ? (y + 1 - o[1]) / d[1] : sy < 0 ? (o[1] - y) / -d[1] : Infinity;
  let tz = sz > 0 ? (z + 1 - o[2]) / d[2] : sz < 0 ? (o[2] - z) / -d[2] : Infinity;
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < 120; i++) {
    const t = Math.min(tx, ty, tz);
    if (t > maxDist) return null;
    const id = getB(x, y, z);
    if (id && id !== WATER && DEF[id]) return { x, y, z, nx, ny, nz };
    if (tx <= ty && tx <= tz) { x += sx; tx += dx; nx = -sx; ny = 0; nz = 0; }
    else if (ty <= tz) { y += sy; ty += dy; nx = 0; ny = -sy; nz = 0; }
    else { z += sz; tz += dz; nx = 0; ny = 0; nz = -sz; }
  }
  return null;
}
let target = null;

function wouldHitPlayer(x, y, z) {
  return (x + 1 > player.x - HALF && x < player.x + HALF &&
          y + 1 > player.y && y < player.y + HEIGHT &&
          z + 1 > player.z - HALF && z < player.z + HALF);
}
function breakBlock() {
  if (!target) return;
  if (getB(target.x, target.y, target.z) === AIR) return;
  setB(target.x, target.y, target.z, AIR);
  sendBlockEdit(target.x, target.y, target.z, AIR);
  state.broken++;
  edits.set(`${target.x},${target.y},${target.z}`, AIR);
  if (edits.size > 6000) { const first = edits.keys().next().value; edits.delete(first); }
  beep(150 + Math.random() * 40, 0.05, 'square', 0.016);
  checkQuests(); renderQuests(); saveSoon();
}
function placeBlock() {
  if (!target) return;
  const x = target.x + target.nx, y = target.y + target.ny, z = target.z + target.nz;
  if (!inBounds(x, y, z)) return;
  if (y < 1 || y > WY - 2) return;
  const cur = getB(x, y, z);
  if (cur !== AIR && cur !== WATER && !(DEF[cur] && DEF[cur].cross)) return;
  if (wouldHitPlayer(x, y, z)) return;
  const id = HOTBAR[selected];
  setB(x, y, z, id);
  sendBlockEdit(x, y, z, id);
  state.placed++;
  edits.set(`${x},${y},${z}`, id);
  if (edits.size > 6000) { const first = edits.keys().next().value; edits.delete(first); }
  beep(320 + Math.random() * 40, 0.05, 'triangle', 0.018);
  checkQuests(); renderQuests(); saveSoon();
}
let saveTimer = 0;
function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 1200); }

// --------------------------------------------------------------- multiplayer --
//
// MQTT v5 is the only multiplayer control plane. Mosquitto runs in the VM with
// a WebSocket listener (nginx proxies `/mqtt`); every client publishes its own
// player C2 topics and subscribes to the shared map, NPC and ledger state.
//
//   wa/v1/c2/torrance/player/<pid>/presence   retained  join/leave + name/colour
//   wa/v1/c2/torrance/player/<pid>/pos        QoS 0     movement (not retained)
//   wa/v1/c2/torrance/player/<pid>/chat       QoS 1     chat (not retained)
//   wa/v1/c2/torrance/player/<pid>/score      retained  quests/tokens
//   wa/v1/c2/torrance/npc/<id>/state          retained  server actor state
//   wa/v1/c2/torrance/map/block               QoS 1     one edit
//   wa/v1/c2/torrance/map/state               retained  authoritative edits + anchor
//   wa/v1/c2/torrance/ledger/anchor           retained  CC level anchor
//   wa/v1/c2/torrance/ledger/side/<shard>     retained  local sidechain tip
//
const NET = {
  enabled: false, client: null, connected: false, pid: null,
  name: '', color: 0, players: new Map(), scores: new Map(),
  lastPos: 0, retry: 0, anchor: null, revision: 0, chatHideTimer: 0,
  accounts: new Map(), sides: new Map()
};
const MQTT_BASE = 'wa/v1/c2/torrance';
const MQTT_FILTERS = [
  'player/+/presence', 'player/+/pos', 'player/+/chat', 'player/+/score',
  'npc/+/state', 'map/state', 'map/block', 'ledger/anchor', 'ledger/side/+', 'player/+/account'
];
const PLAYER_COLORS = ['#f4c95d', '#8fd14f', '#7fc4ff', '#ff8f6b', '#c99cff', '#5be0c8', '#ff7fb0', '#d7dde0'];

function sanitizeName(s) {
  const out = String(s || '').replace(/[^A-Za-z0-9 _.-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 18);
  return out || 'Traveler';
}
function randomName() { return 'Traveler-' + (100 + Math.floor(Math.random() * 900)); }
function storedName() { try { return store && store.getItem('nc_name'); } catch (e) { return null; } }
function colorIndex(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % PLAYER_COLORS.length;
}
function getPid() {
  try {
    let p = store && store.getItem('nc_pid');
    if (!p) { p = 'p-' + Math.random().toString(36).slice(2, 10); if (store) store.setItem('nc_pid', p); }
    return p;
  } catch (e) { return 'p-' + Math.random().toString(36).slice(2, 10); }
}
function canMultiplayer() {
  return !!(WORLD.multiplayer && WORLD.multiplayer.enabled !== false &&
            /^https?:$/.test(location.protocol) && location.host && window.MqttV5);
}
function setNetStatus(text) { if (netEl) netEl.textContent = text; }
function mqttUrl() {
  const override = new URLSearchParams(location.search).get('mqtt');
  if (override) return override;
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/mqtt';
}
function mqttPublish(suffix, payload, qos, retain) {
  if (!NET.client || !NET.connected) return;
  const body = typeof payload === 'string'
    ? payload
    : (payload instanceof Uint8Array ? payload : JSON.stringify(payload));
  NET.client.publish(MQTT_BASE + '/' + suffix, body, qos === undefined ? 1 : qos, !!retain);
}
function publishPresence() {
  if (!NET.connected) return;
  mqttPublish('player/' + NET.pid + '/presence', {
    v: 1, pid: NET.pid, name: NET.name, color: NET.color, at: Date.now()
  }, 1, true);
  mqttPublish('player/' + NET.pid + '/score', { quests: questCount(), tokens: tokenCount(), at: Date.now() }, 1, true);
}
netSendScore = function () {
  if (NET.connected) {
    mqttPublish('player/' + NET.pid + '/score', { quests: questCount(), tokens: tokenCount(), at: Date.now() }, 1, true);
  }
};
function sendBlockEdit(x, y, z, id) {
  if (NET.connected) mqttPublish('map/block', { x, y, z, id, by: NET.pid, at: Date.now() }, 1, false);
}
function sendChat(text) {
  if (!NET.connected) return;
  mqttPublish('player/' + NET.pid + '/chat', { text, name: NET.name, at: Date.now() }, 1, false);
}

function appendChat(name, text, me, sys) {
  if (!chatlogEl) return;
  const line = document.createElement('div');
  line.className = 'chatline' + (me ? ' me' : '') + (sys ? ' sys' : '');
  if (!sys) {
    const b = document.createElement('b');
    b.textContent = name + ': ';
    line.appendChild(b);
  }
  line.appendChild(document.createTextNode(String(text).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160)));
  chatlogEl.appendChild(line);
  while (chatlogEl.children.length > 8) chatlogEl.removeChild(chatlogEl.firstChild);
  chatEl.classList.add('show');
  clearTimeout(NET.chatHideTimer);
  NET.chatHideTimer = setTimeout(() => {
    if (document.activeElement !== chatinputEl) chatEl.classList.remove('show');
  }, 14000);
}
function showChat(open) {
  chatEl.classList.toggle('show', open);
  if (open) {
    closeDialogue();
    chatformEl.classList.remove('hidden');
    setTimeout(() => chatinputEl.focus(), 30);
  } else {
    chatformEl.classList.add('hidden');
    chatinputEl.blur();
  }
}
function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function renderOnline() {
  if (!onlineListEl) return;
  const rows = [];
  const self = { pid: NET.pid || getPid(), name: NET.name || 'You', color: NET.color || 0 };
  rows.push('<div class="online-row"><span><span class="dot" style="background:' +
    PLAYER_COLORS[self.color % PLAYER_COLORS.length] + '"></span><b>' +
    escapeHTML(self.name) + '</b> (you)</span><span>' + questCount() + 'q · ' + tokenCount() + 't ' +
    '<button class="vbtn" data-verify="' + escapeHTML(self.pid) + '" title="Verify sidechain in the anchor">✓</button></span></div>');
  const entries = [...NET.players.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const p of entries) {
    const s = NET.scores.get(p.pid) || { quests: 0, tokens: 0 };
    rows.push('<div class="online-row"><span><span class="dot" style="background:' +
      PLAYER_COLORS[(p.color || 0) % PLAYER_COLORS.length] + '"></span>' +
      escapeHTML(p.name) + '</span><span>' + (s.quests | 0) + 'q · ' + (s.tokens | 0) + 't ' +
      '<button class="vbtn" data-verify="' + escapeHTML(p.pid) + '" title="Verify sidechain in the anchor">✓</button></span></div>');
  }
  onlineListEl.innerHTML = rows.join('');
  setNetStatus('ONLINE · ' + (NET.players.size + 1));
}
function upsertPlayer(pid, data) {
  let p = NET.players.get(pid);
  if (!p) {
    p = {
      pid, name: data.name || 'Traveler', color: data.color || 0,
      x: data.x === undefined ? 48.5 : data.x,
      y: data.y === undefined ? 9 : data.y,
      z: data.z === undefined ? 37.5 : data.z,
      tx: data.x === undefined ? 48.5 : data.x,
      ty: data.y === undefined ? 9 : data.y,
      tz: data.z === undefined ? 37.5 : data.z,
      sprite: (colorIndex(pid) % 2) ? 'barista' : 'gardener'
    };
    const el = document.createElement('div');
    el.className = 'poi npc player-tag';
    el.textContent = p.name;
    labelsEl.appendChild(el);
    p.el = el;
    NET.players.set(pid, p);
    appendChat('', p.name + ' joined', false, true);
  }
  if (data.name) { p.name = data.name; if (p.el) p.el.textContent = p.name; }
  if (typeof data.color === 'number') p.color = data.color % PLAYER_COLORS.length;
  if (typeof data.x === 'number') { p.tx = data.x; if (Math.abs(p.x - data.x) > 12) p.x = data.x; }
  if (typeof data.y === 'number') { p.ty = data.y; if (Math.abs(p.y - data.y) > 12) p.y = data.y; }
  if (typeof data.z === 'number') { p.tz = data.z; if (Math.abs(p.z - data.z) > 12) p.z = data.z; }
  if (!NET.scores.has(pid)) NET.scores.set(pid, { name: p.name, quests: 0, tokens: 0 });
  renderOnline();
}
function removePlayer(pid) {
  const p = NET.players.get(pid);
  if (!p) return;
  if (p.el) p.el.remove();
  NET.players.delete(pid);
  NET.scores.delete(pid);
  appendChat('', p.name + ' left', false, true);
  renderOnline();
}
function applyRemoteBlock(x, y, z, id) {
  if (!inBounds(x, y, z)) return;
  if (getB(x, y, z) === id) return;
  setB(x, y, z, id);
  edits.set(`${x},${y},${z}`, id);
  scheduleMapRebuild();
}
let mapRebuildTimer = 0;
function scheduleMapRebuild() {
  clearTimeout(mapRebuildTimer);
  mapRebuildTimer = setTimeout(() => { if (mapBase) buildMapBase(); }, 700);
}
function applyServerNpc(s) {
  if (!s || !s.id) return;
  const n = NPCS.find((x) => x.id === s.id);
  if (!n) return;
  if (typeof s.x === 'number') { n.tx = s.x; if (Math.abs(n.x - s.x) > 8) n.x = s.x; }
  if (typeof s.y === 'number') { n.ty = s.y; if (Math.abs(n.y - s.y) > 8) n.y = s.y; }
  if (typeof s.z === 'number') { n.tz = s.z; if (Math.abs(n.z - s.z) > 8) n.z = s.z; }
  if (typeof s.yaw === 'number') n.yaw = s.yaw;
  if (typeof s.shard === 'number') n.shard = s.shard;
  if (typeof s.shards === 'number') n.seen = s.shards;
  if (typeof s.shards_seen === 'number') n.seenCount = s.shards_seen;
  const i = NPCS.indexOf(n);
  if (i >= 0 && NPC_LABELS[i]) {
    NPC_LABELS[i].textContent = `${n.name.toUpperCase()} · S${(n.shard | 0) + 1} · ${n.seenCount | 0}/4`;
  }
}
let mapQueue = [];
function applyMapState(obj) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj.edits)) {
    mapQueue = obj.edits.filter((e) => Array.isArray(e) && e.length >= 4).slice(0, 6000);
  }
  if (typeof obj.revision === 'number') NET.revision = obj.revision;
  if (obj.anchor) { NET.anchor = obj.anchor; renderAnchor(); }
}
function drainMapQueue() {
  let n = 0;
  while (mapQueue.length && n < 220) {
    const e = mapQueue.shift();
    const [x, y, z, id] = e;
    if (getB(x | 0, y | 0, z | 0) !== (id | 0)) applyRemoteBlock(x | 0, y | 0, z | 0, id | 0);
    n++;
  }
  if (mapQueue.length === 0) scheduleMapRebuild();
}
function renderAnchor() {
  const el = document.getElementById('anchor');
  if (!el) return;
  if (!NET.anchor) { el.textContent = '—'; return; }
  const a = NET.anchor;
  const roots = Array.isArray(a.roots) ? a.roots.length : 0;
  el.textContent = '#' + (a.height === undefined ? '?' : a.height) + ' · ' + roots + ' shards';
}

// --- light-client verification: player MMR -> shard MMR -> anchor -------
const SHA_K = [
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
];
const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;
function sha256Bytes(bytes) {
  const H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const len = bytes.length;
  const padded = new Uint8Array((((len + 9) + 63) >> 6) << 6);
  padded.set(bytes); padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  const bits = len * 8;
  dv.setUint32(padded.length - 4, bits >>> 0);
  dv.setUint32(padded.length - 8, Math.floor(bits / 4294967296));
  const w = new Uint32Array(64);
  for (let i = 0; i < padded.length; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4);
    for (let j = 16; j < 64; j++) {
      const s0 = rotr(w[j - 15], 7) ^ rotr(w[j - 15], 18) ^ (w[j - 15] >>> 3);
      const s1 = rotr(w[j - 2], 17) ^ rotr(w[j - 2], 19) ^ (w[j - 2] >>> 10);
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let j = 0; j < 64; j++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA_K[j] + w[j]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  H.forEach((v, i) => odv.setUint32(i * 4, v));
  return out;
}
function hexOf(bytes) { return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(''); }
function sha256Text(text) { return hexOf(sha256Bytes(new TextEncoder().encode(text))); }
function concatBytes(a, b) { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; }
function mmrRoot(events) {
  const peaks = [];
  for (const event of events || []) {
    let node = sha256Bytes(new TextEncoder().encode(String(event)));
    let level = 0;
    while (level < peaks.length && peaks[level]) {
      node = sha256Bytes(concatBytes(peaks[level], node));
      peaks[level] = null;
      level++;
    }
    if (level === peaks.length) peaks.push(node); else peaks[level] = node;
  }
  let acc = sha256Bytes(new TextEncoder().encode('mmr'));
  for (let i = peaks.length - 1; i >= 0; i--) if (peaks[i]) acc = sha256Bytes(concatBytes(acc, peaks[i]));
  return hexOf(acc);
}
function verifyPlayer(pid) {
  const account = NET.accounts.get(pid);
  if (!account) { toast('NO ACCOUNT FOR ' + pid, 2000); return false; }
  const events = Array.isArray(account.events) ? account.events : [];
  if (events.length !== (account.mmrEvents | 0)) { toast('✗ ACCOUNT MMR LENGTH', 2400); return false; }
  const accountRoot = mmrRoot(events);
  if (accountRoot !== account.mmrRoot) { toast('✗ ACCOUNT MMR ROOT', 2400); return false; }
  const shard = account.shard | 0;
  const side = NET.sides.get(shard);
  if (!side) { toast('✗ SIDECHAIN ' + shard + ' NOT SEEN', 2400); return false; }
  const leaf = 'account|' + pid + '|' + accountRoot + '|' + (account.mmrEvents | 0);
  if (!Array.isArray(side.leaves) || side.leaves.indexOf(leaf) === -1) {
    toast('✗ LEAF NOT IN SHARD ' + shard, 2400); return false;
  }
  const sideRoot = mmrRoot(side.leaves);
  if (sideRoot !== side.root) { toast('✗ SHARD MMR ROOT', 2400); return false; }
  const anchor = NET.anchor;
  if (!anchor || !Array.isArray(anchor.roots)) { toast('✗ NO ANCHOR', 2400); return false; }
  const ar = anchor.roots.find((r) => (r.shard | 0) === shard);
  if (!ar) { toast('✗ SHARD NOT ANCHORED', 2400); return false; }
  const rootsJson = '[' + anchor.roots.map((r) =>
    '{"hash":"' + r.hash + '","height":' + r.height + ',"root":"' + r.root + '","shard":' + r.shard + '}').join(',') + ']';
  const anchorHash = sha256Text(anchor.height + '|' + anchor.parent + '|' + rootsJson + '|' + anchor.at);
  if (anchorHash !== anchor.hash) { toast('✗ ANCHOR HASH', 2400); return false; }
  if (ar.root !== side.root || (ar.height | 0) !== (side.height | 0)) {
    toast('… ANCHOR PENDING · shard ' + shard + ' height ' + ar.height, 2600); return false;
  }
  toast('✓ ' + pid + ' VERIFIED · anchor #' + anchor.height + ' · shard ' + shard, 3200);
  return true;
}
function handleTopicMessage(topic, bytes, retained) {
  const parts = topic.split('/');
  // wa / v1 / c2 / torrance / <kind> / ...
  if (parts.length < 5 || parts[3] !== 'torrance') return;
  let text = '';
  try { text = new TextDecoder().decode(bytes || new Uint8Array(0)); } catch (e) { return; }
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch (e) { console.warn('bad json', topic, text.length); return; } }
  if (parts[4] === 'player' && parts[5] && parts[6]) {
    const pid = parts[5], kind = parts[6];
    if (pid === NET.pid && kind === 'chat') {
      if (data && data.text) appendChat(NET.name, data.text, true, false);
      return;
    }
    if (pid === NET.pid && (kind === 'pos' || kind === 'presence')) return;
    if (kind === 'presence') {
      if (!text || !data) removePlayer(pid);
      else upsertPlayer(pid, data);
    } else if (kind === 'pos' && data) {
      upsertPlayer(pid, data);
    } else if (kind === 'chat' && data && data.text) {
      appendChat(data.name || (NET.players.get(pid) || {}).name || 'Traveler', data.text, false, false);
    } else if (kind === 'score' && data) {
      NET.scores.set(pid, { name: (NET.players.get(pid) || {}).name || 'Traveler', quests: data.quests | 0, tokens: data.tokens | 0 });
      renderOnline();
    } else if (kind === 'account' && data) {
      NET.accounts.set(pid, data);
      if (pid === NET.pid) {
        const w = document.getElementById('wallet');
        if (w) w.textContent = data.address ? String(data.address).slice(0, 12) + '…' : 'pending';
      }
      renderOnline();
    }
    return;
  }
  if (parts[4] === 'npc' && parts[5] && parts[6] === 'state' && data) {
    applyServerNpc(data);
    return;
  }
  if (parts[4] === 'map') {
    if (parts[5] === 'block' && data && data.by !== NET.pid) {
      applyRemoteBlock(data.x | 0, data.y | 0, data.z | 0, data.id | 0);
    } else if (parts[5] === 'state' && data) {
      applyMapState(data);
    }
    return;
  }
  if (parts[4] === 'ledger' && parts[5] === 'anchor' && data) {
    NET.anchor = data;
    renderAnchor();
    renderOnline();
    return;
  }
  if (parts[4] === 'ledger' && parts[5] === 'side' && data) {
    const shard = Number(parts[6]);
    if (Number.isFinite(shard)) NET.sides.set(shard, data);
  }
}
const netRing = { bufs: [[], []], active: 0, dropped: 0 };
function netProduce(topic, bytes, retained) {
  const b = netRing.bufs[netRing.active];
  if (b.length < 512) b.push({ topic, bytes, retained });
  else netRing.dropped++;
}
function netDrain(fn) {
  const old = netRing.active;
  netRing.active = 1 - old;
  const b = netRing.bufs[old];
  for (const msg of b) fn(msg.topic, msg.bytes, msg.retained);
  b.length = 0;
}
function connectNet() {
  if (!canMultiplayer()) {
    setNetStatus('OFFLINE · SOLO');
    return;
  }
  NET.pid = getPid();
  NET.name = sanitizeName(playerNameEl ? playerNameEl.value : NET.name);
  NET.color = colorIndex(NET.name);
  if (NET.client) { try { NET.client.disconnect(); } catch (e) {} }
  setNetStatus('CONNECTING…');
  const client = new window.MqttV5({
    url: mqttUrl(),
    clientId: 'nc-' + NET.pid,
    keepalive: 30,
    willTopic: MQTT_BASE + '/player/' + NET.pid + '/presence',
    onConnect: () => {
      NET.connected = true;
      client.subscribe(MQTT_FILTERS.map((topic) => ({ topic: MQTT_BASE + '/' + topic, qos: 1 })));
      publishPresence();
      renderOnline();
      appendChat('', 'MQTT v5 connected · ' + location.host, false, true);
      beep(520, 0.06, 'triangle', 0.015);
    },
    onMessage: (topic, payload) => netProduce(topic, payload, false),
    onOffline: () => {
      NET.connected = false;
      setNetStatus('OFFLINE · SOLO');
      for (const [, p] of NET.players) if (p.el) p.el.remove();
      NET.players.clear();
      NET.scores.clear();
      renderOnline();
    },
    onLog: (line) => console.warn('mqtt:', line)
  });
  NET.client = client;
  client.connect();
}
function leaveMqtt() {
  if (!NET.connected) return;
  mqttPublish('player/' + NET.pid + '/presence', new Uint8Array(0), 1, true);
  try { NET.client.disconnect(); } catch (e) {}
}
addEventListener('pagehide', leaveMqtt);
addEventListener('beforeunload', leaveMqtt);

// ------------------------------------------------------------------ minimap --
let mapBase = null;
const MAP_COLORS = {};
function buildMapBase() {
  const c = document.createElement('canvas');
  c.width = WX; c.height = WZ;
  const g = c.getContext('2d');
  const img = g.createImageData(WX, WZ);
  const col = (id) => {
    if (!MAP_COLORS[id]) MAP_COLORS[id] = hex(DEF[id] ? DEF[id].color : '#000000');
    return MAP_COLORS[id];
  };
  for (let z = 0; z < WZ; z++) {
    for (let x = 0; x < WX; x++) {
      let id = AIR;
      for (let y = WY - 1; y >= 0; y--) {
        const b = world[idx(x, y, z)];
        if (b && b !== WATER) { id = b; break; }
        if (b === WATER) { id = WATER; break; }
      }
      const rgb = col(id || GRASS);
      const i = (z * WX + x) * 4;
      const shade = 0.78 + ((x * 7 + z * 13) % 11) / 50;
      img.data[i] = rgb[0] * shade; img.data[i + 1] = rgb[1] * shade; img.data[i + 2] = rgb[2] * shade; img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  mapBase = c;
}
function hex(h) {
  const n = parseInt(h.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function drawMap() {
  if (!mapBase || !minimapEl.classList.contains('show')) return;
  const g = mapCanvas.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(mapBase, 0, 0, 192, 192);
  const px = (player.x / WX) * 192, pz = (player.z / WZ) * 192;
  const fx = Math.sin(player.yaw), fz = -Math.cos(player.yaw);
  g.strokeStyle = '#ffdf7e'; g.lineWidth = 3;
  g.beginPath(); g.moveTo(px, pz); g.lineTo(px + fx * 13, pz + fz * 13); g.stroke();
  g.fillStyle = '#f4c95d';
  g.beginPath(); g.arc(px, pz, 3.4, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = 1; g.stroke();
}

// ----------------------------------------------------------------- matrices --
const proj = new Float32Array(16), view = new Float32Array(16), vp = new Float32Array(16);
const eye = [0, 0, 0], fwd = [0, 0, 0], right = [0, 0, 0], up = [0, 0, 0];
const SUN = norm3([-0.42, 0.34, -0.84]);
const FOG = [0.93, 0.82, 0.68];

function resize() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = Math.floor(innerWidth * dpr), h = Math.floor(innerHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w; canvas.height = h;
  }
  gl.viewport(0, 0, canvas.width, canvas.height);
}
addEventListener('resize', resize);

// ------------------------------------------------------------------- render --
let highlight = null;
function drawHighlight() {
  if (!target) return;
  if (!highlight) {
    highlight = { vao: gl.createVertexArray(), buf: gl.createBuffer() };
    gl.bindVertexArray(highlight.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, highlight.buf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }
  const x = target.x, y = target.y, z = target.z, e = 0.003;
  const a = [x - e, y - e, z - e], b = [x + 1 + e, y + 1 + e, z + 1 + e];
  const v = [];
  const edge = (p, q) => { v.push(p[0], p[1], p[2], q[0], q[1], q[2]); };
  edge([a[0], a[1], a[2]], [b[0], a[1], a[2]]); edge([a[0], a[1], a[2]], [a[0], b[1], a[2]]); edge([a[0], a[1], a[2]], [a[0], a[1], b[2]]);
  edge([b[0], a[1], a[2]], [b[0], b[1], a[2]]); edge([b[0], a[1], a[2]], [b[0], a[1], b[2]]);
  edge([a[0], b[1], a[2]], [b[0], b[1], a[2]]); edge([a[0], b[1], a[2]], [a[0], b[1], b[2]]);
  edge([a[0], a[1], b[2]], [b[0], a[1], b[2]]); edge([a[0], a[1], b[2]], [a[0], b[1], b[2]]);
  edge([b[0], b[1], b[2]], [a[0], b[1], b[2]]); edge([b[0], b[1], b[2]], [b[0], a[1], b[2]]); edge([b[0], b[1], b[2]], [b[0], b[1], a[2]]);
  gl.useProgram(lineProg);
  gl.uniformMatrix4fv(gl.getUniformLocation(lineProg, 'uVP'), false, vp);
  gl.uniform4f(gl.getUniformLocation(lineProg, 'uColor'), 0.06, 0.06, 0.06, 0.75);
  gl.bindVertexArray(highlight.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, highlight.buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.DYNAMIC_DRAW);
  gl.drawArrays(gl.LINES, 0, v.length / 3);
  gl.bindVertexArray(null);
}

function projectPoint(x, y, z) {
  const w = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
  if (w <= 0.05) return null;
  const cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12];
  const cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
  return [(cx / w * 0.5 + 0.5) * innerWidth, (-cy / w * 0.5 + 0.5) * innerHeight, w];
}
function updateLabels() {
  for (let i = 0; i < POIS.length; i++) {
    const p = POIS[i], el = poiEls[i];
    const s = projectPoint(p.x, p.y, p.z);
    if (!s || s[0] < -120 || s[0] > innerWidth + 120 || s[1] < -80 || s[1] > innerHeight + 80) {
      el.style.display = 'none';
      continue;
    }
    const dist = Math.hypot(p.x - player.x, p.y - (player.y + EYE), p.z - player.z);
    if (dist > 90) { el.style.display = 'none'; continue; }
    el.style.display = '';
    el.style.transform = `translate(-50%,-50%) translate(${s[0].toFixed(1)}px,${s[1].toFixed(1)}px)`;
    el.style.opacity = String(clamp(1.15 - dist / 90, 0.18, 1));
  }
  for (let i = 0; i < NPCS.length; i++) {
    const n = NPCS[i], el = NPC_LABELS[i];
    const s = projectPoint(n.x, n.y + n.size[1] + 0.28, n.z);
    if (!s || s[0] < -80 || s[0] > innerWidth + 80 || s[1] < -60 || s[1] > innerHeight + 60) { el.style.display = 'none'; continue; }
    const dist = Math.hypot(n.x - player.x, n.y + n.size[1] - (player.y + EYE), n.z - player.z);
    if (dist > 42) { el.style.display = 'none'; continue; }
    el.style.display = '';
    el.style.transform = `translate(-50%,-50%) translate(${s[0].toFixed(1)}px,${s[1].toFixed(1)}px)`;
    el.style.opacity = String(clamp(1.1 - dist / 48, 0.16, 1));
  }
  for (const [, p] of NET.players) {
    if (!p.el) continue;
    const s = projectPoint(p.x, p.y + 2.25, p.z);
    if (!s || s[0] < -80 || s[0] > innerWidth + 80 || s[1] < -60 || s[1] > innerHeight + 60) { p.el.style.display = 'none'; continue; }
    const dist = Math.hypot(p.x - player.x, p.z - player.z);
    if (dist > 64) { p.el.style.display = 'none'; continue; }
    p.el.style.display = '';
    p.el.style.color = PLAYER_COLORS[(p.color || 0) % PLAYER_COLORS.length];
    p.el.style.borderColor = 'rgba(255,255,255,0.28)';
    p.el.style.transform = `translate(-50%,-50%) translate(${s[0].toFixed(1)}px,${s[1].toFixed(1)}px)`;
    p.el.style.opacity = String(clamp(1.1 - dist / 70, 0.2, 1));
  }
}

// --------------------------------------------------------------------- loop --
let last = performance.now(), acc = 0, frames = 0, fpsTimer = 0, started = false;
let bobT = 0;

function physics(dt) {
  const wasGround = player.onGround;
  const feet = getB(Math.floor(player.x), Math.floor(player.y + 0.2), Math.floor(player.z));
  const head = getB(Math.floor(player.x), Math.floor(player.y + EYE), Math.floor(player.z));
  player.inWater = feet === WATER || head === WATER;

  let f = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0) - joy.y;
  let r = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0) + joy.x;
  const len = Math.hypot(f, r);
  if (len > 1) { f /= len; r /= len; }

  const sprint = !!keys.ShiftLeft || !!keys.ShiftRight;
  let speed = player.fly ? 9.5 : (sprint ? 6.3 : 4.3);
  if (player.inWater && !player.fly) speed *= 0.62;

  const fx = Math.sin(player.yaw), fz = -Math.cos(player.yaw);
  const rx = Math.cos(player.yaw), rz = Math.sin(player.yaw);
  const wishX = fx * f + rx * r;
  const wishZ = fz * f + rz * r;

  player.vx = wishX * speed;
  player.vz = wishZ * speed;

  if (player.fly) {
    const upDown = (keys.Space || jumpHeld ? 1 : 0) - (sprint ? 1 : 0);
    player.vy = upDown * 7.5;
  } else if (player.inWater) {
    player.vy -= 5.0 * dt;
    if (player.vy < -2.4) player.vy = -2.4;
    if (keys.Space || jumpHeld) player.vy = 4.4;
  } else {
    player.vy -= 28 * dt;
    if (player.vy < -32) player.vy = -32;
    if ((keys.Space || jumpHeld) && wasGround) player.vy = 8.6;
  }

  const movedX = moveAxis('x', player.vx * dt);
  const movedZ = moveAxis('z', player.vz * dt);

  player.onGround = false;
  player.y += player.vy * dt;
  if (playerCollides()) {
    if (player.vy < 0) {
      player.y = Math.floor(player.y) + 1.0001;
      player.onGround = true;
    } else {
      player.y = Math.floor(player.y + HEIGHT) - HEIGHT - 0.0001;
    }
    player.vy = 0;
  }
  if (player.y < 1) { player.y = 1; player.vy = 0; }

  if (started) bobT += Math.hypot(player.vx, player.vz) * dt * 2.2;
  acc += dt; frames++;
  fpsTimer += dt;
  if (fpsTimer > 0.5) {
    fpsEl.textContent = Math.round(frames / fpsTimer);
    frames = 0; fpsTimer = 0;
  }
  coordsEl.textContent = `${player.x.toFixed(0)} ${player.y.toFixed(0)} ${player.z.toFixed(0)}`;
  modeEl.textContent = player.fly ? 'flying' : player.inWater ? 'swimming' : 'walking';
  if (movedX === false && movedZ === false) { /* wall */ }
}

let questTimer = 0, saveTick = 0;
function drawSprites(t) {
  if (!Object.keys(spriteTex).length) return;
  gl.useProgram(spriteProg);
  gl.uniformMatrix4fv(gl.getUniformLocation(spriteProg, 'uVP'), false, vp);
  gl.disable(gl.CULL_FACE);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.depthMask(true);
  for (const n of NPCS) {
    const bob = Math.sin(t * 1.4 + n.bob) * 0.035;
    drawBillboard(n.sprite, n.x, n.y + n.size[1] * 0.5 + bob, n.z, n.size[0], n.size[1], 1);
  }
  for (let i = 0; i < TOKENS.length; i++) {
    const tk = TOKENS[i];
    if (state.tokens.indexOf(tk.id) !== -1) continue;
    const bob = Math.sin(t * 2.0 + i * 1.7) * 0.10;
    drawBillboard('token', tk.x, tk.y + bob, tk.z, 0.55, 0.55, 1);
  }
  for (const [, p] of NET.players) {
    drawBillboard(p.sprite, p.x, p.y + 0.95, p.z, 1.3, 1.9, 1);
  }
  gl.disable(gl.BLEND);
  gl.enable(gl.CULL_FACE);
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000) || 0.016;
  last = now;
  if (started) physics(dt);
  else {
    player.inWater = false;
    coordsEl.textContent = `${player.x.toFixed(0)} ${player.y.toFixed(0)} ${player.z.toFixed(0)}`;
  }
  renderShards();
  renderEpoch();

  netDrain(handleTopicMessage);
  drainMapQueue();
  for (const [, p] of NET.players) {
    p.x += (p.tx - p.x) * 0.22;
    p.y += (p.ty - p.y) * 0.22;
    p.z += (p.tz - p.z) * 0.22;
  }
  for (const n of NPCS) {
    n.x += (n.tx - n.x) * 0.18;
    n.y += (n.ty - n.y) * 0.18;
    n.z += (n.tz - n.z) * 0.18;
  }
  if (NET.connected && started && now - NET.lastPos > 100) {
    NET.lastPos = now;
    mqttPublish('player/' + NET.pid + '/pos', {
      x: Math.round(player.x * 100) / 100,
      y: Math.round(player.y * 100) / 100,
      z: Math.round(player.z * 100) / 100,
      yaw: Math.round(player.yaw * 1000) / 1000,
      pitch: Math.round(player.pitch * 1000) / 1000
    }, 0, false);
  }

  // process at most one remesh per frame
  if (dirty.size) {
    const i = dirty.values().next().value;
    dirty.delete(i);
    remesh(i);
  }

  eye[0] = player.x; eye[1] = player.y + EYE + Math.sin(bobT) * 0.035; eye[2] = player.z;
  const cp = Math.cos(player.pitch);
  fwd[0] = Math.sin(player.yaw) * cp; fwd[1] = Math.sin(player.pitch); fwd[2] = -Math.cos(player.yaw) * cp;
  right[0] = Math.cos(player.yaw); right[1] = 0; right[2] = Math.sin(player.yaw);
  up[0] = right[1] * fwd[2] - right[2] * fwd[1];
  up[1] = right[2] * fwd[0] - right[0] * fwd[2];
  up[2] = right[0] * fwd[1] - right[1] * fwd[0];
  resize();
  const aspect = canvas.width / canvas.height;
  mat4Perspective(proj, 72 * Math.PI / 180, aspect, 0.08, 240);
  mat4LookAt(view, eye, fwd, [0, 1, 0]);
  mat4Multiply(vp, proj, view);

  gl.clearColor(FOG[0], FOG[1], FOG[2], 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  // sky
  gl.disable(gl.DEPTH_TEST);
  gl.depthMask(false);
  gl.useProgram(skyProg);
  gl.uniform3f(gl.getUniformLocation(skyProg, 'uFwd'), fwd[0], fwd[1], fwd[2]);
  gl.uniform3f(gl.getUniformLocation(skyProg, 'uRight'), right[0], right[1], right[2]);
  gl.uniform3f(gl.getUniformLocation(skyProg, 'uUp'), up[0], up[1], up[2]);
  const tanF = Math.tan(36 * Math.PI / 180);
  gl.uniform2f(gl.getUniformLocation(skyProg, 'uTan'), tanF * aspect, tanF);
  gl.uniform3f(gl.getUniformLocation(skyProg, 'uSun'), SUN[0], SUN[1], SUN[2]);
  gl.bindVertexArray(skyVao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.enable(gl.DEPTH_TEST);
  gl.depthMask(true);

  gl.useProgram(blockProg);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(gl.getUniformLocation(blockProg, 'uTex'), 0);
  gl.uniformMatrix4fv(gl.getUniformLocation(blockProg, 'uVP'), false, vp);
  gl.uniform3f(gl.getUniformLocation(blockProg, 'uEye'), eye[0], eye[1], eye[2]);
  gl.uniform3f(gl.getUniformLocation(blockProg, 'uFog'), FOG[0], FOG[1], FOG[2]);
  gl.uniform1f(gl.getUniformLocation(blockProg, 'uFogNear'), 54);
  gl.uniform1f(gl.getUniformLocation(blockProg, 'uFogFar'), 92);
  gl.uniform1f(gl.getUniformLocation(blockProg, 'uAlphaTest'), 0.5);

  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.BACK);
  for (const c of chunks) if (c && c.op) { gl.bindVertexArray(c.op.vao); gl.drawArrays(gl.TRIANGLES, 0, c.op.count); }

  if (dirty.size === 0) {
    gl.disable(gl.CULL_FACE);
    for (const c of chunks) if (c && c.cu) { gl.bindVertexArray(c.cu.vao); gl.drawArrays(gl.TRIANGLES, 0, c.cu.count); }
    gl.enable(gl.CULL_FACE);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.uniform1f(gl.getUniformLocation(blockProg, 'uAlphaTest'), 0.02);
    for (const c of chunks) if (c && c.wa) { gl.bindVertexArray(c.wa.vao); gl.drawArrays(gl.TRIANGLES, 0, c.wa.count); }
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  drawSprites(now / 1000);

  target = started ? raycast(6.5) : null;
  if (target && started) drawHighlight();

  if (started) {
    actionCooldown -= dt;
    if (breakHeld && actionCooldown <= 0) { breakBlock(); actionCooldown = 0.22; }
    else if (placeHeld && actionCooldown <= 0) { placeBlock(); actionCooldown = 0.22; }
  }

  updateLabels();
  drawMap();

  questTimer += dt;
  if (questTimer > 0.3 && started) {
    questTimer = 0;
    checkQuests();
    collectTokens();
    updateNearNPC();
    renderQuests();
    renderDay();
    if (questCount() > 0 && state.started === 0) { state.started = Date.now(); saveSoon(); }
  }
  saveTick += dt;
  if (saveTick > 5 && started) { saveTick = 0; saveNow(); }
}

// ------------------------------------------------------------------- boot ---
function applyManifest() {
  const set = (id, v) => { const el = $(id); if (el && typeof v === 'string' && v) el.textContent = v; };
  const title = WORLD.title || 'Torrance';
  set('brandSub', title + ' beginner level · ' + (WORLD.coords || '33.8096°N 118.3547°W'));
  set('wEyebrow', WORLD.eyebrow);
  set('wTitle', title);
  set('wSub', WORLD.subtitle);
  set('wIntro', WORLD.intro);
  document.title = 'Nautilus Craft — ' + title + ' Beginner Level';
}

function initUI() {
  applyManifest();
  buildHotbar();
  renderQuests();
  renderTokens();
  renderAnchor();
  NET.name = sanitizeName(storedName() || randomName());
  NET.color = colorIndex(NET.name);
  if (playerNameEl) playerNameEl.value = NET.name;
  const netNote = $('netNote');
  if (netNote) {
    netNote.textContent = canMultiplayer()
      ? 'Online · this world is shared with other players at this address'
      : 'Solo in the embedded WebView · open over HTTP for multiplayer';
  }
  if (creditsBoxEl) creditsBoxEl.textContent = window.__CREDITS__ || 'Credits unavailable in this build.';
  renderOnline();
  onlineListEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-verify]');
    if (b) verifyPlayer(b.dataset.verify);
  });
  if (state.finished) { /* keep the badge visible in the list */ }
  $('btnPlay').addEventListener('click', startGame);
  $('btnHelp2').addEventListener('click', () => { welcomeEl.classList.add('hidden'); openHelp(); });
  $('btnCloseHelp').addEventListener('click', () => { helpEl.classList.add('hidden'); startGame(); });
  $('btnHelp').addEventListener('click', openHelp);
  $('btnMap').addEventListener('click', toggleMap);
  btnChatEl.addEventListener('click', () => showChat(!chatEl.classList.contains('show')));
  chatformEl.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatinputEl.value.trim();
    if (!text) return;
    sendChat(text);
    chatinputEl.value = '';
  });
  chatinputEl.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); showChat(false); }
  });
  talkEl.addEventListener('click', () => openDialogue(nearNPC));
  farmEl.addEventListener('click', () => beginClaim(nearBiz));
  photoInput.addEventListener('change', () => handlePhoto(photoInput.files[0]));
  ensureFarmDay();
  renderSats();
  dialogueNextEl.addEventListener('click', advanceDialogue);
  playerNameEl.addEventListener('change', () => {
    NET.name = sanitizeName(playerNameEl.value);
    playerNameEl.value = NET.name;
    NET.color = colorIndex(NET.name);
    try { if (store) store.setItem('nc_name', NET.name); } catch (e) {}
    if (NET.connected) publishPresence();
    renderOnline();
  });
  $('btnSound').addEventListener('click', () => {
    muted = !muted;
    try { store && store.setItem('nc_mute', muted ? '1' : '0'); } catch (e) {}
    $('btnSound').classList.toggle('on', !muted);
    if (!muted) beep(660, 0.08, 'square', 0.02);
    toast(muted ? 'SOUND OFF' : 'SOUND ON', 1200);
  });
  $('btnReset').addEventListener('click', resetPosition);
  $('btnKeep').addEventListener('click', () => completeEl.classList.add('hidden'));
  $('btnRestart').addEventListener('click', resetWorld);
  $('btnResetWorld').addEventListener('click', resetWorld);
  $('btnSound').classList.toggle('on', !muted);
}

function resetPosition() {
  player.x = SPAWN.x; player.y = SPAWN.y; player.z = SPAWN.z;
  player.vy = 0; player.yaw = SPAWN.yaw; player.pitch = SPAWN.pitch;
  toast('BACK AT SPAWN', 1400);
  saveNow();
}
function resetWorld() {
  world.fill(0);
  edits.clear();
  state.quests = Object.create(null);
  state.tokens = [];
  state.inventory = Object.create(null);
  state.sats = 0;
  state.credits = 3000;
  state.shards = 0;
  state.citizens = [];
  state.relations = {};
  state.goal = 'growth';
  state.guidance = '';
  state.campaign = { pve: 0, trade: 0, haul: 0, explore: 0, skirmish: 0, closed: false };
  state.contracts = null;
  state.rep = { completed: 0, failed: 0 };
  state.mer = { faucets: 0, sinks: 0 };
  state.farmDay = '';
  state.farmed = [];
  state.placed = 0; state.broken = 0; state.started = 0; state.finished = false;
  genWorld();
  for (let i = 0; i < CX * CZ; i++) remesh(i);
  resetPosition();
  saveNow();
  renderTokens();
  renderSats();
  netSendScore();
  helpEl.classList.add('hidden');
  completeEl.classList.add('hidden');
  toast('WORLD RESET · TORRANCE RESTORED', 2400);
  renderQuests();
}

function startGame() {
  if (started) { welcomeEl.classList.add('hidden'); return; }
  welcomeEl.classList.add('hidden');
  helpEl.classList.add('hidden');
  if (IS_TOUCH) minimapEl.classList.add('show');
  audioCtx();
  if (!meshed) {
    $('btnPlay').textContent = 'Building Torrance…';
    setTimeout(() => {
      meshAll();
      started = true;
      if (state.started === 0) { state.started = Date.now(); saveSoon(); }
      showHint(IS_TOUCH ? 'Left thumb moves · right thumb looks · ⛏ break · ▣ place' : 'Click to capture the mouse · WASD to move');
      beep(440, 0.08, 'triangle', 0.02);
      const msg = (WORLD.copy && WORLD.copy.started) || 'TORRANCE · FOLLOW THE PALE PATHS';
      setTimeout(() => toast(msg, 2600), 350);
    }, 40);
  } else {
    started = true;
    showHint(IS_TOUCH ? 'Left thumb moves · right thumb looks' : 'Click to capture the mouse');
  }
  NET.name = sanitizeName(playerNameEl ? playerNameEl.value : NET.name);
  try { if (store) store.setItem('nc_name', NET.name); } catch (e) {}
  connectNet();
  if (!IS_TOUCH) setTimeout(lockPointer, 80);
}

// world, save, GL and UI
genWorld();
loadSave();
if (playerCollides()) resetPosition();
initUI();
resize();
requestAnimationFrame(frame);

// ------------------------------------------------------- free-roam shards ---
// Four play shards on a 2×2 grid. NPCs are not fenced to one: the server walks
// them across all four and persists each visit; the HUD shows the player's own
// mapped shards. This mirrors the VM's `game_npc_roam` table.
const SHARD_COUNT = 4;
const SHARD_SPAN = 48;
const SHARD_TIERS = ['STARTER', 'HIGH', 'LOW', 'NULL'];
function shardAt(x, z) {
  return (x >= SHARD_SPAN ? 1 : 0) + (z >= SHARD_SPAN ? 2 : 0);
}
function shardCenter(s) {
  const k = ((s | 0) % SHARD_COUNT + SHARD_COUNT) % SHARD_COUNT;
  return [SHARD_SPAN * 0.5 + (k & 1) * SHARD_SPAN, SHARD_SPAN * 0.5 + ((k >> 1) & 1) * SHARD_SPAN];
}

// ------------------------------------------------- citizens · AI governor ---
// Costs are game credits, never sats and never BTC. The VM/CC is authoritative;
// this panel is the direct-controller mirror with the same type catalogue.
const CITIZEN_TYPES = {
  settler: { name: 'Settler', cost: 1200, toils: ['settle', 'build', 'scout'], blurb: 'Founds an outpost and claims a POI.' },
  worker: { name: 'Worker', cost: 600, toils: ['farm', 'build', 'mine', 'haul'], blurb: 'Grows food, builds, mines and hauls.' },
  trader: { name: 'Trader', cost: 900, toils: ['trade', 'haul', 'broker'], blurb: 'Works a regional order book.' },
  scholar: { name: 'Scholar', cost: 1000, toils: ['research', 'teach', 'culture'], blurb: 'Advances the technology tree.' },
  ranger: { name: 'Ranger', cost: 700, toils: ['scout', 'map', 'patrol'], blurb: 'Explores and maps every shard.' },
  guard: { name: 'Guard', cost: 800, toils: ['guard', 'patrol', 'escort'], blurb: 'Defends the vault or a hauler.' },
  diplomat: { name: 'Diplomat', cost: 1100, toils: ['contact', 'treaty', 'trade'], blurb: 'Opens contact and raises standing.' },
  artisan: { name: 'Artisan', cost: 850, toils: ['craft', 'culture', 'build'], blurb: 'Crafts goods and raises culture.' }
};
const GOAL_WORDS = [
  ['food', ['food', 'farm', 'harvest', 'wheat', 'carrot']],
  ['defence', ['defend', 'defence', 'defense', 'guard', 'protect', 'patrol']],
  ['gold', ['gold', 'credit', 'money', 'profit', 'trade', 'sell']],
  ['science', ['science', 'research', 'tech', 'learn']],
  ['culture', ['culture', 'art', 'craft']],
  ['map', ['map', 'explore', 'scout', 'shard', 'fog']],
  ['diplomacy', ['diplomacy', 'diplomat', 'treaty', 'faction', 'standing']],
  ['production', ['build', 'production', 'mine', 'structure']],
  ['growth', ['settle', 'outpost', 'expand']]
];
const GOAL_TOILS = {
  food: ['farm', 'haul'], defence: ['guard', 'patrol', 'escort'],
  gold: ['trade', 'broker', 'haul'], science: ['research', 'teach'],
  culture: ['culture', 'craft'], map: ['scout', 'map', 'patrol'],
  diplomacy: ['contact', 'treaty', 'trade'], production: ['build', 'mine', 'craft'],
  growth: ['settle', 'build', 'farm']
};
function inferGoal(text) {
  const low = String(text || '').toLowerCase();
  const found = [];
  for (const [kind, words] of GOAL_WORDS) {
    for (const w of words) {
      const at = low.indexOf(w);
      if (at >= 0) { found.push([at, kind]); break; }
    }
  }
  found.sort((a, b) => a[0] - b[0]);
  return found.length ? found[0][1] : 'growth';
}
let lastPlanReason = '';
function citizenDayCount() {
  return state.citizens.filter((c) => c.createdDay === gameDay()).length;
}
function createCitizen(kind, name) {
  const t = CITIZEN_TYPES[kind];
  if (!t) return 'Unknown citizen type.';
  if (citizenDayCount() >= 3) return 'Three citizens per game day is the cap.';
  if (state.credits < t.cost) return `${t.name} costs ${t.cost} credits; you have ${state.credits}.`;
  state.credits -= t.cost;
  const c = {
    id: 'c' + Date.now() + ':' + state.citizens.length,
    kind, name: (name || t.name).slice(0, 24), level: 1, xp: 0,
    shard: shardAt(player.x, player.z), toil: 'idle', goal: state.goal,
    createdDay: gameDay()
  };
  state.citizens.push(c);
  renderCredits(); renderCitizens(); saveSoon();
  beep(660, 0.08, 'triangle', 0.02);
  mqttPublish('citizens/create', { id: c.id, kind, name: c.name, pid: NET.pid || 'solo' }, 1, false);
  return `${c.name} the ${t.name} created for ${t.cost} credits.`;
}
function guideCitizens(text) {
  const goal = inferGoal(text);
  state.goal = goal;
  state.guidance = String(text || '').slice(0, 200);
  renderCitizens(); saveSoon();
  mqttPublish('citizens/guide', { text: state.guidance, goal, pid: NET.pid || 'solo' }, 1, false);
  return `Goal set to ${goal}. I will assign toil and shards from that.`;
}
function planCitizens() {
  if (!state.citizens.length) return 'No citizens yet. Create one first.';
  const wanted = (GOAL_TOILS[state.goal] || GOAL_TOILS.growth);
  const rows = [];
  state.citizens.forEach((c, i) => {
    const t = CITIZEN_TYPES[c.kind] || CITIZEN_TYPES.worker;
    const allowed = t.toils.filter((x) => wanted.includes(x));
    c.toil = allowed.length ? allowed[0] : t.toils[0];
    c.shard = state.goal === 'map' ? (gameDay() + i) % SHARD_COUNT : (i + 1) % SHARD_COUNT;
    c.goal = state.goal;
    c.reason = `goal=${state.goal}; ${c.kind} affinity=${t.toils[0]}; toil=${c.toil}; shard S${c.shard + 1}`;
    rows.push(c.reason);
  });
  lastPlanReason = rows[0] || '';
  campaignAdd('pve', 1);
  renderCitizens(); saveSoon();
  mqttPublish('citizens/plan', { goal: state.goal, pid: NET.pid || 'solo',
    plan: state.citizens.map((c) => ({ id: c.id, toil: c.toil, shard: c.shard })) }, 1, false);
  return `Planned toil for ${state.citizens.length} citizen${state.citizens.length === 1 ? '' : 's'} on goal ${state.goal}.`;
}
function deployCitizen(id, shard) {
  const c = state.citizens.find((x) => x.id === id);
  if (!c) return 'No such citizen.';
  const s = ((shard | 0) % SHARD_COUNT + SHARD_COUNT) % SHARD_COUNT;
  c.shard = s;
  c.status = 'deployed';
  renderCitizens(); saveSoon();
  mqttPublish('citizens/deploy', { id, shard: s, pid: NET.pid || 'solo' }, 1, false);
  return `${c.name} deployed to S${s + 1}. Every shard is reachable.`;
}
function citizenStatus() {
  if (!state.citizens.length) return 'No citizens yet. Say "create a worker".';
  return state.citizens.map((c) => `${c.name} the ${c.kind} is ${c.toil || 'idle'} on S${c.shard + 1}`).join('; ');
}
function renderCitizens() {
  const list = $('citList');
  if (!list) return;
  const goalEl = $('citGoal');
  if (goalEl) goalEl.textContent = `Goal: ${state.goal}${state.guidance ? ' · ' + state.guidance : ''}`;
  const why = $('citWhy');
  if (why) why.textContent = lastPlanReason || 'The AI assigns toil from your goal; the walk and the photo stay yours.';
  list.textContent = '';
  for (const c of state.citizens) {
    const row = document.createElement('div');
    row.className = 'item';
    const left = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = c.name;
    const small = document.createElement('small');
    const t = CITIZEN_TYPES[c.kind] || CITIZEN_TYPES.worker;
    small.textContent = `${t.name} · L${c.level} · ${c.toil || 'idle'} · S${c.shard + 1}`;
    left.append(b, small);
    const btn = document.createElement('button');
    btn.textContent = 'DEPLOY';
    btn.addEventListener('click', () => { toast(deployCitizen(c.id, (c.shard + 1) % SHARD_COUNT).toUpperCase(), 2400); });
    row.append(left, btn);
    list.appendChild(row);
  }
}

// ------------------------------------------------------------- market UI ---
function marketPrice(b) { return Math.max(6, Math.round((b.sats || 60) / 8)); }
function renderMarket() {
  const list = $('mktList');
  if (!list) return;
  list.textContent = '';
  for (const b of BUSINESSES) {
    const price = marketPrice(b);
    const row = document.createElement('div');
    row.className = 'item';
    const left = document.createElement('div');
    const name = document.createElement('b');
    name.textContent = b.item.toUpperCase();
    const small = document.createElement('small');
    small.textContent = `${b.name} · sell ${Math.round(price * 0.95)} cr · you have ${state.inventory[b.item] || 0}`;
    left.append(name, small);
    const buy = document.createElement('button');
    buy.textContent = `BUY ${price}`;
    buy.addEventListener('click', () => {
      if (state.credits < price) { toast('NOT ENOUGH CREDITS', 2000); return; }
      state.credits -= price;
      state.inventory[b.item] = (state.inventory[b.item] || 0) + 1;
      merAdd(0, price); campaignAdd('trade', price);
      renderCredits(); renderMarket(); saveSoon();
      toast(`BOUGHT 1 ${b.item.toUpperCase()} · ${price} CREDITS`, 2000);
    });
    const sell = document.createElement('button');
    sell.textContent = 'SELL';
    sell.addEventListener('click', () => {
      if (!(state.inventory[b.item] > 0)) { toast('NOTHING TO SELL', 1800); return; }
      state.inventory[b.item] -= 1;
      state.credits += Math.round(price * 0.95);
      merAdd(Math.round(price * 0.95), 0); campaignAdd('trade', price);
      renderCredits(); renderMarket(); saveSoon();
      toast(`SOLD 1 ${b.item.toUpperCase()} · 3% BROKER · 2% TAX`, 2200);
    });
    row.append(left, buy, sell);
    list.appendChild(row);
  }
}

// --------------------------------------------------------- relations UI ----
function standingBand(n) {
  if (n >= 60) return 'allied';
  if (n >= 25) return 'friendly';
  if (n >= -25) return 'neutral';
  return 'hostile';
}
function renderDiplomacy() {
  const list = $('dipList');
  if (!list) return;
  list.textContent = '';
  for (const n of NPCS) {
    const standing = Number.isFinite(state.relations[n.id]) ? state.relations[n.id] : 0;
    const row = document.createElement('div');
    row.className = 'item';
    const left = document.createElement('div');
    const name = document.createElement('b');
    name.textContent = n.name;
    const small = document.createElement('small');
    small.textContent = `${standingBand(standing)} · ${standing} · S${(n.shard | 0) + 1} · mapped ${n.seenCount | 0}/4`;
    left.append(name, small);
    const gift = document.createElement('button');
    gift.textContent = 'GIFT 50';
    gift.addEventListener('click', () => {
      if (state.credits < 50) { toast('NOT ENOUGH CREDITS', 1800); return; }
      state.credits -= 50;
      state.relations[n.id] = Math.min(100, standing + 5);
      renderCredits(); renderDiplomacy(); saveSoon();
      toast(`${n.name.toUpperCase()} · ${standingBand(state.relations[n.id]).toUpperCase()}`, 2000);
    });
    row.append(left, gift);
    list.appendChild(row);
  }
}

// ------------------------------------------------- campaigns + contracts ----
const CAMPAIGN_KINDS = [
  ['pve', 'NPC guards', 9, 25],
  ['trade', 'Trade', 9, 5000],
  ['haul', 'Haul', 9, 40],
  ['explore', 'Explore', 8, 4],
  ['skirmish', 'Skirmish', 9, 10]
];
const CAMPAIGN_WIN = 30;
function campaignDone() {
  let done = 0;
  for (const [kind, , count, target] of CAMPAIGN_KINDS) {
    done += Math.min(count, Math.floor((state.campaign[kind] || 0) / target));
  }
  return Math.min(44, done);
}
function campaignAdd(kind, amount) {
  if (state.campaign.closed) return;
  state.campaign[kind] = (state.campaign[kind] || 0) + Math.max(0, amount);
  if (campaignDone() >= CAMPAIGN_WIN) {
    state.campaign.closed = true;
    state.credits += 500;
    toast('CAMPAIGN WON · 30 / 44 OBJECTIVES · +500 CREDITS', 4600);
  }
  renderCampaign();
  saveSoon();
}
function merAdd(faucets, sinks) {
  state.mer.faucets += Math.max(0, faucets | 0);
  state.mer.sinks += Math.max(0, sinks | 0);
}
function seedContracts() {
  if (Array.isArray(state.contracts)) return;
  state.contracts = [
    { id: 'c1', title: 'Haul 3 crates to S2', kind: 'haul', reward: 500, collateral: 0, status: 'open' },
    { id: 'c2', title: 'Guard the garden for a day', kind: 'guard', reward: 400, collateral: 0, status: 'open' },
    { id: 'c3', title: 'Map S4 and report', kind: 'explore', reward: 700, collateral: 200, status: 'open' }
  ];
}
function acceptContract(id) {
  const c = state.contracts.find((x) => x.id === id);
  if (!c || c.status !== 'open') return 'Contract is not open.';
  const active = state.contracts.filter((x) => x.status === 'accepted').length;
  if (active >= 3) return 'Three active contracts is the cap.';
  c.status = 'accepted';
  renderCampaign(); saveSoon();
  return `${c.title} accepted. Deliver it for ${c.reward} credits.`;
}
function deliverContract(id) {
  const c = state.contracts.find((x) => x.id === id);
  if (!c || c.status !== 'accepted') return 'Accept it first.';
  c.status = 'delivered';
  state.credits += c.reward;
  state.rep.completed += 1;
  merAdd(c.reward, 0);
  campaignAdd(c.kind === 'explore' ? 'explore' : 'haul', 1);
  renderCredits(); renderCampaign(); saveSoon();
  return `${c.title} delivered. +${c.reward} credits.`;
}
function renderCampaign() {
  seedContracts();
  const p = $('campProgress');
  if (p) {
    p.textContent = `${campaignDone()} / ${CAMPAIGN_WIN} objectives · 44 total`
      + (state.campaign.closed ? ' · WON' : '');
  }
  const list = $('campKinds');
  if (list) {
    list.textContent = '';
    for (const [kind, name, count, target] of CAMPAIGN_KINDS) {
      const done = Math.min(count, Math.floor((state.campaign[kind] || 0) / target));
      const row = document.createElement('div');
      row.className = 'item';
      const left = document.createElement('div');
      const b = document.createElement('b');
      b.textContent = name;
      const sm = document.createElement('small');
      sm.textContent = `${done}/${count} · ${state.campaign[kind] || 0} contribution`;
      left.append(b, sm);
      const pct = document.createElement('button');
      pct.textContent = `${Math.round((done / count) * 100)}%`;
      pct.disabled = true;
      row.append(left, pct);
      list.appendChild(row);
    }
  }
  const rep = $('contractRep');
  if (rep) rep.textContent = `Reputation ${state.rep.completed} delivered · 3 active max · escrow`;
  const cl = $('contractList');
  if (cl) {
    cl.textContent = '';
    for (const c of state.contracts) {
      const row = document.createElement('div');
      row.className = 'item';
      const left = document.createElement('div');
      const b = document.createElement('b');
      b.textContent = c.title;
      const sm = document.createElement('small');
      sm.textContent = `${c.status} · ${c.reward} credits · bond ${c.collateral}`;
      left.append(b, sm);
      const btn = document.createElement('button');
      btn.textContent = c.status === 'open' ? 'ACCEPT' : c.status === 'accepted' ? 'DELIVER' : 'DONE';
      btn.disabled = c.status === 'delivered';
      btn.addEventListener('click', () => {
        const msg = c.status === 'open' ? acceptContract(c.id) : deliverContract(c.id);
        toast(msg.toUpperCase(), 2800);
      });
      row.append(left, btn);
      cl.appendChild(row);
    }
  }
  const mer = $('merLine');
  if (mer) {
    const delta = state.mer.faucets - state.mer.sinks;
    mer.textContent = `MER · in ${state.mer.faucets} · out ${state.mer.sinks}`
      + ` · Δ ${delta >= 0 ? '+' : ''}${delta}`;
  }
}

// -------------------------------------------------------- voice + panels ---
const PANELS = ['citizens', 'market', 'diplomacy', 'campaign'];
function openPanel(id) {
  for (const p of PANELS) {
    const el = $(p);
    if (el) el.classList.toggle('hidden', p !== id);
  }
  for (const btn of document.querySelectorAll('#pad button')) {
    btn.classList.toggle('on', btn.dataset.pad === id);
  }
  if (id === 'citizens') renderCitizens();
  if (id === 'market') renderMarket();
  if (id === 'diplomacy') renderDiplomacy();
  if (id === 'campaign') renderCampaign();
}
function closePanels() { for (const p of PANELS) { const el = $(p); if (el) el.classList.add('hidden'); } }
let recognizer = null;
function startAssist() {
  const voiceEl = $('voice');
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    const text = window.prompt('Assistant — say what you want:', '');
    if (text) assistantIntent(text);
    return;
  }
  if (recognizer) { try { recognizer.stop(); } catch (e) {} recognizer = null; return; }
  recognizer = new SR();
  recognizer.lang = 'en-US';
  recognizer.interimResults = false;
  recognizer.maxAlternatives = 1;
  recognizer.onstart = () => { if (voiceEl) voiceEl.classList.remove('hidden'); };
  recognizer.onend = () => { if (voiceEl) voiceEl.classList.add('hidden'); recognizer = null; };
  recognizer.onerror = () => {
    if (voiceEl) voiceEl.classList.add('hidden');
    toast('VOICE UNAVAILABLE · USE THE CITIZENS PANEL OR THE PAD', 3000);
  };
  recognizer.onresult = (ev) => {
    const text = ev.results && ev.results[0] && ev.results[0][0] ? ev.results[0][0].transcript : '';
    if (text) assistantIntent(text);
  };
  try { recognizer.start(); } catch (e) { if (voiceEl) voiceEl.classList.add('hidden'); }
}
function speak(text) {
  if (muted || !('speechSynthesis' in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(String(text).slice(0, 220));
    u.rate = 1.02; u.pitch = 1.0;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch (e) {}
}
function assistantIntent(text) {
  const low = String(text || '').toLowerCase().trim();
  if (!low) return '';
  let reply = '';
  let m;
  if ((m = /create (?:a |an )?(settler|worker|trader|scholar|ranger|guard|diplomat|artisan)(?: named ([a-z0-9 ]{1,24}))?/.exec(low))) {
    reply = createCitizen(m[1], (m[2] || m[1]).trim().replace(/\b\w/g, (c) => c.toUpperCase()));
    openPanel('citizens');
  } else if ((m = /(?:tell|guide|direct) the citizens? to (.+)/.exec(low))) {
    reply = guideCitizens(m[1]);
    openPanel('citizens');
  } else if (/(put the citizens to work|plan the citizens|assign (the )?citizens)/.test(low)) {
    reply = planCitizens();
    openPanel('citizens');
  } else if ((m = /deploy ([a-z0-9 ]{1,24}?) to shard ([1-4])/.exec(low))) {
    const name = m[1].trim();
    const c = state.citizens.find((x) => x.name.toLowerCase() === name);
    reply = c ? deployCitizen(c.id, Number(m[2]) - 1) : `No citizen named ${name}.`;
  } else if (/citizen/.test(low) && /(status|doing|report|list)/.test(low)) {
    reply = citizenStatus();
    openPanel('citizens');
  } else if (/market|price|buy|sell/.test(low)) {
    reply = 'Regional market open. Prices are game credits; BTC never moves here.';
    openPanel('market');
  } else if (/diplomacy|relation|standing|gift/.test(low)) {
    reply = 'AI relations open. Contact works in any shard; aggression cools after seven game days.';
    openPanel('diplomacy');
  } else if (/map|shard|explore/.test(low)) {
    reply = `Mapped ${countBits(state.shards)} of ${SHARD_COUNT} shards. The AI roams every one.`;
    toggleMap();
  } else if (/claim|photo|farm/.test(low)) {
    if (nearBiz && !state.farmed.includes(nearBiz.id)) { beginClaim(nearBiz); reply = `Photo claim started for ${nearBiz.name}.`; }
    else reply = nearBiz ? 'That business is already claimed this game day.' : 'Walk to a business first; I cannot take the photo for you.';
  } else if (/talk|speak|hello/.test(low)) {
    if (nearNPC) { openDialogue(nearNPC); reply = `Talking to ${nearNPC.name}.`; }
    else reply = 'Walk to a neighbour first; I will not move your body.';
  } else if (/campaign|objective|war/.test(low)) {
    reply = `Epoch campaign: ${campaignDone()} of ${CAMPAIGN_WIN} objectives (44 total).`;
    openPanel('campaign');
  } else if (/contract|job|hire/.test(low)) {
    reply = 'Contract board open. Rewards are held in escrow; three active contracts per worker.';
    openPanel('campaign');
  } else if (/security|tier|border/.test(low)) {
    const s = shardAt(player.x, player.z);
    reply = `Shard S${s + 1} is ${SHARD_TIERS[s]} security; payout ${s === 0 ? 80 : s === 3 ? 125 : 100}%.`;
  } else if (/restart|new epoch|reset/.test(low)) {
    if (/confirm/.test(low)) {
      restartEpoch();
      reply = `Epoch ${state.epoch} started in cohort ${state.epochCohort}. Nothing carried over.`;
    } else {
      requestRestart();
      reply = 'A restart starts a new epoch in the same cohort and nothing carries over. Say "confirm restart" or tap EPOCH again.';
    }
  } else if (/help|what can/.test(low)) {
    reply = 'I can create citizens, set their goal, plan toil, deploy them, open the market or relations, map shards, claim and talk. The pad does the same directly.';
  } else {
    reply = 'I can create citizens, guide or plan them, deploy to a shard, open the market or relations, map, claim or talk.';
  }
  mqttPublish('assistant/intent', { text: low, reply, pid: NET.pid || 'solo', at: Date.now() }, 1, false);
  appendChat('ASSISTANT', reply, false, true);
  toast(reply.toUpperCase().slice(0, 120), 3400);
  speak(reply);
  return reply;
}
function padAction(id) {
  if (id === 'assist') return startAssist();
  if (id === 'claim') {
    if (nearBiz && !state.farmed.includes(nearBiz.id)) beginClaim(nearBiz);
    else toast(nearBiz ? 'ALREADY FARMED THIS GAME DAY' : 'WALK TO A BUSINESS FIRST', 2200);
    return;
  }
  if (id === 'talk') {
    if (nearNPC) openDialogue(nearNPC);
    else toast('WALK TO A NEIGHBOUR FIRST', 2000);
    return;
  }
  if (id === 'map') return toggleMap();
  if (id === 'epoch') return requestRestart();
  openPanel(id);
}
for (const btn of document.querySelectorAll('#pad button')) {
  btn.addEventListener('click', () => padAction(btn.dataset.pad));
}
for (const btn of document.querySelectorAll('[data-close]')) {
  btn.addEventListener('click', () => { const el = $(btn.dataset.close); if (el) el.classList.add('hidden'); });
}
if ($('btnCitizens')) $('btnCitizens').addEventListener('click', () => openPanel('citizens'));
if ($('btnAssist')) $('btnAssist').addEventListener('click', startAssist);
if ($('citCreate')) $('citCreate').addEventListener('click', () => {
  const name = ($('citName').value || '').trim();
  const kind = $('citKind').value;
  toast(createCitizen(kind, name).toUpperCase(), 3200);
  if ($('citName')) $('citName').value = '';
});
if ($('citGuideBtn')) $('citGuideBtn').addEventListener('click', () => {
  const text = ($('citGuide').value || '').trim();
  if (text) toast(guideCitizens(text).toUpperCase(), 3200);
});
if ($('citPlan')) $('citPlan').addEventListener('click', () => toast(planCitizens().toUpperCase(), 3200));
if ($('citMap')) $('citMap').addEventListener('click', () => { guideCitizens('map every shard'); toast(planCitizens().toUpperCase(), 3200); });
addEventListener('keydown', (e) => {
  if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.code === 'KeyC') openPanel('citizens');
  else if (e.code === 'KeyV') startAssist();
  else if (e.code === 'KeyM') openPanel('market');
  else if (e.code === 'KeyR') openPanel('diplomacy');
  else if (e.code === 'Escape') closePanels();
});

window.__nc = {
  get ready() { return started; },
  get player() { return player; },
  get state() { return state; },
  get quests() { return QUESTS.map((q) => ({ id: q.id, done: !!state.quests[q.id] })); },
  get manifest() { return WORLD; },
  teleport(x, z, y) {
    player.x = x + 0.5; player.z = z + 0.5;
    player.y = typeof y === 'number' ? y : GROUND + 1;
    player.vy = 0;
  },
  look(yaw, pitch) {
    player.yaw = typeof yaw === 'number' ? yaw : player.yaw;
    player.pitch = typeof pitch === 'number' ? pitch : player.pitch;
  },
  set(x, y, z, name) {
    const id = NAME_TO_ID[String(name).toLowerCase()];
    if (typeof id === 'number') setB(x | 0, y | 0, z | 0, id);
  },
  edit(x, y, z, name) {
    const id = NAME_TO_ID[String(name).toLowerCase()];
    if (typeof id !== 'number') return;
    setB(x | 0, y | 0, z | 0, id);
    sendBlockEdit(x | 0, y | 0, z | 0, id);
  },
  chat(text) { sendChat(String(text)); },
  verify(pid) { return verifyPlayer(pid); },
  get sats() { return state.sats; },
  get credits() { return state.credits; },
  get shards() { return state.shards; },
  get citizens() { return state.citizens.map((c) => ({ ...c })); },
  get goal() { return state.goal; },
  get epoch() { return { id: state.epoch, cohort: state.epochCohort, day: epochDay(), archive: state.epochArchive.length }; },
  restartEpoch, requestRestart,
  get campaign() { return { ...state.campaign, done: campaignDone(), needed: CAMPAIGN_WIN }; },
  get contracts() { return (state.contracts || []).map((c) => ({ ...c })); },
  get mer() { return { ...state.mer }; },
  campaignAdd, acceptContract, deliverContract,
  security() { const s = shardAt(player.x, player.z); return { shard: s + 1, tier: SHARD_TIERS[s] }; },
  shardAt, createCitizen, guideCitizens, planCitizens, deployCitizen, citizenStatus,
  assistantIntent, openPanel, closePanels,
  market() { return BUSINESSES.map((b) => ({ id: b.id, item: b.item, price: marketPrice(b) })); },
  get gameDay() { return gameDay(); },
  get inventory() { return { ...state.inventory }; },
  async exif() { return photoExif(photoInput.files[0]); },
  claimState() { return { pending: pendingClaim && pendingClaim.id, farmed: state.farmed.slice(), sats: state.sats }; },
  claim(id) {
    const b = BUSINESSES.find((x) => x.id === id);
    if (!b) return false;
    if (farmDistance(b) > 4.2) return false;
    pendingClaim = b;
    return true;
  },
  ledger() {
    return {
      anchor: NET.anchor, sides: [...NET.sides.keys()],
      accounts: [...NET.accounts.keys()], revision: NET.revision
    };
  },
  net() {
    return {
      connected: NET.connected,
      players: [...NET.players.keys()],
      scores: [...NET.scores.keys()],
      anchor: NET.anchor,
      revision: NET.revision,
      pid: NET.pid
    };
  },
  start: startGame,
  reset: resetWorld,
  map: toggleMap,
  place() { placeBlock(); },
  breakBlock() { breakBlock(); },
  meshAll
};
console.log('NAUTILUS_CRAFT ready · Torrance', WX + '×' + WZ, 'blocks');
})();
