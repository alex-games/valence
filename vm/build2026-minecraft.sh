#!/usr/bin/env bash
# Build the separate Minecraft VM image.
#
#   ./build2026-minecraft.sh            build and publish the payload
#   ./build2026-minecraft.sh --no-cache bypass the docker layer cache
#   ./build2026-minecraft.sh --clean    wipe the package tarball cache
#   ./build2026-minecraft.sh --require-ccache
#                                       fail if Redis saw no compiler traffic
#
# This is deliberately a separate image from the business (pg-browser) VM:
#   config/board/minecraft/               board, overlay, nginx, Mosquitto
#   config/config-buildroot-2026.08.1-minecraft   generated defconfig
#   build-2026-minecraft/filesystem      the v86 payload
#
# The game binary is cross-built separately and copied to
# config/board/minecraft/rootfs_overlay/usr/bin/minecraft-server before this
# script runs. post-build.sh refuses a non-i386 ELF.

set -u

BUILD_ROOT_RELEASE=2026.08.1
BUILD_ROOT_TAG=buildroot2026-minecraft
BOARD=minecraft
CONFIG_NAME="config-buildroot-${BUILD_ROOT_RELEASE}-${BOARD}"
CACHE_DIR="$PWD/build-2026-cache"
REDIS_DIR="$CACHE_DIR/redis"
LOCAL_CCACHE_DIR="$CACHE_DIR/ccache"
ARTIFACT_DIR="$PWD/build-2026-minecraft"
DOCKER_CACHE_ARGS=""
CLEAN=0
REQUIRE_CCACHE=0

while [ $# -gt 0 ]; do
    case "$1" in
        --clean) CLEAN=1 ;;
        --no-cache) DOCKER_CACHE_ARGS="--no-cache" ;;
        --no-stage) : ;;
        --require-ccache) REQUIRE_CCACHE=1 ;;
        -h|--help)
            sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
    shift
done

if [ ! -f "config/config-buildroot-${BUILD_ROOT_RELEASE}" ]; then
    echo "!! missing base config; run from the buildroot checkout" >&2
    exit 1
fi
if [ ! -d "config/board/${BOARD}" ]; then
    echo "!! missing config/board/${BOARD}" >&2
    exit 1
fi
if [ ! -f "config/board/${BOARD}/rootfs_overlay/usr/bin/minecraft-server" ]; then
    echo "!! missing the i686-musl game binary in config/board/${BOARD}/rootfs_overlay/usr/bin" >&2
    exit 1
fi
# The Vault binary is shared with the business board; copy it rather than
# committing a second 258 MiB copy.
if [ ! -f "config/board/${BOARD}/rootfs_overlay/usr/bin/vault" ]; then
    cp "config/board/pg-browser/rootfs_overlay/usr/bin/vault" \
       "config/board/${BOARD}/rootfs_overlay/usr/bin/vault"
fi

python3 "config/board/${BOARD}/patch-defconfig.py" || exit 1

if [ "$CLEAN" -eq 1 ]; then
    echo "== wiping caches =="
    rm -rf "${CACHE_DIR:?}/dl" "${CACHE_DIR:?}/redis" "${CACHE_DIR:?}/ccache"
fi
mkdir -p "$CACHE_DIR/dl" "$REDIS_DIR" "$LOCAL_CCACHE_DIR" "$ARTIFACT_DIR"
chmod 0777 "$REDIS_DIR" 2>/dev/null || true

if [ ! -f "./src/buildroot-${BUILD_ROOT_RELEASE}.tar.gz" ]; then
    mkdir -p ./src
    ( cd src && wget -c "http://buildroot.org/downloads/buildroot-${BUILD_ROOT_RELEASE}.tar.gz" )
fi

if [ -z "$(docker images buildroot-base | grep buildroot-base)" ]; then
    docker build --build-arg BUILD_ROOT_RELEASE="${BUILD_ROOT_RELEASE}" \
        -t buildroot-base ./buildroot-base/
fi

docker build ${DOCKER_CACHE_ARGS} \
    --build-arg BUILD_ROOT_RELEASE="${BUILD_ROOT_RELEASE}" \
    --build-arg BOARD="${BOARD}" \
    --build-arg CONFIG_NAME="${CONFIG_NAME}" \
    -t "${BUILD_ROOT_TAG}" . || exit 1

docker network create buildroot-net >/dev/null 2>&1 || true
if [ -z "$(docker ps -q -f name=^/buildroot-redis$)" ]; then
    docker rm -f buildroot-redis >/dev/null 2>&1 || true
    docker run -d \
        --name buildroot-redis \
        --network buildroot-net \
        --restart unless-stopped \
        -v "$REDIS_DIR:/data" \
        redis:7-alpine \
        redis-server --appendonly yes --appendfsync everysec --dir /data \
        --maxmemory 10gb --maxmemory-policy allkeys-lru >/dev/null
