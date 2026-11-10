# Silk standard-library upstream candidates

Living notes from the Node-compatible Silk runtime implementation. These are extraction/design candidates, not claims that the latest stdlib lacks equivalent functionality. No upstream changes have been made for these items. Compare against the current stdlib before proposing patches; this runtime currently pins `0.1.0-dev.28+14bcdaa837f3`.

## 1. Budgeted allocator with independent observation

**Source:** `../silkjs/src/runtime_memory.silk` — `RuntimeAllocator`, `AllocationObserver`, `RuntimeMemoryStats`.

The engine needs a memory budget and coherent usage/peak/allocation-count snapshots while its allocator is exclusively installed as an effect service. Allocations and observation handles may outlive the provider; native reclamation can occur on another thread. The implementation keeps a reference-counted ledger separate from the allocator provider and charges allocation headers, padding, and payload.

**Potential stdlib contribution:** an allocator decorator and owning, allocation-free observation handle. This is independent of JavaScript and useful for embedders, bounded workloads, and service accounting.

**Preserve:** failed allocations do not raise the peak; lowering the limit below current usage prevents new allocations without invalidating existing owners; snapshots cannot tear during cross-thread reclamation; the ledger survives until its last owner/observer is dropped.

**Runtime evidence:** a worker allocated and filled a 1 MiB ArrayBuffer, transferred it to its parent, then exited. After the worker's engine and allocator provider were torn down, the parent verified every byte and mutated the transferred storage. The runtime and Node 24.22.2 both returned `[0,1048576,true,99,7]` (exit status, size, contents valid, mutated first byte, final byte). This exercises the ledger/owner lifetime boundary, not just live-worker sharing.

**Review before extraction:** accounting policy for allocator metadata, overflow behavior, contention, and whether the current `Allocator` API already offers an equivalent decorator. Do not upstream the engine's JS heap walk as part of this allocator abstraction.

## 2. Owned native asynchronous operations and completion delivery

**Sources:** `src/ext/fs_async.silk`, `src/ext/uv_fs.silk`, `src/ext/crypto_native.silk`.

Filesystem requests, watchers, and crypto thread-pool work use the same native loop. C callbacks only publish completion state; language-level callbacks run afterward, with native requests unlinked and mutable borrows released. Shutdown drains outstanding native operations without calling user code, then releases request buffers and callback roots. Submitted writes copy into owned staging buffers because the original JS view can be detached or mutated while native work is pending.

**Potential stdlib contribution:** reusable ownership/cancellation/completion primitives for native asynchronous I/O and thread-pool work. Prefer integrating with Silk's existing effect/I/O facilities rather than making libuv a mandatory stdlib dependency.

**Preserve:** close is not immediate free; cancellation can race with completion; callback storage stays alive until native completion; shutdown is safe without dispatching application callbacks; unreferenced watchers do not keep the event loop alive.

**Review before extraction:** which layer owns the loop, cancellation guarantees, executor/thread affinity, and whether a backend-neutral operation owner is sufficient. JS rooting, `AsyncResource`, `process.nextTick`, and rejection checkpoints belong in this runtime, not the stdlib.

## 3. Canonical foreign-function declarations and callback contracts

**Sources:** `src/ext/uv_fs.silk`, `src/ext/openssl.silk`, `src/ext/fs_async.silk`, `sys` of silk-lang/nonstd `db/sqlite` (formerly `src/ext/sqlite_abi.silk`); engine libc declarations in `../silkjs/src`.

Integration exposed duplicate declarations of the same C symbol with incompatible behavioral contracts, even when their ABI types matched. In particular, `free` declarations differed on `noCapture`, and libuv work/run declarations had been duplicated between filesystem and crypto adapters. Where declarations remain repeated, both ABI and behavioral contracts must agree. Deferred/thread callbacks must be distinguished from immediate callbacks, and nullable callback pointers are required by libuv's synchronous filesystem API.

Networking integration also exposed a fixed-arity `fcntl(fd, command, value)` declaration conflicting with the real variadic declaration. This is not just a naming issue: Darwin arm64 passes variadic arguments differently. The runtime now uses the canonical variadic signature. Process integration required aligning `read` and libuv loop lifetime contracts too.

HTTP/2 integration required matching the canonical `memcpy` pointer-capture contract. Worker integration likewise required matching `uv_ref`/`uv_unref` declarations across adapters. These mismatches produce compiler `SEM0192` errors; including the foreign symbol and both declaration locations in that diagnostic would also help, but that is a compiler improvement rather than a stdlib API.

SQLite exposed another ABI mismatch: one `sqlite3_bind_blob64` declaration used an integer destructor sentinel and another used a typed function pointer. The binding now has one typed signature and gives SQLite one owned snapshot instead of asking SQLite to make a second copy. Scalar/window callbacks reentered the engine with its original runtime allocator; nested SQL and original JS exception propagation matched Node in actual execution.

Registration-time destructors can run either during a failed registration or later during teardown. The current foreign-contract vocabulary cannot express that exact same-thread combination with `deferredCallbacks` alone; the adapter uses the more permissive `threadCallbacks` contract. A precise immediate-or-retained callback mode is a compiler-design candidate, not a reason to add SQLite-specific types to the stdlib.

**Potential stdlib contribution:** canonical low-level libc/platform declarations and reusable callback-safe adapters, so packages do not independently restate ABI and lifetime promises for common symbols.

**Boundary:** nullable C callback support was a compiler/toolchain prerequisite, not a stdlib fix. The runtime moved to dev.28, which already supports it; no compiler patch was needed for that issue.

**Review before extraction:** avoid exposing libuv/OpenSSL-specific ABI as a universal core API. Verify declarations against supported platform headers, and do not strengthen ownership contracts merely to silence duplicate-symbol diagnostics.

## 4. Lossless native filesystem metadata

**Sources:** `src/ext/fs_native.silk`, `src/ext/uv_fs.silk`.

Node's bigint stat surface needs integer inode/device/size fields and nanosecond timestamps without an intermediate floating-point conversion. The native adapter also needs positional I/O, exact Buffer/view bounds, descriptor-based operations, and consistent platform error data.

**Potential stdlib contribution:** lossless filesystem metadata and positioned-I/O primitives where the existing stdlib surface does not already provide them. Represent seconds/nanoseconds and native integers independently of Node's `Stats` object or JavaScript `BigInt`.

The trace sink (`src/ext/trace_native.silk`, `trace_abi.silk`) is another positioned-I/O consumer: allocation-free GC callbacks append actual collection events with `pwrite`, preserve a valid JSON trailer, and use `ftruncate` when rolling back a failed append. The integrated trace smoke exercised GC, asynchronous resources, filesystem operations, user timing, category ownership, and disabled-category suppression. An allocation-free positioned-write interface is worth comparing with existing stdlib APIs; this evidence does not establish that such an API is absent.

**Review before extraction:** Darwin/Linux field widths, negative/pre-epoch timestamps, supported timestamp precision, symlink semantics, and ownership of file descriptors. Node property names and `ERR_*` formatting remain compatibility-layer concerns.

## 5. System/process records and native ownership

**Sources:** `src/ext/os_abi.silk`, `src/ext/os_native.silk`.

The runtime now reads CPU information, network interfaces, user records, resource usage, and memory through native APIs. The integrated executable passed the exercised OS/process identity, usage-shape, and umask comparisons against Node 24.22.2; this is not exhaustive platform verification.

**Potential stdlib contribution:** owned CPU/interface/passwd results, growable native string queries, credential/group operations, and normalized resource counters. Preserve Darwin/Linux LP64 layout differences, unsigned IDs, allocator cleanup, and platform errno semantics. Exclude the JS property/encoding adapters.

## 6. Socket and resolver completion ownership

**Sources:** `src/ext/uv_net.silk`, `src/ext/net_native.silk`, `src/ext/dns_abi.silk`, `src/ext/dns_native.silk`.

The integrated executable passed TCP half-close and UDP view-boundary scenarios, NSS lookup of localhost, a local UDP DNS A-record response with TTL, and resolver cancellation reporting `ECANCELLED`. Reusable pieces include aligned socket-address handling, owned asynchronous writes, native completion queues, resolver lifetime, and readiness/timeout pumping. These checks do not establish exhaustive protocol or cross-platform compatibility.

**Preserve:** borrowed callback buffers cannot outlive the callback without ownership transfer/copying; cancellation requires draining before freeing; one loop owns its handles; NSS lookup and DNS record resolution are different operations.

**Existing overlap:** the pinned stdlib already exports `silk.net.address`, `resolver`, `resolver_native`, and `socket_native`, plus concurrency schedulers, thread pools, and work queues. Compare these contracts before proposing additions; do not upstream a duplicate networking stack merely because this runtime uses libuv.

## 7. Streaming/asynchronous subprocess contract

**Evidence:** the pinned `silk.system.child_process` module documents a blocking `submit` operation, closed child stdin, and complete captured stdout/stderr (`child_process.silk`, module documentation lines 1–15). `child_process_native` supplies its native provider.

The integrated runtime passed real synchronous and asynchronous `/bin/sh` scenarios with streamed stdin, independently captured stdout/stderr, and nonzero exit status. IPC transfer, cancellation, and large-output limits require separate checks.

**Potential stdlib contribution:** a child-process owner with separately managed stdin/stdout/stderr, asynchronous exit observation, signal/termination, and explicit descriptor inheritance. Node's spawn APIs need these capabilities; blocking capture alone cannot implement their observable behavior.

**Review before implementation/upstreaming:** existing scheduler integration, newer stdlib versions, wait/reap ownership, pipe backpressure, process groups, cancellation versus termination, output limits, and safe teardown. Keep Node `ChildProcess` events and IPC serialization policy outside the generic API.

## 8. Incremental compression contracts

**Sources:** `src/ext/compression_native.silk`, `src/ext/compression_abi.silk`; pinned `silk.compress.deflate`, `silk.compress.inflate`, and `silk.compress.zstd`.

**Observed gaps in the pinned implementation:** deflate exposes complete-buffer fixed-Huffman encoding rather than configurable levels and incremental flush; inflate does not accept preset dictionaries; Zstd is decoder-only and rejects dictionary-backed frames. The pinned module manifest has no Brotli implementation. The runtime therefore uses native zlib, Brotli, and Zstd adapters. The integrated executable passed gzip/raw-deflate/Brotli/Zstd round trips, a preset-dictionary deflate round trip, and a chunked 120 KB gzip-to-gunzip pipeline against Node 24.22.2. Flush/reset, Zstd malformed-input cases, and output-limit boundaries still need separate checks.

