import * as stdNamespace from 'silk:host/std';
import * as osNamespace from 'silk:host/os';

const rawStd = { ...stdNamespace };
const rawOS = { ...osNamespace };

const native = globalThis.__silkNative;
delete globalThis.__silkNative;
// Every exit path ends here. Node's exit handler stops and joins every worker
// before exit(): libc exit handlers (OpenSSL's cleanup among them) must not tear
// down shared native state while a worker thread still runs.
rawStd.exit = code => { native.workerNative('stopThreads', []); stdNamespace.exit(code); };
const factories = new Map();
const modules = new Map();
const realmSources = new Map();
const factoryGet = Map.prototype.get.bind(factories);
const factorySet = Map.prototype.set.bind(factories);
const factoryHas = Map.prototype.has.bind(factories);
const moduleGet = Map.prototype.get.bind(modules);
const moduleHas = Map.prototype.has.bind(modules);
const moduleSet = Map.prototype.set.bind(modules);
const moduleDelete = Map.prototype.delete.bind(modules);
const stringStartsWith = Function.prototype.call.bind(String.prototype.startsWith);
const promiseThen = Function.prototype.call.bind(Promise.prototype.then);
const promiseReject = Promise.reject.bind(Promise);
const stringEndsWith = Function.prototype.call.bind(String.prototype.endsWith);
const stringSlice = Function.prototype.call.bind(String.prototype.slice);
const stringIndexOf = Function.prototype.call.bind(String.prototype.indexOf);
const stringLastIndexOf = Function.prototype.call.bind(String.prototype.lastIndexOf);
const define = (name, factory) => {
  factories.set(name, factory);
  if (name === 'internal/error_stack' ||
      name === 'internal/web/wasm' || name.startsWith('internal/web/wasm/'))
    realmSources.set(name, factory);
};
// process.moduleLoadList: every built-in module this realm has run, in load order.
const moduleLoadList = [];
function internalRequire(request, parent = '') {
  if (stringStartsWith(request, 'node:')) request = stringSlice(request, 5);
  if (stringStartsWith(request, '.')) {
    let base = stringSlice(parent, 0, Math.max(0, stringLastIndexOf(parent, '/')));
    let start = 0;
    while (start <= request.length) {
      const separator = stringIndexOf(request, '/', start);
      const part = stringSlice(request, start, separator < 0 ? request.length : separator);
      if (part === '..') base = stringSlice(base, 0, Math.max(0, stringLastIndexOf(base, '/')));
      else if (part !== '.' && part) base += (base ? '/' : '') + part;
      if (separator < 0) break;
      start = separator + 1;
    }
    request = base;
  }
  if (stringEndsWith(request, '.js')) request = stringSlice(request, 0, -3);
  if (moduleHas(request)) return moduleGet(request).exports;
  let factory = factoryGet(request);
  if (factory === undefined) throw Object.assign(new Error('Unknown builtin: ' + request), { code: 'ERR_UNKNOWN_BUILTIN_MODULE' });
  const module = { exports: {} }; moduleSet(request, module);
  moduleLoadList.push('NativeModule ' + request);
  try {
    if (typeof factory === 'number') {
      factory = native.compileBuiltin(factory, 'node:' + request);
      factorySet(request, factory);
    }
    // Like Node's builtin wrapper, process is a parameter, so user code that
    // shadows or replaces the global process cannot change what built-ins see.
    factory(module, module.exports, name => internalRequire(name, request), process);
  }
  catch (error) { moduleDelete(request); throw error; }
  return module.exports;
}
for (let index = 0, count = native.builtinCount(); index < count; index++) define(native.builtinName(index), index);
// tools/build.py runs the freshly linked executable once this way to get the
// built-ins' bytecode, which it then links in. Nothing else of the runtime is up yet.
if (native.argv.length === 2 && native.argv[1] === '--silk-write-builtin-cache') rawStd.exit(native.writeBuiltinCache() ? 0 : 1);

for (const name of ['dispose', 'asyncDispose']) {
  if (Symbol[name] === undefined) Object.defineProperty(Symbol, name, { value: Symbol.for('nodejs.' + name) });
}
const host = { ...native, rawOS, rawStd };
// Startup snapshots: what Node keeps in internalBinding('mksnapshot') for
// internal/v8/startup_snapshot. With --build-snapshot (native.snapshotBuild) the
// heap is saved as the blob when the loop ends; a start from the blob runs
// runSnapshot instead of run.
const snapshotState = { building: native.snapshotBuild === true, codeCache: true, serialize: undefined, deserialize: undefined, main: undefined };
host.startupSnapshot = {
  isBuildingSnapshotBuffer: new Uint8Array([native.snapshotBuild ? 1 : 0]),
  setSerializeCallback(callback) { snapshotState.serialize = callback; },
  setDeserializeCallback(callback) { snapshotState.deserialize = callback; },
  setDeserializeMainFunction(callback) { snapshotState.main = callback; },
};
// Throws value again and keeps the throw site its first throw recorded, as
// V8's TryCatch::ReThrow does for Node's own catch and rethrow paths.
host.rethrow = value => { native.captureCallSites(-5, value); };
host.builtinLoaded = moduleHas;
// Whether a built-in id (public or internal) exists, loaded or not: Node's BuiltinModule.exists.
host.builtinExists = Map.prototype.has.bind(factories);
// Source maps are off until something loads the module to switch them on, so
// registering a source before that only matters when coverage wants every map.
host.registerSource = (filename, source, metadata) => {
  if (!moduleHas('internal/source_maps') && !host.env.NODE_V8_COVERAGE) return undefined;
  return internalRequire('internal/source_maps').registerSource(filename, source, metadata);
};
// pathToFileURL(path).href for the plain absolute paths that need no escaping.
const plainPath = /^\/[A-Za-z0-9\/._~+@=,-]*$/;
const dotSegment = /\/\.\.?(?:\/|$)/;
const fileHref = path => host.platform !== 'win32' && plainPath.test(path) && !dotSegment.test(path)
  ? 'file://' + path : internalRequire('url').pathToFileURL(path).href;
const inspectorNativeOperations = Array.from({ length: 32 }, (_, index) => native['inspectorNative' + index]);
const reflectApply = Reflect.apply;
host.inspectorNative = (operation, ...args) => reflectApply(inspectorNativeOperations[operation], undefined, args);
host.inspectorEntry = wrapper => host.inspectorNative(15, wrapper);
host.typeScriptMode = 'strip';
// libm lgamma and erfc for the histogram statistics (internal/histogram_native).
host.lgamma = x => native.mathSpecial(0, x);
host.erfc = x => native.mathSpecial(1, x);
host.testCoverageStart = () => native.testCoverageNative(0);
host.testCoverageTake = () => native.testCoverageNative(1);
host.testCoverageStop = () => native.testCoverageNative(2);
host.processFeatures = {
  debug: native.debugBuild, uv: true, ipv6: true, inspector: true,
  openssl_is_boringssl: false, quic: false,
  tls: true, tls_alpn: true, tls_sni: true, tls_ocsp: false,
  cached_builtins: false,
  get require_module() { return !host.requireModuleDisabled; },
  get typescript() { return host.typeScriptMode; }
};
// Node's kFirstModuleParent: the module that first required a module, for require stacks.
host.kFirstModuleParent = Symbol('kFirstModuleParent');
define('internal/host', module => { module.exports = host; });
// Like Node's, process is an instance of a constructor named process whose
// prototype inherits from EventEmitter.prototype once events has loaded below.
// It exists before any built-in runs, since every one of them takes it.
const ProcessConstructor = { process: function () {} }.process;
const process = Object.create(ProcessConstructor.prototype);
internalRequire('internal/error_stack').install(globalThis);
// QuickJS's InternalError is no Node global; the engine still throws its errors.
delete globalThis.InternalError;
let warnedTransformTypes = false;
host.stripTypeScriptModuleTypes = (source, filename, sourceURL = filename) => {
  const transform = host.typeScriptMode === 'transform';
  if (transform && !warnedTransformTypes) {
    warnedTransformTypes = true;
    process.emitWarning('Transform Types is an experimental feature and might change at any time', 'ExperimentalWarning');
  }
  // --experimental-transform-types implies --enable-source-maps unless it is turned off.
  const mode = transform ? 'transform' : 'strip-only', sourceMap = transform && host.enableSourceMaps !== false;
  const strip = () => internalRequire('internal/typescript').stripTypeScriptModuleTypes(source, filename, mode, sourceMap, sourceURL);
  return moduleHas('internal/compile_cache') ? internalRequire('internal/compile_cache').transpile(source, filename, mode, sourceMap, strip) : strip();
};
// These ephemeron registries share brands without rooting other realms. Only
// internal factories receive the bridge; no registry is a VM global.
const wasmCallbacks = new WeakMap();
host.wasmRealmState = {
  records: new WeakMap(), wrappers: new WeakMap(), suspension: new WeakMap(),
  exceptionStacks: new WeakMap(), builtinTraps: new WeakSet(),
};
host.registerWasmRealm = (global, callbacks) => wasmCallbacks.set(global, callbacks);
host.rebindRealmBuiltins = (previous, global) => {
  const callbacks = wasmCallbacks.get(previous);
  wasmCallbacks.delete(previous);
  wasmCallbacks.set(global, callbacks);
};
const wasmResolver = global => wasmCallbacks.get(global);
native.wasmNative('register', wasmResolver);
// --disable-proto=delete|throw, for the main realm and each new one.
function disableProto(global) {
  const prototype = global.Object.prototype;
  if (host.disableProto === 'delete') delete prototype.__proto__;
  else if (host.disableProto === 'throw') {
    const thrower = function () {
      throw Object.assign(new Error('Accessing Object.prototype.__proto__ has been disallowed with --disable-proto=throw'), { code: 'ERR_PROTO_ACCESS' });
    };
    Object.defineProperty(prototype, '__proto__', { get: thrower, set: thrower, enumerable: false, configurable: true });
  }
}
host.initializeRealmBuiltins = (handle, global, wasmCodeGeneration, isolated = false) => {
  delete global.InternalError;
  if (host.disableProto !== undefined) disableProto(global);
  const cache = new Map();
  const bridge = {
    captureCallSites: native.captureCallSites,
    errorStackState: host.errorStackState,
    builtinLoaded: moduleHas,
    wasmNative: native.vmWasmNative(handle),
    wasmRealmState: host.wasmRealmState,
    wasmCodeGeneration,
    registerWasmRealm(_global, callbacks) {
      host.registerWasmRealm(native.vmGlobal(handle), callbacks);
    },
  };
  function load(name) {
    if (name === 'internal/host') return bridge;
    if (!realmSources.has(name)) return internalRequire(name);
    if (cache.has(name)) return cache.get(name).exports;
    const index = realmSources.get(name);
    if (typeof index !== 'number') throw new Error('Unknown realm builtin dependency: ' + name);
    const source = native.builtinSource(index);
    const module = { exports: {} };
    cache.set(name, module);
    const script = native.vmCompile('(' + source + ')', 'node:' + name, handle);
    const factory = native.vmRun(script, 0, false);
    factory(module, module.exports, load, process);
    return module.exports;
  }
  load('internal/error_stack').install(global, isolated);
  if (!host.jitless) Object.defineProperty(global, 'WebAssembly', {
    value: load('internal/web/wasm').WebAssembly, writable: true, configurable: true,
  });
};
const errnoNames = new Map(), errnoMessages = new Map();
{
  // QuickJS's std.Error exposes only a subset of POSIX errno constants.
  // Reuse the complete platform libuv table also used by node:util.
  const errors = native.utilErrorMap();
  for (let index = 0; index < errors.length; index += 3) {
    errnoNames.set(-errors[index], errors[index + 1]);
    errnoMessages.set(-errors[index], errors[index + 2]);
  }
}
function systemError(errno, syscall, path, dest) {
  const number = Math.abs(errno), code = errnoNames.get(number) || 'UNKNOWN';
  const message = errnoMessages.get(number) || rawStd.strerror(number);
  const error = new Error(code + ': ' + message + ', ' + syscall + (path === undefined ? '' : " '" + path + "'") +
    (dest === undefined ? '' : " -> '" + dest + "'"));
  Object.assign(error, { errno: -number, code, syscall });
  if (path !== undefined) error.path = path;
  if (dest !== undefined) error.dest = dest;
  return error;
}
// libc's text for an errno, as node's ErrnoException (api/exceptions.cc) words it.
host.strerror = number => rawStd.strerror(number);
function pair(result, syscall, path) { if (result[1] !== 0) throw systemError(result[1], syscall, path); return result[0]; }
// node_process_methods.cc Cwd: a uv_cwd UVException, worded for a removed directory.
host.cwd = () => {
  const result = rawOS.getcwd();
  if (result[1] === 0) return result[0];
  const error = systemError(result[1], 'uv_cwd');
  if (error.code === 'ENOENT') {
    error.message = 'ENOENT: process.cwd failed with error ' + (errnoMessages.get(2) || rawStd.strerror(2)) +
      ', the current working directory was likely removed without changing the working directory, uv_cwd';
  }
  throw error;
};
// Node's tryGetCwd (lib/internal/process/execution.js): getcwd fails once the
// directory is removed, so names fall back to the executable's directory.
host.tryGetCwd = () => { try { return host.cwd(); } catch { return host.path.dirname(process.execPath); } };
host.realpath = path => pair(rawOS.realpath(path), 'realpath', path);
function statResult(result, syscall, path) {
  const value = pair(result, syscall, path);
  value.isFile = () => (value.mode & 0o170000) === 0o100000;
  value.isDirectory = () => (value.mode & 0o170000) === 0o040000;
  return value;
}
host.stat = (path, follow = true) =>
  statResult((follow ? rawOS.stat : rawOS.lstat)(path), follow ? 'stat' : 'lstat', path);
