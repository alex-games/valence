#!/usr/bin/env python3
"""Bundle the Torrance game into one self-contained HTML file.

    web/src/index.html       template   (/*__CSS__*/, /*__JS__*/ and /*__FONT__*/)
    web/src/style.css        styles
    web/src/game.js          WebGL2 game, NPCs and multiplayer client
    web/src/world.json       the level manifest seeded into Postgres
    web/assets/tiles/*.png   CC0 block textures
    web/assets/sprites/*.png CC0 character/item sprites
    web/assets/audio/*       CC0 UI sounds and ambience
    web/assets/fonts/*       Press Start 2P (SIL OFL) + licence

Output (web/dist, also installed under /nautilus/minecraft):
    index.html      one file, no subresources, works with loadHTMLString
    world.json      game_world.data for the nautilus_craft database
    torrance-map.svg
    README.txt
    CREDITS.txt
"""
from __future__ import annotations

import base64
import json
import mimetypes
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "web" / "src"
ASSETS = ROOT / "web" / "assets"
DIST = ROOT / "web" / "dist"

CSS_MARKER = "/*__CSS__*/"
JS_MARKER = "/*__JS__*/"
FONT_MARKER = "/*__FONT__*/"


def data_url(path: Path) -> str:
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    if path.suffix == ".woff2":
        mime = "font/woff2"
    if path.suffix == ".mp3":
        mime = "audio/mpeg"
    if path.suffix == ".wav":
        mime = "audio/wav"
    return f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode("ascii")


def collect(folder: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if folder.exists():
        for p in sorted(folder.iterdir()):
            if p.suffix.lower() in (".png", ".wav", ".mp3"):
                out[p.stem] = data_url(p)
    return out


def main() -> int:
    html = (SRC / "index.html").read_text(encoding="utf-8")
    css = (SRC / "style.css").read_text(encoding="utf-8")
    js = (SRC / "game.js").read_text(encoding="utf-8")
    mqtt = (SRC / "mqtt.js").read_text(encoding="utf-8")
    world = json.loads((SRC / "world.json").read_text(encoding="utf-8"))

    if CSS_MARKER not in html or JS_MARKER not in html or FONT_MARKER not in css:
        print("bundle: markers missing", file=sys.stderr)
        return 1

    font_path = ASSETS / "fonts" / "pressstart2p.woff2"
    if not font_path.exists():
        print("bundle: missing Press Start 2P woff2", file=sys.stderr)
        return 1
    font_css = (
        "@font-face{font-family:'Press Start 2P';font-style:normal;font-weight:400;"
        "font-display:swap;src:url(" + data_url(font_path) + ") format('woff2');}"
    )
    css = css.replace(FONT_MARKER, font_css, 1)

    tiles = collect(ASSETS / "tiles")
    sprites = collect(ASSETS / "sprites")
    audio = collect(ASSETS / "audio")
    # The ambience is fetched over HTTP so it never rides the serial bridge.
    audio.pop("birds", None)

    credits = ""
    third = ROOT / "assets" / "THIRD_PARTY.md"
    if third.exists():
        credits += third.read_text(encoding="utf-8")
    ofl = ASSETS / "fonts" / "OFL.txt"
    if ofl.exists():
        credits += "\n\n--- SIL OPEN FONT LICENSE ---\n\n" + ofl.read_text(encoding="utf-8")

    asset_js = (
        "window.__TEXTURES__=" + json.dumps(tiles, ensure_ascii=False) + ";\n"
        "window.__SPRITES__=" + json.dumps(sprites, ensure_ascii=False) + ";\n"
        "window.__AUDIO__=" + json.dumps(audio, ensure_ascii=False) + ";\n"
        "window.__CREDITS__=" + json.dumps(credits, ensure_ascii=False) + ";\n"
    )

    html = html.replace(CSS_MARKER, css, 1)
    html = html.replace(JS_MARKER, asset_js + "</script><script>" + mqtt + "\n" + js, 1)
    if CSS_MARKER in html or JS_MARKER in html:
        print("bundle: marker left in output", file=sys.stderr)
        return 1

    DIST.mkdir(parents=True, exist_ok=True)
    (DIST / "index.html").write_text(html, encoding="utf-8")
    (DIST / "world.json").write_text(
        json.dumps(world, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    for name in ("torrance-map.svg", "README.txt"):
        src = SRC / name
        if src.exists():
            (DIST / name).write_bytes(src.read_bytes())
    if credits:
        (DIST / "CREDITS.txt").write_text(credits, encoding="utf-8")

    size = (DIST / "index.html").stat().st_size
    print(
        f"bundle: {DIST / 'index.html'} ({size:,} bytes; {len(tiles)} tiles, "
        f"{len(sprites)} sprites, {len(audio)} sounds, {len(world.get('npcs', []))} NPCs, "
        f"{len(world.get('quests', []))} quests)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