Web stream checks additionally matched Node for truncated input and strict rejection of trailing junk, padding, and concatenated members across gzip, deflate, raw deflate, and Brotli. Cancellation preserved the original reason in both directions; a 1 MiB incompressible input exercised writable pressure and decoded byte-for-byte. A negative-status serialization trap was fixed with the stdlib's existing wrapping integer conversions; that was an adapter bug, not a missing numeric primitive.

**Potential stdlib contribution:** incremental encoder/decoder owners with bounded output, explicit progress/end status, dictionary handling, flush/reset semantics, and cancellation-safe asynchronous execution. A bulk seeded CRC32 operation may avoid per-byte adapter overhead; compare the existing checksum API before proposing it.

**Preserve:** distinguish truncated input from a stream awaiting more bytes; preserve unconsumed input and partial output across calls; make memory/output limits explicit; do not silently accept unsupported dictionary or flush modes. Keep Node Transform wrappers, callbacks, and zlib constant aliases out of the generic API.

## 9. Terminal and inherited-descriptor ownership

**Sources:** `src/ext/uv_net.silk`, `src/ext/net_native.silk`, `ext/node/internal/stdio.js`, `ext/node/tty.js`.

The adapter distinguishes files, pipes/sockets, and terminals; duplicates inherited descriptors before handing them to a close-owning transport; opens stdin lazily; and restores raw terminal mode on exit. A real 80×24 PTY probe matched Node 24.22.2: stdin/stdout terminal detection, raw-mode state, window size, and immediate single-byte input. The original terminal attributes were restored after both processes exited.

**Potential stdlib contribution:** descriptor classification, explicit borrowed-versus-owned descriptor adapters, terminal mode guards, window-size queries, and resize notification. Compare existing terminal APIs before extraction. Node's sync/async stdio policy and process lifetime rules remain runtime concerns.

Cluster UDP now shares actual kernel sockets through `SCM_RIGHTS` under both round-robin and shared-listener scheduling. Primary and intermediate IPC handles do not receive packets; workers adopt descriptors and start their own receive watchers. Node 24.22.2 and the runtime passed ephemeral/fixed-port grouping, exclusive collisions, close/exit/disconnect ownership, surviving delivery, and final port reuse. Shared TLS listeners also passed worker-only SNI/handshakes and delivery after another worker disconnected under both policies. These consumers strengthen the case for owned/borrowed descriptor types, close-on-exec duplication, ancillary descriptor transfer, and adoption separated from receive registration; no new primitive was required for this slice.

## 10. Native backing leases and transactional transfer

**Sources:** `../silkjs/src/js_buffer_storage.silk` — `BufferLease`, `BufferTransfer`, `prepareTransfer`; `src/ext/worker_native.silk`; `src/ext/sqlite_native.silk`.

Native-owned bytes can move between runtimes by retaining an allocation owner rather than copying the payload. Foreign-owned bytes are different: their destructor may depend on the originating runtime and cannot simply be invoked in the recipient. Transfer preparation now snapshots that external storage into an independently owned allocation; only successful transaction commit detaches the source and invokes its local destructor. Ordinary native-owned transfers remain zero-copy.

**Runtime evidence:** a SQLite changeset conflict callback transferred and detached the same ArrayBuffer being consumed by the database operation. The database adapter's pre-callback snapshot kept parsing valid; both the runtime and Node applied the replacement, retained both rows, and reported a detached zero-length source. Worker transfer and source-worker-exit scenarios separately exercise native allocation lifetime.

The shared llhttp adapter now exercises a read lease during synchronous reentry: its headers callback transfers and detaches the input ArrayBuffer, but parsing still delivers the complete `payload` body and message completion. The runtime and Node 24.22.2 returned identical results, including the detached source and captured async context. Ordinary input stays borrowed until transfer requires a snapshot; foreign/shared backing follows its explicit snapshot policy. `tests/compat.mjs` retains this boundary as `http-parser-detach-context`.

SEA assets add an immutable mapped-file owner (`src/ext/sea_payload.silk`, `src/ext/sea_native.silk`). A read-only mapped file is a candidate for the Silk std filesystem. The runtime and each raw ArrayBuffer retain independent mapping references; copied assets and Blob results are independent allocations. A real detach/collection failure exposed the engine's external-finalizer convention: a detached wrapper can invoke the callback again with null data. The SEA adapter now releases its mapping reference only for live data, preventing premature unmapping. Standalone source and bytecode-cache executables passed asset transfer and Blob ownership checks after every input source, asset, configuration, and preparation blob had been deleted. This callback convention is an embedding responsibility, not a stdlib feature request.

**Potential stdlib contribution:** reusable native allocation leases and explicit foreign-owner transfer policies, if existing ownership/reference-counting primitives do not already cover them. Preserve all-or-nothing preparation, source-thread destruction, and allocation lifetime independent of the allocating service. JavaScript detachment, structured-clone traversal, and SQLite callback policy stay outside the generic abstraction.

## 11. Cross-thread CPU accounting

**Source:** `src/ext/worker_resource_controls.silk`.

Worker CPU queries use an owned Mach thread port on Darwin, protected from retirement by the registry lock. The integrated worker fixture and Node 24.22.2 both passed parent-versus-worker CPU isolation, actual worker CPU consumption, previous-usage subtraction, and dead-worker handling. The Linux implementation retains `/proc/thread-self/stat` and reports kernel-tick-resolution counters; that branch has not been exercised here.

**Potential stdlib contribution:** a lifetime-safe thread resource-counter capability with explicit unavailable/error results and documented precision. Do not replace thread counters with process totals. Check newer thread APIs before extraction.

`stackSizeMb` uses the existing SilkJS stack limit and a native thread stack reservation with unwind headroom; configured recursion depth and error-before-exit isolation passed on both runtimes. V8 young/old-generation and JIT code-range limits remain unsupported rather than being mislabeled as whole-runtime limits. Idle-worker termination also requires an interruption check at the event-loop polling boundary: a wakeup alone can be consumed before the interpreter's next interrupt sample. That boundary is runtime scheduling policy.


## Candidates still being investigated

- **TLS:** the memory-BIO adapter passed a real locally signed, mutually authenticated client/server handshake, ALPN negotiation, and encrypted payload transfer against Node 24.22.2. Rejection/identity policies and shutdown boundaries need additional checks. The pinned stdlib already has certificate, trust/path, and TLS modules; no general stdlib TLS gap has been established.
- **TLS compatibility boundary:** `_tls_common` and `_tls_wrap` reuse the existing secure contexts and transport. Their integrated builtin-module smoke completed a real mutually authenticated handshake with ALPN `h2` and the `private-tls` payload, matching Node. Legacy certificate normalization matched Node for self-signed issuer cycles, repeated and quoted access locations, and a literal `__proto__` key; this normalization is JavaScript API policy, not a stdlib TLS primitive.

## Deliberately not stdlib candidates

Node module resolution, CommonJS/ESM interop, Node error-code wording, EventEmitter conventions, HTTP agent policy, JS promise/GC hooks, WebCrypto constructor/receiver branding, and QuickJS class introspection are runtime/engine responsibilities. Their native building blocks may be reusable; their Node-facing contracts should not become general Silk APIs.

Two verified boundaries illustrate this distinction: WebCrypto methods reject invalid receivers before evaluating algorithm dictionaries, with asynchronous methods returning rejected promises; domain and async-local rejection handlers inherit the rejection-time context rather than a promise's creation context or mutable `.domain` property. Both matched Node 24.22.2 in actual execution. These are JavaScript compatibility policies, not reasons to add Node-specific brands or domain state to Silk's stdlib.

HTTP parser async IDs, provider categories, callback resource identity, and Node's `AsyncContextFrame` behavior likewise belong in the runtime. The parser smoke preserved its registration-time async-local value while executing under a different caller context; reset assigned the requested async ID and captured the new context. Both default frame mode and `--no-async-context-frame` matched the reference's actual frame visibility. These observations do not establish a missing Silk stdlib context API.

WASI Preview 1 uses the pinned uvwasi adapter rather than a second JavaScript engine. Actual Wasm guests exercised arguments/environment, redirected standard descriptors, preopened filesystem operations, reactors, invalid pointers, and returned exit codes; a separate `returnOnExit: false` run terminated the host with status 23. The lifecycle and guest fixtures passed on both the runtime and Node 24.22.2. Node's guest-memory bounds errors are `EOVERFLOW` (61), not `EFAULT`; this errno policy and the JS lifecycle checks belong in the runtime, not Silk's stdlib. Byte-span arithmetic and descriptor ownership remain the reusable concerns.

WebAssembly realm installation likewise stays in the runtime. The existing Intl
factory loader also evaluates the Wasm facade and compile-option helpers inside
each `vm` realm; Buffer and fetch dependencies remain internal modules, not VM
globals. A root-private, weak-global-keyed callback resolver supplies realm-local
errors and wrappers to the native bridge, while shared weak registries preserve
cross-realm resource brands and canonical wrapper identities. Each realm owns its
JSTag; disabling `codeGeneration.wasm` blocks compilation but not validation or
instantiation of an existing Module. `tests/wasm-realms-smoke.cjs` passed on
Node 24.22.2 and the integrated runtime, exercising these boundaries, resource
reexports, import exceptions, cross-realm JSPI, and home-realm Promise allocation.
Async function promise capabilities and await assimilation use the bytecode
function's home realm, not the calling or settling job's realm. Continuations
recover that realm from their already-rooted async frame; no prototype mutation
or extra runtime-lifetime realm retention is involved.
Exception `traceStack` creates an own, configurable, nonenumerable stack accessor
backed by weak per-object state. Borrowed own accessors preserve stack reads and
assignments across realms; the branded prototype getter returns `undefined`,
including after deletion of an exception's own stack property.

