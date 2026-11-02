# Third-party assets — Nautilus Craft, Torrance level

All assets below are permissive. They were fetched on **2026-11-01**. The
vendored originals live under `assets/vendor/`; the files the game actually
uses live under `web/assets/` and are inlined into `web/dist/index.html` and
stored in PostgreSQL (`nautilus_craft.game_assets`).

## Block textures — CC0 1.0

**“16×16 Block Texture Set”** and **“16*16 Block Textures”** by
**ARoachIFoundOnMyPillow**.

- Source: https://opengameart.org/content/16x16-block-texture-set
- Source: https://opengameart.org/content/1616-block-textures
- Licence: Creative Commons Zero 1.0 Universal (public domain dedication)
- Used for: grass, dirt, stone, sand, gravel, farmland, oak planks/log/leaves,
  glass, granite/limestone/marble/slate/rhyolite bricks, sandstone tiles, ice,
  pine leaves, lupine, dandelion, tall grass.
- Changes: 16×16 tiles placed in the game atlas; some tiles are tinted or
  overlaid (asphalt darkening, water blue) and a few are composed with
  procedural tiles (road lines, signs, cars, roofs).

## Character and item sprites — CC0 1.0

**“Voxel Pack”** by **Kenney** (kenney.nl).

- Source: https://opengameart.org/content/voxel-pack
- Source: https://kenney.nl/assets/voxel-pack
- Licence: Creative Commons Zero 1.0 Universal
- Used for: the gardener, barista, ranger, dealer and gnome NPCs (assembled
  from the pack's head/body/arm/leg parts), the hedgehog, and the emerald
  garden-token sprite.
- Changes: parts assembled into single 128×180 RGBA sprites; emerald cropped
  from the item sheet.

## UI sounds — CC0 1.0

**“UI Audio”** by **Kenney**, WAV conversion by **Calinou**.

- Source: https://kenney.nl/assets/ui-audio
- WAVs: https://github.com/Calinou/kenney-ui-audio (CC0)
- Licence: Creative Commons Zero 1.0 Universal
- Used for: `click.wav` (click4) and `switch.wav` (switch13).

## Ambience — CC0 1.0

**“Bird chirping sounds”** by **syncopika**.

- Source: https://opengameart.org/content/bird-chirping-sounds
- Licence: Creative Commons Zero 1.0 Universal
- Used for: `birds.mp3`, a quiet looping ambience in the HTTP build. The
  embedded (`/embed/`) build skips it so the serial fetch stays small.

## Font — SIL Open Font License 1.1

**“Press Start 2P”** by **CodeMan38**.

- Source: https://fonts.google.com/specimen/Press+Start+2P
- Licence: SIL Open Font License, Version 1.1 (see `web/assets/fonts/OFL.txt`)
- Used for: headings and the landmark labels. Body copy stays in the system
  monospace stack.

## Engine

The voxel engine, level geometry, UI and server are original code in this
repository. Valence (the parent repository) is MIT licensed; this level does
not use the Valence Java-protocol server — it is a browser voxel sandbox.

## A note on trade marks

The level is inspired by the Torrance, California neighbourhood the assistant
measured at 33.8096 N, 118.3547 W. It uses no Mojang or Microsoft art, code,
sounds or fonts, and is not affiliated with Minecraft.
