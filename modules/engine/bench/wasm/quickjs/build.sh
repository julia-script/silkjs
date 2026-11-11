#!/bin/sh
# Builds QuickJS as a WASI Preview 1 command for the benchmark tables.
#   build.sh QUICKJS_DIR OUT.wasm
# QUICKJS_DIR is a checkout of github.com/bellard/quickjs.
# Needs wasi-sdk at $WASI_SDK (default /opt/wasi-sdk). The build uses -O2, as QuickJS's own
# Makefile does, and host.c in place of quickjs-libc.c, which needs fork, signals and threads.
set -eu
src=$1
out=$2
sdk=${WASI_SDK:-/opt/wasi-sdk}
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# dtoa.c includes <setjmp.h> without using it, and wasi-libc's header refuses to compile without
# the exception-handling proposal, so an empty header shadows it.
: > "$work/setjmp.h"
# wasi-libc's allocator has malloc_usable_size but <malloc.h> does not declare it.
printf '#include <stddef.h>\nsize_t malloc_usable_size(void *ptr);\n' > "$work/wasi_shim.h"
# WebAssembly has no computed goto: LLVM lowers it to a jump table behind an extra branch, which
# measured 10 to 15% slower on Crypto and RayTrace than QuickJS's own switch dispatch.
sed 's/^#define DIRECT_DISPATCH  1$/#define DIRECT_DISPATCH  0/' "$src/quickjs.c" > "$work/quickjs.c"
grep -q '^#define DIRECT_DISPATCH  0$' "$work/quickjs.c"

sources="$work/quickjs.c"
for f in dtoa.c libregexp.c libunicode.c cutils.c; do sources="$sources $src/$f"; done
defines="-D_GNU_SOURCE -DCONFIG_VERSION=\"$(cat "$src/VERSION")\""
if [ -d "$src/intl" ]; then
  for f in "$src"/intl/*.c "$src"/temporal/*.c; do sources="$sources $f"; done
  defines="$defines -DCONFIG_TEMPORAL_INTL"
fi
# shellcheck disable=SC2086
"$sdk/bin/clang" --target=wasm32-wasip1 -O2 -fwrapv -w $defines \
  -I"$work" -include wasi_shim.h -I"$src" \
  -Wl,-z,stack-size=8388608 \
  -o "$out" $sources "$here/host.c"
