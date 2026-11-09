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
| D77 `edits int4` + outbox payload | 2026-11-08 | 12,279 s | exit 0, 226 MB; sealed restore PASS, 1 shard / 1 anchor / 1 outbox row |
| scoped Vault token | 2026-11-09 | 12,551 s | exit 0, 226 MB; sealed restore 10/10 PASS, game-token denied policy list |
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
PostgreSQL 16 container.

**Seventh image status: validated 2026-11-09.** Build `12,279 s`, exit 0,
226 MB, binary 16 MB i686 static with the D77 cast and the outbox producer. A
sealed capture (`state7clean`, 869,969,460 bytes raw / 42 MB zst,
sha256 `6ce31794…c00a61`) restored a shell in **0 s** and the proof printed
`restore-proof: PASS` for every check:

```
Sealed false (Vault 1.17.0-beta1)
POST /api/assistant restore-p1 → "intent":"status"
vault secret/data/nautilus/game/index → {"players":["restore-p1"],"revision":1}
vault secret/data/nautilus/players/restore-p1/state → version 1
game_state_index → restore-p1 | revision 1 | 5c972e004b5817d3
game_accounts    → restore-p1
game_side_blocks → 1 (shard row written)
game_anchors     → 1
game_outbox      → 1 queued game.state.restore-p1
```

**Eighth image status: validated 2026-11-09.** Build `12,551 s`, exit 0,
226 MB. Cold capture `state8b` (868,888,252 bytes raw / 42 MB zst,
sha256 `c4bd908b…cde0`); restore shell **0 s**, `restore-proof: PASS` for all
ten checks:

```
/etc/init.d/S47vault unseal → OK (sealed=false; scoped token)
vault status → Sealed false
s47: grep -c game-token /etc/init.d/S47vault → 2
game-token tokenlen=95; KV read succeeds; vault policy list is denied
POST /api/assistant restore-p1 → "intent":"status"
game_state_index → restore-p1 | revision 1 | 676d088eae0d0824
game_accounts → restore-p1
game_side_blocks → 1
game_anchors → 1
game_outbox → 1 queued game.state.restore-p1
```

The game server therefore runs with the scoped token, not the root token, on
the built image.

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

**Scoped Vault token.** S47 writes a `nautilus-game` policy and creates an
orphan token at `/var/lib/vault/game-token` (`0600`); `S52minecraft` exports it
and the Rust client prefers it over the root token. `unseal` revalidates the
token and recreates it if `token lookup` fails. Validated against Vault 1.17.6
in Docker:

```
kv put/get secret/nautilus/game/probe   → 200
vault policy list                       → 403 permission denied
kv put secret/other/x                   → 403 permission denied
token lookup                            → token-nautilus-game
```

The seventh image predates this change; the eighth payload carries it.

**D62 — capture Vault sealed.** An unsealed Vault in a warm snapshot restores to
an empty console. A state captured with Vault stopped or sealed returns a shell
in 3 s. `vm/validate.sh` defaults `WA_GAME_SEAL_VAULT=1`; after restore run
`/etc/init.d/S47vault start` (or `unseal`) before reading per-player KV.

Verified with state8: shell 3 s, unseal `Sealed false`, POST `/api/assistant`
created `restore-p1`, Vault index `{"players":["restore-p1"],"revision":1}`,
player state version 1, and `game_state_index` revision 1.

**D62 follow-up — sealing is necessary, not sufficient.** On the seventh image
`vault operator seal` printed `Success! Vault is sealed.` and then the shell did
not return; the old capture ran `vault status` in the same command and saved
with that probe still in front of the prompt. Restoring that state echoes every
command and executes none. The harness now Ctrl-Cs after the seal, waits for
`__WA_SEAL_QUIET__`, probes status separately, and Ctrl-Cs again before the
save. `state7clean` was captured this way and restores a shell in **0 s**; the
proof is above.

## 4. What the image now persists

- `/var/lib/vault/data` — file-backend Vault; per-player game state at
  `secret/data/nautilus/players/<pid>/state`, the index/revision, the audit and
  wallet secrets. S47 initialises once, stores the unseal key/root token `0600`,
  re-unseals on boot, and creates the scoped `game-token` (`0600`) the game
  server actually uses.
- `/var/lib/pgsql` — PostgreSQL sidechain (`game_edits`, `game_accounts`,
  `game_side_blocks`, `game_anchors`, `game_outbox`).
- Both are under `/var/lib` and therefore in the warm-boot snapshot.

The `-dev` Vault is gone; `nautilus-dev` is no longer the token. The game server
reads `/var/lib/vault/game-token`; that token can only touch
`secret/data/nautilus/*`. Use the root token only for Vault administration.

## 5. Verify before capture

```sh
# in the guest
wget -qO- http://127.0.0.1/healthz
vault status
VAULT_TOKEN=$(cat /var/lib/vault/game-token) vault kv get secret/nautilus/game/index
VAULT_TOKEN=$(cat /var/lib/vault/game-token) vault kv get secret/nautilus/players/<pid>/state
VAULT_TOKEN=$(cat /var/lib/vault/game-token) vault policy list   # expect 403
su - postgres -c "psql -d nautilus_craft -c '\\dt'"
```

Then capture the cold boot with `vm/coldboot-default.sh`; the manifest and the
warm-boot snapshot are what make the state portable.