fi
for _ in $(seq 1 20); do
    if docker exec buildroot-redis redis-cli ping 2>/dev/null | grep -q PONG; then break; fi
    sleep 0.5
done

redis_num() {
    docker exec buildroot-redis redis-cli info stats 2>/dev/null \
        | awk -F: -v k="$1" '$1==k {gsub(/\r/,"",$2); print $2; exit}'
}
redis_keys() {
    docker exec buildroot-redis redis-cli dbsize 2>/dev/null | tr -dc '0-9'
}
redis_keys_before="$(redis_keys)"; redis_keys_before="${redis_keys_before:-0}"
redis_cmds_before="$(redis_num total_commands_processed)"; redis_cmds_before="${redis_cmds_before:-0}"
redis_hits_before="$(redis_num keyspace_hits)"; redis_hits_before="${redis_hits_before:-0}"
redis_misses_before="$(redis_num keyspace_misses)"; redis_misses_before="${redis_misses_before:-0}"

echo "== building ${BOARD} (${BUILD_ROOT_RELEASE}) =="
echo "ccache: before keys=${redis_keys_before} commands=${redis_cmds_before} hits=${redis_hits_before} misses=${redis_misses_before}"
start=$(date +%s)
docker run \
    --rm \
    -i \
    --network buildroot-net \
    --platform linux/amd64 \
    -v "$PWD/tools:/tools" \
    -v "$ARTIFACT_DIR:/build" \
    -v "$PWD/config:/config" \
    -v "$CACHE_DIR/dl:/root/buildroot-${BUILD_ROOT_RELEASE}/dl" \
    -v "$LOCAL_CCACHE_DIR:/root/.buildroot-ccache" \
    -e BR2_DL_DIR="/root/buildroot-${BUILD_ROOT_RELEASE}/dl" \
    -e CCACHE_CONFIGPATH=/config/ccache.conf \
    "${BUILD_ROOT_TAG}" \
    -c "make -j \$(( \$(nproc) + 1 )) -l \$(( \$(nproc) + 1 )) STATIC=1 oldconfig && sh /config/board/minecraft/fix-toolchain-headers.sh .config && FORCE_UNSAFE_CONFIGURE=1 make -j \$(( \$(nproc) + 1 )) -l \$(( \$(nproc) + 1 )) STATIC=1 && python3 /tools/compress-filesystem.py /build/filesystem; rc=\$?; echo '== ccache =='; /root/buildroot-${BUILD_ROOT_RELEASE}/output/host/bin/ccache -s || true; exit \$rc"
rc=$?
elapsed=$(( $(date +%s) - start ))
echo "== ${BOARD} build finished in ${elapsed}s (exit ${rc}) =="
redis_keys_after="$(redis_keys)"; redis_keys_after="${redis_keys_after:-0}"
redis_cmds_after="$(redis_num total_commands_processed)"; redis_cmds_after="${redis_cmds_after:-0}"
redis_hits_after="$(redis_num keyspace_hits)"; redis_hits_after="${redis_hits_after:-0}"
redis_misses_after="$(redis_num keyspace_misses)"; redis_misses_after="${redis_misses_after:-0}"
ops_delta=$((redis_cmds_after - redis_cmds_before))
hits_delta=$((redis_hits_after - redis_hits_before))
misses_delta=$((redis_misses_after - redis_misses_before))
echo "ccache: after keys=${redis_keys_after} commands=${redis_cmds_after} hits=${redis_hits_after} misses=${redis_misses_after}"
echo "ccache: delta keys=$((redis_keys_after - redis_keys_before)) ops=${ops_delta} hits=${hits_delta} misses=${misses_delta}"
if [ "$REQUIRE_CCACHE" -eq 1 ] && [ "$rc" -eq 0 ]; then
    if [ "$redis_keys_after" -eq 0 ] || [ "$ops_delta" -le 0 ] || [ "$((hits_delta + misses_delta))" -le 0 ]; then
        echo "ccache: FAIL -- Redis saw no compiler traffic; remote_storage is not reaching the build" >&2
        rc=4
    else
        echo "ccache: PASS -- Redis saw compiler traffic"
    fi
fi
if [ "$rc" -eq 0 ]; then
    echo "payload: $ARTIFACT_DIR/filesystem"
    echo "manifest: $ARTIFACT_DIR/filesystem/filesystem.json"
else
    echo "build FAILED -- caches kept for the next attempt"
fi
exit $rc