Imported-string-constant reflection depends on actual recognition, not merely
the presence of a compile option. Node 24.22.2 recognizes ASCII namespaces
(including embedded NUL), hides those imports, and supplies their string values.
Its pinned [V8 namespace matcher](https://github.com/nodejs/node/blob/v24.22.2/deps/v8/src/wasm/wasm-features.h)
compares unsigned wire bytes with plain `char` bytes from `std::string`.
The adapter preserves the target's `char` signedness rather than forcing signed
bytes: non-ASCII namespaces remain ordinary, visible imports on the signed-char
reference platform but can be recognized on unsigned-char targets. This is
runtime compatibility policy, not a proposed Silk stdlib contract, UTF8
truncation, or rejection of non-ASCII constant values. The compile-options fixture
separates recognized constants from the reference platform's ordinary-import cases.

WebAssembly import and export names must use the engine's value-key property
APIs: the byte-slice `getPropertyStr`/`definePropertyValueStr` helpers deliberately
implement C-string semantics and truncate at NUL. The native bridge keeps decoded
names as JS strings for namespace/field reads and export definitions, preserving
BOMs, Unicode, and embedded NUL without a UTF-8 round trip. Custom-section lookup
already passes explicit byte lengths and compares original bytes. These are
runtime/engine boundary requirements, not stdlib gaps; `tests/wasm-name-smoke.cjs`
passed on both engines, exercising full-name identity and getter order.

Structured cloning shared WebAssembly memory creates a fresh native handle and JS
wrapper over the retained backing; backing equality must not collapse distinct
Memory identities. Message graph aliases remain the serializer's responsibility.
Module deserialization consumes the exact byte span inside its wire buffer.
Adopting a Module uses its kind and owner directly, without requesting resource
type metadata: only functions, memories, tables, globals and tags expose that
metadata.
The root Wasm facade is installed before worker-data decoding so destination-realm
wrapper callbacks exist during adoption. These runtime ownership and bootstrap
requirements passed the Wasm smoke and worker fixtures on both engines, including
compile-option preservation across worker transfers. The basic Wasm fixture also
passed with forced collection enabled, checking that retained buffers outlive
their wrappers.

Native JS reference tokens must retain the value they actually store, not merely
an equal incoming value. Equal-content strings can occupy different allocations.
Retaining the incoming allocation while releasing the canonical stored one caused
a real atom-lifetime failure when a Wasm string builtin returned a newly allocated
string equal to its input. Retaining the stored value fixed the failure; the full
compile-options fixture now passes, including GC-array string roundtrips and worker
cloning. This is an ownership invariant in the adapter, not a missing stdlib API.

Trace category names, Node async-resource records, and Chrome trace JSON belong
to the runtime. The SilkJS `EngineServices.gcLifecycle` hook observes real
collection boundaries without allocating or entering JavaScript; the sink remains
alive through engine destruction. Records use actual monotonic time, process ID,
and native thread ID. GC events are named `SilkGC`, not fabricated V8 collections.

SEA preparation and launch are likewise runtime/tooling concerns. The verified
injector supports thin Darwin arm64 Mach-O executables, adds an `LC_NOTE` payload,
and signs/verifies the resulting executable. The build uses Silk's existing
`--clang` hook to reserve load-command space; no compiler change was needed.
Prepared blobs are tied to the exact runtime binary, and cached code is actual
SilkJS bytecode. `useSnapshot: true` remains explicitly unsupported because a
complete runtime-image serializer is not yet present; source replay is not a
substitute for startup snapshots.

WebAssembly now checks the existing host cancellation/deadline hook during
interpreter execution without allocating or entering JavaScript. Uncatchable
exceptions are materialized only after native unwinding. Atomic waits use the
engine's shared address-keyed waiter queue, capped by the earliest nested VM
deadline; worker cancellation wakes the existing cancellable domain. No extra
polling loop or separate Wasm waiter queue is needed. Node 24.22.2 and the runtime
passed `tests/wasm-interruptions.cjs`: ordinary and promising calls, start
functions, JS/nested-Wasm imports, blocking waits, post-timeout reuse, and worker
termination after JSPI resumption. Reusable cancellable waits and deadline
composition are candidates to compare with stdlib concurrency APIs; Node timeout
errors and uncatchable-JavaScript propagation remain runtime/engine concerns.

HTTP upgrade handoff must stop ordinary message-completion processing before the
parser clears its current message. The repaired path passed 34 real HTTP, HTTPS,
WS, and WSS boundary scenarios against Node 24.22.2, including redirect replay,
abort reason identity, permissive compressed-body final flushing, corrupt bodies,
strict upgrade headers, trust failures, and close ordering. These parser/fetch/
WebSocket policies belong to the runtime, not the Silk standard library.

HTTP/2 settings acknowledgment ordering, ping cancellation, CANCEL resets,
GOAWAY state, trailers, and graceful cleartext/secure exchanges passed all seven
real-connection scenarios. The secure failure was a protocol write after FIN:
HTTP/2 now drains its final frames before committing transport half-close. Net
shutdown treats only synchronous `ENOTCONN` submission as completed, matching
Node/libuv; queued errors still propagate. Session/window controls wrap actual
nghttp2 operations. Node's deprecated priority method remains a genuine no-op.

Eval and REPL builtin bindings share one lazy-accessor implementation. Assignment
replaces the accessor with an ordinary enumerable property; reading a frozen
context still loads the builtin. Eval's lexical crypto compatibility binding
does not replace global WebCrypto. CJS eval, ESM eval, and REPL lifecycle checks
passed against Node 24.22.2. These scope and descriptor rules are Node policy,
not reusable stdlib mechanisms.

All 14 TLS contract scenarios passed against Node 24.22.2 and the runtime:
CRL revocation, signature/version/DH restrictions, session-ticket keys, X509
ownership, negotiated algorithms, TLS 1.2 renegotiation and abuse limits, TLS 1.3
refusal, tracing, and shutdown. Credentials are generated temporarily. A reusable
TLS layer needs explicit callback/handle ownership and separate submission versus
completion errors; Node option names and event ordering remain runtime policy.

## Verified provider cryptography and syntax-only compilation

The native provider path now passes the public crypto, X509/PKCS12, and
MAC/Argon2/KEM smoke programs. Modern WebCrypto passes in both Node 24.22.2 and
Silk: AES-KW/OCB, ChaCha20-Poly1305, SHA3/cSHAKE, KMAC, Argon2, ML-DSA, ML-KEM,
capability queries, public-key extraction, and KeyObject conversion. Node-produced
ML-DSA signatures and ML-KEM ciphertexts are consumed by Silk; a separate run
exports Silk-produced fixtures and consumes them successfully in Node.

Reusable stdlib candidates are owned EVP/X509/provider handles, typed OpenSSL
parameter construction, and byte-oriented authenticated encryption, KDF, MAC,
signature, and KEM operations. Async jobs must retain every native key and input
until completion. Preserve typed runtime errors separately from OpenSSL error
queue messages: otherwise a generic crypto prefix hides the original argument
error. Secret-buffer zeroization and fallible allocation need an explicit review
before promoting these native wrappers into a general-purpose crypto library.

Non-extractable AES keys and private ECDSA keys now cross real worker boundaries.
The clone smoke checks aliases, cycles, usage/algorithm metadata, continued export
rejection, encryption/decryption, and signatures after the source worker exits.
Cloning imports independently owned native keys at the destination; it does not
send native pointers or expose an application-visible export bypass. This
trusted serialization policy and CryptoKey branding belong to the runtime;
native key ownership and lifetime primitives are reusable.

SilkJS now separates syntax-only compilation from linking and execution, and
uses parser evidence rather than token scanning or exception-message matching
to detect module-only syntax. Actual CLI checks accept an unresolved import
without loading it, reject an undeclared local export, and do not execute the
checked source. Automatic top-level-await input and explicit ESM input execute;
vm.Script and Function continue rejecting module-only syntax. The parser APIs
belong to SilkJS. NODE_OPTIONS precedence, CJS wrapper bindings, print/stdin
rules, and CLI exit conventions belong to the runtime, not the stdlib.

The integrated differential suite passes all 70 existing Node 24 cases. This
does not establish complete Node compatibility; remaining public APIs and CLI
controls remain tracked separately.

## Verified utility, filesystem, and native clone contracts

The utility smoke passes on Node 24.22.2 and Silk: argument/environment parsing,
MIME objects and mutable parameter iteration, diff operations, debounce/throttle,
signal conversion, and independent system-error maps. Canonical error names and
messages come from libuv's real `UV_ERRNO_MAP` and `uv_strerror_r`, not a partial
errno list or platform `strerror` approximations. The macro expansion needs a
small C bridge; the ownership and JS conversion layer is Silk.

Reusable candidates include byte/text parsers, diff algorithms, monotonic timer
combinators, and a complete platform-error catalog. Promise-handled state is an
engine responsibility: the runtime reuses SilkJS `js_promise.markHandled`,
without attaching a synthetic reaction. An actual event-loop probe confirms
that early marking suppresses rejection notification and late marking emits
exactly one `rejectionHandled` event, even after repeated calls.

Filesystem smoke covers synchronous/callback/async-iterator glob traversal,
exclusions, symlink cycles, lazy file Blob reads and slices, cancellation,
mutation, and real Utf8Stream buffering/backpressure/flush/reopen/error recovery.
Readers own their descriptors and close them on completion, cancellation, error,
or collection; worker teardown also has descriptor tracking. Lazy immutable byte
sources with explicit reader ownership are a useful stdlib candidate. Glob
traversal and reusable UTF-8 buffering may also qualify; Node option names,
events, aliases, and worker-clone policy remain runtime responsibilities.

Do not upstream Node's file-mutation fingerprint as a general integrity check.
Node 24.22.2 compares file size and only mtime's nanosecond component. The smoke
replaces a file, changes timestamp seconds while keeping the nanosecond
component, and observes replacement contents in both runtimes. A general Silk
file-source API should specify full timestamp/identity semantics independently.

The reference binary aborts inside `FdEntry::get_reader` when a worker reads a
cloned file-backed Blob slice (`v8::HandleScope::CreateHandle` failure). The full
filesystem smoke, including that worker path, passes in Silk. Node comparison
passes with the explicit `--skip-worker-blob` switch; this is a reference-runtime
crash limitation, not a claim that the worker path was compared successfully.

The extended native-clone smoke passes in both runtimes. CryptoKey, KeyObject,
and X509 wrappers retain aliases and independently owned native state; returned
keys remain usable after the worker exits. Cloning ignores overridden public
key export methods and mutated cached certificate bytes. Moving these native
objects into a VM-context MessagePort rejects with
`ERR_MESSAGE_TARGET_CONTEXT_UNAVAILABLE`, matching the observed Node boundary.

## Additional reference boundaries for experimental APIs

Node 24.22.2 exposes `stream/iter` and `zlib/iter` under their experimental flag
as ordinary builtins: both bare and `node:` imports work, and `builtinModules`
lists the bare names. The Readable conversion protocol exists without the flag
but throws `ERR_STREAM_ITER_MISSING_FLAG` when invoked. This gating belongs to
the runtime, not Silk's standard library.

Worker option inheritance uses private startup snapshots rather than the
mutable `process.execArgv` array. Explicit environment or execArgv options
create a fresh parser configuration; inherited environment errors are treated
differently from explicit environment errors. The worker-entry smoke passes in
both runtimes and verifies global Script bindings, ESM detection, option
precedence, process-wide GC exposure, and the distinct Symbol coercion rules
for argv, execArgv, and environment values. These are Node compatibility policies.

Node's lazy Storage initializer can fatally abort when a user-replaced
`process.emitWarning` deletes the initializing global property. The SilkJS
owned-initializer implementation must instead detach and root its in-flight
state, invoke JavaScript, then re-resolve the property after arbitrary mutation
or collection. This is an engine ownership contract, not a stdlib Storage API.
The separate reentrancy safety smoke passes in Silk with collection inside the
initializer, 2,048 added globals, deletion, data/accessor redefinition,
assignment, recursive access, and exceptions. It intentionally requires safer
behavior than the crashing reference. Full Storage verification now passes:
global capture/declaration does not eagerly initialize Storage, quota-sized
UTF-16 values round-trip, and SQLite persistence is shared correctly between
workers and concurrent processes.

The reference iterable-codec probe also exposed an unhandled `AbortError` after
returning early from a gzip pipeline. The portable pre-EOF smoke now checks
actual gzip header bytes before releasing upstream input, then drains and
decodes the result. It does not claim successful reference comparison of that
early-return cancellation path.

The iterable-stream smoke passes in Node and Silk, including classic adapters,
fan-out, backpressure, sync/async gzip/deflate/Brotli/Zstd, dictionaries,
truncation, and Zstd pledged source-size enforcement. Bounded streaming codec
state, cancellation ownership, and full-width pledged sizes are reusable
binding contracts; Node byte-batch protocols and experimental flags are not.

Bulk string/byte conversion deserves a native Silk primitive rather than
JavaScript-per-character loops. A debug-runtime probe performing twenty
12,000-byte Buffer UTF-8 encode/decode round trips consumed 9.818 seconds
wall time and 9.790 seconds user CPU. A separate HTTP/2 probe spent
472–473 milliseconds synchronously processing one 12KB header block while
TCP_NODELAY was enabled. These are CPU costs, not blocked sockets or failed
memory-credit reclamation. This is measured debug-build evidence, not a release
performance claim; investigate existing Unicode codecs before proposing a
second implementation.

The source now routes Buffer UTF-8/UTF-16LE conversion through
`src/ext/buffer_codec.silk` (host operation 18), retaining JavaScript overload
and encoding coercion policy. UTF-8 byte length traverses the engine's
`RopeIterator` without encoding allocation. Writes use the engine's `Utf8.encode`
and existing shared-aware scalar stores directly into the destination view;
decoding builds an owned engine string with `StringBuilder`. No external
allocation or finalizer is introduced. UTF-16LE preserves individual code units,
including lone surrogates and NUL, and ignores a final odd byte.

`Strings.fromUtf8` deliberately has QuickJS invalid-run consumption, while
`Utf8.decode` accepts extended encodings and surrogate code points. Buffer
therefore needs a strict maximal-subpart decoder rather than silently changing
these existing engine contracts or adopting TextDecoder BOM semantics.
`tests/buffer-codecs-smoke.cjs` records malformed sequences, bounded writes,
view offsets, shared backing, detachment and resizing for Node differential
comparison. All 2,032 records now match Node, including writes whose encoding
coercion shrinks a view: UTF-16 writes clamp to its live extent, unlike UTF-8.
The same debug UTF-8 workload now takes 6.004 milliseconds wall time and 5,999
microseconds user CPU; full Storage quota verification passes. These are local
debug-build measurements, not release benchmarks. All thirteen HTTP/2 resource
scenarios and seven existing protocol-control scenarios also pass after the
codec cutover. The 70-case compatibility suite passes on that native build.

Worker constructor option coercion, environment/argument inheritance, naming
lifecycle, standard I/O and tracked-descriptor cleanup now pass the dedicated
smoke in Node and Silk. Existing worker entry and CPU/stack-control smokes also
pass in Silk. OS thread names are set before engine startup using libuv and a
bounded, stack-only UTF-8 name copy. Darwin `proc_pidinfo` observations match
Node for Unicode names, byte-limit truncation, embedded NUL and lone surrogates;
the JavaScript metadata retains the full name. Linux naming is not yet exercised.
Unsafe huge stack requests retain explicit range
errors rather than reproducing the reference's SIGBUS. UTF conversion and
platform thread naming/stack primitives are stdlib candidates; Node option
truthiness, private startup snapshots and inheritance precedence are not.

## Module startup policy

CommonJS preloads run before ESM preloads regardless of argument interleaving;
ESM preloads evaluate sequentially and await top-level promises before entry.
Environment preloads precede CLI preloads within each group. The preload smoke
passes in Node and Silk for files, eval, stdin, syntax checking, option-error
precedence, asynchronous preload rejection and worker inheritance. Node omits
ESM preloads for a CommonJS eval Worker, but runs them for an ESM eval Worker;
the runtime preserves that distinction. Preloaded CommonJS modules expose
`module.isPreloading` and the `internal/preload` parent without installing eval
globals early.

Native `silk:host/std` and `silk:host/os` namespaces are bootstrap-only. Bootstrap
links them before the public module loader is installed; no source filename
grants access. The native normalization callback rejects private Silk names on
both input and output, before SilkJS consults its loaded-module cache, including
hook redirects. Public `os` remains the Node builtin and `std` remains an ordinary
package name, not a native alias. `tests/loader-private-builtins-smoke.cjs` includes
direct, indirect, hook-redirected and VM import regressions for this boundary.

SEA startup uses the same preload path. Actual signed code-cache executables
passed with configured preloads and both environment/CLI extensions after the
main source was removed; external preload files intentionally remained. The
existing standalone source/cache and asset-ownership smoke also passes.
These grouping and entry policies belong in Node compatibility, not Silk's
stdlib. Reusable filesystem, URL and asynchronous-evaluation ownership
primitives should stay separate from Node's startup rules.

## Environment-file loading

`process.loadEnvFile`, `--env-file` and `--env-file-if-exists` now reuse the
existing dotenv parser and filesystem path/error adapters. The Node/Silk smoke
passes for quoted multiline values, pre-existing environment precedence,
multiple-file overrides, optional/required files, URL and byte-view paths,
read failures, and isolation from monkey-patched public filesystem methods.
CLI files are combined before applying values, so later files win without
overwriting the initial environment; separate public API calls preserve values
already applied by earlier calls.

Environment-file `NODE_OPTIONS` takes effect before preloads, and `NODE_PATH`
refreshes CommonJS global lookup before entry. Worker options accept env-file
flags but do not load those files again; actual environment inheritance is
verified separately. A pure bounded dotenv parser and explicit environment-map
merge operations are reusable stdlib candidates. Node flag scanning, startup
ordering, optional-file diagnostics and its open/read error classification are
runtime policy, not stdlib behavior.

## Structured call sites and runtime bytecode caches

`util.getCallSites` now passes the Node-reference smoke for actual call
coordinates, UTF-16 columns and ECMAScript line terminators, tail calls, eval,
VM contexts, cached compilation, snapshot ownership across GC, and compilation
identity. Supplemental call PCs survive instruction relocation and jump
shrinking; legacy QuickJS `Error.stack` coordinates and its bytecode wire format
remain unchanged. Shared compilation-tree coordinate lookup reverses only the
cursor delta rather than restarting at byte zero on backward queries. The
observed debug-build startup probe fell from 6.688 seconds to 1.628 seconds.

VM realm clones copy owned supplemental tables and preserve compilation IDs.
Runtime disk caches wrap actual QuickJS bytecode in a versioned `SILKSC01`
envelope with coordinate/eval metadata, never process-local IDs. Deserialization
assigns a fresh tree identity. Signed SEA source and cache executables produced
identical structured coordinates after deleting the main source; both also
loaded configured environment files. Source-map remapping remains separate
unfinished work, not a capability claimed by this verification.

Reusable stdlib candidates: explicit UTF-8/code-point/UTF-16 source-coordinate
indices and bounded binary cursors with checked lengths. Instruction-PC
relocation, script identity, frame capture, and bytecode cache envelopes belong
to the engine/runtime.

## Module-resolution policy verification

The Node/Silk module-controls smoke passes for `findPackageJSON`, CommonJS
`NODE_PATH`/`globalPaths`, custom package conditions, and independent main versus
dependency symlink modes. ESM does not acquire CommonJS global lookup paths.
These policies remain in the Node compatibility layer; generic canonical-path
and filesystem primitives are the reusable stdlib boundary.

Startup diagnostics use the existing synchronous descriptor writer rather than
the public Writable queue. The dotenv regression verifies that multiple
optional-file notices and a final fatal option/path diagnostic all survive
immediate exit.

The full 70-case differential suite passes after the call-site/cache/module
changes. Existing SEA ownership tests pass with the new cache envelope, and six
malformed-envelope variants reject before executing main: magic, bytecode
length, function count, metadata flags, code length, and unterminated coordinate
encoding. This verifies the envelope boundary, not general validation of every
QuickJS instruction/operand in an untrusted bytecode payload.

## VM diagnostic offsets and test-runner lifecycle

The Node 24 reference and runtime pass `vm-diagnostic-offsets-smoke.cjs` for
signed Script/compileFunction offsets, first-line-only column adjustment,
syntax-error carets, UTF-16 coordinates, realm clones, and cached reuse without
mutating the producer. VM stack coordinates exclude compileFunction wrapper
and context-extension scaffolding. Runtime cache metadata is now `SILKSC02`,
which adds signed diagnostic-policy offsets; the earlier `SILKSC01` SEA evidence
above predates this revision and the new executable-bytecode validator.

`test-snapshots-smoke.cjs` passes bidirectional Node/runtime snapshot-file
interoperability, serializer pipelines and copied defaults, nested names and
escaping, custom paths, file snapshots, read-only mismatches, explicit updates,
stale-entry removal, child-process flag inheritance, and teardown write errors.
`test-plan-smoke.cjs` passes indefinite/bounded waits, plan and test timeouts,
cancellation cleanup, validation before installation, captured assertion
objects, and plan checking before teardown hooks.

The reusable stdlib boundaries remain owned source-coordinate tables, checked
binary cursors, filesystem/path primitives, and cancellable deadline/wakeup
primitives. Node snapshot syntax, assertion-plan ordering, VM wrapper policy,
and cached-script diagnostic records belong to the runtime rather than Silk's
standard library. Prefer extending existing primitives over adding a second
runtime-specific formatting or cancellation abstraction.

SilkJS compiler regression roots `js_debug_positions_tests.silk` and
`js_compiler_labels_tests.silk` pass 11 and 6 tests respectively. The focused
bytecode-validator, regexp-validator, and private-field roots pass 6, 12, and 6
tests. Integration exposed three unused/variant metadata assumptions: argument
and synthesized-local `scopeNext` fields are not active scope chains, ordinary
generators use `return_async`, and delegated iteration explicitly disables its
cleanup marker. Scope links are now checked only when direct-eval operands can
traverse them, with bounds, cycle detection, and memoized body/argument
terminals. The signed SEA ownership/source/cache smoke passes after the
argument-metadata repair.

The complete binary-object oracle now passes 173 cross-read/write records,
6,606 malformed/truncation boundaries, 28 executable-admission boundaries,
two immutable-buffer ROM executions, and 331 native allocation-failure
injections with zero final ledgers. Coverage includes generator delegation,
async generators, iterator cleanup, direct eval, mapped arguments, private
fields, and regexp constants. Independent compilers may choose different
instructions: the oracle checks cross-engine execution and exact decoded-byte
roundtrips, not identical optimization choices. The pinned C oracle reports its
own allocation leaks/semantic losses and four injected reader crashes; these
are reported, not treated as permission for native failures.

The current signed SEA source and cache executables also run generator
delegation, async generators, `for await`, mapped arguments, direct-eval
captures, private fields, and regexp constants after deleting the original
entry, configuration, and intermediate blob. Ten correctly constructed
`SILKSC02` corruptions reject before main: magic, bytecode length, function count,
metadata flags, code length, unterminated coordinate encoding, an out-of-range
line, a negative wrapper prefix, offsets without VM diagnostic policy, and an
invalid decoded closure-constant operand.

## TypeScript parser ownership and loader integration

The vendored Amaro 1.1.11 parser runs its bundled SWC Wasm through the runtime's
WebAssembly implementation. Its provenance and MIT/Apache-2.0 notices live in
`ext/node/internal/deps/amaro/`. The public stripping/transformation API smoke
passes on Node 24.22.2 and the native runtime, including erased-token positions,
CRLF/Unicode, executable enums/namespaces/parameter properties, validation,
diagnostic locations, and source-map/source-URL output. Transform tests exercise
the emitted program rather than pinning incidental pretty-printing or error
wording.

That workload exposed quadratic ownership traversal: each ordinary function
reference searched all 4,883 native handles for an exception owner. A guest
exception is an explicitly tagged externref; checking that tag before the
registry scan preserves the existing ownership/lifetime rules. The complete
API smoke now passes in 8.19 seconds in the checked debug build, rather than
timing out after 180 seconds. Existing WebAssembly execution, suspended
externref/exception ownership, GC references, modern EH, and SIMD suspension
smokes also pass. This tag/owner lookup is runtime-specific, not a new stdlib
container proposal.

Reusable boundaries for later stdlib work:

- Cancellable atomic waits with deadlines and notifications, shared by worker
  coordination and loader RPC. Node permits blocking Atomics in its main thread
  as well as worker isolates; that policy belongs to the embedding.
- A non-consuming thread-completion observation distinct from joining or
  draining message/exit events. Hook registration must detect a stopped worker
  while the requesting thread is synchronously waiting.
- Reentrant event-loop turns that share timer, I/O, and job scheduling without
  emitting another main-loop `beforeExit`/`exit` lifecycle. The actual Promise
  state/result access and module-hook semantics remain SilkJS/Node concerns.

The JavaScript loader-hook smoke passes on both runtimes for chain order,
deregistration, validation, URL/source/attribute propagation, real async I/O,
transferred registration data, and original hook failures. A separate native
scenario executes timer-backed resolve hooks and nested imports in the hook
isolate. An async CommonJS load that returns null source retains legacy
`require`; a supplied source opts into hook-aware loading. This distinction is
Node loader policy, not a filesystem/std-library concern.

The integrated CLI passes 22 reference scenarios for `.ts`/`.mts`/`.cts`,
package modes, erased imports, transformation, explicit/automatic typed
eval/stdin, node_modules rejection, extension probing, and worker/fork flag
inheritance. Node 24 `--check` deliberately does not strip types; automatic
input fallback preserves the original JavaScript syntax error when stripping
cannot produce a valid program. Internal hook workers inherit transform and
resolution policy without recursively replaying `--import`/`--require`
preloads. Typed timer-backed hooks and nested imports pass end-to-end.

The expanded hook fixture also verifies that `process.exit(7)` in a hook
worker exits its requesting thread with status 7 rather than becoming a
catchable hook rejection. Terminating a worker blocked in hook registration
returns exit status 1 and cleans up its waiting hook worker on both runtimes.
The native module/cancellation regression root passes seven tests after
forwarding import attributes through every SilkJS normalization implementation.
The complete differential compatibility suite passes 70 cases after this
integration.

## Cross-thread coordination

The runtime's native worker group now routes `postMessageToThread` payloads and
transferable ports with delivery acknowledgements, timeout handling, and owner
cleanup. A group-owned lock registry supplies exclusive/shared arbitration,
FIFO waiting, cancellation, stealing, and release when an isolate exits.
Callbacks and Promise settlement stay on the owning isolate; registry locks
are released before constructing JavaScript values.

Potential Silk standard-library additions:

- Thread-group mailboxes with stable endpoint identities, wakeups, delivery
  acknowledgements, and ownership-aware shutdown. JavaScript structured cloning
  and the Node event API remain embedding concerns.
- Named reader/writer arbitration with FIFO cohorts, cancellable waiters,
  owner-exit cleanup, and snapshots scoped to a requesting owner. Keep the
  arbitration registry separate from callback execution and allocation.
- Non-owning snapshots of referenced endpoints, including pending close
  delivery, without retaining the objects being observed.

The native messaging smoke passes routing, acknowledgement, listener errors,
timeout, and transfer cases; the same fixture passes on Node 24.22.2. The native
lock smoke passes exclusion, concurrent readers, ordering, cancellation,
stealing, and owner-exit cleanup. The pinned Node reference fatally aborts on
cross-thread stealing (`v8::HandleScope::CreateHandle` without a HandleScope);
a separate owner-exit probe leaves its waiter unresolved until a five-second
guard fails. Those reference failures are not compatibility targets.

## Persistent VM cache ownership

`vm.Script` and `vm.compileFunction` now consume copied/persisted SilkJS
bytecode in fresh processes. Their `SILKVM01` envelope records the compilation
kind, exact payload length, runtime/compiler/build identity, UTF-16 source
identity, and payload digest. Digests detect accidental corruption and stale
inputs; they are not authentication. Native instruction/metadata validation
still runs when a caller supplies a correctly recomputed digest.

Cache input is copied through intrinsic view accessors before hashing or
decoding. Subviews, DataViews, and shared backing are snapshotted; detached
input is rejected. Decoded bytecode owns its storage. Consumer filenames and
diagnostic offsets are applied to the new code tree without mutating the
producer, while context extensions remain live consumer bindings.

Reusable standard-library candidates are bounded binary envelopes, checked
extent arithmetic, stable build fingerprints, and explicit snapshot/read-lease
APIs. Opcode validation, source encoding identity, realm binding, and stack
coordinate metadata belong to SilkJS/the Node embedding rather than the
general standard library.

The fresh-process VM fixture passes on Node 24.22.2 and this runtime. Native
offset and call-site fixtures also pass. A separate native probe rejects ten
header/payload corruptions, including recomputed-digest malformed bytecode,
and distinguishes lone UTF-16 surrogates. Its deliberately rewritten source
digest allows valid cached code to execute despite an unparseable supplied
source, proving actual deserialization rather than recompilation.

## Lazy diagnostic ownership and detached module graphs

SilkJS now exposes opt-in, per-realm lazy Error stack headings through
`js_error_intrinsics.enableNodeStackFormatting`. The captured trace and cached
result are GC-owned payload edges. Accessor failures do not commit the cache;
assigned overrides and successful formatting do. Ordinary QuickJS embeddings
retain their existing behavior. Root, worker, and VM realm smoke scenarios
pass, including frozen errors, throwing accessors, native exceptions, and
diagnostic offsets. Engine error, GC, and module suites pass: 9, 19, and 7
tests respectively. Full `Error.captureStackTrace`/`prepareStackTrace` CallSite
support remains separate work, not a claim of this formatting change.

Flagged VM modules use actual SilkJS module records, linking, namespaces,
live export bindings, and asynchronous evaluation. Host-owned graphs trace
their detached dependencies and callbacks; callback metadata is not serialized
into bytecode. VM data-function handles explicitly retain their realm:
QuickJS's ordinary data functions have a null realm, so assuming otherwise
caused a native trap during integration. The flagged and unflagged smoke
scenarios now pass on the runtime and Node 24.22.2, as do fresh-process VM
caches, offsets, and structured call sites.

These mechanisms belong in the engine/embedding, not Silk's general standard
library. Reusable stdlib lessons are explicit ownership for detached graphs,
fallible lazy initialization that commits only after success, and immutable
snapshot owners that survive their originating execution scope.

## Resource snapshots, report configuration, and synchronous output

`src/ext/resource_snapshot.silk`, `fs_async.silk`, and `net_native.silk`
distinguish native handle flags from public owner lifetime. Filesystem requests
remain visible during callback delivery, with explicit callback/Promise/
FileHandle-close ownership rather than a dynamically inherited label. A
listening socket's logical reference survives its native close callback until
delivery finishes, even though libuv has already cleared its physical flag.
Throwaway filesystem and close-delivery probes exercise these boundaries.
The permanent socket fixture awaits both peers explicitly; client close does
not guarantee that the accepted server socket has already closed.

Report directory, filename and compact mode live in the worker group's report
settings (`src/ext/diagnostics_fatal.silk`) behind their own mutex, and
fatal-report enablement is an atomic beside them, so the fatal path reads them
with one `tryLock` and never waits. Out-of-memory in an isolate's runtime heap
reaches the report through `ReportingAllocator`, the heap's child allocator,
which carries the settings and isolate ID; `napi_fatal_error` reaches it
through a per-thread context that `napi_native` sets. Immutable UTF-8 path
storage is retained under the mutex and decoded after unlocking; no JavaScript allocation occurs
while the registry is locked. Lone surrogates normalize to replacement
characters, and native path settings truncate at the first NUL. Signal and
uncaught-exception settings remain isolate-local with Node's worker option
inheritance rules. Report configuration and diagnostics smokes pass on both
the runtime and Node 24.22.2, including CLI/environment precedence, actual
signal and uncaught reports, filtered fields, file output, and standard output.

Two reusable stdlib candidates emerged from those smokes:

- **Polling without extending lifetime.** `fs_async.pollInner` temporarily
  references the existing worker wake handle only around nonblocking native
  polling. Otherwise libuv skips polling when only unreferenced signals or
  sockets exist, even if a JavaScript timer keeps the runtime alive. The
  reference is restored before JavaScript runs; no additional handle is
  allocated. A real signal delivered before the timer after this fix, rather
  than only after later I/O made libuv alive.
- **Complete descriptor writes without flag mutation.**
  `os_native.writeAllDescriptor` preserves partial-write progress, handles
  interrupted syscalls, and waits for writable readiness on backpressure.
  It neither spins nor changes shared descriptor flags. A synchronous report
  previously failed with EAGAIN on a subprocess pipe. Reports now complete,
  including a 277,553-byte report preserving a 262,144-character property
  through a socket configured with a 1,024-byte send buffer. This primitive
  blocks until progress or a real error; general stdlib adoption should expose
  explicit cancellation/deadline policy.

Node report schemas, public resource names, and setting inheritance belong
in the runtime. Cross-isolate report snapshots and allocation-failure-safe
fatal reporting are still absent and explicitly identified as unsupported;
the normal report writer does not establish either capability.

## Structured frames, creation realms, and cached source metadata

`silkjs/js_stack_frames.silk` and `js_node_stack.silk` capture actual execution
frames, receiver/function ownership, declaration coordinates, and script
identity. `ext/node/internal/error_stack.js` implements lazy formatting,
constructor exclusion, capture-time stack limits, custom formatter results,
retry after formatter exceptions, and realm-local CallSite objects. Neither
capture nor source positioning parses rendered stack text.

Objects retain their allocation realm through one traced inline pointer.
This preserves formatter selection after prototype mutation and for
null-prototype targets. Publication, failure cleanup, cycle tracing, and
destruction must agree on that edge; deriving the realm from the current
prototype is incorrect. This is an engine ownership requirement, not a
stdlib object API. The error-stack smoke passes on Node 24.22.2 and the
runtime with explicit GC, including cross-realm receivers and cached scripts.
After the ownership changes, engine error, GC, and module suites passed
9, 19, and 7 tests; the native binary oracle exercised 173 cross-read/write
records, 6,606 malformed/truncation cases, and 331 allocation-failure cases
with zero native allocation ledgers.

The reusable stdlib candidate is a bounded immutable text envelope:
`src/ext/script_cache.silk` now uses `SILKSC03`, preserving source text,
sourceURL, and source-map URL as length-checked Latin-1 or UTF-16LE fields.
It rebuilds process-local traced metadata rather than serializing realms,
callbacks, object graphs, or script IDs. Fresh-process VM cache smoke passes;
the cache-backed stack smoke verifies astral source coordinates, source
hashes, and distinct physical/sourceURL filenames. QuickJS's interoperable
binary-object format is unchanged. Earlier `SILKSC02` evidence above refers
to the previous runtime envelope.

A throwaway consumer recomputed outer cache digests before submitting 43
malformed source-metadata cases: invalid tags, oversized lengths, truncated
text fields, and the old envelope version. Each was rejected, and recompiling
the supplied source still produced the expected value. The signed SEA smoke
also passes source and cached entry points, assets, backing ownership, and
explicit snapshot rejection with the new envelope.

Keep diagnostic policy separate from source coordinates: Node's sourceURL
suppresses line/column presentation offsets for execution positions but
retains those offsets for enclosing-function coordinates. The lexer supplies
actual comment spans for engine metadata. Generated-source map registration
has a separate Node textual-extraction policy; that compatibility quirk
should not enter a generic lexer or stdlib source-location abstraction.

## Source-map registry and compilation observers

`ext/node/internal/source_maps.js` implements flat/indexed mapping lookup,
relative source resolution, cached external and inline maps, and structured
stack/call-site remapping. Native compilation observers supply real script IDs,
source text, and lexer-confirmed directive spans; ESM presentation filenames
become URLs without changing the loader's module identity. CJS registers with
its Module owner, while eval and ESM use traced compilation metadata.

The source-map smoke passes on Node 24.22.2 and the runtime, both normally and
with startup mapping enabled. It exercises actual CJS/ESM consumers, VM
exclusion, invalid-map replacement, node_modules filtering, programmatic
controls, CLI/environment precedence, and worker startup inheritance.
Generated eval deliberately uses Node's textual directive extraction:
template and block-comment matches, repeated whitespace, empty directives,
and trailing tokens differ from the engine's lexer-confirmed metadata.

Potential stdlib pieces are bounded VLQ decoding and structured source-position
mapping. Node's cache admission, URL acceptance, generated-source extraction,
and public output shapes should remain runtime policy. Compilation observers
and traced script metadata belong in SilkJS's embedding surface.

Internal module-body promises are marked handled before body execution:
a synchronous throw can notify rejection tracking before the native call
returns. This prevents discarded private completion promises from becoming
spurious unhandled rejections while retaining the public module rejection and
error identity. Module smokes cover synchronous failures and interruption.
This is an engine completion-ownership rule, not a stdlib Promise policy.

## Interruptible waits and real terminal signal handoff

`silkjs/js_atomics_native.silk` accepts a borrowed interruption predicate for
blocking waits. With a VM deadline or signal scope, timed condition waits
periodically check it outside the queue lock while retaining their queue
position. Ordinary waits are unchanged; worker cancellation still unlinks
the waiter. A stdlib cancellation-aware wait primitive should preserve these
ownership, ordering, and lock-release guarantees rather than repeatedly
removing and re-registering a waiter.

The runtime VM signal smoke passes for execution, nested watchdog priority,
Atomics.wait, module interruption, listener restoration, and worker teardown.
`tests/repl-sigint-smoke.py` runs the actual CLI in a controlling pseudo-TTY:
Ctrl-C interrupts a running loop, kernel signal delivery is enabled during
evaluation, raw mode is restored afterward, and the same REPL evaluates
another expression. Both Node 24.22.2 and the runtime pass.

`src/ext/vm_interrupt.silk` now owns one process-group SIGINT subscription.
Its native loop selects the newest VM watchdog, or otherwise signals subscribed
isolate-loop async handles. Observer records contain native state only; detach
completes before their async handles close, and process states retain the
broker lease through teardown. This removes duplicate delivery to a worker VM
and the main JavaScript listener. Obsolete per-isolate pause/resume APIs were
removed. Root and worker modules, late listener registration, existing listener
preservation, and resubscription pass the runtime smoke. A separate actual Wasm
loop sets an atomic shared-memory gate before the sender sends SIGINT; both
Node and the runtime interrupt it and reuse the VM afterward.

Reference limitation and intentional difference: Node 24.22.2 times out the
worker VM if a newly added main-thread listener steals its SIGINT. It also
terminates on a later SIGINT despite an existing main listener after the
worker watchdog exits. The expanded broker smoke catches these failures on
Node; the runtime preserves subscriptions instead of reproducing them.
The broker's allocation-free intrusive registration, acknowledged activation,
exclusive routing, and detach-before-close ownership are stdlib candidates.

## Weak cancellation ownership and cross-isolate transfer

`ext/node/internal/abort_controller.js` implements weak-resource abort waits
and MessagePort-backed signal transfer. A wait holds weak references to both
the resource and signal; its listener checks liveness before resolving, even
if finalizer delivery has not yet occurred. A pending wait resolves with the
abort Event; an already-aborted signal resolves with undefined. Function
resources are accepted. Protected listeners cannot be blocked by another
listener's stopImmediatePropagation.

Transfers use prepare/commit/rollback ownership. The clone graph is serialized
before trailing host-state snapshots, so getter-triggered aborts and cyclic
reasons survive. Sender subscriptions detach on abort, collection, rollback,
or peer close. Receiver ports are unreferenced; observed signals, composite
dependencies, and forwarding chains remain live, while discarded unobserved
receivers can close their channels. DOMException reasons retain their brand,
name, message, and stack.

The runtime smoke exercised same-thread clones, MessagePorts, workerData,
bidirectional worker delivery, rollback, repeated transfers, cyclic reasons,
forwarding across GC, and collected-resource cleanup. The corrected fixture
also passes Node 24.22.2. Runtime-only cleanup additionally passed closed-peer,
discarded-receiver, and worker-termination cases. Node retained a sender abort
listener after delivery into a closed peer in the reference probe; removing
that subscription is an intentional ownership improvement, not a parity claim.

Reusable candidates are weak-resource cancellation subscriptions and
transferable cancellation leases with explicit transactional ownership.
WeakRef/finalizer timing must not be treated as deterministic disposal.
Cross-isolate messages must contain serialized data, never another isolate's
heap references. Existing native ports and engine GC hooks were sufficient;
Node Event, DOMException, and transfer-list error shapes remain runtime policy.

## REPL domains and test-mock lifecycle

`ext/node/repl.js` binds evaluation to an owned or supplied Domain. Runtime
throws, async callbacks, promise rejection, syntax failures, and custom-eval
failures reach the appropriate domain without confusing falsy thrown values
with successful callback results. Recoverable input stays buffered, custom
writers render errors, explicit _error assignments survive, and evaluations
recover after an error. The REPL rejects uncaughtException registration from
its evaluation domain while allowing unrelated callers.

`tests/repl-domain-smoke.cjs` passes on Node 24.22.2 and the runtime, including
two-server isolation and async-domain cleanup. The actual terminal SIGINT
smoke also passed after this integration. Inspector previews remain separate
and unfinished. Domain policy is Node-specific; the reusable cancellation and
async-resource ownership mechanisms are discussed above.

`ext/node/internal/test_runner/mock.js`, `mock_timers.js`, and the loader's mock
registry implement scoped method/accessor restoration, recursive and
constructor calls, promise timers, cancellation, interval disposal, and
versioned CJS/ESM/builtin module replacement. The runtime exercised disabled
and enabled module-mock modes and test-local restoration; the corrected
consumer fixture passes Node 24.22.2. Node's mocked timer functions do not
retain the custom util.promisify hook; the runtime does not add that extension.
These are Node testing contracts, not proposed Silk stdlib APIs.

Ordinary ESM bytecode now retains its actual ModuleDef owner before diagnostic
filenames become file URLs. The source-map smoke verifies import.meta identity
and relative dynamic import resolution, both normally and with source maps
enabled. Presentation metadata must not replace execution identity; this
belongs in SilkJS's embedding ownership contract, not its source-map parser.

## Persistent bytecode cache publication and transactional decode

`ext/node/internal/compile_cache.js` and `src/ext/module_cache.silk` implement
Node's module-cache controls using actual SilkJS CJS/ESM bytecode. Keys include
source, compilation kind/options, compiler/runtime identity, and portable or
absolute module identity. Writes are staged and published by a same-filesystem
rename from a unique temporary directory. Cache I/O failure falls back to
compilation; malformed input is never treated as executable merely because
its outer digest matches.

The separate runtime envelope restores source/source-map metadata and fresh
script IDs. Module owners, filenames, import resolution, and host callbacks
are relocated before execution. SilkJS's validated reader now keeps module
graph publication transactional: validation failure rolls back the decoded
graph rather than exposing partially admitted modules.

`tests/module-compile-cache-smoke.cjs` passed on the runtime and Node 24.22.2
for public contracts. Its runtime-only warm-cache witnesses alter serialized
string constants and recompute the envelope digest while retaining source
identity, proving that CJS and ESM execute deserialized bytecode. The fixture
also exercised corruption fallback, invalidation, portable relocation,
concurrent writers, I/O failure, synthetic filenames, and fresh-process
diagnostics. The existing VM cache smoke passed after this decoder change.

The pinned QuickJS interoperability run then passed 173 cross-read/write and
execution records, 6,606 malformed/truncated boundaries, 28 executable-safety
boundaries, two ROM/atom-relocation cases, and 331 native allocation-failure
cases with zero native ownership ledgers. The oracle still reports its own
previously identified allocation-failure leaks, graph changes, and crashes;
those are not SilkJS success claims or behavior to reproduce.

Reusable stdlib candidates: race-safe temporary-file/directory ownership,
atomic same-filesystem publication, and transactional graph construction
with rollback before registry insertion. Cache keys, Node status codes,
portable module identities, bytecode validation, and engine metadata belong
to the runtime or SilkJS rather than a general-purpose filesystem API.

## Startup option ownership and asynchronous error policy

`ext/node/internal/options.js` derives allowedNodeEnvironmentFlags from the
implemented environment-option registry. The exposed Set preserves Node's
lookup normalization and ineffective ordinary mutators; CLI-only module-mock
flags are excluded. Node-owned boolean flags ignore an attached value, even
`=false`; V8-style expose-gc flags reject attached values. Public execArgv
retains the supplied spelling.

`startup_controls.js` and `rejections.js` implement warning selection,
redirection, real stack traces/constructor exclusion, deprecation controls,
all five rejection modes, exception monitors/capture callbacks, and late
rejection handling. The startup smoke passed on Node 24.22.2 and the runtime,
including worker/fork inheritance, environment precedence, and exit status.
An actual async loader hook also observed enabled mock.module in its worker;
the same reference probe passed Node. REPL domain and real terminal SIGINT
smokes passed after integration.

These option names, warning formats, and rejection routing rules are Node
policy, not stdlib candidates. Their reusable foundations are existing
owner-thread scheduling, cancellation-safe resource leases, and native
diagnostic frames; no additional stdlib upstream change was needed.

## Native addon value ownership and ABI boundaries

`src/ext/napi_core.silk`, `napi_values.silk`, `napi_async.silk`, and
`napi_native.silk` implement Node-API value handles over real SilkJS values.
They are written in Silk with no C glue: the library registry and the
per-thread fatal report contexts that `napi_module_register` and
`napi_fatal_error` need without an environment live behind
`Intrinsic.processWord`, and addons resolve the `export "C"` entry points
against the executable through `--export-dynamic` (`-export_dynamic` on
Darwin).
Handle scopes own retained values; escaping transfers a retained owner to the
parent scope. Strong and weak references use the engine's actual ownership
and weak-liveness primitives. Native callbacks, classes, external buffers,
and finalizers keep their environment and allocator association.

Compiled addon consumers passed on the runtime for strings, BigInts, dates,
symbols, property operations, classes, buffers, deferred values, and original
exception identity. Scope/reference/reload consumers passed with and without
exposed GC, including four separate worker environments. The corresponding
value and lifetime consumers also passed Node 24.22.2. The binary exports the
155 stable Node-API entrypoints in the pinned API-10 header inventory; export
presence is not proof of every entrypoint's semantics.

The reusable stdlib candidate is a scoped foreign-handle arena with explicit
escape/weak ownership and owner-thread callback dispatch. Node's ABI names,
status codes, environment version negotiation, and V8-addon rejection remain
runtime policy. Callback arenas must survive reentry without borrowing a
movable host value; finalizers must run before unloading native code and must
not call JavaScript after isolate shutdown.

## Unicode-versioned IDNA tables

The URL implementation now uses the Unicode 17 data from `tr46` 6.0.0,
matching the pinned Node 24 binary. Its algorithm, status map, and license
are byte-identical to the previous 5.1.1 inputs; only generated mapping and
validation tables changed. Exact source commit and npm integrity are recorded
in `ext/web/vendor/provenance.json`.

Differential URL/encoding and IDNA boundary consumers passed for newly
assigned U+11DB0/U+1E6C0 hosts, an adjacent unassigned character, fullwidth
mapping, joiners, and leading combining characters. For a future stdlib
Unicode/IDNA API, versioned generated data and scalar-validity boundaries are
reusable; Node URL diagnostics and domainToASCII/domainToUnicode coercion
policy are not. Do not update tables independently of the target Unicode
version: `tr46` 7.0.0 contains Unicode 18, not the required Unicode 17.

## Owner-thread diagnostic transport

`src/ext/inspector_transport.c` supplies a bounded, byte-only HTTP/WebSocket
transport on a private I/O thread. JavaScript values never cross that thread;
the isolate consumes owned packets and sends owned response bytes. The wake
handle must outlive server stop/join. `src/ext/diagnostics_hub.silk` supplies
the isolate-addressed native mailbox used by inspector and profile requests. It
lives in the worker registry, so its lock and the group's `changed` condition
guard every queue; packets and published reports are allocated from the
group's resources because another isolate frees them.

Worker registration in that mailbox precedes JavaScript bootstrap readiness.
Inspector polling leaves incoming packets transport-owned until the isolate
installs its dispatcher. Workers install it only after startup permissions and
options are initialized, setting the debugger-wait state before registration.
This preserves early parent attachment requests and prevents a queued resume
from being overwritten by a later startup wait. Main-thread registration remains
eager; the existing inspector smoke covers auto-wait attachment, pre-entry
evaluation, resume, and attachment without waiting.

The reusable stdlib candidates are bounded message queues with explicit packet
ownership, shutdown-safe wake handles, and incremental WebSocket framing.
DevTools methods, discovery metadata, inspector permission checks, and Node
session routing remain runtime policy. Host/Origin admission is an explicit
server policy rather than a universal WebSocket default.

The standalone native server passed `tests/inspector-transport-smoke.py
--transport-only`: discovery, hostile Host/Origin rejection, unknown endpoints,
masking and continuation validation, control-frame rules, UTF-8 validation,
close codes, ping, and close. This verifies transport only; it does not claim
integrated debugger, frame evaluation, or cross-worker session correctness.

## Debugger evaluation ownership and effect boundaries

The native debugger execution consumer passed against the real compiler and VM:
lexical reads/writes, TDZ and shadowing, caller frames, arrow `this`, closures
escaping a pause, generators and async continuations, stepping, exception stops,
late attachment, busy-loop interruption, and restricted evaluation. Runtime
destruction returned the allocation ledger to zero. The regression harness is
`../silkjs/src/js_debugger_tests.silk`; runtime cache/inspector integration is
verified separately and is not implied by this engine result.

Restricted evaluation rejects getters, proxy traps, native calls, writes to
preexisting storage, and effectful coercions before execution. Direct `eval`
uses the same guarded dynamic-scope property operations; allowing those reads
does not allow dynamic-scope writes. Successful temporary values retain their
ordinary engine ownership, and the caller's pending exception is preserved.

The reusable stdlib pieces are scoped ownership transfer and bounded,
cancellation-aware owner-thread request delivery. Lexical-environment layout,
bytecode safepoints, and the JavaScript effect policy belong in SilkJS, not
Silk's standard library.

## Native async work and thread teardown

The compiled Node-API consumer now passes on the integrated runtime for actual
libuv work/cancellation, bounded thread-safe queues, native producer threads,
abort disposal, callback scopes, AsyncLocalStorage restoration, and cleanup.
Normal and unreferenced teardown both produced cleanup order `B`,
`async-start`, `A`, `async-end`. Two concurrent workers completed actual native
work and 128 native-thread callbacks each; another worker exited with an
unreferenced producer queue and joined it without dispatching into dead JS.
The same worker scenario passed Node 24.22.2.

Fatal-exception consumers verified original exception identity for a registered
handler and worker-only failure with a surviving parent on both engines.
This is `napi_fatal_exception`, not the process-aborting `napi_fatal_error`
diagnostic-report path.

Reusable stdlib candidates: bounded owner-thread delivery with explicit
queued/running/closing states, cancellation that reports whether work actually
started, reference-aware loop keepalive, and asynchronous shutdown barriers.
Node async-resource IDs and callback-scope AsyncLocalStorage rules remain Node
policy. A producer's lifetime must outlive queued disposal and join before its
native code or isolate allocator is released.

## Observational profiling and fatal diagnostics evidence

`../silkjs/src/js_profiles_tests.silk` now passes actual CPU, allocation, and
heap-graph consumers with a zero-allocation ledger after teardown. The graph
consumer checks strong/weak/ephemeron relationships, real rope children, and
noninvocation of getters. A failed consumer must release fixture roots before
destroying its runtime; otherwise the shutdown ownership assertion hides the
original failure.

Reusable candidates are a bounded allocation/reclamation journal with stable
IDs, a monotonic sample recorder with copied stack attribution, and read-only
graph visitor utilities. These do not imply V8's GC spaces or memory limits.
Running operand-stack extents and opaque native payloads remain explicitly
unavailable where the engine cannot safely observe them.

The integrated fatal-report consumer passed real `napi_fatal_error` failures
in main and worker contexts and the disabled-report case. Its allocation-safe
native writer reports actual process/thread identity and resource usage,
while explicitly omitting heap data that cannot safely be collected. The
RuntimeAllocator failure hook is connected, but this consumer did not force
system-allocator exhaustion; it exercised the native fatal API boundary.
Preallocated failure-report buffers and allocation-free output are stdlib
candidates; Node report JSON fields and configuration inheritance are not.

## Guarded VM previews and debugger cache restoration

The integrated PTY consumer passes for both private-context and `useGlobal`
REPLs: expression previews, mutation/getter/proxy guards, cursor navigation,
domain isolation, and SIGINT recovery. Restricted VM-global reads use an
explicit trusted host opt-in with a fail-closed default, walking current
ordinary descriptors without invoking JavaScript handlers or copying globals.
The sandbox and backing-global identities remain live; accessor, proxy,
custom-exotic, and lazy-initialization boundaries remain guarded.

Fresh-process VM cache consumers now also preserve debugger statements and
paused lexical writes. Cache binding validation checks captured-slot uniqueness,
all link bounds, and the ancestry/order of chains reachable from scope heads.
Synthetic eval bindings are appended after compiler scope linking; their unused
default links are not executable chains and must not reject valid caches.
This distinction is compiler metadata policy, not a stdlib concern.

Reusable stdlib candidates are explicit opt-in observer capabilities and
bounded graph validation with a reused visited bitmap. The JavaScript property
rules, lexical scope encoding, and debugger cache envelope belong in SilkJS
and the runtime. Neither passing consumer establishes compatibility with V8
bytecode or permits getters during observation.

## Native snapshot encoding and owner-thread delivery

`src/ext/profile_heap_json.silk` emits the complete native graph directly in
DevTools format. Compact `silk.heap.snapshot` v2 metadata preserves edge
strengths, ephemeron conditions, native-byte attribution, backing allocations,
and unavailable observations without duplicating all nodes and edges.
The native consumer reconstructs every original graph field, checks exact
numeric-ID boundaries, makes no guest allocations while observing/encoding,
and finishes with a zero allocation ledger.

The worker consumer passes actual CPU/allocation recording, snapshots, and
lifecycle requests while its guest event loop remains busy. The measured
snapshot fell from 110.25 MB to 16.94 MB; consumer parsing fell from roughly
7.95 seconds to 0.73 seconds after removing the raw-JSON parse/project/stringify
roundtrip. These are local diagnostic measurements, not portable benchmarks.
The public `node:v8` consumer also passes native reachability queries, snapshots,
file errors, Promise hooks including snapshot reentry, and CPU profiling.

Reusable stdlib candidates: borrowed-key interning, stable adjacency indexes,
bounded owned-byte request/reply packets, and checked JSON integer encoding.
DevTools schemas and Node heap-profiler commands remain runtime policy. A
native worker returns owned bytes; no receiving thread walks its live JS heap.

## Permission-aware loader probes and platform errors

The expanded 34-case permission matrix passes on Node 24.22.2 and the runtime.
Node deliberately permits metadata-only module existence probes, but checks
package metadata and actual source reads separately. The runtime captures an
unwrapped stat function only for its private loader capability; public stat,
file reads, and private-module import boundaries remain guarded.

The model retains Node's documented limits, including symlink-target behavior,
SQLite I/O limitations, and unrestricted networking. It is not a stronger
security sandbox. A reusable stdlib capability could distinguish metadata
observation from content access; Node search precedence and audit semantics
must remain outside the stdlib.

Platform error names now come from the actual libuv error map instead of a
partial hand-written table. The watch/run consumer verifies restart, dependency
tracking, signal forwarding, and child teardown, including `ESRCH` after exit.
Portable errno translation and owned child-process shutdown are stdlib
candidates; package-script environment and Node CLI flags are not.

## Test execution and coverage evidence

The execution/coverage consumer passes against both Node 24 and the runtime:
process/non-process isolation, concurrency and ordered reporting, filtered
versus explicitly skipped tests, selected descendants, cancellation cleanup,
actual executed/unexecuted functions and lines, aggregate coverage ordering,
threshold failure, and lcov output. Process-isolated file summaries precede the
final aggregate coverage/summary pair; they are not interchangeable events.

Reusable primitives are cancellation scopes with completion barriers and
stable ordered event delivery from concurrent owners. Test filtering, reporter
schemas, coverage thresholds, and bytecode/source attribution are runner or
engine policy, not general stdlib facilities.

## Positioned rope traversal and linear range copying

SilkJS `src/js_string_rope.silk` now provides `RopeIterator.makeAt` for
code-unit iteration from an explicit UTF-16 position. It skips complete
subtrees without allocating, preserves the pending traversal stack, and
positions inside the selected leaf. An end position produces an empty
iterator. The source must remain alive throughout traversal, as with the
existing iterator; this does not create an additional owning string.

`StringBuilder.appendRange` in `src/js_strings.silk` uses that position for
both width discovery and copying. Previously each range scanned from the
beginning, making repeated fixed-size slices quadratic. This mattered to
inspector heap-snapshot delivery, but the correction is a general string
operation rather than a profiling-specific workaround.

The exercised runtime consumer copies consecutive 64 KiB chunks:

| Input | Before | After |
| --- | ---: | ---: |
| 1 MiB | 54.185 ms | 12.077 ms |
| 2 MiB | 196.057 ms | 24.146 ms |
| 4 MiB | 747.582 ms | 48.492 ms |

These are local measurements, not cross-platform performance guarantees.
Ten native string tests passed, including ownership, allocation failure,
aliasing, late rope boundaries, narrow output after a wide prefix, and
surrogate boundaries. The independent pinned QuickJS C oracle also passed
135,023 string records after the change.

A stdlib upstream candidate is allocation-free positioned traversal with
explicit byte/code-unit/leaf coordinates and preserved source ownership.
QuickJS string representations, UTF-16 narrowing policy, and inspector
transport chunk sizes remain engine/runtime responsibilities.

## Independent channel liveness and delivery state

`src/ext/worker_native.silk` now counts an open, explicitly referenced
MessagePort as live even before message delivery starts. Previously the
native pending-work predicate required both `started` and `referenced`;
`parentPort.ref()` could therefore report a reference while the worker exited.
The Node 24 oracle keeps an unstarted referenced port alive, and the new
`message-port-ref-before-start` differential case now passes in the runtime.
The inspector worker-to-main Session consumer also passes with explicit
ownership of its pending work.

The stdlib candidate is a channel/async-handle contract that separates
delivery activation, event-loop liveness, object reachability, and close
state. Starting delivery must not be an undocumented prerequisite for a
reference to hold the loop. Node's automatic message-listener ref/unref
policy remains runtime policy.

## Debug metadata must not manufacture ownership

Debugger compilation previously enabled the compiler's direct-eval path
synthetically. That captured otherwise-unused lexical ancestors into
escaping functions, so an unresolved Promise reaction retained the target
of a WeakRef and prevented `util.aborted` resource cleanup.

SilkJS now prepares debugger bindings for the current activation separately
from genuine source-level direct-eval captures. Actual source captures and
debugger-created escaping cells retain their values; unused expired outer
bindings do not acquire new strong edges merely to make them inspectable.
Native debugger ownership regressions and the runtime's abort-transfer
cleanup consumer both pass.

This is an engine/compiler invariant, not a proposed stdlib debugger API.
The reusable design constraint for diagnostic observers is that observing
state must not silently change the ownership graph or prolong unrelated
resource lifetimes.

## Source-coordinate cache ownership

SilkJS `src/js_compiler_finish.silk` reuses the parser-owned ECMAScript
coordinate cache when assembling debugger locations. Creating a new cursor
for each function rescanned overlapping source prefixes, adding substantial
work to every process startup. Standalone compiler consumers without a
shared cache retain a local fallback; no additional allocation is required.

The original differential deadline remains 15 seconds. An instrumented
`node-options-precedence-and-rejection` run showed:

| Coordinate-cache behavior | Outer scenario | Completed child processes |
| --- | ---: | ---: |
| Fresh cursor per function | Timed out at 15.006 s | 4 of 6 |
| Compilation-tree cursor reuse | Completed in 10.195 s | 6 of 6 |

Both previously failing nested CLI scenarios now pass without changing their
deadlines. These are local measurements, not platform-wide timing guarantees.
The coordinate tests, native debugger ownership consumer, and independent
QuickJS binary-object oracle passed after the change.

The reusable primitive is a reversible source-position cursor with explicit
ownership of its immutable source and a fixed coordinate policy. UTF-8 byte
offsets, ECMAScript UTF-16 columns/all line terminators, and legacy QuickJS
scalar/LF coordinates must not be mixed through one cache.

## Owner-thread debugger control and source-level steps

The inspector's actual WebSocket consumer now exercises startup waiting,
source breakpoints, live lexical reads/writes, step into/over/out, same-line
statement steps, and resume. Native control delivery permits nested pumping
only while the engine is paused and not performing restricted/internal
evaluation; unrestricted user evaluation remains debugger-visible.

SilkJS records parser-authored statement/return boundaries separately from
instruction locations. Stepping no longer stops merely because an argument
load has a different column, while explicit instruction breakpoints remain
available. Those markers survive compiler rewrites and the v3 debugger
sidecar. The default QuickJS wire golden remains unchanged, verified against
the pinned C implementation.

Reusable stdlib candidates are owner-thread mailboxes, wake handles, and
cancellable paused-owner loops. Script IDs, lexical-frame representation,
CDP messages, and source-step classification belong to the engine/runtime.

## SIGINT tracing without signal-handler allocation

`src/ext/sigint_trace.silk` integrates the native signal broker with an
owner-thread interrupt hook in `src/ext/process_native.silk`. The observer
is unreferenced, so enabling tracing alone does not keep the loop alive.
Busy JavaScript is interrupted at an engine safe point; tracing prints
actual frames without calling JavaScript stack formatters, then unregisters
and re-raises SIGINT to preserve normal termination.

The Node 24 and runtime consumers both pass busy/idle stack attribution,
enable/disable, signal termination, listener policy, CLI/environment options,
and worker boundaries. SIGINT listeners suspend tracing; removing the last
listener restores it. Node's ten-frame limit, truthy/falsy API conversion,
worker rejection, and option inheritance remain compatibility policy.

The stdlib candidate is a scoped signal subscription that safely wakes its
owner, preserves/restores the previous disposition, and separates callback
lifetime from loop liveness. Raw signal handlers must not allocate, touch
another thread's heap, or invoke user code.

## Immutable dependency preparation

The engine was first consumed as a published revision of julia-script/silkjs,
downloaded and checked against a pinned archive SHA-256 by
`tools/prepare_silkjs.py`. Since the runtime moved into silk-lang/lib-silkjs
as `modules/runtime`, it builds the sibling `modules/engine` as a path
dependency, and `tools/prepare_silkjs.py` only checks that path.

Reusable Silk stdlib candidates are checksum-verified downloads, safe archive
extraction, canonical path handling, and atomic directory publication.
Repository allowlists, revision pinning, and build-cache identity are tooling
policy, not generic library defaults.

Final integration also exercised a native HTTP server backed by SQLite,
fetched its result, moved it through a distinct VM realm and a worker, and
observed the derived result and clean worker exit. The pinned-source build's
interactive REPL, compiled Node-API addon, TLS, and WebAssembly consumers
passed. Shared-broker VM/REPL SIGINT and Wasm interruption consumers passed
after signal tracing was integrated.
