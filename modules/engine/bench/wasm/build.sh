#!/bin/sh
# Builds silkjs as a 32-bit WebAssembly module that runs as a WASI Preview 1 command.
#   build.sh [OUT.wasm]        (default build/silkjs.wasm)
# Needs the pinned Silk toolchain on PATH and Clang 22 with its wasm-ld at $SILK_CLANG.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out=${1:-$here/build/silkjs.wasm}
clang=${SILK_CLANG:-clang}
linker=$(dirname "$(command -v "$clang")")/wasm-ld
work=$here/build
mkdir -p "$work" "$(dirname "$out")"
cd "$here"

# The package build would link with no C library, so stop at the object and link it here.
silk build src/main.silk -o "$work/silkjs.o" --emit object --target wasm32-unknown-unknown \
  --optimization speed --debug false
"$clang" --target=wasm32-unknown-unknown -O2 -ffreestanding -fno-builtin -c host.c -o "$work/host.o"
# An 8 MiB shadow stack matches the QuickJS build this is compared with.
"$linker" "$work/silkjs.o" "$work/host.o" -o "$out" --no-entry --export=_start \
  -z stack-size=8388608 --strip-debug
