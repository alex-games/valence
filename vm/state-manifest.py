#!/usr/bin/env python3
"""Record the cold-boot capture as the default warm-boot game state.

The build produces one cold boot. That boot is captured once, hashed, and becomes
the default starting state every later warm boot and every new epoch restores
from. This script writes the manifest next to the state and, when asked, appends
the checkpoint to the game's global MMR (`game_saves.create`).

    python3 vm/state-manifest.py --state vm/runtime/state/default.bin \
        --out vm/runtime/state/default.json --register

The manifest is deliberately small and reviewable: no key, no player data, no
guest memory dump beyond the state file itself.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

MAX_BYTES = 256 * 1024 * 1024


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def git_commit(root: Path) -> str:
    try:
        out = subprocess.run(["git", "-C", str(root), "rev-parse", "--short", "HEAD"],
                             capture_output=True, text=True, timeout=5)
        return out.stdout.strip() if out.returncode == 0 else ""
    except Exception:
        return ""


def register(manifest: dict, state: Path, root: Path) -> str:
    """Append a `save` leaf to epochs.db, if the command-centre scripts are present."""
    scripts = root.parent / "workagent-3" / "commandcenter" / "scripts"
    db = root.parent / "workagent-3" / "commandcenter" / "data" / "game" / "epochs.db"
    if not scripts.exists() or not db.exists():
        return "not registered (commandcenter scripts or epochs.db missing)"
    sys.path.insert(0, str(scripts))
    try:
        import game_saves
        con = game_saves.game_connect(db)
        row = game_saves.create(
            con, epoch="default", pid="system", day=0, path=state,
            meta={"kind": "coldboot", "commit": manifest["commit"],
                  "memory_mb": manifest["memory_mb"]},
        )
        game_saves.verify(con, row["id"])
        return row["id"]
    except Exception as exc:  # a missing policy must not lose the manifest
        return f"not registered: {exc}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", default="vm/runtime/state/default.bin")
    parser.add_argument("--out", default="vm/runtime/state/default.json")
    parser.add_argument("--memory-mb", type=int, default=768)
    parser.add_argument("--register", action="store_true")
    args = parser.parse_args()
    state = Path(args.state)
    if not state.exists() or state.stat().st_size == 0:
        print(f"state-manifest: missing or empty {state}", file=sys.stderr)
        return 2
    size = state.stat().st_size
    if size > MAX_BYTES:
        print(f"state-manifest: {size} bytes exceeds the {MAX_BYTES} cap", file=sys.stderr)
        return 3
    root = Path.cwd()
    manifest = {
        "kind": "coldboot-default",
        "game": "torrance",
        "epoch": "default",
        "state": str(state),
        "bytes": size,
        "sha256": sha256(state),
        "memory_mb": args.memory_mb,
        "commit": git_commit(root),
        "created_at": int(time.time()),
        "note": ("cold boot once; every later warm boot and every new epoch starts "
                 "from this captured state"),
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(manifest, indent=2) + "\n")
    if args.register:
        manifest["checkpoint"] = register(manifest, state, root)
        out.write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