// Node's resolver may probe existence without granting access to file contents.
const moduleStat = osNamespace.stat, moduleLstat = osNamespace.lstat;
// A path's file type bits, or 0 for a path that is not there: the resolver asks
// about many of those.
host.moduleType = (path, follow) => {
  const result = (follow ? moduleStat : moduleLstat)(path);
  if (result[1] === 0) return result[0].mode & 0o170000;
  const code = errnoNames.get(Math.abs(result[1]));
  if (code === 'ENOENT' || code === 'ENOTDIR') return 0;
  throw systemError(result[1], follow ? 'stat' : 'lstat', path);
};
// Built-ins read the environment where it lives: nothing of it is kept here.
const environmentHandler = {
  get(target, key) { return typeof key === 'string' ? rawStd.getenv(key) : undefined; },
  has(target, key) { return typeof key === 'string' && rawStd.getenv(key) !== undefined; },
  ownKeys() { return Object.keys(rawStd.getenviron()); },
  getOwnPropertyDescriptor(target, key) {
    const value = typeof key === 'string' ? rawStd.getenv(key) : undefined;
    if (value !== undefined) return { value, writable: true, enumerable: true, configurable: true };
  },
  set(target, key, value) { if (typeof key === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string'); rawStd.setenv(key, String(value)); return true; },
  deleteProperty(target, key) { if (typeof key === 'string') rawStd.unsetenv(key); return true; },
};
// A heap image is this bootstrap's result, saved at build time and started from
// by later processes (src/ext/heap_image.silk). Whatever the bootstrap takes from
// its process must be taken again by hydrate, below. While an image is built, the
// environment variables the bootstrap reads are noted, and seal refuses an image
// whose bootstrap read one that hydrate does not know.
const environmentRead = native.heapImage ? new Set() : undefined;
const notes = {
  get(target, key) { environmentRead.add(key); return target[key]; },
  has(target, key) { environmentRead.add(key); return key in target; },
  getOwnPropertyDescriptor(target, key) { environmentRead.add(key); return Reflect.getOwnPropertyDescriptor(target, key); },
  ownKeys(target) { environmentRead.add('*'); return Reflect.ownKeys(target); },
};
const noted = environment => new Proxy(environment, notes);
const startupEnvironmentValues = new Proxy(Object.create(null), environmentHandler);
host.env = environmentRead ? noted(startupEnvironmentValues) : startupEnvironmentValues;
// Built-ins that keep something of the process at load time refresh it here.
const hydrations = [];
host.onHydrate = refresh => { hydrations.push(refresh); };
const asyncHooks = internalRequire('async_hooks');
function resource(type, owner) { return asyncHooks._createResource(type, owner); }
const invokeScoped = asyncHooks._invoke;
const hidePromises = asyncHooks._hidePromises;
function invokeResource(scope, callback, receiver, args, destroy = true) {
  try { return invokeScoped(scope, invoke, callback, receiver, args); }
  finally { if (destroy) scope.emitDestroy(); }
}
host.invokeResource = invokeResource;
// Queues drain from a head index: Array.prototype.shift moves every element.
// ticks holds flat (callback, args, scope) triples.
const ticks = [];
let tickHead = 0;
const completions = [];
let completionHead = 0;
const ticksPending = () => ticks.length !== tickHead;
const completionsPending = () => completions.length !== completionHead;
// Compound native operations finish through promises, but their public
// callbacks are I/O completions, not microtasks. Dispatch them outside drainJobs.
host.enqueueIOCompletion = callback => completions.push(callback);
// Built-in modules publish to diagnostics channels through these, so a process that never
// loads diagnostics_channel pays one property read per publish site. No channel can have a
// subscriber before diagnostics_channel loads (it sets host.diagnosticsChannel): subscribing
// needs its exports, and the node.diagnostics_channel trace category loads it when enabled.
host.diagnostics = {
  publish(name, message) {
    const dc = host.diagnosticsChannel;
    if (dc !== undefined && dc.hasSubscribers(name)) dc.channel(name).publish(message);
  },
  // The tracing channel for name, or undefined when nothing observes any of its events.
  tracing(name) {
    const dc = host.diagnosticsChannel;
    if (dc === undefined) return undefined;
    const channels = dc.tracingChannel(name);
    return channels.hasSubscribers ? channels : undefined;
  },
};
host.nextTick = function nextTick(callback, ...args) {
  if (typeof callback !== 'function') throw new (internalRequire('internal/errors').codes.ERR_INVALID_ARG_TYPE)('callback', 'function', callback);
  ticks.push(callback, args, resource('TickObject'));
};
host.queueMicrotask = function queueMicrotask(callback) {
  checkCallback(callback);
  const scope = resource('Microtask');
  try { native.enqueueMicrotask(() => invokeResource(scope, callback, undefined, [])); }
  catch (error) { scope.emitDestroy(); throw error; }
};
globalThis.queueMicrotask = host.queueMicrotask;
function checkCallback(callback) {
  if (typeof callback !== 'function') throw new (internalRequire('internal/errors').codes.ERR_INVALID_ARG_TYPE)('callback', 'function', callback);
}
function invoke(callback, receiver, args) {
  try { return Reflect.apply(callback, receiver, args); }
  catch (error) { reportUncaught(error); }
}
function reportUncaught(error) {
  try {
    if (process.domain && internalRequire('domain')._handleException(error)) return;
    internalRequire('internal/startup_controls').handleUncaught(error, 'uncaughtException');
  } catch (next) {
    if (next === error || !workerThreads.isMainThread) throw next;
    exceptionInFatalHandler(next);
  }
}
host.triggerUncaughtException = reportUncaught;
// node_errors.cc AppendExceptionLine: a compile error carries its arrow,
// "<script>:<line>\n<source line>\n<caret>\n", which ReportFatalException prints
// in place of where the error was rethrown. prefix is the length of a wrapper
// that came before the source on its first line. decorateErrorStack puts the
// arrow into the stack itself and marks the error decorated: no arrow then.
host.errorArrows = new WeakMap();
host.decoratedErrors = new WeakSet();
host.attachArrow = (error, scriptName, source, prefix) => {
  if (!(error instanceof SyntaxError) || host.errorArrows.has(error) || !Number.isInteger(error.lineNumber)) return;
  const line = error.lineNumber;
  const text = String(source).split(/\r\n|[\n\r\u2028\u2029]/)[line - 1];
  if (text === undefined) return;
  const column = error.columnNumber - 1 - (line === 1 ? prefix : 0);
  let caret = '';
  if (column >= 0 && column < text.length) {
    for (let index = 0; index < column; index++) caret += text[index] === '\t' ? '\t' : ' ';
    caret += '^\n';
  }
  host.errorArrows.set(error, scriptName + ':' + line + '\n' + text + '\n' + caret);
};
// Runs a timer or immediate callback; true when it threw (and was reported).
function invokeReporting(callback, receiver, args) {
  try { Reflect.apply(callback, receiver, args); return false; }
  catch (error) { reportUncaught(error); return true; }
}
// A domain error handler or uncaughtException listener that throws ends the process
// with Node's kExceptionInFatalExceptionHandler status, without 'exit' listeners.
function exceptionInFatalHandler(error) {
  host.abortOnUncaughtException?.(error);
  let text;
  try { text = internalRequire('util').inspect(error); } catch { text = String(error); }
  try { internalRequire('fs').writeSync(2, text + '\n'); } catch {}
  rawStd.exit(7);
}
const rejections = new Map();
const reportedRejections = new WeakMap();
let nextRejectionId = 0;
function onRejection(promise, reason, handled) {
  if (handled) {
    rejections.delete(promise);
    const info = reportedRejections.get(promise);
    if (info) {
      reportedRejections.delete(promise);
      const warning = internalRequire('internal/rejections').handledWarning(info.id);
      host.nextTick(() => {
        if (!process.emit('rejectionHandled', promise)) process.emitWarning(warning);
      });
    }
  } else {
    rejections.set(promise, { reason, id: ++nextRejectionId, domain: process.domain, context: asyncHooks._captureContext() });
  }
}
function checkpoint() {
  do {
    while (true) {
      while (tickHead !== ticks.length) {
        const at = tickHead;
        const callback = ticks[at], args = ticks[at + 1], scope = ticks[at + 2];
        ticks[at] = ticks[at + 1] = ticks[at + 2] = undefined;
        tickHead = at + 3;
        invokeResource(scope, callback, undefined, args);
      }
      ticks.length = tickHead = 0;
      native.drainJobs();
      if (ticksPending()) continue;
      if (!completionsPending()) { completions.length = completionHead = 0; break; }
      const completion = completions[completionHead];
      completions[completionHead++] = undefined;
      completion();
    }
    while (rejections.size) {
      const pending = Array.from(rejections.keys());
      for (let index = 0; index < pending.length; index++) {
        const promise = pending[index];
        if (!rejections.has(promise)) continue;
        const info = rejections.get(promise);
        const { context } = info;
        rejections.delete(promise);
        reportedRejections.set(promise, info);
        const previous = asyncHooks._captureContext();
        host.setAsyncContext(context);
        try {
          internalRequire('internal/rejections').handle(promise, info, invoke);
        } finally { host.setAsyncContext(previous); }
      }
    }
    asyncHooks._drainDestroy();
    // Listeners and destroy hooks may themselves queue promises or next ticks.
    // These must settle before testing loop liveness or emitting beforeExit.
    if (!ticksPending()) native.drainJobs();
  } while (ticksPending() || rejections.size || completionsPending());
}
host.checkpoint = checkpoint;
// Node's lib/timers.js and lib/internal/timers.js run the timers; the loop
// drives them through internal/timers_binding as Node's Environment does.
// Named, as Node's timer frames are: the REPL trims an error's frames below the
// last one without a function name.
host.invokeTimer = function invokeTimer(scope, callback, receiver, args) { return invokeScoped(scope, invokeReporting, callback, receiver, args); };
const timerAPI = internalRequire('timers');
{
  const { processImmediate, processTimers } = internalRequire('internal/timers').getTimerCallbacks(checkpoint);
  internalRequire('internal/timers_binding').setupTimers(processImmediate, processTimers);
}
const timerLoop = host.timerLoop;
for (const name of ['setTimeout', 'clearTimeout', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval']) globalThis[name] = timerAPI[name];
const Buffer = internalRequire('buffer').Buffer;
host.Buffer = Buffer;
// process and Buffer are accessors on Node's global object (the hook for an
// ESM deprecation path); assigning replaces the value the getter returns.
function defineGlobalAccessor(name, initial) {
  let current = initial;
  Object.defineProperty(globalThis, name, {
    get() { return current; }, set(value) { current = value; }, enumerable: false, configurable: true,
  });
}
defineGlobalAccessor('Buffer', Buffer);
globalThis.global = globalThis;
globalThis.atob = internalRequire('buffer').atob;
globalThis.btoa = internalRequire('buffer').btoa;
// Most files fit in one read into this buffer, which is then copied or decoded at
// the size read; larger files collect copies of it.
let readBuffer;
// Plain descriptor calls: open, reads until one returns 0, close.
function readInto(path, finish) {
  const fd = rawOS.open(path, rawOS.O_RDONLY);
  if (fd < 0) throw systemError(-fd, 'open', path);
  if (readBuffer === undefined) readBuffer = new Uint8Array(65536);
  // held bytes of readBuffer are read; a full buffer is copied out to chunks.
  let chunks = null, size = 0, held = 0;
  try {
    while (true) {
      if (held === readBuffer.length) { (chunks ??= []).push(readBuffer.slice()); held = 0; }
      const count = rawOS.read(fd, readBuffer.buffer, held, readBuffer.length - held);
      if (count < 0) {
        if (count === -4) continue; // EINTR
        throw systemError(-count, 'read', path);
      }
      if (count === 0) break;
      held += count;
      size += count;
    }
  } finally { rawOS.close(fd); }
  if (chunks === null) return finish(Buffer.from(readBuffer.buffer, 0, held));
  if (held !== 0) chunks.push(readBuffer.slice(0, held));
  return finish(Buffer.concat(chunks, size));
}
const copyBytes = bytes => bytes.buffer === readBuffer.buffer ? Buffer.from(bytes) : bytes;
const decodeBytes = bytes => bytes.toString('utf8');
host.readFile = path => readInto(path, copyBytes);
host.readText = path => readInto(path, decodeBytes);
function output(fd) {
  return { fd, isTTY: !!rawOS.isatty(fd), writable: true, write(chunk, encoding, callback) {
    if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk;
    if (!(bytes instanceof Uint8Array)) throw new TypeError('chunk must be a string or Uint8Array');
    let offset = 0;
    while (offset < bytes.length) {
      const count = rawOS.write(fd, bytes.buffer, bytes.byteOffset + offset, bytes.length - offset);
      if (count < 0) throw systemError(count, 'write');
      if (count === 0) throw systemError(5, 'write');
      offset += count;
    }
    if (callback) host.nextTick(callback);
    return true;
  } };
}
host.stdout = output(1); host.stderr = output(2);
// Text written to a descriptor now, with no stream (internal/stdio direct):
// true when all of it was written, false when none of it was, and the bytes
// left over when a write stopped part way (a full nonblocking pipe, or an error).
host.writeText = (fd, text) => {
  const bytes = Buffer.from(text);
  let offset = 0;
  while (offset < bytes.length) {
    const count = rawOS.write(fd, bytes.buffer, bytes.byteOffset + offset, bytes.length - offset);
    if (count <= 0) return offset === 0 ? false : bytes.subarray(offset);
    offset += count;
  }
  return true;
};
host.writeStartupDiagnostic = host.stderr.write;
Object.assign(process, { platform: host.platform, env: host.env, nextTick: host.nextTick, emitWarning: value => host.stderr.write(String(value) + '\n') });
globalThis.process = process;
const EventEmitter = internalRequire('events');
Object.setPrototypeOf(ProcessConstructor.prototype, EventEmitter.prototype);
EventEmitter.call(process);
Object.defineProperty(process, Symbol.toStringTag, { enumerable: false, writable: true, configurable: false, value: 'process' });
defineGlobalAccessor('process', process);
let startTime = native.runtimeStartTime;
const performanceMilestones = {
  nodeStart: 0, v8Start: native.engineStartTime - startTime, environment: native.environmentTime - startTime,
  bootstrapComplete: -1, loopStart: -1, loopExit: -1,
};
// markBootstrapComplete of Node's internal/process/pre_execution, for main entries that prepare later.
host.markBootstrapComplete = () => { performanceMilestones.bootstrapComplete = native.now() - startTime; };
let initialNativeIdleTime = 0;
const loopListeners = new Set();
host.performanceStartTime = startTime;
host.performanceTimeOrigin = Date.now() - (native.now() - startTime);
// A worker takes the process's clock, as Node: performance.timeOrigin, performance.now(),
// process.uptime() and the milestones count from when the process started.
host.adoptProcessClock = (processStart, processOrigin) => {
  const shift = startTime - processStart;
  for (const name of ['v8Start', 'environment', 'bootstrapComplete', 'loopStart', 'loopExit']) {
    if (performanceMilestones[name] >= 0) performanceMilestones[name] += shift;
  }
  startTime = processStart;
  host.performanceStartTime = processStart;
  host.performanceTimeOrigin = processOrigin;
};
host.performanceLoopStats = () => {
  if (performanceMilestones.loopStart < 0) return { idle: 0, active: 0 };
  const idle = native.loopIdleTime() - initialNativeIdleTime;
  const end = performanceMilestones.loopExit < 0 ? native.now() - startTime : performanceMilestones.loopExit;
  return { idle, active: Math.max(0, end - performanceMilestones.loopStart - idle) };
};
host.performanceNodeTiming = () => ({ ...performanceMilestones, idleTime: host.performanceLoopStats().idle });
host.performanceAddLoopListener = callback => {
  loopListeners.add(callback);
  return () => loopListeners.delete(callback);
};
// The Node release whose API this runtime implements.
const nodeVersion = '24.22.1';
// Versions of what this binary runs and links, as Node reports its own: node
// first, the rest by name. The libraries answer for themselves; the bundled
// JavaScript and vendored C sources carry the version of their pinned copy.
function componentVersions() {
  const [uv, openssl, zlib, brotli, zstd, nghttp2, sqlite] = native.osNative('componentVersions', []);
  const versions = {
    node: nodeVersion, acorn: '8.18.0', amaro: '1.1.11',
    brotli: `${brotli >>> 24}.${(brotli >>> 12) & 0xfff}.${brotli & 0xfff}`,
    llhttp: '9.4.3', napi: '10', nghttp2, openssl, quickjs: '2026-06-04', silkjsruntime: '0.1.0', sqlite,
    uv, uvwasi: '0.0.23', zlib, zstd,
  };
  if (zlib === undefined) delete versions.zlib;
  return versions;
}
// process.config describes the build the way Node's config.gypi does, for the
// variables code inspects to learn what the binary supports. Frozen like Node's.
function buildConfig() {
  const freeze = value => {
    if (value !== null && typeof value === 'object') { for (const key of Object.keys(value)) freeze(value[key]); Object.freeze(value); }
    return value;
  };
  return freeze({
    target_defaults: {
      cflags: [], default_configuration: native.debugBuild ? 'Debug' : 'Release', defines: [], include_dirs: [], libraries: [],
    },
    variables: {
      asan: 0, ubsan: 0, napi_build_version: '10', node_builtin_shareable_builtins: [], node_module_version: 137, node_shared: false,
      node_shared_openssl: false, node_shared_sqlite: false, node_shared_zstd: false, node_use_amaro: true,
      node_use_openssl: true, node_without_node_options: false, node_quic: false, shlib_suffix: host.platform === 'darwin' ? 'dylib' : 'so',
      single_executable_application: true, icu_small: false, v8_enable_i18n_support: 1, v8_enable_inspector: 1,
    },
  });
}
// What process.exit ends with; replaceable, as in Node. --trace-exit reports the stack
// above it and --heap-prof writes its profile here, as Node's reallyExit binding does.
function reallyExit(code) {
  if (moduleHas('internal/compile_cache')) internalRequire('internal/compile_cache').flushAtExit();
  internalRequire('internal/startup_controls').traceExit(code, 0, reallyExit);
  if (moduleHas('internal/heap_prof')) internalRequire('internal/heap_prof').finish();
  if (moduleHas('internal/profiler_binding')) internalRequire('internal/profiler_binding').finish();
  rawStd.exit(code);
}
// Node's process_methods binding: process.chdir and process.cwd call through
// it at each call, so a replaced method takes effect as in Node.
const processMethods = host.processMethods = {
  cwd: host.cwd,
  chdir(directory) {
    const code = rawOS.chdir(directory);
    // Node reports the directory it was in as the path and the target as dest.
    if (code < 0) throw systemError(code, 'chdir', host.cwd(), directory);
  },
};
Object.assign(process, {
  argv: native.argv.slice(), argv0: native.argv[0], execArgv: [], execPath: native.osNative('execPath', []),
  version: 'v' + nodeVersion, versions: componentVersions(), config: buildConfig(),
  platform: host.platform, arch: host.arch, env: host.env, pid: rawOS.getpid(),
  release: {
    name: 'node', lts: 'Krypton',
    sourceUrl: `https://nodejs.org/download/release/v${nodeVersion}/node-v${nodeVersion}.tar.gz`,
    headersUrl: `https://nodejs.org/download/release/v${nodeVersion}/node-v${nodeVersion}-headers.tar.gz`,
  }, stdout: host.stdout, stderr: host.stderr,
  cwd() { return processMethods.cwd(); },
  chdir(directory) {
    internalRequire('internal/validators').validateString(directory, 'directory');
    processMethods.chdir(directory);
  },
  nextTick: host.nextTick, uptime: () => (native.now() - startTime) / 1000,
  hrtime(previous) { const nanoseconds = native.nowNanoseconds(); const value = [Number(nanoseconds / 1000000000n), Number(nanoseconds % 1000000000n)]; if (previous !== undefined) { if (!Array.isArray(previous)) throw new (internalRequire('internal/errors').codes.ERR_INVALID_ARG_TYPE)('time', 'Array', previous); if (previous.length !== 2) throw new (internalRequire('internal/errors').codes.ERR_OUT_OF_RANGE)('time', 2, previous.length); value[0] -= previous[0]; value[1] -= previous[1]; if (value[1] < 0) { value[0]--; value[1] += 1000000000; } } return value; },
  emitWarning: internalRequire('internal/startup_controls').emitWarning,
  setUncaughtExceptionCaptureCallback: internalRequire('internal/startup_controls').setUncaughtExceptionCaptureCallback,
  hasUncaughtExceptionCaptureCallback: internalRequire('internal/startup_controls').hasUncaughtExceptionCaptureCallback,
  exit(code) {
    if (code !== undefined) process.exitCode = code;
    if (!process._exiting) { process._exiting = true; process.emit('exit', Number(process.exitCode) || 0); }
    inspectorBackend._atExit();
    process.reallyExit(Number(process.exitCode) || 0);
  },
  // What process.exit ends with; replaceable, as in Node.
  reallyExit,
  kill(pid, signal) {
    if (pid != (pid | 0)) throw new (internalRequire('internal/errors').codes.ERR_INVALID_ARG_TYPE)('pid', 'number', pid);
    let number = signal;
    if (signal !== (signal | 0)) {
      signal ||= 'SIGTERM';
      number = internalRequire('os').constants.signals[signal];
      if (number === undefined) throw new (internalRequire('internal/errors').codes.ERR_UNKNOWN_SIGNAL)(signal);
    }
    const code = rawOS.kill(pid, number);
    if (code < 0) throw new (internalRequire('internal/errors').ErrnoException)(-Math.abs(code), 'kill');
    // SIGINT listeners hear it through the interrupt broker's thread: wait for it,
    // so a signal this process sent itself is seen in the next poll as in Node.
    if (number === 2) host.processNative('signalFlush', []);
    return true;
  },
  _fatalException: internalRequire('internal/startup_controls').fatalException,
  // node_binding.cc GetLinkedBinding: the addon permission names the module, then the embedder's
  // linked modules are searched. This runtime links none.
  _linkedBinding(module) {
    module = `${module}`;
    internalRequire('internal/permission').check('addon', module);
    throw Object.assign(new Error(`No such binding was linked: ${module}`), { code: 'ERR_INVALID_MODULE' });
  },
  // Formats like console.log and writes to fd 2 at once: no streams, ticks or console.
  _rawDebug(...args) { host.writeText(2, internalRequire('util').format(...args) + '\n'); },
});
// exitCode accepts an integer, a string holding one, undefined or null (Node's validation).
{
  let exitCode;
  Object.defineProperty(process, 'exitCode', {
    get() { return exitCode; },
    set(code) {
      if (code !== null && code !== undefined) {
        let value = code;
        if (typeof code === 'string' && code !== '' && Number.isInteger(+code)) value = +code;
        internalRequire('internal/validators').validateInteger(value, 'code');
      }
      exitCode = code;
    },
    enumerable: true, configurable: false,
  });
}
// node_process_object.cc DebugPortGetter/DebugPortSetter: the inspector port,
// stored as an Int32 and range checked (a C++ THROW_ERR_OUT_OF_RANGE).
{
  let debugPort = 9229;
  Object.defineProperty(process, 'debugPort', {
    get() { return debugPort; },
    set(value) {
      const port = value | 0;
      if ((port !== 0 && port < 1024) || port > 65535)
        throw Object.assign(new RangeError('process.debugPort must be 0 or in range 1024 to 65535'), { code: 'ERR_OUT_OF_RANGE' });
      debugPort = port;
    },
    enumerable: true, configurable: true,
  });
}
Object.defineProperty(process, 'config', { writable: false });
Object.defineProperty(process, 'allowedNodeEnvironmentFlags', {
  configurable: true, enumerable: true,
  get() {
    const value = internalRequire('internal/options').buildAllowedFlags();
    Object.defineProperty(this, 'allowedNodeEnvironmentFlags', { value, writable: true, enumerable: true, configurable: true });
    return value;
  },
  set(value) {
    Object.defineProperty(this, 'allowedNodeEnvironmentFlags', { value, writable: true, enumerable: true, configurable: true });
  },
});
process.hrtime.bigint = native.nowNanoseconds;
host.nativeResourceReport = () => native.resourceSnapshot().map(
  ([type, is_active, is_referenced, is_closing, address, fd]) => {
    const record = { type, is_active, is_referenced, is_closing, address };
    if (fd !== null) record.fd = fd;
    return record;
  });
host.activeResources = () => {
  const names = [];
  for (const row of native.resourceSnapshot())
    if ((row[7] ?? row[2]) && row[6] !== null) names.push(row[6]);
  // As node_process_methods.cc does: the referenced Timeouts, then the referenced Immediates.
  for (let count = timerLoop.timeoutInfo[0]; count > 0; count--) names.push('Timeout');
  for (let count = timerLoop.immediateInfo[1]; count > 0; count--) names.push('Immediate');
  names.push(...native.workerNative('activeResources', []));
  return names;
};
// lib/internal/async_hooks.js fatalError: the error's stack, or for a value
// without one, a stack captured here under "Error: <value>".
function asyncHookFatalText(error) {
  try {
    if (typeof error?.stack === 'string') return error.stack;
    const holder = {};
    Error.captureStackTrace(holder, host.asyncHookFatal);
    const lines = String(holder.stack).split('\n');
    lines[0] = `Error: ${String(error)}`;
    return lines.join('\n');
  } catch { return error; }
}
host.asyncHookFatal = error => {
  try { internalRequire('internal/process_report').onFatalError(error); }
  finally { native.asyncHookFatal(asyncHookFatalText(error)); }
};
internalRequire('internal/process_native').install(process);
Object.defineProperty(process, 'sourceMapsEnabled', {
  enumerable: true, configurable: true,
  get: () => internalRequire('internal/source_maps').getSourceMapsSupport().enabled,
});
process.setSourceMapsEnabled = function setSourceMapsEnabled(enabled) {
  internalRequire('internal/source_maps').setSourceMapsSupport(enabled, {
    nodeModules: enabled, generatedCode: enabled,
  });
};
process.moduleLoadList = moduleLoadList;
define('process', module => { module.exports = process; });
internalRequire('internal/napi').install(host, process);
const eventGlobals = internalRequire('internal/path_events/event_target');
for (const name of ['Event', 'CustomEvent', 'EventTarget', 'AbortController', 'AbortSignal', 'DOMException'])
  Object.defineProperty(globalThis, name, { value: eventGlobals[name], writable: true, enumerable: false, configurable: true });
const asyncFS = internalRequire('internal/fs_async')(native);
host.submitIO = (operation, args, callback, requestKind) => {
  const scope = resource(requestKind === 1 ? 'FSREQPROMISE' : requestKind === 2 ? 'FILEHANDLECLOSEREQ' : 'FSREQCALLBACK');
  hidePromises(1);
  try { return asyncFS.submitIO(operation, args, function oncomplete(...values) { return invokeResource(scope, callback, undefined, values); }, requestKind); }
  catch (error) { scope.emitDestroy(); throw error; }
  finally { hidePromises(-1); }
};
host.watch = (filename, options, callback) => {
  const scope = resource(options.stat ? 'STATWATCHER' : 'FSEVENTWRAP');
  let handle;
  try {
    handle = asyncFS.watch(filename, options, (...values) => {
      invokeResource(scope, callback, undefined, values, false);
      checkpoint();
    });
  } catch (error) { scope.emitDestroy(); throw error; }
  const close = handle.close;
  let closed = false;
  handle.close = () => {
    if (closed) return;
    closed = true;
    try { return close.call(handle); } finally { scope.emitDestroy(); }
  };
  return handle;
};
// Worker bootstrap decodes Wasm host objects through the realm's wrap callbacks.
Object.defineProperty(globalThis, 'WebAssembly', {
  value: internalRequire('internal/web/wasm').WebAssembly, writable: true, configurable: true,
});
const workerThreads = internalRequire('internal/worker');
const workerBootstrap = workerThreads._bootstrap();
if (workerThreads.isMainThread) {
  internalRequire('internal/process_signals').install(process);
  internalRequire('internal/stdio').install(process);
}
workerThreads._install(process, workerBootstrap);
const liveEnvironment = process.env;
if (environmentRead) process.env = noted(liveEnvironment);
if (workerThreads.isMainThread) internalRequire('internal/watch_mode/dependencies').initialize();
// The standard streams and console are built on first use: a script that
// prints nothing loads neither the stream stack nor the formatter.
for (const name of ['stdout', 'stderr']) Object.defineProperty(host, name, {
  enumerable: true, configurable: true,
  get: () => process[name],
  set(value) { Object.defineProperty(host, name, { value, writable: true, enumerable: true, configurable: true }); },
});
const webGlobals = internalRequire('internal/web/index');
webGlobals.install(globalThis);
webGlobals.defineLazy(globalThis, 'console', () => ({ console: internalRequire('console') }), false);
// Register the trusted dispatcher before preloads or any other guest code can
// connect to this isolate (including through a parent Worker inspector).
const inspectorBackend = internalRequire('internal/inspector');
webGlobals.defineLazy(globalThis, 'crypto', () => ({ crypto: internalRequire('crypto').webcrypto }), true);
for (const name of ['Crypto', 'SubtleCrypto', 'CryptoKey']) {
  Object.defineProperty(globalThis, name, {
    get() {
      const value = internalRequire('internal/crypto/webcrypto')[name];
      Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
      return value;
    },
    set(value) { Object.defineProperty(globalThis, name, { value, writable: true, configurable: true }); },
    configurable: true,
  });
}
{
  const loadPerformance = () => internalRequire('perf_hooks');
  for (const name of ['performance', 'Performance', 'PerformanceEntry', 'PerformanceMark', 'PerformanceMeasure', 'PerformanceObserver', 'PerformanceObserverEntryList', 'PerformanceResourceTiming'])
    webGlobals.defineLazy(globalThis, name, loadPerformance, name === 'performance');
}
host.path = internalRequire('path');
// Sorted, as Node lists builtinModules.
const publicBuiltinNames = [...factories.keys()].filter(name => !name.startsWith('internal/')).sort();
const publicBuiltinHas = Set.prototype.has.bind(new Set(publicBuiltinNames));
const prefixOnlyBuiltinHas = Set.prototype.has.bind(new Set(['test', 'test/reporters', 'sqlite', 'sea']));
const defineBuiltinName = Object.defineProperty;
function publicBuiltin(name) {
  if (!publicBuiltinHas(name)) return host.exposeInternals === true && exposedInternal(name);
  return (name !== 'stream/iter' && name !== 'zlib/iter') || host.experimentalStreamIter === true;
}
// With --expose-internals, Node's internal/* modules load like public ones
// (still left out of builtinModules). internal/host is the runtime's own
// privileged bridge, not a Node module, so it never is.
function exposedInternal(name) {
  return typeof name === 'string' && stringStartsWith(name, 'internal/') && name !== 'internal/host' && factoryHas(name);
}
// Modules of this runtime, which only their silk: names load.
const runtimeModules = { __proto__: null, 'silk:serve': 'internal/web/serve' };
const publicBuiltins = {
  has: name => runtimeModules[name] !== undefined || publicBuiltin(name),
  get: name => internalRequire(runtimeModules[name] ?? name),
  runtime: name => typeof name === 'string' && runtimeModules[name] !== undefined,
  // Whether names() lists name, without building the list.
  listed(name) {
    if (typeof name !== 'string') return false;
    if (runtimeModules[name] !== undefined) return true;
    if (stringStartsWith(name, 'node:')) {
      const bare = stringSlice(name, 5);
      return prefixOnlyBuiltinHas(bare) && publicBuiltin(bare);
    }
    return !prefixOnlyBuiltinHas(name) && publicBuiltin(name);
  },
  // The modules with a bare name first, then the node:-only ones, as Node lists them.
  names() {
    const names = [];
    for (let pass = 0; pass < 2; pass++) {
      for (let index = 0; index < publicBuiltinNames.length; index++) {
        const name = publicBuiltinNames[index];
        if (publicBuiltin(name) && prefixOnlyBuiltinHas(name) === (pass === 1)) defineBuiltinName(names, names.length, {
          value: pass === 1 ? 'node:' + name : name, enumerable: true, writable: true, configurable: true,
        });
      }
    }
    return names;
  }
};
host.awaitModuleHook = promise => {
  native.markPromiseAsHandled(promise);
  while (native.promiseState(promise) === 0) {
    checkpoint();
    pollWorkers();
    if (workerThreads._exitRequested)
      throw Object.assign(new Error('Loader worker exited while awaiting a hook'), { code: 'ERR_WORKER_NOT_RUNNING' });
    if (native.promiseState(promise) === 0) loopTurn(promise);
  }
  return native.promiseResult(promise);
};
host.loaderWorkerStatus = threadId => {
  const status = Number.isInteger(threadId) && threadId > 0 && threadId <= 0xffffffff
    ? native.workerNative('workerStatus', [threadId]) : null;
  if (status === null)
    throw Object.assign(new Error('Loader worker is not running'), { code: 'ERR_WORKER_NOT_RUNNING' });
  return status;
};
host.canReadModulePath = path => internalRequire('internal/permission').canRead(path);
host.checkModuleRead = path => internalRequire('internal/permission').check('fs.read', path);
const loader = internalRequire('internal/loader/loader').createLoader(host, publicBuiltins);
host.loader = loader;
host.vmCreateDefaultImporter = filename =>
  native.compileFunction('(specifier, attributes, source) => source ? import.source(specifier) : import(specifier, { with: attributes })', filename);
let builtinRequire;
process.getBuiltinModule = function getBuiltinModule(id) {
  internalRequire('internal/validators').validateString(id, 'id');
  if (!loader.Module.isBuiltin(id)) return undefined;
  builtinRequire ||= loader.requireFor('/[builtin]', undefined, false);
  return builtinRequire(id);
};
process.loadEnvFile = function loadEnvFile(path = undefined) { return internalRequire('internal/dotenv').loadEnvFile(path); };
// Like Node's initializeClusterWorker: a cluster worker joins its primary, then the variable is gone.
function setupClusterWorker() {
  internalRequire('cluster')._setupWorker();
  delete process.env.NODE_UNIQUE_ID;
}
if (workerThreads.isMainThread && process.env.NODE_UNIQUE_ID !== undefined) setupClusterWorker();
Object.defineProperty(globalThis, '__silkModuleBridge', { value: loader.bridge });
let mainModuleName;
let inspectorStartupArmed = false;
function armInspectorEntry() {
  if (inspectorStartupArmed || !host.inspectorOptions?.enabled || !host.inspectorOptions.breakFirst) return;
  inspectorStartupArmed = true;
  inspectorBackend._armStartup();
}
function evaluateMain(source, name) {
  mainModuleName = name;
  armInspectorEntry();
  // Node's ModuleJob.run hint for a CommonJS global (an --eval module has no load step
  // that would add it).
  let result;
  try { result = native.evaluateModule(source, name, true); }
  catch (cause) { throw loader.decorateModuleError(cause, name); }
  // As loader.runMain does for a file entry.
  return result instanceof Promise ? promiseThen(result, undefined, cause => { throw loader.decorateModuleError(cause, name); }) : result;
}
const requirePreloads = [], importPreloads = [], loaderPreloads = [];
function runPreloads(entry, loadImports = true, loadRequires = true) {
  if (host.configFile) process.emitWarning('--experimental-config-file is an experimental feature and might change at any time', 'ExperimentalWarning');
  // Before any preload: Node applies it when the context is made.
  if (host.disableProto !== undefined) disableProto(globalThis);
  if (host.disallowCodeGeneration) native.vmSetCodeGeneration(undefined, false);
  if (host.jitless) delete globalThis.WebAssembly;
  if (host.experimentalShadowRealm) internalRequire('internal/shadow_realm').enable();
  // --experimental-loader: each one is module.register(specifier, cwd) before any preload.
  if (loadImports && loaderPreloads.length) {
    const base = internalRequire('url').pathToFileURL(host.cwd() + host.path.sep).href;
    for (const specifier of loaderPreloads) loader.Module.register(specifier, base);
  }
  if (loadRequires) loader.Module._preloadModules(requirePreloads);
  if (host.frozenIntrinsics) {
    process.emitWarning('Frozen intristics is an experimental feature and might change at any time', 'ExperimentalWarning');
    internalRequire('internal/freeze_intrinsics')();
  }
  if (!loadImports || !importPreloads.length) return entry();
  const name = host.path.join(host.tryGetCwd(), '[preload]');
  let pending = Promise.resolve();
  for (const specifier of importPreloads) {
    pending = pending.then(() => native.compileFunction('import(' + JSON.stringify(specifier) + ')', name));
  }
  return pending.then(entry);
}
const optionFlag = entry => internalRequire('internal/options').optionFlag(entry);
function runtimeFlag(arg) {
  try {
    if (internalRequire('internal/permission').applyOption(arg) ||
        internalRequire('internal/startup_controls').applyOption(arg) ||
        internalRequire('internal/tls/options').applyOption(arg) ||
        internalRequire('internal/heap_prof').applyOption(arg) ||
        internalRequire('internal/options').applyInspectorOption(arg)) return true;
  }
  catch (error) { cliError(error.message); return true; }
  if (arg === '--enable-source-maps' || arg === '--no-enable-source-maps') {
    host.enableSourceMaps = arg === '--enable-source-maps'; return true;
  }
  if (arg === '--trace-sigint' || arg === '--no-trace-sigint') {
    host.traceSigint = arg === '--trace-sigint'; return true;
  }
  if (arg === '--experimental-repl-await' || arg === '--no-experimental-repl-await') {
    host.replAwait = arg === '--experimental-repl-await'; return true;
  }
  if ((arg.startsWith('--report-') || arg.startsWith('--no-report-') || arg === '--experimental-report') &&
      internalRequire('internal/process_report').applyOption(arg)) return true;
  if (['--strip-types', '--experimental-strip-types', '--no-strip-types', '--no-experimental-strip-types'].includes(arg)) {
    host.stripTypes = !arg.startsWith('--no-'); return true;
  }
  if (arg === '--experimental-transform-types' || arg === '--no-experimental-transform-types') {
    // Implies("--experimental-transform-types", "--experimental-strip-types"): a later --no- still wins.
    host.transformTypes = arg === '--experimental-transform-types';
    if (host.transformTypes) host.stripTypes = true;
    return true;
  }
  if (arg === '--insecure-http-parser' || arg === '--no-insecure-http-parser') {
    host.insecureHTTPParser = arg === '--insecure-http-parser'; return true;
  }
  if (arg.startsWith('--max-http-header-size=')) {
    const value = arg.slice(23);
    if (!/^\d+$/.test(value)) { cliError('--max-http-header-size requires a nonnegative integer'); return true; }
    host.maxHTTPHeaderSize = Number(value); return true;
  }
  // The size of V8's platform pool for background GC and compile jobs: the engine
  // runs none, so only getOptionValue reads it.
  if (arg.startsWith('--v8-pool-size=')) return true;
  if (arg === '--async-context-frame' || arg === '--no-async-context-frame') {
    host.asyncContextFrame = arg === '--async-context-frame'; return true;
  }
  if (arg === '--expose-gc' || arg === '--no-expose-gc') {
    host.exposeGC = arg === '--expose-gc'; return true;
  }
  // Node's BuiltinModule.exposeInternals: user code may load the internal/*
  // built-ins (see publicBuiltins.listed).
  if (arg === '--expose-internals') { host.exposeInternals = true; return true; }
  // Read at startup by internal/config_file; pre_execution only warns.
  if (arg.startsWith('--experimental-config-file=')) { host.configFile = true; return true; }
  // node.cc: the per-process --title sets the process title before any script runs.
  if (arg.startsWith('--title=')) {
    if (workerThreads.isMainThread) internalRequire('internal/process/title').set(arg.slice('--title='.length));
    return true;
  }
  if (arg === '--disable-sigusr1') { host.disableSigusr1 = true; return true; }
  if (arg === '--trace-events-enabled') { (host.traceOptions ||= {}).enabled = true; return true; }
  if (arg.startsWith('--trace-event-categories=')) { (host.traceOptions ||= {}).categories = arg.slice(25); return true; }
  if (arg.startsWith('--trace-event-file-pattern=')) { (host.traceOptions ||= {}).filePattern = arg.slice(27); return true; }
  if (arg === '--experimental-eventsource' || arg === '--no-experimental-eventsource') {
    host.experimentalEventSource = arg === '--experimental-eventsource'; return true;
  }
  if (arg === '--experimental-websocket' || arg === '--no-experimental-websocket') {
    host.experimentalWebSocket = arg === '--experimental-websocket'; return true;
  }
  if (arg === '--frozen-intrinsics') { host.frozenIntrinsics = true; return true; }
  if (arg.startsWith('--disable-proto=')) {
    const mode = arg.slice(16);
    if (mode !== 'delete' && mode !== 'throw') {
      host.writeStartupDiagnostic(process.execPath + ': invalid mode passed to --disable-proto\n');
      return process.exit(12);
    }
    host.disableProto = mode; return true;
  }
  // Read before the bootstrap runs (worker.silk snapshotWanted): without a snapshot the
  // start skips the heap image and runs the bootstrap itself.
  if (arg === '--node-snapshot' || arg === '--no-node-snapshot') return true;
  // V8's optimizing tiers (Sparkplug, Maglev, Turbofan) and their switches. The engine
  // is an interpreter with no compiler tiers, so turning one on or off changes nothing,
  // as these V8 flags change nothing under --jitless. Spellings as V8 parses them:
  // --no-x, --nox, and _ for -.
  if (/^--(no-?)?(maglev|turbofan|sparkplug|opt|concurrent[-_]recompilation|always[-_]osr|use[-_]osr)$/.test(arg)) return true;
  // Node maps its code to large pages on request; this binary does not, which Node
  // reports as its ENOTSUP result (src/large_pages/node_large_page.cc).
  if (arg.startsWith('--use-largepages=')) {
    const mode = arg.slice(17);
    if (mode !== 'off' && mode !== 'on' && mode !== 'silent') { cliError('invalid value for --use-largepages'); return true; }
    if (mode === 'on') host.writeStartupDiagnostic(process.execPath + ': Mapping to large pages is not supported.\n');
    return true;
  }
  // V8's flag: eval and new Function throw EvalError in the main realm.
  if (arg === '--disallow-code-generation-from-strings') { host.disallowCodeGeneration = true; return true; }
  // V8 frees ArrayBuffer backing stores on a concurrent thread unless told not to; this
  // engine frees them when they are collected, so the flag already holds.
  if (arg === '--no-concurrent-array-buffer-sweeping') return true;
  // V8's flag to run without a JIT. This engine is an interpreter, so only what V8 leaves
  // out with it shows: WebAssembly, which V8 cannot run without generated code.
  if (arg === '--jitless') { host.jitless = true; return true; }
  // V8 flags that turn on source phase imports and import attributes, which this
  // engine always implements.
  if (arg === '--js-source-phase-imports' || arg === '--harmony-import-attributes') return true;
  // Buffer.allocUnsafe memory is always zeroed here, which is what this flag asks for.
  if (arg === '--zero-fill-buffers') { host.zeroFillBuffers = true; return true; }
  if (arg === '--experimental-webstorage' || arg === '--no-experimental-webstorage') {
    host.experimentalWebStorage = arg === '--experimental-webstorage'; return true;
  }
  if (arg === '--experimental-stream-iter' || arg === '--no-experimental-stream-iter') {
    host.experimentalStreamIter = arg === '--experimental-stream-iter'; return true;
  }
  if (arg === '--experimental-require-module' || arg === '--no-experimental-require-module' ||
      arg === '--require-module' || arg === '--no-require-module') {
    host.requireModuleDisabled = arg.startsWith('--no-'); return true;
  }
  if (arg === '--experimental-import-meta-resolve') { host.importMetaResolveParent = true; return true; }
  if (arg === '--experimental-print-required-tla') { host.printRequiredTLA = true; return true; }
  if (arg === '--experimental-import-text') { host.importText = true; return true; }
  if (arg.startsWith('--experimental-package-map=')) { host.packageMap = arg.slice(27); return true; }
  if (arg.startsWith('--experimental-loader=') || arg.startsWith('--loader=')) {
    loaderPreloads.push(arg.slice(arg.indexOf('=') + 1)); return true;
  }
  if (arg === '--experimental-shadow-realm' || arg === '--no-experimental-shadow-realm' ||
      arg === '--harmony-shadow-realm' || arg === '--no-harmony-shadow-realm') {
    host.experimentalShadowRealm = !arg.startsWith('--no-'); return true;
  }
  if (arg === '--experimental-vm-modules' || arg === '--no-experimental-vm-modules') {
    host.experimentalVmModules = arg === '--experimental-vm-modules'; return true;
  }
  if (arg === '--experimental-storage-inspection' || arg === '--no-experimental-storage-inspection') {
    host.experimentalStorageInspection = arg === '--experimental-storage-inspection'; return true;
  }
  if (arg === '--experimental-network-inspection' || arg === '--no-experimental-network-inspection') {
    host.experimentalNetworkInspection = arg === '--experimental-network-inspection'; return true;
  }
  if (arg === '--experimental-inspector-network-resource' || arg === '--no-experimental-inspector-network-resource') {
    host.experimentalInspectorNetworkResource = arg === '--experimental-inspector-network-resource'; return true;
  }
  if (arg.startsWith('--localstorage-file=')) { host.localStorageFile = arg.slice(20); return true; }
  if (arg.startsWith('--require=')) { requirePreloads.push(arg.slice(10)); return true; }
  if (arg.startsWith('--import=')) { importPreloads.push(arg.slice(9)); return true; }
  if (arg === '--addons' || arg === '--no-addons') { host.noAddons = arg === '--no-addons'; return true; }
  if (arg.startsWith('--conditions=')) { (host.moduleConditions ||= []).push(arg.slice(13)); return true; }
  if (arg === '--preserve-symlinks' || arg === '--no-preserve-symlinks') {
    host.preserveSymlinks = arg === '--preserve-symlinks'; return true;
  }
  if (arg === '--preserve-symlinks-main' || arg === '--no-preserve-symlinks-main') {
    host.preserveSymlinksMain = arg === '--preserve-symlinks-main'; return true;
  }
  return false;
}
function installRuntimeOptions(args, entrypoints = [], preloadEntrypoints = true) {
  const preloadParent = host.path.join(host.tryGetCwd(), '[preload]');
  if (preloadEntrypoints) for (const [specifiers, mode] of [[requirePreloads, 'require'], [importPreloads, 'import']]) {
    for (const specifier of specifiers) {
      const resolved = loader.resolve(specifier, preloadParent, mode);
      if (resolved.filename.startsWith('file:')) entrypoints.push(internalRequire('url').fileURLToPath(resolved.filename));
      else if (host.path.isAbsolute(resolved.filename)) entrypoints.push(resolved.filename);
    }
  }
  internalRequire('internal/permission').initialize({ entrypoints });
  internalRequire('internal/startup_controls').initialize();
  // Only a heap-prof option loads internal/heap_prof, and without one there is nothing to start.
  const heapProfileProblem = moduleHas('internal/heap_prof') ? internalRequire('internal/heap_prof').start() : undefined;
  if (heapProfileProblem) return cliError(heapProfileProblem);
  // NODE_V8_COVERAGE: counts from the start, written when the process ends (inspector_profiler.cc).
  if (process.env.NODE_V8_COVERAGE) internalRequire('internal/profiler_binding').startFromEnvironment(process.env.NODE_V8_COVERAGE);
  if (host.enableSourceMaps || moduleHas('internal/source_maps')) process.setSourceMapsEnabled(!!host.enableSourceMaps);
  host.typeScriptMode = host.stripTypes === false ? false : host.transformTypes ? 'transform' : 'strip';
  host.initialExecArgv = process.execArgv.slice();
  host.workerRuntimeArgs = args.slice();
  if (host.exposeGC) {
    // A collection gc() asks for is a forced one to 'gc' performance entries.
    const collect = rawStd.gc;
    const gc = function gc() {
      const observer = host.gcObserver;
      if (observer === undefined) return Reflect.apply(collect, undefined, arguments);
      observer(false);
      try { return Reflect.apply(collect, undefined, arguments); }
      finally { observer(true); }
    };
    Object.defineProperty(globalThis, 'gc', { value: gc, writable: true, enumerable: true });
  }
  if (host.experimentalEventSource) Object.defineProperty(globalThis, 'EventSource', {
    value: internalRequire('internal/web/eventsource').EventSource, writable: true, configurable: true,
  });
  if (host.experimentalWebSocket === false) {
    delete globalThis.WebSocket;
    delete globalThis.CloseEvent;
  }
  if (host.experimentalWebStorage) internalRequire('internal/web/storage').install(globalThis, { localStorageFile: host.localStorageFile, inspect: !!host.experimentalStorageInspection });
  if (host.experimentalStreamIter) { internalRequire('fs/promises'); internalRequire('internal/fs/iter').install(); }
  // http is in the heap image, whose global agent was made without this process's options.
  if (internalRequire('internal/options').getOptionValue('--use-env-proxy')) {
    const agent = internalRequire('_http_agent');
    agent.globalAgent = internalRequire('internal/http').getGlobalAgent(process.env, agent.Agent);
  }
  if (workerThreads.isMainThread) internalRequire('internal/trace_events').initialize(host.traceOptions);
  if (workerThreads.isMainThread && host.traceSigint) internalRequire('util').setTraceSigInt(true);
  if (process.env.NODE_COMPILE_CACHE) internalRequire('internal/compile_cache').initialize();
  // Watch supervisors forward these options to their child, which owns the
  // inspector endpoint; opening here would steal that child's port.
  if (preloadEntrypoints) {
    const options = host.inspectorOptions;
    if (options?.port !== undefined) process.debugPort = options.port;
    process._breakFirstLine = !!options?.breakFirst;
    if (options?.enabled) inspectorBackend._start(options.port, options.host, options.wait, options.breakFirst);
    if (workerThreads.isMainThread) inspectorBackend._installProcess(process, options?.host, !host.disableSigusr1);
    if (!workerThreads.isMainThread) inspectorBackend._waitForWorker();
  }
}
function prepareInput(source, filename, inputType, explicit) {
  if (!host.typeScriptMode) return source;
  // Node strips an input under its tag ([eval], [stdin]), which its syntax errors name.
  if (inputType && inputType.endsWith('-typescript'))
    return host.stripTypeScriptModuleTypes(source, host.path.basename(filename));
  if (explicit) return source;
  try { native.checkSyntax(source, filename, native.detectModuleSyntax(source)); return source; }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    try { return host.stripTypeScriptModuleTypes(source, host.path.basename(filename)); }
    catch (strippingError) {
      if (strippingError.code === 'ERR_INVALID_TYPESCRIPT_SYNTAX' ||
          strippingError.code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') {
        // The script is named [eval] or [stdin], as Node compiles it.
        host.attachArrow(error, host.path.basename(filename), source, 0);
        throw error;
      }
      throw strippingError;
    }
  }
}
function runWorker() {
  const { filename, eval: evaluate, argv, runtimeArgs } = workerBootstrap;
  let inputType;
  for (const entry of internalRequire('internal/options').parseArguments(runtimeArgs, false).entries) {
    if (entry.name === '--input-type') inputType = entry.value;
    else if (!['--eval', '--print', '--env-file', '--env-file-if-exists'].includes(entry.name)) runtimeFlag(optionFlag(entry));
  }
  if (workerBootstrap.reportOptions) internalRequire('internal/process_report').inherit(workerBootstrap.reportOptions);
  // Engine flags affect the process, not an individual Worker option parser.
  host.exposeGC = workerBootstrap.processExposeGC;
  installRuntimeOptions(runtimeArgs, evaluate || filename.startsWith('data:') ? [] : [loader.resolveMain(filename).filename]);
  process.argv = [process.execPath, evaluate ? '[worker eval]' : filename, ...argv];
  if (evaluate) process._eval = filename;
  const workerSource = evaluate ? prepareInput(filename, '[worker eval]', inputType, inputType !== undefined) : undefined;
  const moduleEval = evaluate && (inputType?.startsWith('module') || (inputType === undefined && native.detectModuleSyntax(workerSource)));
  return runPreloads(() => {
    if (evaluate) {
      if (moduleEval) return evaluateMain(workerSource, host.path.join(host.tryGetCwd(), '[eval1]'));
      const name = host.path.join(host.tryGetCwd(), '[worker eval]');
      installCommonJSInputGlobals(name, '[worker eval]');
      armInspectorEntry();
      return native.compileFunction(workerSource, '[worker eval]', undefined, undefined, undefined, true);
    }
    if (filename.startsWith('data:')) {
      const loaded = loader.loadESM(filename);
      return evaluateMain(loaded.source, loaded.filename);
    }
    const resolved = loader.resolveMain(filename);
    mainModuleName = resolved.filename;
    armInspectorEntry();
    return loader.runMain(filename, inputType !== undefined);
  }, !evaluate || moduleEval);
}
function startRepl() {
  console.log('Welcome to SilkJS Runtime.\nType ".help" for more information.');
  return internalRequire('internal/repl').createInternalRepl(process.env, {
    input: process.stdin, output: process.stdout, terminal: !!process.stdout.isTTY, preview: !!process.stdout.isTTY,
  }, error => { if (error) console.error('REPL history:', error.message); });
}
function installCommonJSInputGlobals(filename, id) {
  // Node's createModule (lib/internal/process/execution.js): lookup paths from the cwd.
  const module = new loader.Module(id);
  module.filename = filename;
  module.paths = loader.Module._nodeModulePaths(host.tryGetCwd());
  globalThis.require = loader.requireFor(filename, module);
  globalThis.module = module; globalThis.exports = module.exports;
  globalThis.__filename = id; globalThis.__dirname = '.';
}
const HELP_TEXT = `Usage: silkjsruntime [options] [script.js] [arguments]
  -e, --eval CODE    Evaluate JavaScript (also --eval=CODE)
  -p, --print [CODE] Evaluate and print; read stdin when CODE is omitted
  -c, --check        Check syntax without executing
  -i, --interactive Start the REPL, also after evaluating a script
  --inspect[=[HOST:]PORT]       Activate the inspector (default 127.0.0.1:9229)
  --inspect-brk[=[HOST:]PORT]   Wait for a debugger and break at user entry
  --inspect-wait[=[HOST:]PORT]  Wait for Runtime.runIfWaitingForDebugger
  --inspect-port=[HOST:]PORT   Set the inspector address without activating
  --experimental-inspector-network-resource  Enable inspector network resources
  -r, --require ID  Preload a CommonJS module (repeatable)
  --import ID       Preload a module, awaiting evaluation (repeatable)
  -C, --conditions NAME  Add a package resolution condition (repeatable)
  --preserve-symlinks, --no-preserve-symlinks
  --preserve-symlinks-main, --no-preserve-symlinks-main
  --env-file=PATH, --env-file-if-exists=PATH
  --watch, --watch-path=PATH
  --watch-preserve-output, --watch-kill-signal=SIGNAL
  --run [SCRIPT]    Run a package.json script; pass arguments after --
  --permission, --permission-audit
  --allow-fs-read=PATH, --allow-fs-write=PATH
  --allow-child-process, --allow-worker, --allow-addons
  --allow-wasi, --allow-inspector, --allow-openssl-store
  --input-type=module|commonjs|module-typescript|commonjs-typescript
  --strip-types, --no-strip-types
  --experimental-transform-types, --no-experimental-transform-types
  --enable-source-maps, --no-enable-source-maps
  --warnings, --no-warnings, --trace-warnings, --no-trace-warnings
  --trace-sigint, --no-trace-sigint
  --deprecation, --no-deprecation, --trace-deprecation, --throw-deprecation
  --pending-deprecation, --no-pending-deprecation
  --disable-warning=CODE|NAME, --redirect-warnings=PATH
  --unhandled-rejections=throw|strict|warn|warn-with-error-code|none
  --insecure-http-parser, --no-insecure-http-parser, --max-http-header-size=SIZE
  --async-context-frame, --no-async-context-frame
  --expose-gc, --no-expose-gc
  --experimental-eventsource
  --experimental-webstorage, --localstorage-file=PATH
  --experimental-stream-iter
  --experimental-shadow-realm, --no-experimental-shadow-realm
  --experimental-vm-modules, --no-experimental-vm-modules
  --experimental-test-module-mocks, --no-experimental-test-module-mocks
  --trace-events-enabled
  --trace-event-categories=CATEGORIES
  --trace-event-file-pattern=PATH
  --experimental-sea-config=PATH
  --report-directory=PATH, --report-filename=PATH
  --report-signal=SIGNAL, --report-on-signal
  --report-uncaught-exception, --report-on-fatalerror
  --report-compact, --report-exclude-env, --report-exclude-network
  --test [files]    Run Node tests
  --test-isolation=process|none
  --test-concurrency=N, --test-timeout=MS, --test-only
  --test-name-pattern=REGEXP, --test-skip-pattern=REGEXP
  --test-shard=INDEX/TOTAL
  --test-update-snapshots
  --experimental-test-coverage
  --test-coverage-include=GLOB, --test-coverage-exclude=GLOB
  --test-coverage-lines=N, --test-coverage-branches=N, --test-coverage-functions=N
  --test-reporter=NAME, --test-reporter-destination=PATH
  --build-snapshot ENTRY.js, --build-snapshot-config=FILE
                     Run ENTRY.js and save the heap after its loop as a startup snapshot
  --snapshot-blob=PATH Where --build-snapshot saves the snapshot, or the snapshot to start from
  -h, --help         Print these options
  -v, --version
Environment:
  NODE_OPTIONS      Supported runtime flags, applied before CLI flags
  NODE_PATH         Additional CommonJS package lookup directories
  NODE_NO_WARNINGS, NODE_REDIRECT_WARNINGS, NODE_PENDING_DEPRECATION
`;
function cliError(messages) {
  if (typeof messages === 'string') messages = [messages];
  host.writeStartupDiagnostic(messages.map((message) => process.execPath + ': ' + message + '\n').join(''));
  return process.exit(9);
}
function loadRuntimeEnvironment(args, beforeLoading) {
  const files = internalRequire('internal/options').environmentFiles(args);
  if (!files.length) return;
  if (beforeLoading) beforeLoading();
  const { loaded, errors } = internalRequire('internal/dotenv').loadEnvironmentFiles(files);
  if (errors.length) return cliError(errors.join('\n' + process.execPath + ': '));
  if (loaded) loader.Module._initPaths();
}
// node.cc GenerateAndWriteSnapshotData and LoadSnapshotData, up to the process that
// does the work: the checks that need no heap, then exec of this executable as
// `--silk-build-snapshot BLOB` or `--silk-snapshot-blob BLOB` and the same arguments.
function startSnapshotProcess(build, blob, config, entry, startupEnvironment) {
  const fail = (text, status) => { host.writeStartupDiagnostic(text); return process.exit(status); };
  if (build) {
    if (config === undefined && entry === undefined)
      return fail('--build-snapshot must be used with an entry point script.\nUsage: node --build-snapshot /path/to/entry.js\n', 9);
    if (config === undefined && entry === 'node:embedded_snapshot_main')
      return fail('node:embedded_snapshot_main was specified as snapshot entry point but Node.js was built without embedded snapshot.\n', 9);
    if (config === undefined) {
      try { rawOS.close(internalRequire('fs').openSync(entry, 'r')); } catch (error) {
        return fail(`Cannot read builder script ${entry} for building snapshot. ${error.code}: ${systemMessage(error)}\n`, 1);
      }
    }
  } else if (!internalRequire('fs').existsSync(blob)) {
    return fail(`Cannot open ${blob}`, 14);
  }
  const argv = [native.argv[0], build ? '--silk-build-snapshot' : '--silk-snapshot-blob', blob ?? 'snapshot.blob', ...native.argv.slice(1)];
  const environment = startupEnvironment ?? process.env, entries = [];
  for (const key of Object.keys(environment)) entries.push(key + '=' + environment[key]);
  const errno = native.osNative('execve', [process.execPath, argv, entries]);
  return fail(`${process.execPath}: unable to start the snapshot process (errno ${errno})\n`, 1);
}
// uv_strerror's text, as an fs error message carries it: "ENOENT: no such file or directory, open 'x'".
function systemMessage(error) {
  const message = String(error.message), start = message.indexOf(': '), end = message.indexOf(', ', start);
  return start < 0 ? message : message.slice(start + 2, end < 0 ? undefined : end);
}
// Node's V8 installs Error.stackTraceLimit when it deserializes a snapshot, which the
// builder took it out of (internal/main/mksnapshot). A --stack-trace-limit given to
// this process has already set it.
function restoreStackTraceLimit() {
  if (Object.prototype.hasOwnProperty.call(Error, 'stackTraceLimit')) return;
  Object.defineProperty(Error, 'stackTraceLimit', { value: 10, writable: true, enumerable: true, configurable: true });
}
function runSnapshotBuilder(config) {
  return internalRequire('internal/main/mksnapshot').run(config, (withoutCodeCache) => { snapshotState.codeCache = !withoutCodeCache; });
}
function run(restored = false) {
  if (workerBootstrap) return runWorker();
  // The heap of a snapshot builder whose loop already ended: start over as this process.
  if (restored) {
    snapshotState.building = false; host.startupSnapshot.isBuildingSnapshotBuffer[0] = 0;
    process._exiting = false; process.exitCode = undefined; process.execArgv.length = 0;
  }
  if (native.seaNative(0)) return internalRequire('internal/sea').runMain(native.argv.slice(1), runtimeFlag, installRuntimeOptions, runPreloads, loadRuntimeEnvironment);
  // A script path first means no flags, so no environment file to look for:
  // the option tables load only for flags or NODE_OPTIONS.
  const flags = native.argv.length < 2 || native.argv[1].charCodeAt(0) === 45;
  // NODE_OPTIONS in the environment is preferred over a config file's (node.cc).
  const environmentOptions = process.env.NODE_OPTIONS;
  // The environment as the process got it, before any environment file: only the
  // snapshot process needs it, so it is copied only when a file is about to load.
  let startupEnvironment;
  if (flags) loadRuntimeEnvironment(native.argv.slice(1), () => { startupEnvironment = { ...process.env }; });
  const args = native.argv.slice(1);
  // --experimental-config-file: read before NODE_OPTIONS, rewriting its bare forms in args.
  const config = flags && args.some(arg => arg.startsWith('--experimental-config-file') || arg.startsWith('--experimental-default-config-file'))
    ? internalRequire('internal/config_file').read(args) : undefined;
  if (config?.errors.length) return cliError(config.errors);
  let nodeOptions = process.env.NODE_OPTIONS;
  if (config && environmentOptions === undefined) nodeOptions = config.nodeOptions + (nodeOptions === undefined ? '' : ' ' + nodeOptions);
  let environment = [], environmentEntries = [];
  if (nodeOptions) {
    let parsed;
    try {
      const options = internalRequire('internal/options');
      environment = options.parseEnvironment(nodeOptions);
      parsed = options.parseArguments(environment, true);
    } catch (error) {
      return cliError(error.message);
    }
    if (parsed.error !== undefined) return cliError(parsed.error);
    environment.length = parsed.index;
    environmentEntries = parsed.entries;
  }
  // A config file's namespace flags come after NODE_OPTIONS and before the command line.
  if (config?.namespaceFlags.length) {
    const parsed = internalRequire('internal/options').parseArguments(config.namespaceFlags, false);
    if (parsed.error !== undefined) return cliError(parsed.error);
    environment = environment.concat(config.namespaceFlags.slice(0, parsed.index));
    environmentEntries = environmentEntries.concat(parsed.entries);
  }
  // Without flags the parser and its option table stay unloaded.
  const parsed = flags ? internalRequire('internal/options').parseArguments(args, false) : { entries: [], execArgv: [], index: 0 };
  if (parsed.error !== undefined) return cliError(parsed.error);
  const index = parsed.index;
  process.execArgv.push(...parsed.execArgv);
  let expression, print = false, inputType = 'commonjs';
  let filename, interactive = false, testMode = false, inputTypeSet = false, check = false;
  let watchMode = false, runName;
  let buildSnapshot = false, snapshotBlob, snapshotConfig;
  let testCoverage = false;
  const afterMain = result => interactive ? result && typeof result.then === 'function' ? result.then(startRepl) : startRepl() : result;
  // Options apply in order, NODE_OPTIONS first. Names are canonical: the
  // option table has expanded aliases and short forms.
  // getOptionValue reads the options no handler below keeps (internal/options).
  host.cliOptionEntries = environmentEntries.concat(parsed.entries);
  for (const entry of host.cliOptionEntries) {
    const { name, value } = entry;
    switch (name) {
      case '--watch': watchMode = value; continue;
      case '--run': runName = value; continue;
      case '--build-snapshot': buildSnapshot = value; continue;
      case '--build-snapshot-config': snapshotConfig = value; continue;
      case '--snapshot-blob': snapshotBlob = value; continue;
      case '--experimental-test-coverage': testCoverage = value; continue;
      // Loaded before parsing, by loadRuntimeEnvironment.
      case '--env-file': case '--env-file-if-exists': continue;
      case '--experimental-sea-config': sea.prepare(value); return;
      case '--print': print = value; continue;
      case '--eval': expression = value; continue;
      case '--input-type':
        if (!['module', 'commonjs', 'module-typescript', 'commonjs-typescript'].includes(value))
          return cliError('--input-type must be "module", "commonjs", "module-typescript" or "commonjs-typescript"');
        inputType = value; inputTypeSet = true; continue;
      case '--interactive': interactive = value; continue;
      case '--check': check = value; continue;
      case '--test': testMode = value; continue;
      case '--version': host.stdout.write('silkjsruntime 0.1.0 (QuickJS; Node 24 target)\n'); return;
      case '--help': host.stdout.write(HELP_TEXT); return;
    }
    // The test runner and the watch supervisor read their options with getOptionValue, as Node's do.
    if (name.startsWith('--test-') || name.startsWith('--experimental-test-') || name.startsWith('--watch-')) continue;
    // Node keeps both in its table only to reject them.
    if (entry.name === '--debug' || entry.name === '--debug-brk')
      return cliError('`node --debug` and `node --debug-brk` are invalid. Please use `node --inspect` and `node --inspect-brk` instead.');
    if (runtimeFlag(optionFlag(entry)) || entry.implied) continue;
    return cliError('bad option: ' + entry.raw);
  }
  // node.cc: --build-snapshot runs the builder, --snapshot-blob alone starts from a blob.
  // Both take a process of their own (src/runtime/worker.silk), so this one becomes it.
  if (!restored && !snapshotState.building && (buildSnapshot || snapshotBlob !== undefined)) {
    return startSnapshotProcess(buildSnapshot, snapshotBlob, snapshotConfig, args[index], startupEnvironment);
  }
  if (runName !== undefined) {
    const separator = native.argv.indexOf('--', 1);
    return internalRequire('internal/main/run').runPackageScript(runName, separator < 0 ? [] : native.argv.slice(separator + 1));
  }
  // http loads internal/tls/options into the heap image, so being loaded says nothing:
  // given() is whether this process had a TLS or OpenSSL option.
  const tlsOptions = moduleHas('internal/tls/options') && internalRequire('internal/tls/options').given();
  const tlsErrors = tlsOptions ? internalRequire('internal/tls/options').validate() : [];
  if (tlsErrors.length) return cliError(tlsErrors);
  // Only an OpenSSL option or OPENSSL_CONF initializes OpenSSL at startup.
  const opensslError = tlsOptions || process.env.OPENSSL_CONF ? internalRequire('internal/tls/options').processOpenSSLOptions() : undefined;
  if (opensslError !== undefined) {
    host.writeStartupDiagnostic(process.execPath + ': ' + opensslError + '\n');
    return process.exit(1);
  }
  if (watchMode && expression !== undefined) return cliError('either --watch or --eval can be used, not both');
  if (watchMode && check) return cliError('either --watch or --check can be used, not both');
  if (watchMode && interactive) return cliError('either --watch or --interactive can be used, not both');
  if (expression !== undefined) process._eval = expression;
  process._print_eval = print;
  filename = args[index];
  process.argv = [process.execPath, ...args.slice(index)];
  // As lib/internal/main: an empty script name is no script, so the input is stdin (or the REPL).
  if (filename === '') filename = undefined;
  if (snapshotState.building) {
    installRuntimeOptions(environment.concat(process.execArgv));
    // node_snapshotable.cc runs the builder under a TryCatch of its own: what it throws
    // is printed and the build ends with kGenericUserError, with no 'exit' event.
    return runPreloads(() => {
      try { return runSnapshotBuilder(snapshotConfig); } catch (error) {
        host.writeText(2, internalRequire('internal/fatal_report').caught(error) + '\n');
        return rawStd.exit(1);
      }
    });
  }
  if (restored) {
    // Before any preload, as Node's prepareMainThreadExecution runs them.
    restoreStackTraceLimit();
    if (snapshotState.deserialize !== undefined) snapshotState.deserialize();
    const main = snapshotState.main;
    if (main !== undefined) {
      installRuntimeOptions(environment.concat(process.execArgv));
      return runPreloads(() => afterMain(main()));
    }
  }
  // `node inspect ...`: the debugger client (lib/internal/main/inspect.js).
  if (filename === 'inspect' && expression === undefined && !testMode && !check && !watchMode && !interactive) {
    installRuntimeOptions(environment.concat(process.execArgv));
    return runPreloads(() => internalRequire('internal/debugger/inspect').start());
  }
  if (check && expression !== undefined) return cliError('either --check or --eval can be used, not both');
  if (check && testMode) return cliError('either --test or --check can be used, not both');
  if (testMode && (expression !== undefined || interactive || inputTypeSet))
    return cliError('--test cannot be combined with eval, interactive, or input-type');
  // Node's watch supervisor keeps argv[1] as given (prepareMainThreadExecution without expandArgv1).
  if (expression === undefined && filename !== undefined && filename !== '-' && !testMode && !watchMode)
    process.argv[1] = host.path.resolve(filename);
  const entrypoints = [];
  // The main script as resolved before any preload ran.
  let early;
  if (!watchMode && !testMode && expression === undefined && filename !== undefined && filename !== '-') {
    early = loader.resolveMain(host.path.resolve(filename));
    entrypoints.push(early.filename);
  }
  // With --test, --watch is the test runner's own watch mode (run({ watch })), as in Node.
  if (testMode) watchMode = false;
  installRuntimeOptions(environment.concat(process.execArgv), entrypoints, !watchMode);
  if (watchMode) return internalRequire('internal/main/watch_mode');
  // Counts start before user code; the harness's setupCoverage then finds coverage active.
  if (testCoverage && !testMode && !check) internalRequire('internal/profiler_binding').startCoverage();
  // Node's internal/main/test_runner loads the -r modules itself (not with isolation none).
  if (testMode) return runPreloads(() => internalRequire('internal/main/test_runner'), true, false);
  return runPreloads(() => {
  if (check) {
    const fromStdin = filename === undefined || filename === '-';
    if (!fromStdin && inputTypeSet) throw Object.assign(new Error('--input-type can only be used with string input via --eval, --print, or STDIN'), { code: 'ERR_INPUT_TYPE_NOT_ALLOWED' });
    const resolved = fromStdin ? null : loader.resolveMain(host.path.resolve(filename));
    const name = fromStdin ? host.path.join(host.tryGetCwd(), '[stdin]') : resolved.filename;
    const source = loader.cleanSource(fromStdin ? rawStd.in.readAsString() : host.Buffer.from(host.readFile(name)).toString('utf8'));
    const module = fromStdin ? inputType === 'module' || (!inputTypeSet && native.detectModuleSyntax(source)) : resolved.format === 'module';
    // node:internal/main/check_syntax names piped source [stdin].
    const scriptName = fromStdin ? '[stdin]' : name;
    const wrapped = module ? source : loader.Module.wrap(source);
    try { native.checkSyntax(wrapped, scriptName, module); }
    catch (error) { host.attachArrow(error, scriptName, source, wrapped.indexOf(source)); throw error; }
    return;
  }
  // As node.cc, ask whether descriptor 0 is a terminal without making process.stdin:
  // that stream would make the descriptor nonblocking before a piped script is read.
  if (expression === undefined && filename === undefined && (interactive || internalRequire('tty').isatty(0))) {
    if (inputTypeSet) {
      console.error('Cannot specify --input-type for REPL');
      process.exitCode = 9;
      return;
    }
    return startRepl();
  }
  if (expression !== undefined) {
    const name = host.path.join(host.tryGetCwd(), '[eval]');
    expression = prepareInput(expression, name, inputType, inputTypeSet);
    internalRequire('internal/modules/helpers').addBuiltinLibsToObject(globalThis, '<eval>');
    const code = !inputType.startsWith('module') && /\bcrypto\b/.test(expression) ?
      (print ? 'let crypto=require("node:crypto");{' + expression + '}' : '(crypto=>{{' + expression + '}})(require("node:crypto"))') : expression;
    if (inputType.startsWith('module') || (!inputTypeSet && native.detectModuleSyntax(code))) {
      if (print) throw Object.assign(new Error('--print cannot be used with ESM'), { code: 'ERR_EVAL_ESM_CANNOT_PRINT' });
      return afterMain(evaluateMain(code, name));
    }
    installCommonJSInputGlobals(name, '[eval]');
    armInspectorEntry();
    // As in Node, the script is named [eval] while module.filename is under the cwd.
    return afterMain(internalRequire('internal/process/execution').evalScript('[eval]', code, print));
  }
  if (filename === undefined || filename === '-') {
    let source = rawStd.in.readAsString();
    const name = host.path.join(host.tryGetCwd(), '[stdin]');
    process._eval = source;
    source = prepareInput(source, name, inputType, inputTypeSet);
    if (inputType.startsWith('module') || (!inputTypeSet && native.detectModuleSyntax(source))) {
      if (print) throw Object.assign(new Error('--print cannot be used with ESM'), { code: 'ERR_EVAL_ESM_CANNOT_PRINT' });
      return afterMain(evaluateMain(source, name));
    }
    installCommonJSInputGlobals(name, '[stdin]');
    armInspectorEntry();
    return afterMain(internalRequire('internal/process/execution').evalScript('[stdin]', source, print));
  }
  const path = host.path.resolve(filename);
  process.argv[1] = path;
  // A preload may replace Module.runMain (test-module-run-main-monkey-patch); Node then
  // hands it the entry path instead of running its own loader.
  if (loader.Module.runMain !== loader.defaultRunMain) {
    mainModuleName = path;
    armInspectorEntry();
    return afterMain(loader.Module.runMain(path));
  }
  // Only a preload can register a hook or a mock that resolves it differently.
  const resolved = early !== undefined && !requirePreloads.length && !importPreloads.length ? early : loader.resolveMain(path);
  mainModuleName = resolved.filename;
  armInspectorEntry();
  return afterMain(loader.runMain(path, inputTypeSet, resolved));
  });
}
function referencedWork() {
  return native.hasPendingIO() || timerLoop.hasRef();
}
function pollWorkers() {
  // Replenished queues must yield to timers and native I/O. Rearm the wake
  // even for an already-queued burst, since uv_async coalesces notifications.
  for (let count = 0; count < 1000; count++) {
    if (!invoke(workerThreads._poll, workerThreads, [])) return;
    checkpoint();
  }
  native.workerNative('wake', []);
}
// Milliseconds the native poll may wait: 0 when JavaScript work is ready, the
// delay to the next timer, or -1 to wait for native completions alone.
function pollTimeout(pendingPromise) {
  if (ticksPending()) return 0;
  if (pendingPromise !== undefined && native.promiseState(pendingPromise) !== 0) return 0;
  const referenced = referencedWork();
  if (!referenced && pendingPromise === undefined) return 0;
  const delay = timerLoop.pollDelay();
  // A hook may await an unreferenced timer or an externally settled promise.
  // Keep nested waits interruptible without emitting main-loop lifecycle events.
  if (!referenced && delay === -1) return 1;
  if (delay === -1) return native.hasPendingIO() ? -1 : 0;
  // To the fraction of a millisecond: rounding up would wait up to one more.
  return delay;
}
// One turn in libuv's order: timers, poll for I/O, then the check phase (immediates).
function loopTurn(pendingPromise) {
  if (timerLoop.runTimers()) checkpoint();
  native.pollIO(pollTimeout(pendingPromise));
  pollWorkers();
  checkpoint();
  if (loopListeners.size !== 0) for (const listener of loopListeners) listener();
  if (timerLoop.checkImmediate()) checkpoint();
}
// An exception in a 'beforeExit' or 'exit' listener is uncaught like any other.
function emitProcessEvent(name) { process.emit(name, Number(process.exitCode) || 0); }
function loop() {
  performanceMilestones.loopStart = native.now() - startTime;
  initialNativeIdleTime = native.loopIdleTime();
  while (true) {
    checkpoint();
    pollWorkers();
    if (workerThreads._exitRequested) break;
    if (!referencedWork()) {
      invoke(emitProcessEvent, undefined, ['beforeExit']);
      checkpoint();
      // embed_helpers.cc SpinEventLoopInternal: a snapshot builder serializes here.
      if (snapshotState.serialize !== undefined) { invoke(snapshotState.serialize, undefined, []); checkpoint(); }
      if (!referencedWork()) break;
    }
    loopTurn();
  }
  performanceMilestones.loopExit = native.now() - startTime;
  process._exiting = true;
  invoke(emitProcessEvent, undefined, ['exit']);
  inspectorBackend._atExit();
  if (moduleHas('internal/heap_prof')) internalRequire('internal/heap_prof').finish();
  if (moduleHas('internal/profiler_binding')) internalRequire('internal/profiler_binding').finish();
  if (moduleHas('internal/compile_cache')) internalRequire('internal/compile_cache').flushAtExit();
  if (snapshotState.building) {
    // What is left becomes the blob: no serialize callback, and no garbage.
    snapshotState.serialize = undefined;
    rawStd.gc();
    // The cleanup callbacks of what that collected give its native handles back
    // (src/runtime/worker.silk refuses a snapshot that still holds any).
    checkpoint();
    rawStd.gc();
  }
  return Number(process.exitCode) || 0;
}
const imageModules = ['fs', 'fs/promises', 'internal/fs/streams', 'internal/streams/fast-utf8-stream', 'path', 'os',
  'events', 'stream', 'stream/promises', 'string_decoder', 'util', 'assert', 'console', 'net', 'tty', 'http',
  'internal/tty/write', 'url', 'internal/url', 'internal/encoding', 'internal/abort_controller',
  'internal/process/execution'];
globalThis.__silkRuntime = {
  normalize(name, parent, attributes) { return loader.importKey(name, parent, attributes); },
  load(name, attributes) { return loader.loadESM(name, attributes).source; },
  moduleSource(name, parent, attributes) { return loader.moduleSource(name, parent, attributes); },
  moduleError(name, error) { loader.moduleEvaluationError(name, error); },
  // Node's ModuleLoader.import runs under tracingChannel('module.import').tracePromise:
  // the engine has queued the load, and the promise import() returns is the traced one.
  importTrace(specifier, referrer, promise) {
    const channels = host.diagnostics.tracing('module.import');
    if (channels === undefined) return promise;
    const parentURL = typeof referrer === 'string' ? (/^[A-Za-z][A-Za-z\d+.-]*:/.test(referrer) ? referrer : fileHref(referrer)) : undefined;
    const context = { __proto__: null, parentURL, url: specifier };
    const { end, asyncStart, asyncEnd, error } = channels;
    const resolve = result => {
      context.result = result;
      asyncStart.publish(context);
      asyncEnd.publish(context);
      return result;
    };
    const reject = cause => {
      context.error = cause;
      error.publish(context);
      asyncStart.publish(context);
      asyncEnd.publish(context);
      return promiseReject(cause);
    };
    return channels.start.runStores(context, () => {
      try { return promiseThen(promise, resolve, reject); }
      finally { end.publish(context); }
    });
  },
  registerSource(filename, source, metadata) {
    host.registerSource(filename, source, { ...metadata, owner: metadata });
    if (!metadata.generated && typeof filename === 'string') {
      return /^[A-Za-z][A-Za-z\d+.-]*:/.test(filename) ? filename : fileHref(filename);
    }
  },
  importMeta(name) {
    const asURL = value => /^[A-Za-z][A-Za-z\d+.-]*:/.test(value) ? value : fileHref(value);
    const url = asURL(name);
    // As in Node: a null prototype, keys in this order, filename and dirname for file: only.
    const meta = { __proto__: null };
    if (url.startsWith('file:')) {
      const filename = url === 'file://' + name ? name : internalRequire('url').fileURLToPath(url);
      meta.dirname = host.path.dirname(filename);
      meta.filename = filename;
    }
    meta.main = mainModuleName !== undefined && url === asURL(mainModuleName);
    meta.resolve = function resolve(specifier, parent) {
      // Only --experimental-import-meta-resolve gives the second argument meaning.
      let from = name;
      if (host.importMetaResolveParent && parent !== undefined) {
        // Node's throwIfInvalidParentURL.
        if (typeof parent !== 'string' && !(parent instanceof internalRequire('url').URL))
          throw new (internalRequire('internal/errors').codes.ERR_INVALID_ARG_TYPE)('parentURL', ['string', 'URL'], parent);
        from = String(parent);
      }
      // As in Node, a file that is missing (or a directory) still resolves to its URL.
      try { return asURL(loader.resolve(specifier, from, 'import').filename); }
      catch (error) {
        if ((error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'ERR_UNSUPPORTED_DIR_IMPORT') && error.url) return error.url;
        throw error;
      }
    };
    meta.url = url;
    return meta;
  },
  asyncEvent: asyncHooks._nativeEvent,
  asyncDestroy: asyncHooks._nativeDestroy,
  drainDestroy: asyncHooks._drainDestroy,
  workerError: workerThreads._reportError,
  run: () => invoke(run, undefined, []), loop, onRejection,
  runSnapshot: () => invoke(run, undefined, [true]),
  // Whether the snapshot this builder ends keeps compiled function bodies
  // (a snapshot configuration's "withoutCodeCache").
  snapshotCodeCache: () => snapshotState.codeCache,
  // Ends the build of a heap image. Each variable listed here is read again by hydrate.
  seal() {
    // Built-ins most programs load run here, so that a start from the image finds
    // them loaded. None of them keeps anything of the process when it loads.
    for (const name of imageModules) internalRequire(name);
    // And they find the way to a main script warm (loader.warmMain).
    const fs = internalRequire('fs'), directory = fs.mkdtempSync('/tmp/silkjs-image-');
    try {
      fs.writeFileSync(directory + '/main.js', "require('./dependency.js');\n");
      fs.writeFileSync(directory + '/dependency.js', 'module.exports = 1;\n');
      loader.warmMain(directory + '/main.js');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    // And a first console.log of text, here written to /dev/null.
    const saved = rawOS.dup(1), sink = rawOS.open('/dev/null', rawOS.O_WRONLY);
    try {
      if (saved < 0 || sink < 0) throw new Error('No /dev/null to warm console.log against');
      rawOS.dup2(sink, 1);
      globalThis.console.log('silkjs heap image');
    } finally {
      if (saved >= 0) { rawOS.dup2(saved, 1); rawOS.close(saved); }
      if (sink >= 0) rawOS.close(sink);
    }
    // Read again by hydrate, or (NODE_V8_COVERAGE) read again on every use.
    const hydrated = new Set(['HOME', 'NODE_PATH', 'NODE_CHANNEL_FD', 'NODE_UNIQUE_ID', 'WATCH_REPORT_DEPENDENCIES', 'NODE_V8_COVERAGE']);
    const missed = [...environmentRead].filter(key => typeof key === 'string' && !hydrated.has(key));
    if (missed.length) throw new Error('The bootstrap read environment variables that a start from a heap image does not read again: ' + missed.join(' '));
    // Whoever kept a noting proxy reaches the environment through it unnoted.
    for (const trap of Object.keys(notes)) delete notes[trap];
    host.env = startupEnvironmentValues; process.env = liveEnvironment;
    // The warm main script and its dependency are cycles the loader no longer holds;
    // left in the image, every start would find them (the inspector lists their scripts).
    rawStd.gc();
  },
  // Starts a process from a heap image: everything the bootstrap took from the
  // process that built the image is taken again from this one.
  hydrate(argv, runtimeStartTime, environmentTime, engineStartTime) {
    native.argv = argv;
    startTime = runtimeStartTime;
    performanceMilestones.v8Start = engineStartTime - startTime;
    performanceMilestones.environment = environmentTime - startTime;
    host.performanceStartTime = startTime;
    host.performanceTimeOrigin = Date.now() - (native.now() - startTime);
    process.argv = argv.slice(); process.argv0 = argv[0];
    process.execPath = native.osNative('execPath', []); process.pid = rawOS.getpid();
    native.wasmNative('register', wasmResolver);
    loader.Module._initPaths();
    internalRequire('internal/child_process/ipc').installChild(process);
    internalRequire('internal/watch_mode/dependencies').initialize();
    if (process.env.NODE_UNIQUE_ID !== undefined) setupClusterWorker();
    for (const refresh of hydrations) refresh();
    performanceMilestones.bootstrapComplete = native.now() - startTime;
  }
};
performanceMilestones.bootstrapComplete = native.now() - startTime;
