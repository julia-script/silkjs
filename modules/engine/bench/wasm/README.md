# silkjs and QuickJS on WebAssembly

Two WebAssembly builds for the benchmark tables, both run by the same runtime
([wasmtime](https://github.com/bytecodealliance/wasmtime)):

- **silkjs**, compiled by the Silk LLVM backend to `wasm64-unknown-unknown` and linked with
  `host.c`, a small C library on WASI Preview 1 imports.
- **QuickJS** from github.com/bellard/quickjs (the tables used master e585640, version
  2026-06-04), compiled by wasi-sdk to `wasm32-wasip1` with `quickjs/host.c` in place of
  `quickjs-libc.c`.

They are comparison columns, not goals: nothing in the engine is tuned for WebAssembly.

## Why silkjs is a 64-bit module

The engine's heap layout assumes 64-bit words (a four-word `RawBuffer` prefix, 16-byte values
and slot pairs, 64-bit sentinels), so it does not run on `wasm32`. It type-checks there after
small fixes, then traps on its first layout assertion. `wasm64` needs no layout change. The
cost is that a 64-bit memory cannot use guard pages, so the runtime checks the bounds of every
load and store; QuickJS on `wasm32` pays none of that. On Richards, turning off wasmtime's
Spectre masking of those checks alone took silkjs from 337 to 516.

## Build

```sh
export SILK_CLANG=/opt/llvm22/bin/clang     # Clang 22 with wasm-ld beside it
./build.sh                                  # writes build/silkjs.wasm, about 4 minutes

git clone https://github.com/bellard/quickjs
./quickjs/build.sh path/to/quickjs build/qjs.wasm   # needs wasi-sdk at $WASI_SDK
```

`build.sh` stops the Silk build at the object file and links it with `host.c` itself, because
the freestanding target links no C library. `src/main.silk` is the engine's own command line
with command arguments supplied by `host.c`.

## Run

WASI has no working directory, so pass absolute script paths and preopen the filesystem. The
JavaScript stack lives on the WebAssembly stack, so raise wasmtime's 512 KiB default:

```sh
wasmtime run --dir / -W max-wasm-stack=8388608 build/silkjs.wasm /abs/path/script.js
wasmtime run --dir / -W max-wasm-stack=8388608 build/qjs.wasm /abs/path/script.js
```

For repeated runs compile each module once, with the same stack setting, and run the result:

```sh
wasmtime compile -W max-wasm-stack=8388608 build/silkjs.wasm -o build/silkjs.cwasm
wasmtime run --allow-precompiled --dir / -W max-wasm-stack=8388608 build/silkjs.cwasm /abs/path/script.js
```

Both builds provide `print`, `console.log`, `performance.now` and `scriptArgs`, which is what
Octane and `bench/microbench.js` use.

## What the silkjs build leaves out

`host.c` implements reading files, writing to open descriptors, clocks, exit and command
arguments. Environment variables, directories, file metadata, processes, threads, signals,
terminals, sleeping, `std.printf` formatting and dynamic loading fail with `ENOSYS`. Local time
is UTC.
