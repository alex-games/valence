#!/bin/sh
#
# Finish the Nautilus Craft image. Runs after the rootfs overlay is copied and
# before the 9p filesystem is generated.
#
set -eu

BIN="$TARGET_DIR/usr/bin/minecraft-server"
CONF="$TARGET_DIR/etc/nginx/site-enabled/minecraft"
MQ="$TARGET_DIR/etc/mosquitto/mosquitto.conf"
PAGE="$TARGET_DIR/nautilus/minecraft/index.html"
VAULT="$TARGET_DIR/usr/bin/vault"

for f in "$BIN" "$CONF" "$MQ" "$PAGE" "$VAULT"; do
    if [ ! -e "$f" ]; then
        echo "post-build: missing $f" >&2
        exit 1
    fi
done

# The guest is i386. A binary for the wrong architecture fails at boot with
# "not found" and no other clue, so check the ELF header here.
magic=$(od -An -tu1 -N5 "$BIN" | tr -s ' ' | sed -e 's/^ *//' -e 's/ *$//')
if [ "$magic" != "127 69 76 70 1" ]; then
    echo "post-build: $BIN is not a 32-bit ELF (header: $magic)" >&2
    exit 1
fi

chmod 0755 "$BIN"
for s in "$TARGET_DIR"/etc/init.d/S*; do
    chmod 0755 "$s"
done
chmod 0644 "$CONF" "$MQ" "$TARGET_DIR/etc/nginx/nginx.conf" "$TARGET_DIR/etc/nginx/mime.types"

mkdir -p "$TARGET_DIR/var/log/nginx" "$TARGET_DIR/var/lib/nginx" "$TARGET_DIR/var/lib/pgsql" "$TARGET_DIR/var/run"
# The vm-harness reads /var/log/vault-boot.log; the dev Vault logs to vault.log.
ln -sf vault.log "$TARGET_DIR/var/log/vault-boot.log"
mkdir -p "$TARGET_DIR/nautilus/minecraft/audio"

echo "post-build: minecraft-server installed; nginx, Mosquitto, Vault and PostgreSQL configured"
