NAUTILUS CRAFT — TORRANCE BEGINNER LEVEL
========================================

A standalone Minecraft-style voxel level built from the geofence the assistant
measured at 33.8096 N, 118.3547 W — the Torrance Community Garden, Lago Seco
Park, The Coffee Bean and Martin Chevrolet.

PLAY
----
Open  http://<vm-ip>/  in a browser, or open the WebView in WorkAgent. The page
is one self-contained HTML file, so it also works through loadHTMLString.
On a phone: left thumb moves, right thumb looks, the round buttons jump, fly,
break and place. On a desktop: WASD, mouse, LMB break, RMB place, 1-9 palette,
F fly, M map, H help.

The six beginner quests are: visit the Community Garden, walk the Lago Seco
Park pier, step into The Coffee Bean, browse Martin Chevrolet, place 10 blocks,
break 5 blocks. Nothing can hurt you; water lets you swim and fly is always on
tap.

SERVICES IN THE VM
------------------
nginx             :80 and :8080, site /etc/nginx/site-enabled/minecraft
minecraft-server  127.0.0.1:8081, /usr/bin/minecraft-server (i686-musl static)
PostgreSQL 18.6   127.0.0.1:5432, database nautilus_craft, role craft

The game binary is the origin; nginx owns the public ports. This means the
existing WebView fetch of http://127.0.0.1:8080/embed/ resolves to the game.

POSTGRES
--------
The level is not baked into the page at serve time: /usr/bin/minecraft-server
reads the manifest and every asset from PostgreSQL.

  game_world(slug, title, data jsonb, updated_at)
      one row, slug = torrance. data is the manifest injected as
      window.__WORLD__ (title, copy, spawn, palette, POIs, quests).

  game_assets(path, content_type, body bytea, updated_at)
      /index.html, /torrance-map.svg, /README.txt

  game_meta(key, value)
      asset_version, so a new image refreshes the seeded rows.

Inspect it from the VM console:

  su - postgres -c "psql -d nautilus_craft -c '\\dt'"
  su - postgres -c "psql -d nautilus_craft -c 'select path, length(body) from game_assets'"
  su - postgres -c "psql -d nautilus_craft -c 'select slug, title, jsonb_array_length(data->'\\''quests'\\'') from game_world'"

Update the manifest without rebuilding the image:

  su - postgres -c "psql -d nautilus_craft -c \"update game_world set data = jsonb_set(data, '{copy,hint}', '\\\"New hint\\\"') where slug='torrance'\""
  # then reload http://127.0.0.1/

HEALTH
------
  wget -qO- http://127.0.0.1/healthz
  wget -qO- http://127.0.0.1/api/world
  tail -50 /var/log/minecraft.log
  tail -50 /var/log/nginx/error.log
  tail -50 /var/log/pgsql.log

FILES
-----
  /usr/bin/minecraft-server            static game origin
  /nautilus/minecraft/index.html       authored bundle (seed + fallback)
  /nautilus/minecraft/world.json       manifest (seed)
  /nautilus/minecraft/torrance-map.svg map plate
  /etc/nginx/site-enabled/minecraft    the site
  /etc/init.d/S51craft-db              create role + database
  /etc/init.d/S52minecraft             start the origin
  /etc/init.d/S53nginx                 start the web server

BUILD
-----
  tools/build-vm.sh      cross-build the binary and bundle the page
  buildroot/build2026.sh --board minecraft
