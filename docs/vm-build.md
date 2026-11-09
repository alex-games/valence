# Building the Minecraft VM on `dev@192.168.40.105`

The VM is built on the buildroot host, not on the phone:

```
buildroot checkout  /localdisk/home/dev/work/ntls-api-builder/nftconsole/buildroot
board               config/board/minecraft
image script        ./build2026-minecraft.sh
payload             build-2026-minecraft/filesystem
```

## 1. Cross-build the Valence binary

The guest is **i686**, so the binary must be a 32-bit static ELF. On the Mac:

```bash
cd Vendor/valence
python3 -m pip install --user ziglang
ZIG=~/Library/Python/3.9/lib/python/site-packages/ziglang/zig   # or `which zig`
export PATH=$HOME/.cargo/bin:$PATH
export CC_i686_unknown_linux_musl=$PWD/tools/zigcc-i686.sh
export CARGO_TARGET_I686_UNKNOWN_LINUX_MUSL_LINKER=$CC_i686_unknown_linux_musl
export AR_i686_unknown_linux_musl="$ZIG ar"
export RUSTFLAGS='-C link-self-contained=no'
cargo build --release --target i686-unknown-linux-musl -p nautilus_craft --features c2
cp target/i686-unknown-linux-musl/release/nautilus-craft \
   vm/board/minecraft/rootfs_overlay/usr/bin/minecraft-server
file vm/board/minecraft/rootfs_overlay/usr/bin/minecraft-server
```

`tools/zigcc-i686.sh` is the small wrapper that translates the Rust target
triple to `zig cc -target x86-linux-musl` and strips `-m32`/`-melf_i386`.

Two Valence upstream fixes are required for the 32-bit build:

- `valence_protocol/src/var_long.rs`: `_pdep_u64` is x86_64-only; the 32-bit
  path now uses the scalar encoder.
- `ring` MUST be built with the same wrapper and `AR`; otherwise its static
  archive is empty and the final link fails with `ring_core_…` undefined.

## 2. Sync the board

```bash
rsync -az --delete \
  --exclude rootfs_overlay/usr/bin/vault \
  vm/board/minecraft/ \
  dev@192.168.40.105:/localdisk/home/dev/work/ntls-api-builder/nftconsole/buildroot/config/board/minecraft/
```

The 258 MiB `vault` binary is shared with the business board and is deliberately
not copied by rsync.

## 3. Build

```bash
ssh dev@192.168.40.105
cd /localdisk/home/dev/work/ntls-api-builder/nftconsole/buildroot
./build2026-minecraft.sh
```

The build creates `build-2026-minecraft/filesystem` and its runtime payload.
`post-build.sh` refuses a non-i386 ELF and checks `etc/vault/vault.hcl` is
present.

## Build result

| Build | When | Duration | Result |
|---|---|---|---|
| file-backend Vault + Valence origin | 2026-11-07 | 11,826 s | exit 0, 226 MB, 12,540 blobs |
| per-player Vault state + revision | 2026-11-07 | 11,855 s | exit 0, 226 MB, 12,540 blobs |
| S47 init validation | 2026-11-07 | 11,864 s | exit 0, 226 MB, 12,540 blobs |
| S47 human-output recovery + sidechain | 2026-11-08 | 12,473 s | exit 0, 226 MB, 12,540 blobs |
| accounts/shards/anchors producer | 2026-11-08 | 12,227 s | exit 0, 226 MB, six-state sidechain |
| D77 `edits int4` payload | 2026-11-08 | running | seventh image, started 20:29 |
| cold boot (sidechain build) | 2026-11-08 | — | Vault **unsealed**, KV enabled, PostgreSQL tables created |

The second build's `rootfs/usr/bin/minecraft-server` is the 15 MB i686 static
binary (timestamp 06:20) and contains the per-player Vault paths.

