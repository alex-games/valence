#!/usr/bin/env bash
# Cold boot once, then keep the captured state as the default game start.
#
#   ./vm/coldboot-default.sh            # capture vm/runtime/state/default.bin
#   ./vm/coldboot-default.sh --register # also append the checkpoint to epochs.db
#
# The cold boot is the only boot that runs the full guest init (Postgres initdb,
# nginx, Mosquitto, Vault, minecraft-server). The captured v86 state is the
# default for every warm boot and every new epoch; a player's progression
# checkpoint is layered on top of it (docs/games/save-states.md).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT="${OUT:-$ROOT/runtime/state/default.bin}"
MANIFEST="${MANIFEST:-$ROOT/runtime/state/default.json}"
REGISTER="${1:-}"

mkdir -p "$(dirname "$OUT")"
if [ -f "$OUT" ]; then
    echo "coldboot: keeping existing $OUT (delete it to force a new cold boot)"
else
    echo "coldboot: no default state; running the real cold boot"
    "$ROOT/validate.sh" "$OUT"
fi

args=(--state "$OUT" --out "$MANIFEST" --memory-mb "${MEMORY:-768}")
if [ "$REGISTER" = "--register" ]; then
    args+=(--register)
fi
python3 "$ROOT/state-manifest.py" "${args[@]}"
