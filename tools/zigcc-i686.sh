#!/bin/sh
# Translate the Rust i686-unknown-linux-musl target into Zig's x86 musl target.
#
# Rust's cc crate appends `-m32` and `--target=i686-unknown-linux-musl`, and the
# Rust linker driver appends `-Wl,-melf_i386`; Zig has no `i686` architecture
# name (it calls 32-bit x86 `x86`) and lld rejects the GNU `-melf_i386` spelling.
# Strip those, keep every other argument, and let Zig provide the i686 musl CRT.
set -eu
ZIG="${ZIG:-zig}"
args=""
for a in "$@"; do
    case "$a" in
        -m32|--target=i686-unknown-linux-musl|-target=i686-linux-musl|-Wl,-melf_i386)
            ;;
        *)
            args="$args \"$(printf '%s' "$a" | sed 's/"/\\"/g')\""
            ;;
    esac
done
eval "exec \"$ZIG\" cc -target x86-linux-musl $args"