**Third build (S47 fix):** the in-guest check found Vault `Initialized true` but
`Sealed true` because `init.json` was a non-JSON file from a failed init and the
old script skipped re-init. `S47vault` now validates the file, moves invalid
init/keyless storage aside, writes through a temp file, unseals and checks
`Sealed false`. The third image (11,864 s, exit 0) includes the JSON validation; the fifth image
(12,473 s, exit 0) includes the human-output recovery and the PostgreSQL
sidechain writer. Its cold-boot check observed:

```
Initialized true
Sealed      false
Success! Enabled the kv-v2 secrets engine at: secret/
game_accounts, game_anchors, game_edits, game_state_index, game_events, ...
```

The fresh image has no player state yet, so `secret/nautilus/game/index` and
`secret/nautilus/players` are empty by design; the first assistant turn creates
them.

**Sixth image status:** the accounts/shard/anchor binary is in the payload and a
fresh sealed capture (state6d) reached a shell in **3 s**. After unseal,
`POST /api/assistant` wrote:

- `secret/nautilus/game/index` → `{"players":["restore-p1"],"revision":1}`
- `secret/nautilus/players/restore-p1/state` → version 1
- `game_state_index` → revision 1
- `game_accounts` → `restore-p1`

`game_side_blocks` and `game_anchors` are **empty** on this run. That is D77:
`game_side_blocks.edits` is `int4`, the writer passed `i64` and discarded the
`ToSql` error, so the anchor step saw an empty tip list. Fixed in source at
`2243ee7` (cast to `i32`, log every sidechain error) and proven against a real
PostgreSQL 16 container; the seventh image is the remaining end-to-end proof.

**Outbox producer.** The same writer now appends to `game_outbox`:

- a state save → `game.state.<pid>` with revision, hash, day, quests, tokens,
  shard, shard height and anchor height;
- a place/break → `game.edit` with position, block and player.

Rows start `status='queued'`; no courier drains them yet. Measured on
PostgreSQL 16 with two `status` turns for `outbox-p1`:

```
seq 1  game.state.outbox-p1  rev 1  shard_h 1  anchor_h 1
seq 2  game.state.outbox-p1  rev 2  shard_h 2  anchor_h 2
game_side_blocks: (shard 1, height 1, edits 1), (shard 1, height 2, edits 2)
game_anchors:     height 1 (parent empty), height 2 (parent = anchor 1 hash)
```

**D62 — capture Vault sealed.** An unsealed Vault in a warm snapshot restores to
an empty console. A state captured with Vault stopped or sealed returns a shell
in 3 s. `vm/validate.sh` defaults `WA_GAME_SEAL_VAULT=1`; after restore run
`/etc/init.d/S47vault start` (or `unseal`) before reading per-player KV.

Verified with state8: shell 3 s, unseal `Sealed false`, POST `/api/assistant`
created `restore-p1`, Vault index `{"players":["restore-p1"],"revision":1}`,
player state version 1, and `game_state_index` revision 1.

## 4. What the image now persists

- `/var/lib/vault/data` — file-backend Vault; per-player game state at
  `secret/data/nautilus/players/<pid>/state`, the index/revision, the audit and
  wallet secrets. S47 initialises once, stores the unseal key/root token `0600`,
  and re-unseals on boot.
- `/var/lib/pgsql` — PostgreSQL sidechain (`game_edits`, `game_accounts`,
  `game_side_blocks`, `game_anchors`).
- Both are under `/var/lib` and therefore in the warm-boot snapshot.

The `-dev` Vault is gone; `nautilus-dev` is no longer the token. Read the token
from `/var/lib/vault/root-token` in the guest.

## 5. Verify before capture

```sh
# in the guest
wget -qO- http://127.0.0.1/healthz
vault status
VAULT_TOKEN=$(cat /var/lib/vault/root-token) vault kv get secret/nautilus/game/index
VAULT_TOKEN=$(cat /var/lib/vault/root-token) vault kv get secret/nautilus/players/<pid>/state
su - postgres -c "psql -d nautilus_craft -c '\\dt'"
```

Then capture the cold boot with `vm/coldboot-default.sh`; the manifest and the
warm-boot snapshot are what make the state portable.
