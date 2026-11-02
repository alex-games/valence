# Minecraft VM — build and runbook

This directory is the **separate VM** for Nautilus Craft. It does not share the
business (pg-browser) board, image, runtime or database.

```
vm/
├── board/minecraft/
│   ├── linux.conf                 copied from the working pg-browser kernel
│   ├── post-build.sh              ELF/config checks
│   ├── post-image.sh              rootfs.tar → 9p blobs
│   ├── patch-defconfig.py         derives the Minecraft defconfig
│   ├── users.txt
│   └── rootfs_overlay/
│       ├── usr/bin/minecraft-server   i686-musl static game origin
│       ├── usr/bin/vault              copied from the business board at build
│       ├── nautilus/minecraft/        seed assets (page, manifest, map)
│       └── etc/{init.d,nginx,mosquitto,inittab,hostname,issue}
└── build2026-minecraft.sh
```

## Build

On the build host, from the buildroot checkout:

```bash
# 1. cross-build the game origin (i686-musl, static)
docker run --rm -v "$PWD":/src -w /src rust:1.90-bookworm sh -c '
  rustup target add i686-unknown-linux-musl
  export PATH=$(rustc --print sysroot)/lib/rustlib/x86_64-unknown-linux-gnu/bin:$PATH
  CARGO_TARGET_I686_UNKNOWN_LINUX_MUSL_LINKER=rust-lld \
    cargo build --release --target i686-unknown-linux-musl --manifest-path server/Cargo.toml'
cp server/target/i686-unknown-linux-musl/release/minecraft-server \
   config/board/minecraft/rootfs_overlay/usr/bin/minecraft-server

# 2. bundle the page and stage the assets
python3 tools/bundle-web.py
cp web/dist/* vm/board/minecraft/rootfs_overlay/nautilus/minecraft/

# 3. install the board and build the image
rsync -a vm/board/minecraft/ config/board/minecraft/
cp vm/build2026-minecraft.sh .
./build2026-minecraft.sh
```

The script derives `config/config-buildroot-2026.08.1-minecraft` from the
known-good base, builds a separate image tag `buildroot2026-minecraft`, and
leaves the v86 payload in `build-2026-minecraft/filesystem`.

The Vault binary is 258 MiB and is shared with the business board; the script
copies it into the Minecraft overlay if it is not already there, rather than
committing a second copy.

## What boots

| Service | Port | Notes |
|---|---|---|
| nginx | `:80`, `:8080` | `/` and `/embed/` → game; `/mqtt` → Mosquitto |
| minecraft-server | `127.0.0.1:8081` | assets/manifest from PostgreSQL; MQTT bridge |
| Mosquitto 2.x | `127.0.0.1:1883`, `9001` ws | MQTT v5; anonymous LAN demo |
| Vault (dev) | `127.0.0.1:8200` | BTC wallets; root token `nautilus-dev` |
| PostgreSQL 18.6 | `127.0.0.1:5432` | `nautilus_craft`, user `craft` |

Init order: `S47vault` → `S48mosquitto` → `S49postgres-pgdata` →
Buildroot `S50postgresql` (initdb/start) → `S51craft-db` (role/database) →
`S52minecraft` → `S53nginx` → `S99banner`.

## Verify in the guest

```sh
wget -qO- http://127.0.0.1/healthz
wget -qO- http://127.0.0.1/api/world
tail -40 /var/log/minecraft.log

mosquitto_sub -h 127.0.0.1 -t 'wa/v1/c2/torrance/#' -v

su - postgres -c "psql -d nautilus_craft -c '\\dt'"
su - postgres -c "psql -d nautilus_craft -c 'select path,length(body) from game_assets'"
su - postgres -c "psql -d nautilus_craft -c 'select player_id,name,address,quests,tokens,mmr_events from game_accounts'"
su - postgres -c "psql -d nautilus_craft -c 'select shard,height,edits from game_side_blocks order by height desc limit 8'"
su - postgres -c "psql -d nautilus_craft -c 'select height,hash from game_anchors order by height desc limit 4'"

VAULT_ADDR=http://127.0.0.1:8200 VAULT_TOKEN=nautilus-dev vault kv get secret/nautilus/players/<pid>
```

## Play

