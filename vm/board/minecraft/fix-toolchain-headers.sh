#!/bin/sh
# Buildroot 2026.08.1 knows kernel header series up to 7.1. With AS_KERNEL and a
# 7.2.x kernel, Kconfig falls back to the 2.6 default, and the header check aborts
# with "expected 2.6.x, got 7.2.x". Pin the toolchain series to 7.1 and let the
# loose check accept the newer 7.2 headers.
f="$1"
[ -n "$f" ] || exit 2
sed -i 's/^BR2_TOOLCHAIN_HEADERS_AT_LEAST=.*/BR2_TOOLCHAIN_HEADERS_AT_LEAST="7.1"/' "$f"
sed -i 's/^# BR2_TOOLCHAIN_HEADERS_AT_LEAST_7_1 is not set/BR2_TOOLCHAIN_HEADERS_AT_LEAST_7_1=y/' "$f"
grep -q '^BR2_TOOLCHAIN_HEADERS_AT_LEAST_7_1=y' "$f" || echo 'BR2_TOOLCHAIN_HEADERS_AT_LEAST_7_1=y' >> "$f"
grep -q '^BR2_TOOLCHAIN_HEADERS_LATEST=y' "$f" || echo 'BR2_TOOLCHAIN_HEADERS_LATEST=y' >> "$f"
grep -q '^BR2_TOOLCHAIN_HEADERS_AT_LEAST=' "$f"
