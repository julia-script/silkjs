# silkjsruntime

A Node-compatible JavaScript runtime written in [Silk](https://github.com/silk-lang/silk), using [SilkJS](../engine), the native Silk port of QuickJS, instead of V8.

Node 24 is the compatibility reference. [Deno](https://github.com/denoland/deno) is an organizational reference for the core/extension split—not a runtime dependency or a source of Deno-specific APIs. JavaScript executes in SilkJS; there is no Node or V8 execution fallback.

## Build

The verified build target is **macOS arm64**. Linux x64 (Ubuntu 24.04 with libuv, OpenSSL, zstd and nghttp2 built from source) builds and passes the differential suite (72/72, November 2026); other platforms are not claimed as verified.

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

The package manager of [`modules/pm`](../pm) is in the executable. Its commands come where a script would, and run without starting the engine:

```sh
./build/silkjsruntime install            # what package.json lists; the lockfile is sjs.lock
./build/silkjsruntime add left-pad       # also: add -D, add name@range, add name@tag
./build/silkjsruntime remove left-pad
./build/silkjsruntime update
./build/silkjsruntime ci                 # install, and fail when the lockfile is out of date
./build/silkjsruntime run build          # a script of package.json; arguments follow the name
./build/silkjsruntime exec tsc --noEmit  # a command of the dependencies
```

In a workspace, a `package.json` with `workspaces`, the commands install for every package from any of their directories, and `add --filter <name>` or `add -w` choose the package to change.

The install scripts of a dependency run only when `allowBuilds` in the `package.json` of the project names it: `"allowBuilds": { "esbuild": true }`.

A script file named like one of the commands (`install`, `i`, `ci`, `add`, `remove`, `rm`, `uninstall`, `un`, `update`, `up`, `upgrade`, `run`, `run-script`, `exec`) is run with its path: `./build/silkjsruntime ./install`.

The implementation includes CommonJS and ESM package loading, TypeScript execution, filesystem and process APIs, streams, networking and TLS/HTTP2, crypto and WebCrypto, workers and cluster, SQLite, Intl (SilkJS's ECMA-402 implementation in Silk, with its own CLDR-derived locale data; no ICU), Web APIs, WebAssembly/WASI, Node-API addons, the test runner, REPL, inspector, and native profiling. Feature-specific fixtures in [`tests/`](tests/) exercise these contracts, including cross-process and cross-realm ownership and failure paths.

## Embed

Another Silk program can run the runtime inside itself with [`runtime.embed`](src/runtime/embed.silk) (`silkjsruntime` exports it). The executable owns its process; an embedded runtime does not. Its host passes the arguments it would have had, turns the loop from its own loop, and `process.exit()` ends the runtime instead of the process:

```silk
struct App {}
impl Host for App {
  effect fn drive<'e, 'm>(self: &mut Self, runtime: &mut Runtime<'e, 'm>) -> i32 ! OutOfMemoryError | JsException ? &mut Allocator {
    run runtime.evaluateModule(b"/app/main.mjs", source)
    while true {
      // Timers, then native completions (waiting at most 16 ms), then immediates.
      match run runtime.turn(16.0) { Turn.Running => () Turn.Finished { status } => { return status } }
    }
    return 0
  }
}
let status = run embed.start(run Options.make(b"app"), &mut app)
```

- `Runtime.turn(milliseconds)` runs one pass of the loop and waits for native completions at most that long (0 never blocks). `Runtime.timeout()` says how long until a timer is due, and `Runtime.waker()` ends a turn's wait from another thread, for a host whose own events arrive elsewhere.
- `Options.keepAlive` (on for `Options.make`): the host's own work keeps the runtime alive, as open windows do, so a loop with nothing referenced is not its end. The runtime finishes with `process.exit()` or `Runtime.finish()`, which runs the `'exit'` listeners.
- The runtime runs on the thread that calls `embed.start`; its JavaScript stays on that thread. It leaves the host's signal dispositions alone (the executable ignores `SIGPIPE` and `SIGXFSZ`, as Node does).
- Every extension is still linked into an embedder, and the heap image is the executable's alone, so an embedded runtime bootstraps cold. Native modules for the host's own API are the next step of the embedding API.

[`tests/embed-smoke.py`](tests/embed-smoke.py) builds [`src/embed_smoke.silk`](src/embed_smoke.silk), a host that runs its own module, and checks the status its turn reports.

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
| [`src/runtime/`](src/runtime/) | Runtime startup and teardown (`worker`), the loop in turns (`session`), the embedding API (`embed`) |
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
