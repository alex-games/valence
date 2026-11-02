#!/usr/bin/env python3
"""Point the v86 page at this image's kernel.

The page is copied from WorkAgent/VMResources, whose `bzimageUrl` names the
business image's kernel. The Minecraft image has a different kernel blob. This
reads the new `filesystem.json`, finds the raw `bzImage` entry, and rewrites the
page so a cold boot loads the right kernel.

    python3 vm/patch-page-kernel.py vm/runtime
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else "vm/runtime")
    manifest = root / "filesystem" / "filesystem.json"
    page = root / "index.html"
    if not manifest.exists() or not page.exists():
        print(f"patch-page-kernel: missing {manifest} or {page}", file=sys.stderr)
        return 1
    data = json.loads(manifest.read_text())
    entry = None
    for item in data.get("fsroot", []):
        if item and item[0] == "bzImage":
            entry = item[6]
            break
    if not entry:
        print("patch-page-kernel: no bzImage in the manifest", file=sys.stderr)
        return 1
    entry = entry.removesuffix(".zst")
    html = page.read_text()
    updated, count = re.subn(
        r'const bzimageUrl = "[^"]*";',
        f'const bzimageUrl = "/vm/filesystem/{entry}";',
        html,
        count=1,
    )
    if count != 1:
        print("patch-page-kernel: bzimageUrl assignment not found", file=sys.stderr)
        return 1
    page.write_text(updated)
    print(f"patch-page-kernel: {page} -> /vm/filesystem/{entry}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
