#!/usr/bin/env bash
# Validate the Minecraft VM with workagent-3/tools/vm-harness.
#
#   ./vm/validate.sh [output-state.bin]
#
# It copies the freshly built 9p payload, points the v86 page at the new kernel,
# serves the runtime on 18446, and cold-boots the real page in WKWebView through
# vmrelay-harness. The harness waits for a guest shell, runs lynx, and captures a
# network-capable warm state for the separate VM.
set -euo pipefail

REMOTE="${REMOTE:-dev@192.168.40.105}"
BUILD="${BUILD:-/localdisk/home/dev/work/ntls-api-builder/nftconsole/buildroot/build-2026-minecraft}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$HOME/work/tmp/minecraft-state.bin}"
mkdir -p "$(dirname "$OUT")"
MEMORY="${MEMORY:-768}"
PORT="${PORT:-18446}"

if [ ! -d "$ROOT/runtime/lib" ]; then
    echo "validate: missing vm/runtime/lib; copy the v86 page assets first" >&2
    exit 1
fi

echo "== copy payload from $REMOTE"
rsync -a --delete "$REMOTE:$BUILD/filesystem/" "$ROOT/runtime/filesystem/"
python3 "$ROOT/patch-page-kernel.py" "$ROOT/runtime"

# `vm -> .` lets the stdlib server answer the page's /vm/... URLs.
ln -sfn . "$ROOT/runtime/vm"

echo "== serve runtime on :$PORT"
(python3 "$ROOT/serve.py" "$PORT" "$ROOT/runtime" >/tmp/minecraft-vm-http.log 2>&1) &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT
sleep 1
curl -fsS -o /dev/null "http://127.0.0.1:$PORT/vm/index.html"

echo "== cold boot with the real v86 page (memory ${MEMORY} MB)"
cd "$ROOT/../workagent-3/tools/vmrelay-harness"
./run-snapshot.sh "$OUT" \
    "http://127.0.0.1:$PORT/vm/index.html?boot=true&console=1&memory=${MEMORY}"

echo "== state: $OUT"
ls -lh "$OUT" "$OUT.zst" 2>/dev/null || true
