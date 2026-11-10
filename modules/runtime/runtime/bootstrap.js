import * as stdNamespace from 'silk:host/std';
import * as osNamespace from 'silk:host/os';

const rawStd = { ...stdNamespace };
const rawOS = { ...osNamespace };

const native = globalThis.__silkNative;
delete globalThis.__silkNative;
const factories = new Map();
const modules = new Map();
const realmSources = new Map();
const factoryGet = Map.prototype.get.bind(factories);
const factorySet = Map.prototype.set.bind(factories);
const moduleGet = Map.prototype.get.bind(modules);
const moduleHas = Map.prototype.has.bind(modules);
const moduleSet = Map.prototype.set.bind(modules);
const moduleDelete = Map.prototype.delete.bind(modules);
const stringStartsWith = Function.prototype.call.bind(String.prototype.startsWith);
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
  try {
    if (typeof factory === 'number') {
      factory = native.compileFunction(native.builtinSource(factory), 'node:' + request);
      factorySet(request, factory);
    }
    factory(module, module.exports, name => internalRequire(name, request));
  }
  catch (error) { moduleDelete(request); throw error; }
  return module.exports;
}
for (let index = 0, count = native.builtinCount(); index < count; index++) define(native.builtinName(index), index);

for (const name of ['dispose', 'asyncDispose']) {
  if (Symbol[name] === undefined) Object.defineProperty(Symbol, name, { value: Symbol.for('nodejs.' + name) });
}
const host = { ...native, rawOS, rawStd };
const inspectorNativeOperations = Array.from({ length: 32 }, (_, index) => native['inspectorNative' + index]);
host.inspectorNative = (operation, ...args) => inspectorNativeOperations[operation](...args);
host.inspectorEntry = wrapper => host.inspectorNative(15, wrapper);
host.typeScriptMode = 'strip';
host.testCoverageStart = () => native.testCoverageNative(0);
host.testCoverageTake = () => native.testCoverageNative(1);
host.testCoverageStop = () => native.testCoverageNative(2);
host.processFeatures = {
  debug: native.debugBuild, uv: true, ipv6: true, inspector: true,
  tls: true, tls_alpn: true, tls_sni: true, tls_ocsp: false,
  cached_builtins: false, require_module: true,
  get typescript() { return host.typeScriptMode; }
};
define('internal/host', module => { module.exports = host; });
internalRequire('internal/error_stack').install(globalThis);
let warnedTransformTypes = false;
host.stripTypeScriptModuleTypes = (source, filename, sourceURL = filename) => {
  const transform = host.typeScriptMode === 'transform';
  if (transform && !warnedTransformTypes) {
    warnedTransformTypes = true;
    process.emitWarning('Transform Types is an experimental feature and might change at any time', 'ExperimentalWarning');
  }
  return internalRequire('internal/typescript').stripTypeScriptModuleTypes(
    source, filename, transform ? 'transform' : 'strip-only', transform, sourceURL);
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
native.wasmNative('register', global => wasmCallbacks.get(global));
host.initializeRealmBuiltins = (handle, global, wasmCodeGeneration) => {
  const cache = new Map();
  const bridge = {
    captureCallSites: native.captureCallSites,
    errorStackState: host.errorStackState,
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
    factory(module, module.exports, load);
    return module.exports;
  }
  load('internal/error_stack').install(global);
  Object.defineProperty(global, 'WebAssembly', {
    value: load('internal/web/wasm').WebAssembly, writable: true, configurable: true,
  });
};
const errnoNames = new Map();
{
  // QuickJS's std.Error exposes only a subset of POSIX errno constants.
  // Reuse the complete platform libuv table also used by node:util.
  const errors = native.utilErrorMap();
  for (let index = 0; index < errors.length; index += 3)
    errnoNames.set(-errors[index], errors[index + 1]);
}
function systemError(errno, syscall, path, dest) {
  const number = Math.abs(errno), code = errnoNames.get(number) || 'UNKNOWN';
  const error = new Error(code + ': ' + rawStd.strerror(number) + ', ' + syscall + (path === undefined ? '' : " '" + path + "'"));
  Object.assign(error, { errno: -number, code, syscall });
  if (path !== undefined) error.path = path;
  if (dest !== undefined) error.dest = dest;
  return error;
}
function pair(result, syscall, path) { if (result[1] !== 0) throw systemError(result[1], syscall, path); return result[0]; }
host.cwd = () => pair(rawOS.getcwd(), 'getcwd');
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
const moduleStat = osNamespace.stat;
host.moduleStat = path => statResult(moduleStat(path), 'stat', path);
host.env = new Proxy(Object.assign(Object.create(null), rawStd.getenviron()), {
  set(target, key, value) { if (typeof key === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string'); value = String(value); rawStd.setenv(key, value); target[key] = value; return true; },
  deleteProperty(target, key) { rawStd.unsetenv(key); return delete target[key]; }
});
const asyncHooks = internalRequire('async_hooks');
function resource(type, owner) { return asyncHooks._createResource(type, owner); }
function invokeResource(scope, callback, receiver, args, destroy = true) {
  try { return scope.runInAsyncScope(invoke, undefined, callback, receiver, args); }
  finally { if (destroy) scope.emitDestroy(); }
}
host.invokeResource = invokeResource;
const ticks = [];
const completions = [];
// Compound native operations finish through promises, but their public
// callbacks are I/O completions, not microtasks. Dispatch them outside drainJobs.
host.enqueueIOCompletion = callback => completions.push(callback);
host.nextTick = (callback, ...args) => {
  if (typeof callback !== 'function') throw Object.assign(new TypeError('The callback argument must be a function'), { code: 'ERR_INVALID_ARG_TYPE' });
  ticks.push([callback, args, resource('TickObject')]);
};
host.queueMicrotask = callback => {
  checkCallback(callback);
  const scope = resource('Microtask');
  try { native.enqueueMicrotask(() => invokeResource(scope, callback, undefined, [])); }
  catch (error) { scope.emitDestroy(); throw error; }
};
globalThis.queueMicrotask = host.queueMicrotask;
let nextTimer = 1;
const timers = new Map();
const immediates = new Map();
const executingTimers = [];
function checkCallback(callback) { if (typeof callback !== 'function') throw Object.assign(new TypeError('The callback argument must be a function'), { code: 'ERR_INVALID_ARG_TYPE' }); }
function invoke(callback, receiver, args) {
  try { return Reflect.apply(callback, receiver, args); }
  catch (error) {
    if (process.domain && internalRequire('domain')._handleException(error)) return;
    internalRequire('internal/startup_controls').handleUncaught(error, 'uncaughtException');
  }
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
      while (ticks.length) {
        const [callback, args, scope] = ticks.shift();
        invokeResource(scope, callback, undefined, args);
      }
      native.drainJobs();
      if (ticks.length) continue;
      if (!completions.length) break;
      completions.shift()();
    }
    while (rejections.size) {
      const pending = [...rejections];
      for (const [promise, info] of pending) {
        if (!rejections.has(promise)) continue;
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
    if (!ticks.length) native.drainJobs();
  } while (ticks.length || rejections.size || completions.length);
}
host.checkpoint = checkpoint;
class Timeout {
  constructor(callback, delay, args, repeat, immediate = false) {
    this._id = nextTimer++; this._callback = callback; this._args = args; this._delay = delay;
    this._repeat = repeat; this._refed = true; this._destroyed = false; this._immediate = immediate;
    this._resource = resource(immediate ? 'Immediate' : 'Timeout', this);
    this._due = native.now() + delay;
    (immediate ? immediates : timers).set(this._id, this);
  }
  ref() { this._refed = true; return this; }
  unref() { this._refed = false; return this; }
  hasRef() { return this._refed; }
  refresh() {
    if (this._destroyed) this._resource = resource(this._immediate ? 'Immediate' : 'Timeout', this);
    this._due = native.now() + this._delay; this._destroyed = false;
    (this._immediate ? immediates : timers).set(this._id, this);
    return this;
  }
  close() { clearTimer(this); return this; }
  [Symbol.toPrimitive]() { return this._id; }
  [Symbol.dispose]() { clearTimer(this); }
}
function delayValue(delay) { delay = Number(delay); return !Number.isFinite(delay) || delay < 1 || delay > 2147483647 ? 1 : Math.trunc(delay); }
function setTimer(callback, delay, args, repeat) { checkCallback(callback); return new Timeout(callback, delayValue(delay), args, repeat); }
function clearTimer(timer) {
  const id = timer instanceof Timeout ? timer._id : typeof timer === 'number' || typeof timer === 'string' ? Number(timer) : NaN;
  const value = timers.get(id) || immediates.get(id) || (timer instanceof Timeout ? timer : undefined);
  if (value && !value._destroyed) {
    value._destroyed = true; timers.delete(id); immediates.delete(id);
    value._resource.emitDestroy();
  }
}
const timerAPI = {
  setTimeout: (fn, delay, ...args) => setTimer(fn, delay, args, false),
  setInterval: (fn, delay, ...args) => setTimer(fn, delay, args, true),
  setImmediate: (fn, ...args) => { checkCallback(fn); return new Timeout(fn, 0, args, false, true); },
  clearTimeout: clearTimer, clearInterval: clearTimer, clearImmediate: clearTimer,
};
Object.assign(globalThis, timerAPI);
define('timers', module => { module.exports = timerAPI; });
for (const name of ['setTimeout', 'setImmediate']) {
  Object.defineProperty(timerAPI[name], Symbol.for('nodejs.util.promisify.custom'), {
    enumerable: true, get() { return internalRequire('timers/promises')[name]; }
  });
}
const Buffer = internalRequire('buffer').Buffer;
host.Buffer = Buffer;
globalThis.Buffer = Buffer;
globalThis.global = globalThis;
globalThis.atob = internalRequire('buffer').atob;
globalThis.btoa = internalRequire('buffer').btoa;
host.readFile = path => {
  const options = {}, file = rawStd.open(path, 'rb', options);
  if (!file) throw systemError(options.errno || 2, 'open', path);
  const chunks = []; let size = 0;
  try {
    while (true) {
      const chunk = new Uint8Array(65536), count = file.read(chunk.buffer, 0, chunk.length);
      if (count < 0 || file.error()) throw systemError(file.error() || 5, 'read', path);
      if (count === 0) break;
      chunks.push(chunk.subarray(0, count)); size += count;
    }
  } finally { file.close(); }
  return Buffer.concat(chunks, size);
};
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
host.writeStartupDiagnostic = host.stderr.write;
globalThis.process = { platform: host.platform, env: host.env, nextTick: host.nextTick, emitWarning: value => host.stderr.write(String(value) + '\n') };
const EventEmitter = internalRequire('events');
const process = new EventEmitter();
globalThis.process = process;
const startTime = native.runtimeStartTime;
const performanceMilestones = {
  nodeStart: 0, environment: native.environmentTime - startTime,
  bootstrapComplete: -1, loopStart: -1, loopExit: -1,
};
let initialNativeIdleTime = 0;
const loopListeners = new Set();
host.performanceStartTime = startTime;
host.performanceTimeOrigin = Date.now() - (native.now() - startTime);
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
Object.assign(process, {
  argv: native.argv.slice(), argv0: native.argv[0], execArgv: [], execPath: native.osNative('execPath', []),
  version: 'v24.0.0', versions: { node: '24.0.0', silkjsruntime: '0.1.0', quickjs: '2026-06-04', amaro: '1.1.11' },
  platform: host.platform, arch: host.arch, env: host.env, pid: rawOS.getpid(),
  release: { name: 'silkjsruntime' }, stdout: host.stdout, stderr: host.stderr,
  cwd: host.cwd, chdir(path) { const code = rawOS.chdir(path); if (code < 0) throw systemError(code, 'chdir', path); },
  nextTick: host.nextTick, uptime: () => (native.now() - startTime) / 1000,
  hrtime(previous) { const nanoseconds = native.nowNanoseconds(); const value = [Number(nanoseconds / 1000000000n), Number(nanoseconds % 1000000000n)]; if (previous !== undefined) { if (!Array.isArray(previous)) throw Object.assign(new TypeError('The time argument must be an Array'), { code: 'ERR_INVALID_ARG_TYPE' }); if (previous.length !== 2) throw Object.assign(new RangeError('The time argument must contain two entries'), { code: 'ERR_OUT_OF_RANGE' }); value[0] -= previous[0]; value[1] -= previous[1]; if (value[1] < 0) { value[0]--; value[1] += 1000000000; } } return value; },
  emitWarning: internalRequire('internal/startup_controls').emitWarning,
  setUncaughtExceptionCaptureCallback: internalRequire('internal/startup_controls').setUncaughtExceptionCaptureCallback,
  hasUncaughtExceptionCaptureCallback: internalRequire('internal/startup_controls').hasUncaughtExceptionCaptureCallback,
  exit(code) { if (code !== undefined) process.exitCode = code; if (!process._exiting) { process._exiting = true; process.emit('exit', Number(process.exitCode) || 0); } internalRequire('internal/compile_cache').flushCompileCache(); rawStd.exit(Number(process.exitCode) || 0); },
  kill(pid, signal = 'SIGTERM') { const number = typeof signal === 'string' ? rawOS[signal] : signal; if (number === undefined) throw Object.assign(new TypeError('Unknown signal: ' + signal), { code: 'ERR_UNKNOWN_SIGNAL' }); const code = rawOS.kill(pid, number); if (code < 0) throw systemError(code, 'kill'); return true; }
});
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
  const seen = new Set();
  for (const collection of [timers.values(), immediates.values(), executingTimers]) {
    for (const timer of collection) {
      if (!timer._destroyed && timer._refed && !seen.has(timer)) {
        seen.add(timer);
        names.push(timer._immediate ? 'Immediate' : 'Timeout');
      }
    }
  }
  names.push(...native.workerNative('activeResources', []));
  return names;
};
host.asyncHookFatal = error => {
  try { internalRequire('internal/process_report').onFatalError(error); }
  finally { native.asyncHookFatal(error); }
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
define('process', module => { module.exports = process; });
internalRequire('internal/napi').install(host, process);
const eventGlobals = internalRequire('internal/path_events/event_target');
for (const name of ['Event', 'CustomEvent', 'EventTarget', 'AbortController', 'AbortSignal', 'DOMException']) globalThis[name] = eventGlobals[name];
const asyncFS = internalRequire('internal/fs_async')(native);
host.submitIO = (operation, args, callback, requestKind) => {
  const scope = resource(requestKind === 1 ? 'FSREQPROMISE' : requestKind === 2 ? 'FILEHANDLECLOSEREQ' : 'FSREQCALLBACK');
  try { return asyncFS.submitIO(operation, args, (...values) => invokeResource(scope, callback, undefined, values), requestKind); }
  catch (error) { scope.emitDestroy(); throw error; }
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
const workerThreads = internalRequire('worker_threads');
const workerBootstrap = workerThreads._bootstrap();
if (workerThreads.isMainThread) {
  internalRequire('internal/process_signals').install(process);
  internalRequire('internal/stdio').install(process);
}
workerThreads._install(process, workerBootstrap);
if (workerThreads.isMainThread) internalRequire('internal/watch_mode/dependencies').initialize();
host.stdout = process.stdout;
host.stderr = process.stderr;
const webGlobals = internalRequire('internal/web/index');
webGlobals.install(globalThis);
globalThis.console = internalRequire('console');
// Register the trusted dispatcher before preloads or any other guest code can
// connect to this isolate (including through a parent Worker inspector).
const inspectorBackend = internalRequire('internal/inspector');
webGlobals.defineLazy(globalThis, 'crypto', () => ({ crypto: internalRequire('crypto').webcrypto }));
for (const name of ['Crypto', 'SubtleCrypto', 'CryptoKey']) {
  Object.defineProperty(globalThis, name, {
    get() {
      const value = internalRequire('internal/crypto_webcrypto')[name];
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
    webGlobals.defineLazy(globalThis, name, loadPerformance);
}
host.path = internalRequire('path');
const publicBuiltinNames = [...factories.keys()].filter(name => !name.startsWith('internal/'));
const publicBuiltinHas = Set.prototype.has.bind(new Set(publicBuiltinNames));
const prefixOnlyBuiltinHas = Set.prototype.has.bind(new Set(['test', 'test/reporters', 'sqlite', 'sea']));
const defineBuiltinName = Object.defineProperty;
function publicBuiltin(name) {
  return publicBuiltinHas(name) &&
    ((name !== 'stream/iter' && name !== 'zlib/iter') || host.experimentalStreamIter === true);
}
const publicBuiltins = {
  has: publicBuiltin,
  get: name => internalRequire(name),
  names() {
    const names = [];
    for (let index = 0; index < publicBuiltinNames.length; index++) {
      const name = publicBuiltinNames[index];
      if (publicBuiltin(name)) defineBuiltinName(names, names.length, {
        value: prefixOnlyBuiltinHas(name) ? 'node:' + name : name, enumerable: true, writable: true, configurable: true,
      });
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
  native.compileFunction('(specifier, attributes) => import(specifier, { with: attributes })', filename);
const dotenv = internalRequire('internal/dotenv');
process.loadEnvFile = dotenv.loadEnvFile;
if (workerThreads.isMainThread && process.env.NODE_UNIQUE_ID !== undefined) internalRequire('cluster');
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
  return native.evaluateModule(source, name, true);
}
const requirePreloads = [], importPreloads = [];
function runPreloads(entry, loadImports = true) {
  loader.Module._preloadModules(requirePreloads);
  if (!loadImports || !importPreloads.length) return entry();
  const name = host.path.join(host.cwd(), '[preload]');
  let pending = Promise.resolve();
  for (const specifier of importPreloads) {
    pending = pending.then(() => native.compileFunction('import(' + JSON.stringify(specifier) + ')', name));
  }
  return pending.then(entry);
}
function runtimeFlag(arg) {
  try {
    if (internalRequire('internal/permission').applyOption(arg) ||
        internalRequire('internal/startup_controls').applyOption(arg) ||
        internalRequire('internal/options').applyInspectorOption(arg)) return true;
  }
  catch (error) { cliError(error.message); return true; }
  if (arg === '--enable-source-maps' || arg === '--no-enable-source-maps') {
    host.enableSourceMaps = arg === '--enable-source-maps'; return true;
  }
  if (arg === '--trace-sigint' || arg === '--no-trace-sigint') {
    host.traceSigint = arg === '--trace-sigint'; return true;
  }
  if ((arg.startsWith('--report-') || arg.startsWith('--no-report-') || arg === '--experimental-report') &&
      internalRequire('internal/process_report').applyOption(arg)) return true;
  if (['--strip-types', '--experimental-strip-types', '--no-strip-types', '--no-experimental-strip-types'].includes(arg)) {
    host.stripTypes = !arg.startsWith('--no-'); return true;
  }
  if (arg === '--experimental-transform-types' || arg === '--no-experimental-transform-types') {
    host.transformTypes = arg === '--experimental-transform-types'; return true;
  }
  if (arg === '--insecure-http-parser' || arg === '--no-insecure-http-parser') {
    host.insecureHTTPParser = arg === '--insecure-http-parser'; return true;
  }
  if (arg === '--async-context-frame' || arg === '--no-async-context-frame') {
    host.asyncContextFrame = arg === '--async-context-frame'; return true;
  }
  if (arg === '--expose-gc' || arg === '--no-expose-gc') {
    host.exposeGC = arg === '--expose-gc'; return true;
  }
  if (arg === '--test-update-snapshots' || arg === '--no-test-update-snapshots') {
    host.testUpdateSnapshots = arg === '--test-update-snapshots'; return true;
  }
  if (arg === '--trace-events-enabled') { (host.traceOptions ||= {}).enabled = true; return true; }
  if (arg.startsWith('--trace-event-categories=')) { (host.traceOptions ||= {}).categories = arg.slice(25); return true; }
  if (arg.startsWith('--trace-event-file-pattern=')) { (host.traceOptions ||= {}).filePattern = arg.slice(27); return true; }
  if (arg === '--experimental-eventsource' || arg === '--no-experimental-eventsource') {
    host.experimentalEventSource = arg === '--experimental-eventsource'; return true;
  }
  if (arg === '--experimental-webstorage' || arg === '--no-experimental-webstorage') {
    host.experimentalWebStorage = arg === '--experimental-webstorage'; return true;
  }
  if (arg === '--experimental-stream-iter' || arg === '--no-experimental-stream-iter') {
    host.experimentalStreamIter = arg === '--experimental-stream-iter'; return true;
  }
  if (arg === '--experimental-vm-modules' || arg === '--no-experimental-vm-modules') {
    host.experimentalVmModules = arg === '--experimental-vm-modules'; return true;
  }
  if (arg === '--experimental-test-module-mocks' || arg === '--no-experimental-test-module-mocks') {
    host.experimentalTestModuleMocks = arg === '--experimental-test-module-mocks'; return true;
  }
  if (arg === '--experimental-inspector-network-resource' || arg === '--no-experimental-inspector-network-resource') {
    host.experimentalInspectorNetworkResource = arg === '--experimental-inspector-network-resource'; return true;
  }
  if (arg.startsWith('--localstorage-file=')) { host.localStorageFile = arg.slice(20); return true; }
  if (arg.startsWith('--require=')) { requirePreloads.push(arg.slice(10)); return true; }
  if (arg.startsWith('--import=')) { importPreloads.push(arg.slice(9)); return true; }
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
  const preloadParent = host.path.join(host.cwd(), '[preload]');
  if (preloadEntrypoints) for (const [specifiers, mode] of [[requirePreloads, 'require'], [importPreloads, 'import']]) {
    for (const specifier of specifiers) {
      const resolved = loader.resolve(specifier, preloadParent, mode);
      if (resolved.filename.startsWith('file:')) entrypoints.push(internalRequire('url').fileURLToPath(resolved.filename));
      else if (host.path.isAbsolute(resolved.filename)) entrypoints.push(resolved.filename);
    }
  }
  internalRequire('internal/permission').initialize({ entrypoints });
  internalRequire('internal/startup_controls').initialize();
  process.setSourceMapsEnabled(!!host.enableSourceMaps);
  host.typeScriptMode = host.transformTypes ? 'transform' : host.stripTypes === false ? false : 'strip';
  host.initialExecArgv = process.execArgv.slice();
  host.workerRuntimeArgs = args.slice();
  if (host.exposeGC) Object.defineProperty(globalThis, 'gc', { value: rawStd.gc, writable: true, enumerable: true });
  if (host.experimentalEventSource) Object.defineProperty(globalThis, 'EventSource', {
    value: internalRequire('internal/web/eventsource').EventSource, writable: true, configurable: true,
  });
  if (host.experimentalWebStorage) internalRequire('internal/web/storage').install(globalThis, { localStorageFile: host.localStorageFile });
  if (workerThreads.isMainThread) internalRequire('internal/trace_events').initialize(host.traceOptions);
  if (workerThreads.isMainThread && host.traceSigint) internalRequire('util').setTraceSigInt(true);
  internalRequire('internal/compile_cache').initialize();
  // Watch supervisors forward these options to their child, which owns the
  // inspector endpoint; opening here would steal that child's port.
  if (preloadEntrypoints) {
    const options = host.inspectorOptions;
    process.debugPort = options?.port ?? 9229;
    process._breakFirstLine = !!options?.breakFirst;
    if (options?.enabled) inspectorBackend._start(options.port, options.host, options.wait, options.breakFirst);
    if (!workerThreads.isMainThread) inspectorBackend._waitForWorker();
  }
}
function prepareInput(source, filename, inputType, explicit) {
  if (!host.typeScriptMode) return source;
  if (inputType && inputType.endsWith('-typescript'))
    return host.stripTypeScriptModuleTypes(source, filename);
  if (explicit) return source;
  try { native.checkSyntax(source, filename, native.detectModuleSyntax(source)); return source; }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    try { return host.stripTypeScriptModuleTypes(source, filename); }
    catch (strippingError) {
      if (strippingError.code === 'ERR_INVALID_TYPESCRIPT_SYNTAX' ||
          strippingError.code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') throw error;
      throw strippingError;
    }
  }
}
function runWorker() {
  const { filename, eval: evaluate, argv, runtimeArgs } = workerBootstrap;
  let inputType;
  for (let index = 0; index < runtimeArgs.length; index++) {
    const arg = internalRequire('internal/options').normalizeOption(runtimeArgs[index]);
    if (arg === '-e' || arg === '--eval') { index++; continue; }
    if (arg === '-p' || arg === '--print') {
      if (runtimeArgs[index + 1] !== undefined && !runtimeArgs[index + 1].startsWith('-')) index++;
      continue;
    }
    if (arg === '--input-type') { inputType = runtimeArgs[++index]; continue; }
    if (arg.startsWith('--input-type=')) { inputType = arg.slice(13); continue; }
    if (arg === '--env-file' || arg === '--env-file-if-exists') { index++; continue; }
    if (['--localstorage-file', '-r', '--require', '--import', '-C', '--conditions'].includes(arg) || internalRequire('internal/process_report').isValueOption(arg) || internalRequire('internal/startup_controls').isValueOption(arg) || internalRequire('internal/permission').isValueOption(arg) || internalRequire('internal/options').isInspectorValueOption(arg)) {
      runtimeFlag((arg === '-r' ? '--require' : arg === '-C' ? '--conditions' : arg) + '=' + runtimeArgs[++index]); continue;
    }
    runtimeFlag(arg);
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
      if (moduleEval) return evaluateMain(workerSource, host.path.join(host.cwd(), '[eval1]'));
      const name = host.path.join(host.cwd(), '[worker eval]');
      installCommonJSInputGlobals(name, '[worker eval]');
      armInspectorEntry();
      return native.compileFunction(workerSource, name, undefined, undefined, undefined, true);
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
  if (process.stdout.isTTY) console.log('Welcome to SilkJS Runtime.\nType ".help" for more information.');
  return internalRequire('internal/repl').createInternalRepl(process.env, {
    input: process.stdin, output: process.stdout, terminal: !!process.stdout.isTTY, preview: !!process.stdout.isTTY,
  }, error => { if (error) console.error('REPL history:', error.message); });
}
function runTests(options, files, reporterNames, destinations) {
  const reporters = internalRequire('test/reporters');
  if (!reporterNames.length) reporterNames.push('spec');
  if (!destinations.length && reporterNames.length === 1) destinations.push('stdout');
  if (reporterNames.length !== destinations.length) throw new Error('Each test reporter requires a destination');
  const outputs = reporterNames.map((name, index) => {
    let reporter = reporters[name];
    if (!reporter) {
      reporter = loader.requireFor(host.path.join(host.cwd(), '[test-reporter]'))(name);
      reporter = reporter.default || reporter;
    } else if (name === 'spec' || name === 'lcov') reporter = reporter();
    const destination = destinations[index];
    return { reporter, output: destination === 'stdout' ? process.stdout : destination === 'stderr' ? process.stderr : internalRequire('fs').createWriteStream(destination) };
  });
  const stream = internalRequire('test').run({ ...options, ...(files.length ? { files } : {}) });
  stream.on('test:summary', summary => { if (!summary.success) process.exitCode = 1; });
  const fail = error => { console.error(error); process.exitCode = 1; };
  stream.on('error', fail);
  for (const { reporter, output } of outputs) {
    const branch = new (internalRequire('stream').PassThrough)({ objectMode: true });
    stream.pipe(branch);
    const formatted = branch.compose(reporter);
    formatted.on('error', fail);
    output.on('error', fail);
    formatted.pipe(output, { end: output !== process.stdout && output !== process.stderr });
  }
}
function installCommonJSInputGlobals(filename, id) {
  const module = new loader.Module(id);
  module.filename = filename;
  globalThis.require = loader.requireFor(filename, module);
  globalThis.module = module; globalThis.exports = module.exports;
  globalThis.__filename = id; globalThis.__dirname = '.';
}
function cliError(message) {
  host.writeStartupDiagnostic(process.execPath + ': ' + message + '\n');
  return process.exit(9);
}
function loadRuntimeEnvironment(args) {
  const files = internalRequire('internal/options').environmentFiles(args);
  if (!files.length) return;
  const { loaded, errors } = dotenv.loadEnvironmentFiles(files);
  if (errors.length) return cliError(errors.join('\n' + process.execPath + ': '));
  if (loaded) loader.Module._initPaths();
}
function run() {
  if (workerBootstrap) return runWorker();
  const sea = internalRequire('internal/sea');
  if (sea.isSea()) return sea.runMain(native.argv.slice(1), runtimeFlag, installRuntimeOptions, runPreloads, loadRuntimeEnvironment);
  const startupEnvironment = { ...process.env };
  loadRuntimeEnvironment(native.argv.slice(1));
  const options = internalRequire('internal/options');
  let environment;
  try {
    environment = options.parseEnvironment(process.env.NODE_OPTIONS || '');
    environment.length = options.validateEnvironment(environment);
  } catch (error) {
    return cliError(error.message);
  }
  const args = environment.concat(native.argv.slice(1)); let expression, print = false, inputType = 'commonjs';
  let filename, index = 0, interactive = false, testMode = false, inputTypeSet = false, check = false;
  let watchMode = false, watchPreserveOutput = false, watchKillSignal = 'SIGTERM', runName;
  const watchPaths = [];
  const record = (...values) => {
    if (index >= environment.length) {
      values[0] = args[index - values.length + 1];
      process.execArgv.push(...values);
    }
  };
  const testOptions = {}, reporterNames = [], destinations = [];
  const afterMain = result => interactive ? result && typeof result.then === 'function' ? result.then(startRepl) : startRepl() : result;
  for (; index < args.length; index++) {
    const arg = internalRequire('internal/options').normalizeOption(args[index]);
    if (arg === '--') { index++; break; }
    if (arg === '--watch' || arg === '--no-watch') { watchMode = arg === '--watch'; record(arg); continue; }
    if (arg === '--watch-preserve-output' || arg === '--no-watch-preserve-output') {
      watchPreserveOutput = arg === '--watch-preserve-output'; record(arg); continue;
    }
    if (arg === '--watch-path' || arg.startsWith('--watch-path=') ||
        arg === '--watch-kill-signal' || arg.startsWith('--watch-kill-signal=')) {
      const separator = arg.indexOf('='), name = separator < 0 ? arg : arg.slice(0, separator);
      const value = separator < 0 ? args[++index] : arg.slice(separator + 1);
      if (value === undefined || value === '' || (separator < 0 && value.startsWith('-')))
        return cliError(name + ' requires an argument');
      record(arg, ...(separator < 0 ? [value] : []));
      if (name === '--watch-path') { watchPaths.push(value); watchMode = true; }
      else watchKillSignal = value;
      continue;
    }
    if (arg === '--run' || arg.startsWith('--run=')) {
      const separator = arg.indexOf('=');
      const value = separator < 0 && args[index + 1] !== undefined && !args[index + 1].startsWith('-') ? args[++index] :
        separator < 0 ? '' : arg.slice(separator + 1);
      runName = value;
      record(arg, ...(separator < 0 && value !== '' ? [value] : []));
      continue;
    }
    if (arg === '--experimental-test-coverage' || arg === '--no-experimental-test-coverage') {
      testOptions.coverage = arg === '--experimental-test-coverage'; record(arg); continue;
    }
    if (arg === '--env-file' || arg === '--env-file-if-exists' ||
        arg.startsWith('--env-file=') || arg.startsWith('--env-file-if-exists=')) {
      const separator = arg.indexOf('=');
      const value = separator < 0 ? args[++index] : arg.slice(separator + 1);
      if (value === undefined || value === '' || (separator < 0 && value.startsWith('-')))
        return cliError(arg + ' requires an argument');
      record(arg, ...(separator < 0 ? [value] : []));
      continue;
    }
    if (['--localstorage-file=', '--require=', '--import=', '--conditions='].includes(arg) ||
        (arg.endsWith('=') && (internalRequire('internal/process_report').isValueOption(arg.slice(0, -1)) ||
          internalRequire('internal/permission').isValueOption(arg.slice(0, -1))))) return cliError(arg + ' requires an argument');
    if (runtimeFlag(arg)) { record(arg); continue; }
    if (arg === '--trace-event-categories' || arg === '--trace-event-file-pattern' || arg === '--localstorage-file' ||
        arg === '-r' || arg === '--require' || arg === '--import' || arg === '-C' || arg === '--conditions' ||
        internalRequire('internal/process_report').isValueOption(arg) ||
        internalRequire('internal/startup_controls').isValueOption(arg) ||
        internalRequire('internal/permission').isValueOption(arg) ||
        options.isInspectorValueOption(arg) ||
        arg === '--experimental-sea-config' || arg.startsWith('--experimental-sea-config=')) {
      const separator = arg.indexOf('=');
      const name = arg === '-r' ? '--require' : arg === '-C' ? '--conditions' : separator < 0 ? arg : arg.slice(0, separator);
      const value = separator < 0 ? args[++index] : arg.slice(separator + 1);
      if (value === undefined || (separator < 0 && options.isInspectorValueOption(name) && value.startsWith('-')) ||
          ((['--localstorage-file', '--require', '--import', '--conditions'].includes(name) || internalRequire('internal/process_report').isValueOption(name) || internalRequire('internal/startup_controls').isValueOption(name) || internalRequire('internal/permission').isValueOption(name)) &&
          (value === '' || (separator < 0 && value.startsWith('-'))))) return cliError(name + ' requires an argument');
      record(arg, ...(separator < 0 ? [value] : []));
      if (name === '--experimental-sea-config') { sea.prepare(value); return; }
      runtimeFlag(name + '=' + value);
      continue;
    }
    if (arg === '--no-print') { print = false; record(arg); continue; }
    if (arg.startsWith('--print=')) { print = true; record(arg); continue; }
    if (arg === '-p' || arg === '--print') {
      print = true;
      if (args[index + 1] !== undefined && !args[index + 1].startsWith('-')) {
        expression = args[++index]; record(arg, expression);
      } else record(arg);
      continue;
    }
    if (arg === '-e' || arg === '--eval' || arg === '-pe' || arg.startsWith('--eval=')) {
      const separator = arg.indexOf('=');
      if (arg === '-pe') print = true;
      if (separator < 0 && (++index >= args.length || args[index].startsWith('-'))) return cliError((arg === '-pe' ? '--eval' : arg) + ' requires an argument');
      expression = separator < 0 ? args[index] : arg.slice(separator + 1);
      record(arg, ...(separator < 0 ? [expression] : [])); continue;
    }
    if (arg === '--input-type' || arg.startsWith('--input-type=')) {
      const separator = arg.indexOf('=');
      inputType = separator < 0 ? args[++index] : arg.slice(separator + 1);
      if (inputType === undefined || (separator < 0 && inputType.startsWith('-'))) return cliError('--input-type requires an argument');
      if (!['module', 'commonjs', 'module-typescript', 'commonjs-typescript'].includes(inputType))
        return cliError('--input-type must be "module", "commonjs", "module-typescript" or "commonjs-typescript"');
      inputTypeSet = true; record(arg, ...(separator < 0 ? [inputType] : [])); continue;
    }
    if (arg === '-i' || arg === '--interactive') { interactive = true; record(arg); continue; }
    if (arg === '-c' || arg === '--check') { check = true; record(arg); continue; }
    if (arg === '--test') { testMode = true; record(arg); continue; }
    if (arg === '--test-only') { testOptions.only = true; record(arg); continue; }
    if (arg.startsWith('--test-')) {
      const separator = arg.indexOf('=');
      const name = separator < 0 ? arg : arg.slice(0, separator);
      const option = {
        '--test-concurrency': 'concurrency', '--test-timeout': 'timeout', '--test-isolation': 'isolation',
        '--test-name-pattern': 'testNamePatterns', '--test-skip-pattern': 'testSkipPatterns',
        '--test-shard': 'shard', '--test-reporter': 'reporter', '--test-reporter-destination': 'destination',
        '--test-coverage-include': 'coverageIncludeGlobs', '--test-coverage-exclude': 'coverageExcludeGlobs',
        '--test-coverage-lines': 'lineCoverage', '--test-coverage-branches': 'branchCoverage', '--test-coverage-functions': 'functionCoverage',
      }[name];
      if (!option) return cliError('bad option: ' + arg);
      const value = separator < 0 ? args[++index] : arg.slice(separator + 1);
      if (value === undefined) return cliError(name + ' requires an argument');
      record(arg, ...(separator < 0 ? [value] : []));
      if (option === 'reporter') reporterNames.push(value);
      else if (option === 'destination') destinations.push(value);
      else if (option === 'testNamePatterns' || option === 'testSkipPatterns') (testOptions[option] ||= []).push(value);
      else if (option === 'coverageIncludeGlobs' || option === 'coverageExcludeGlobs') (testOptions[option] ||= []).push(value);
      else if (option === 'lineCoverage' || option === 'branchCoverage' || option === 'functionCoverage') {
        const threshold = Number(value);
        if (value === '' || !Number.isInteger(threshold) || threshold < 0 || threshold > 100)
          return cliError(name + ' must be an integer between 0 and 100');
        testOptions[option] = threshold;
      }
      else if (option === 'shard') {
        const [index, total] = value.split('/').map(Number); testOptions.shard = { index, total };
      } else testOptions[option] = option === 'concurrency' || option === 'timeout' ? Number(value) : value;
      continue;
    }
    if (arg === '-v' || arg === '--version') { host.stdout.write('silkjsruntime 0.1.0 (QuickJS; Node 24 target)\n'); return; }
    if (arg === '-h' || arg === '--help') {
      host.stdout.write(`Usage: silkjsruntime [options] [script.js] [arguments]
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
  --insecure-http-parser, --no-insecure-http-parser
  --async-context-frame, --no-async-context-frame
  --expose-gc, --no-expose-gc
  --experimental-eventsource
  --experimental-webstorage, --localstorage-file=PATH
  --experimental-stream-iter
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
  -v, --version
Environment:
  NODE_OPTIONS      Supported runtime flags, applied before CLI flags
  NODE_PATH         Additional CommonJS package lookup directories
  NODE_NO_WARNINGS, NODE_REDIRECT_WARNINGS, NODE_PENDING_DEPRECATION
`);
      return;
    }
    if (arg !== '-' && arg.startsWith('-')) return cliError('bad option: ' + arg);
    break;
  }
  if (runName !== undefined) {
    const separator = native.argv.indexOf('--', 1);
    return internalRequire('internal/main/run').runPackageScript(runName, separator < 0 ? [] : native.argv.slice(separator + 1));
  }
  if (watchMode && expression !== undefined) return cliError('either --watch or --eval can be used, not both');
  if (watchMode && check) return cliError('either --watch or --check can be used, not both');
  if (watchMode && interactive) return cliError('either --watch or --interactive can be used, not both');
  if (expression !== undefined) process._eval = expression;
  process._print_eval = print;
  filename = args[index];
  process.argv = [process.execPath, ...args.slice(index)];
  if (check && expression !== undefined) return cliError('either --check or --eval can be used, not both');
  if (check && testMode) return cliError('either --test or --check can be used, not both');
  if (testMode && (expression !== undefined || interactive || inputTypeSet))
    return cliError('--test cannot be combined with eval, interactive, or input-type');
  if (expression === undefined && filename !== undefined && filename !== '-' && !testMode)
    process.argv[1] = host.path.resolve(filename);
  const entrypoints = [];
  if (!watchMode && !testMode && expression === undefined && filename !== undefined && filename !== '-')
    entrypoints.push(loader.resolveMain(host.path.resolve(filename)).filename);
  installRuntimeOptions(environment.concat(process.execArgv), entrypoints, !watchMode);
  if (watchMode) {
    const supervisor = internalRequire('internal/watch_mode/watch_mode');
    return supervisor.start({
      args: supervisor.withoutWatchOptions(process.execArgv).concat(process.argv.length > 1 ? ['--', ...process.argv.slice(1)] : []),
      paths: watchPaths, preserveOutput: watchPreserveOutput, killSignal: watchKillSignal,
      envFiles: options.environmentFiles(native.argv.slice(1)), env: startupEnvironment,
    });
  }
  host.testCoverageOptions = testOptions;
  if (testOptions.coverage && !testMode && !check) {
    host.testCoverageStart();
    host.testCoveragePrestarted = true;
  }
  return runPreloads(() => {
  if (check) {
    const fromStdin = filename === undefined || filename === '-';
    if (!fromStdin && inputTypeSet) throw Object.assign(new Error('--input-type can only be used with string input via --eval, --print, or STDIN'), { code: 'ERR_INPUT_TYPE_NOT_ALLOWED' });
    const resolved = fromStdin ? null : loader.resolveMain(host.path.resolve(filename));
    const name = fromStdin ? host.path.join(host.cwd(), '[stdin]') : resolved.filename;
    const source = loader.cleanSource(fromStdin ? rawStd.in.readAsString() : host.Buffer.from(host.readFile(name)).toString('utf8'));
    const module = fromStdin ? inputType === 'module' || (!inputTypeSet && native.detectModuleSyntax(source)) : resolved.format === 'module';
    native.checkSyntax(module ? source : loader.Module.wrap(source), name, module);
    return;
  }
  if (testMode) {
    return runTests(testOptions, args.slice(index), reporterNames, destinations);
  }
  if (expression === undefined && filename === undefined && (interactive || process.stdin.isTTY)) return startRepl();
  if (expression !== undefined) {
    const name = host.path.join(host.cwd(), '[eval]');
    expression = prepareInput(expression, name, inputType, inputTypeSet);
    internalRequire('internal/loader/builtin_globals')(globalThis, '<eval>');
    const code = !inputType.startsWith('module') && /\bcrypto\b/.test(expression) ?
      (print ? 'let crypto=require("node:crypto");{' + expression + '}' : '(crypto=>{{' + expression + '}})(require("node:crypto"))') : expression;
    if (inputType.startsWith('module') || (!inputTypeSet && native.detectModuleSyntax(code))) {
      if (print) throw Object.assign(new Error('--print cannot be used with ESM'), { code: 'ERR_EVAL_ESM_CANNOT_PRINT' });
      return afterMain(evaluateMain(code, name));
    }
    installCommonJSInputGlobals(name, '[eval]');
    armInspectorEntry();
    const result = native.compileFunction(code, name, undefined, undefined, undefined, true);
    if (print) console.log(result);
    return afterMain(result);
  }
  if (filename === undefined || filename === '-') {
    let source = rawStd.in.readAsString();
    const name = host.path.join(host.cwd(), '[stdin]');
    process._eval = source;
    source = prepareInput(source, name, inputType, inputTypeSet);
    if (inputType.startsWith('module') || (!inputTypeSet && native.detectModuleSyntax(source))) {
      if (print) throw Object.assign(new Error('--print cannot be used with ESM'), { code: 'ERR_EVAL_ESM_CANNOT_PRINT' });
      return afterMain(evaluateMain(source, name));
    }
    installCommonJSInputGlobals(name, '[stdin]');
    armInspectorEntry();
    const result = native.compileFunction(source, name, undefined, undefined, undefined, true);
    if (print) console.log(result);
    return afterMain(result);
  }
  const path = host.path.resolve(filename);
  process.argv[1] = path;
  const resolved = loader.resolveMain(path);
  mainModuleName = resolved.filename;
  armInspectorEntry();
  return afterMain(loader.runMain(path, inputTypeSet));
  });
}
function referencedWork() {
  if (native.hasPendingIO()) return true;
  for (const timer of timers.values()) if (timer._refed && !timer._destroyed) return true;
  for (const timer of immediates.values()) if (timer._refed && !timer._destroyed) return true;
  return false;
}
function fireTimer(timer, collection) {
  collection.delete(timer._id);
  if (timer._repeat) {
    timer._due = native.now() + timer._delay;
    collection.set(timer._id, timer);
  }
  executingTimers.push(timer);
  try { invokeResource(timer._resource, timer._callback, timer, timer._args, false); }
  finally {
    executingTimers.pop();
    if (!collection.has(timer._id)) {
      timer._destroyed = true;
      timer._resource.emitDestroy();
    }
  }
  checkpoint();
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
  if (ticks.length || immediates.size) return 0;
  if (pendingPromise !== undefined && native.promiseState(pendingPromise) !== 0) return 0;
  const referenced = referencedWork();
  if (!referenced && pendingPromise === undefined) return 0;
  let due = Infinity;
  for (const timer of timers.values()) if (!timer._destroyed && timer._due < due) due = timer._due;
  // A hook may await an unreferenced timer or an externally settled promise.
  // Keep nested waits interruptible without emitting main-loop lifecycle events.
  if (!referenced && due === Infinity) return 1;
  if (due === Infinity) return native.hasPendingIO() ? -1 : 0;
  return Math.max(0, Math.ceil(due - native.now()));
}
function loopTurn(pendingPromise) {
  const now = native.now();
  for (const timer of [...timers.values()].sort((a, b) => a._due - b._due || a._id - b._id)) {
    if (!timer._destroyed && timer._due <= now) fireTimer(timer, timers);
  }
  native.pollIO(pollTimeout(pendingPromise));
  pollWorkers();
  checkpoint();
  for (const listener of loopListeners) listener();
  for (const timer of [...immediates.values()]) {
    if (!timer._destroyed) fireTimer(timer, immediates);
  }
}
function loop() {
  performanceMilestones.loopStart = native.now() - startTime;
  initialNativeIdleTime = native.loopIdleTime();
  while (true) {
    checkpoint();
    pollWorkers();
    if (workerThreads._exitRequested) break;
    if (!referencedWork()) {
      process.emit('beforeExit', Number(process.exitCode) || 0);
      checkpoint();
      if (!referencedWork()) break;
    }
    loopTurn();
  }
  performanceMilestones.loopExit = native.now() - startTime;
  process._exiting = true; const status = Number(process.exitCode) || 0;
  process.emit('exit', status);
  internalRequire('internal/compile_cache').flushCompileCache();
  return Number(process.exitCode) || 0;
}
globalThis.__silkRuntime = {
  normalize(name, parent, attributes) { return loader.resolve(name, parent, 'import', attributes).filename; },
  load(name, attributes) { return loader.loadESM(name, attributes).source; },
  registerSource(filename, source, metadata) {
    internalRequire('internal/source_maps').registerSource(filename, source, { ...metadata, owner: metadata });
    if (!metadata.generated && typeof filename === 'string') {
      return /^[A-Za-z][A-Za-z\d+.-]*:/.test(filename) ? filename : internalRequire('url').pathToFileURL(filename).href;
    }
  },
  importMeta(name) {
    const { pathToFileURL, fileURLToPath } = internalRequire('url');
    const asURL = value => /^[A-Za-z][A-Za-z\d+.-]*:/.test(value) ? value : pathToFileURL(value).href;
    const url = asURL(name);
    const meta = {
      url,
      main: mainModuleName !== undefined && url === asURL(mainModuleName),
      resolve(specifier) { return asURL(loader.resolve(specifier, name, 'import').filename); }
    };
    if (url.startsWith('file:')) {
      meta.filename = fileURLToPath(url);
      meta.dirname = host.path.dirname(meta.filename);
    }
    return meta;
  },
  asyncEvent: asyncHooks._nativeEvent,
  asyncDestroy: asyncHooks._nativeDestroy,
  drainDestroy: asyncHooks._drainDestroy,
  workerError: workerThreads._reportError,
  run: () => invoke(run, undefined, []), loop, onRejection
};
performanceMilestones.bootstrapComplete = native.now() - startTime;