- Browser: `http://<vm-ip>/` (multiplayer over MQTT).
- WorkAgent WebView: `http://127.0.0.1:8080/embed/` (solo; the host WebView
  cannot reach the guest's MQTT socket).
- Two browsers on the VM's HTTP origin share positions, chat, map edits, NPC
  state and the ledger; the **✓** button in *How to play → Players online*
  verifies a player's account MMR → shard MMR → main-chain anchor.

## Limits

- Mosquitto and Vault are anonymous/dev-mode LAN services. Put TLS and auth in
  front before exposure.
- The Vault dev server stores wallets in memory; a reboot discards them. File
  storage + operator init/unseal is the production path.
- The map snapshot is capped at 6,000 client edits in the demo.
- The anchor payload is CC-compatible, but the command centre does not yet
  append it to the global chain.

## Player accounts, wallets and the chain

- Every `pid` gets a Bitcoin **testnet** P2PKH wallet on first presence. The WIF
  and private key are written to Vault at `secret/data/nautilus/players/<pid>`;
  only the address is published.
- The account is a bagged MMR of `presence|…` and `score|…` events.
- The player is assigned to one of four consistent-hash shards. That shard's
  sidechain is a bagged MMR of map edits and `account|<pid>|<root>|<events>`
  leaves.
- Every ten seconds the bridge appends a `level.anchor` committing the four
  shard tips (height, hash, root) to the main chain and publishes it retained on
  `wa/v1/c2/torrance/ledger/anchor`.
- The game's **Players online** panel has a **✓** button that verifies a
  player's account MMR → shard MMR → anchor entirely in the browser.
- Postgres projections: `game_accounts`, `game_account_events`,
  `game_side_blocks`, `game_anchors`, `game_edits`.

Verified in a standalone run (Mosquitto + the i686 binary, no Postgres): the
account MMR root, shard MMR root and anchor #2 hash all matched the JavaScript
verifier; NPC state and retained map state were delivered on the expected
topics. The VM image build is the remaining step.

## Verified on 2026-11-01

Standalone (Mosquitto + `minecraft-server`, no Postgres) and two Chromium
clients against the real MQTT broker:

- two players connected, saw each other in presence and the online panel;
- chat crossed clients (`hello from Alice` on Bob's screen);
- a block edit crossed clients and advanced `map/state` revision;
- a Vault dev server created a testnet wallet (`mhQQ…`, WIF/private key in
  `secret/data/nautilus/players/walletpid`);
- the **✓** verifier returned `✓ … VERIFIED · anchor #8 · shard 1` after
  rebuilding the player MMR, the shard MMR and the anchor hash in the browser;
- screenshot: `.playwright/game-shot.png` (brand, stats, anchor #8, wallet,
  quests, chat, hotbar, NPCs).

## Memory and runtime

- Boot the guest with **512 MiB**. Vault, PostgreSQL, nginx, Mosquitto and the
  game origin are all resident; 256 MiB is the AI-workspace size, not this VM's.
- The payload is a v86 9p tree (`build-2026-minecraft/filesystem`), not a disk
  image. Assemble a runtime with the v86 page, lib and BIOS from
  `workagent-3/WorkAgent/VMResources`:

```bash
mkdir -p vm/runtime
cp -r ../workagent-3/WorkAgent/VMResources/{index.html,lib,bios} vm/runtime/
cp -r /path/to/build-2026-minecraft/filesystem vm/runtime/
python3 tools/compress-filesystem.py vm/runtime/filesystem --html vm/runtime/index.html
```

- **A warm `state/` snapshot from the business VM is not valid for this image.**
  Boot cold (`?boot=true`) until a new snapshot is captured from this guest.
- **The default starting state is a cold boot captured once.** Run
  `./vm/coldboot-default.sh` after the image build; it cold-boots the real page
  and writes `vm/runtime/state/default.bin` plus `default.json` (sha256, bytes,
  commit, memory). Every later warm boot starts from that state, and every new
  epoch inherits it; `--register` also appends the checkpoint to `epochs.db`.
  Never hand-edit `default.bin`: a state whose hash does not match the manifest
  is refused (`docs/games/save-states.md`).
- The `bzImage` filename in `index.html` is rewritten by
  `compress-filesystem.py`; do not reuse the business page's kernel name.

## Redis ccache sidecar

The build joins `buildroot-net` and ccache 4.13 uses
`remote_storage = redis://buildroot-redis:6379/0`, `namespace = buildroot`.

Verified 2026-11-01 during the Minecraft image build:

- `buildroot-redis` answers PING, holds **121,311 keys**, and `strange_villani`
  resolves it at `172.18.0.2`; `ccache -p` shows the remote storage active.
- ccache wrote and queried the sidecar (116,599 remote lookups), but reported
  **1 remote hit / 116,598 misses**; local storage supplied 336,601 hits
  (73.7%). **The sidecar was connected but not accelerating across builds.**
- Root cause: `compiler_check = mtime`. Every container rebuilds the host and
  target GCC, so the compiler's mtime/size changes and every key changes.
  `config/ccache.conf` now sets `compiler_check = content`; the next image build
  has stable compiler keys. `build2026-minecraft.sh` now prints `ccache -s` and
  the Redis counters at the end so this cannot pass unnoticed again.
