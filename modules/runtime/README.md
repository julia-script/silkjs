# silkjsruntime

A Node-compatible JavaScript runtime written in [Silk](https://github.com/silk-lang/silk), using [SilkJS](../engine), the native Silk port of QuickJS, instead of V8.

Node 24 is the compatibility reference. [Deno](https://github.com/denoland/deno) is an organizational reference for the core/extension split—not a runtime dependency or a source of Deno-specific APIs. JavaScript executes in SilkJS; there is no Node or V8 execution fallback.

## Build

The verified build target is **macOS arm64**. Other platforms are not claimed as verified.

Requirements:

- The Silk launcher; `silk.toml` pins the compiler version.
- Python 3.12 or newer, Clang 22 or newer, CMake, `patch`, and `pkg-config`.
- A macOS SDK supporting the compiler's macOS 11 deployment target. The build selects the installed macOS 15.5 SDK when `SDKROOT` is unset; otherwise set `SDKROOT` explicitly.
- Development headers and static archives for libuv 1.50 or newer, OpenSSL 3.2 or newer, Brotli, Zstandard, and nghttp2. They must be discoverable through `pkg-config`. SQLite needs nothing installed: the `db-sqlite` package from [silk-lang/lib-sqlite](https://github.com/silk-lang/lib-sqlite) compiles its pinned amalgamation into the executable.
- On GNU/Linux, distribution packages are often too old: Ubuntu 24.04 has libuv 1.48 and OpenSSL 3.0.
- Network access on the first build to retrieve checksum-verified source dependencies.

```sh
git clone https://github.com/silk-lang/lib-silkjs.git
cd lib-silkjs/modules/runtime
silk use
silk task build
./build/silkjsruntime -p 'process.versions'
```

Use `SILK_CLANG` to select a particular Clang executable. `silk task build --release` builds with speed optimization; `--output PATH` selects the output executable. `silk task` lists the other tasks (`embed`, `compat`, `sea`); they run the Python tools in [`tools/`](tools/), which can still be run directly.

The engine is this repository's [`modules/engine`](../engine), a path dependency in `silk.toml`, so engine and runtime changes land together. The build also prepares the pinned WAMR/uvwasi dependencies, embeds the JavaScript extensions, and links the native executable. An installed Node executable is not required to build or run it.

## Run

```sh
./build/silkjsruntime app.js
./build/silkjsruntime app.mjs
./build/silkjsruntime app.ts
./build/silkjsruntime -e 'console.log(require("node:path").join("a", "b"))'
./build/silkjsruntime --test
./build/silkjsruntime -i
```

The implementation includes CommonJS and ESM package loading, TypeScript execution, filesystem and process APIs, streams, networking and TLS/HTTP2, crypto and WebCrypto, workers and cluster, SQLite, Intl (SilkJS's ECMA-402 implementation in Silk, with its own CLDR-derived locale data; no ICU), Web APIs, WebAssembly/WASI, Node-API addons, the test runner, REPL, inspector, and native profiling. Feature-specific fixtures in [`tests/`](tests/) exercise these contracts, including cross-process and cross-realm ownership and failure paths.

## Compatibility boundaries

This is a Node compatibility implementation, not an official Node distribution or a claim that every Node package has been tested.

- **Engine artifacts:** compiled bytecode and module caches are SilkJS artifacts bound to source, compilation options, and build identity. They are not V8 code caches. In contrast, `node:v8` value serialization implements the V8 value wire protocol without executing V8.
- **Diagnostics:** heap and CPU data come from the actual SilkJS engine. Heap snapshots use DevTools JSON with SilkJS metadata; engine-specific measurements and limitations are identified rather than fabricated as V8 internals.
- **Native addons:** Node-API addons use the native ABI bridge. Legacy addons requiring V8-specific entry points are rejected explicitly.
- **Single-executable applications:** the macOS arm64 implementation supports source or cached entry points and embedded assets, with executable identity checks and signing. `useSnapshot: true` is rejected: native startup heap images are not implemented, and source replay is not presented as a snapshot.
- **Permissions:** the permission model follows Node's resource checks and documented limitations. It is not an operating-system sandbox; unrestricted networking and symlink behavior must not be mistaken for isolation guarantees.
- **Platform coverage:** build, signing, native library availability, and OS behavior outside the verified target require platform-specific validation.

## Layout

| Location | Responsibility |
| --- | --- |
| [`src/main.silk`](src/main.silk), [`src/libs/core/`](src/libs/core/) | Native entry point, engine embedding, host interfaces |
| [`runtime/`](runtime/) | Bootstrap and event-loop integration |
| [`libs/node_resolver/`](libs/node_resolver/) | Package resolution, module loading, and loader hooks |
| [`src/ext/`](src/ext/) | Native extension implementations and resource ownership |
| [`ext/node/`](ext/node/) | Node-compatible JavaScript modules |
| [`ext/web/`](ext/web/) | Web-platform JavaScript APIs and vendored standards data |
| [`tools/`](tools/) | Dependency preparation, native builds, embedding, executable tooling |
| [`tests/`](tests/) | Differential and real-runtime consumers |

The engine lives beside the runtime in [`modules/engine`](../engine); the runtime does not maintain a second engine implementation.

## Verification

The published-source build passed **72/72 differential cases against Node 24.22.2** on macOS arm64. These are this project's compatibility cases, not the complete upstream Node test suite.

Use a Node 24 executable as the reference/client for the differential suite:

```sh
silk task compat          # or: node tests/compat.mjs
```

`SILKJS_RUNTIME` selects the runtime executable and `NODE_REFERENCE` selects a different Node reference executable. An optional positional regular expression selects cases. Node is a test oracle or debugger client here, not a production execution backend.

Additional integration consumers cover native addons, permissions, workers, network peers, SQLite, VM caches, inspector transport, profiling, REPL interaction, and standalone executables. Their executable inputs and platform requirements are defined in the individual fixtures. Engine-side native consumers additionally check allocator ownership and compatibility with the pinned QuickJS C reference.

## Upstream candidates and licensing

[`UPSTREAM_NOTES.md`](UPSTREAM_NOTES.md) records reusable Silk standard-library candidates, their current implementations, ownership/platform constraints, and exercised evidence. Node policy and engine internals are kept separate from generic stdlib proposals.

Runtime code is licensed under [`LICENSE`](LICENSE). See [`THIRD_PARTY_NOTICES`](THIRD_PARTY_NOTICES), [`vendor/`](vendor/), and the extension provenance manifests for adapted code, vendored data, downloaded dependencies, and their licenses. Redistributing linked binaries also requires the notices applicable to the actual native libraries and engine constituents in that binary.
