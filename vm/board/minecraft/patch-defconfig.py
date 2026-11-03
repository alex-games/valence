#!/usr/bin/env python3
"""Generate the Minecraft VM's Buildroot defconfig from the known-good base.

The base is `config/config-buildroot-2026.08.1` (the pg-browser image). Only the
board paths, hostname, and the packages this VM adds or changes are touched.
Everything else — toolchain, kernel, PostgreSQL, the rest of the package set —
stays exactly as the image that already boots under v86.

Run from the buildroot checkout:
    python3 config/board/minecraft/patch-defconfig.py
"""
from __future__ import annotations

import sys
from pathlib import Path

BASE = Path("config/config-buildroot-2026.08.1")
OUT = Path("config/config-buildroot-2026.08.1-minecraft")


def set_line(text: str, key: str, value: str) -> str:
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if line.startswith(key + "=") or line == f"# {key} is not set":
            lines[i] = f"{key}={value}"
            return "\n".join(lines) + "\n"
    lines.append(f"{key}={value}")
    return "\n".join(lines) + "\n"


def set_unset(text: str, key: str) -> str:
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if line.startswith(key + "=") or line == f"# {key} is not set":
            lines[i] = f"# {key} is not set"
            return "\n".join(lines) + "\n"
    return text


def main() -> int:
    if not BASE.exists():
        print(f"patch-defconfig: missing {BASE}", file=sys.stderr)
        return 1
    s = BASE.read_text()

    s = set_line(s, "BR2_TARGET_GENERIC_HOSTNAME", '"minecraft"')
    s = set_line(s, "BR2_TARGET_GENERIC_ISSUE", '"Welcome to Nautilus Craft"')
    s = set_line(s, "BR2_ROOTFS_USERS_TABLES", '"/config/board/minecraft/users.txt"')
    s = set_line(s, "BR2_ROOTFS_OVERLAY", '"$(CONFIG_DIR)/board/minecraft/rootfs_overlay"')
    s = set_line(s, "BR2_ROOTFS_POST_BUILD_SCRIPT", '"/config/board/minecraft/post-build.sh"')
    s = set_line(s, "BR2_ROOTFS_POST_IMAGE_SCRIPT", '"$(CONFIG_DIR)/board/minecraft/post-image.sh"')
    s = set_line(s, "BR2_LINUX_KERNEL_CUSTOM_CONFIG_FILE", '"$(CONFIG_DIR)/board/minecraft/linux.conf"')
    # **Headers must follow the kernel.** `LATEST` selected 7.2.3 while the kernel
    # was 7.2.10, and Buildroot's header check aborted with "expected 2.6.x".
    s = set_line(s, "BR2_KERNEL_HEADERS_AS_KERNEL", "y")
    s = set_unset(s, "BR2_KERNEL_HEADERS_LATEST")
    # **The version lives in CUSTOM_VERSION_VALUE.** Setting only
    # BR2_LINUX_KERNEL_VERSION left LATEST_VERSION=y and Buildroot built its own
    # 7.1.13; the derived version line is not what Kconfig reads.
    s = set_unset(s, "BR2_LINUX_KERNEL_LATEST_VERSION")
    s = set_line(s, "BR2_LINUX_KERNEL_CUSTOM_VERSION", "y")
    s = set_line(s, "BR2_LINUX_KERNEL_CUSTOM_VERSION_VALUE", '"7.2.10"')
    s = set_line(s, "BR2_LINUX_KERNEL_VERSION", '"7.2.10"')

    # Mosquitto: the browser needs the WebSocket listener. Buildroot's built-in
    # implementation avoids pulling libwebsockets into the image.
    s = set_unset(s, "BR2_PACKAGE_MOSQUITTO_WS_NONE")
    s = set_line(s, "BR2_PACKAGE_MOSQUITTO_WS_BUILTIN", "y")
    s = set_line(s, "BR2_PACKAGE_MOSQUITTO_BROKER", "y")
    s = set_line(s, "BR2_PACKAGE_MOSQUITTO_CLIENTS", "y")

    # nginx is the public front and the MQTT websocket proxy.
    s = set_line(s, "BR2_PACKAGE_NGINX", "y")
    s = set_line(s, "BR2_PACKAGE_NGINX_HTTP", "y")
    s = set_line(s, "BR2_PACKAGE_NGINX_HTTP_PROXY_MODULE", "y")
    s = set_line(s, "BR2_PACKAGE_NGINX_HTTP_GZIP_MODULE", "y")
    s = set_line(s, "BR2_PACKAGE_NGINX_HTTP_STUB_STATUS_MODULE", "y")

    OUT.write_text(s)
    print(f"patch-defconfig: wrote {OUT} ({len(s.splitlines())} lines)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
