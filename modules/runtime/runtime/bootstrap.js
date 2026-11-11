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
    factory(module, module.exports, name => internalRequire(name, request));
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
host.builtinLoaded = moduleHas;
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
host.inspectorNative = (operation, ...args) => inspectorNativeOperations[operation](...args);
host.inspectorEntry = wrapper => host.inspectorNative(15, wrapper);
host.typeScriptMode = 'strip';
host.testCoverageStart = () => native.testCoverageNative(0);
host.testCoverageTake = () => native.testCoverageNative(1);
host.testCoverageStop = () => native.testCoverageNative(2);
host.processFeatures = {
  debug: native.debugBuild, uv: true, ipv6: true, inspector: true,
  openssl_is_boringssl: false, quic: false,
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
const wasmResolver = global => wasmCallbacks.get(global);
native.wasmNative('register', wasmResolver);
host.initializeRealmBuiltins = (handle, global, wasmCodeGeneration) => {
  const cache = new Map();
  const bridge = {
    captureCallSites: native.captureCallSites,
    // Throws value again and keeps the throw site its first throw recorded, as
    // V8's TryCatch::ReThrow does for Node's own catch and rethrow paths.
    rethrow(value) { native.captureCallSites(-5, value); },
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
host.nextTick = (callback, ...args) => {
  if (typeof callback !== 'function') throw Object.assign(new TypeError('The callback argument must be a function'), { code: 'ERR_INVALID_ARG_TYPE' });
  ticks.push(callback, args, resource('TickObject'));
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
    if (!ticksPending()) native.drainJobs();
  } while (ticksPending() || rejections.size || completionsPending());
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
globalThis.process = { platform: host.platform, env: host.env, nextTick: host.nextTick, emitWarning: value => host.stderr.write(String(value) + '\n') };
const EventEmitter = internalRequire('events');
const process = new EventEmitter();
defineGlobalAccessor('process', process);
let startTime = native.runtimeStartTime;
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
      asan: 0, ubsan: 0, napi_build_version: '10', node_builtin_shareable_builtins: [], node_shared: false,
      node_shared_openssl: false, node_shared_sqlite: false, node_shared_zstd: false, node_use_amaro: true,
      node_use_openssl: true, node_without_node_options: false, node_quic: false, shlib_suffix: host.platform === 'darwin' ? 'dylib' : 'so',
      single_executable_application: true, icu_small: false, v8_enable_i18n_support: 1, v8_enable_inspector: 1,
    },
  });
}
Object.assign(process, {
  argv: native.argv.slice(), argv0: native.argv[0], execArgv: [], execPath: native.osNative('execPath', []),
  version: 'v' + nodeVersion, versions: componentVersions(), config: buildConfig(),
  platform: host.platform, arch: host.arch, env: host.env, pid: rawOS.getpid(),
  release: {
    name: 'node', lts: 'Krypton',
    sourceUrl: `https://nodejs.org/download/release/v${nodeVersion}/node-v${nodeVersion}.tar.gz`,
    headersUrl: `https://nodejs.org/download/release/v${nodeVersion}/node-v${nodeVersion}-headers.tar.gz`,
  }, stdout: host.stdout, stderr: host.stderr,
  cwd: host.cwd, chdir(path) { const code = rawOS.chdir(path); if (code < 0) throw systemError(code, 'chdir', path); },
  nextTick: host.nextTick, uptime: () => (native.now() - startTime) / 1000,
  hrtime(previous) { const nanoseconds = native.nowNanoseconds(); const value = [Number(nanoseconds / 1000000000n), Number(nanoseconds % 1000000000n)]; if (previous !== undefined) { if (!Array.isArray(previous)) throw Object.assign(new TypeError('The time argument must be an Array'), { code: 'ERR_INVALID_ARG_TYPE' }); if (previous.length !== 2) throw Object.assign(new RangeError('The time argument must contain two entries'), { code: 'ERR_OUT_OF_RANGE' }); value[0] -= previous[0]; value[1] -= previous[1]; if (value[1] < 0) { value[0]--; value[1] += 1000000000; } } return value; },
  emitWarning: internalRequire('internal/startup_controls').emitWarning,
  setUncaughtExceptionCaptureCallback: internalRequire('internal/startup_controls').setUncaughtExceptionCaptureCallback,
  hasUncaughtExceptionCaptureCallback: internalRequire('internal/startup_controls').hasUncaughtExceptionCaptureCallback,
  exit(code) { if (code !== undefined) process.exitCode = code; if (!process._exiting) { process._exiting = true; process.emit('exit', Number(process.exitCode) || 0); } process.reallyExit(Number(process.exitCode) || 0); },
  reallyExit(code) { internalRequire('internal/compile_cache').flushCompileCache(); rawStd.exit(Number(code) | 0); },
  _fatalException: internalRequire('internal/startup_controls').fatalException,
  kill(pid, signal = 'SIGTERM') { const number = typeof signal === 'string' ? rawOS[signal] : signal; if (number === undefined) throw Object.assign(new TypeError('Unknown signal: ' + signal), { code: 'ERR_UNKNOWN_SIGNAL' }); const code = rawOS.kill(pid, number); if (code < 0) throw systemError(code, 'kill'); return true; }
});
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
process.moduleLoadList = moduleLoadList;
define('process', module => { module.exports = process; });
internalRequire('internal/napi').install(host, process);
const eventGlobals = internalRequire('internal/path_events/event_target');
for (const name of ['Event', 'CustomEvent', 'EventTarget', 'AbortController', 'AbortSignal', 'DOMException'])
  Object.defineProperty(globalThis, name, { value: eventGlobals[name], writable: true, enumerable: false, configurable: true });
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
    webGlobals.defineLazy(globalThis, name, loadPerformance, name === 'performance');
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
  // Whether names() lists name, without building the list.
  listed(name) {
    if (typeof name !== 'string') return false;
    if (stringStartsWith(name, 'node:')) {
      const bare = stringSlice(name, 5);
      return prefixOnlyBuiltinHas(bare) && publicBuiltin(bare);
    }
    return !prefixOnlyBuiltinHas(name) && publicBuiltin(name);
  },
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
process.loadEnvFile = function loadEnvFile(path = undefined) { return internalRequire('internal/dotenv').loadEnvFile(path); };
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
  if (host.enableSourceMaps || moduleHas('internal/source_maps')) process.setSourceMapsEnabled(!!host.enableSourceMaps);
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
  if (process.env.NODE_COMPILE_CACHE) internalRequire('internal/compile_cache').initialize();
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
function loadRuntimeEnvironment(args, beforeLoading) {
  const files = internalRequire('internal/options').environmentFiles(args);
  if (!files.length) return;
  if (beforeLoading) beforeLoading();
  const { loaded, errors } = internalRequire('internal/dotenv').loadEnvironmentFiles(files);
  if (errors.length) return cliError(errors.join('\n' + process.execPath + ': '));
  if (loaded) loader.Module._initPaths();
}
function run() {
  if (workerBootstrap) return runWorker();
  if (native.seaNative(0)) return internalRequire('internal/sea').runMain(native.argv.slice(1), runtimeFlag, installRuntimeOptions, runPreloads, loadRuntimeEnvironment);
  // The environment as the process got it, before any environment file: only a
  // watch supervisor needs it, so it is copied only when a file is about to load.
  let startupEnvironment;
  // A script path first means no flags, so no environment file to look for:
  // the option tables load only for flags or NODE_OPTIONS.
  const flags = native.argv.length < 2 || native.argv[1].charCodeAt(0) === 45;
  if (flags) loadRuntimeEnvironment(native.argv.slice(1), () => { startupEnvironment = { ...process.env }; });
  let environment = [];
  if (process.env.NODE_OPTIONS) {
    const options = internalRequire('internal/options');
    try {
      environment = options.parseEnvironment(process.env.NODE_OPTIONS);
      environment.length = options.validateEnvironment(environment);
    } catch (error) {
      return cliError(error.message);
    }
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
    // Every option starts with a dash: anything else is the script.
    if (args[index].charCodeAt(0) !== 45) break;
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
        internalRequire('internal/options').isInspectorValueOption(arg) ||
        arg === '--experimental-sea-config' || arg.startsWith('--experimental-sea-config=')) {
      const separator = arg.indexOf('=');
      const name = arg === '-r' ? '--require' : arg === '-C' ? '--conditions' : separator < 0 ? arg : arg.slice(0, separator);
      const value = separator < 0 ? args[++index] : arg.slice(separator + 1);
      if (value === undefined || (separator < 0 && internalRequire('internal/options').isInspectorValueOption(name) && value.startsWith('-')) ||
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
  // The main script as resolved before any preload ran.
  let early;
  if (!watchMode && !testMode && expression === undefined && filename !== undefined && filename !== '-') {
    early = loader.resolveMain(host.path.resolve(filename));
    entrypoints.push(early.filename);
  }
  installRuntimeOptions(environment.concat(process.execArgv), entrypoints, !watchMode);
  if (watchMode) {
    const supervisor = internalRequire('internal/watch_mode/watch_mode');
    return supervisor.start({
      args: supervisor.withoutWatchOptions(process.execArgv).concat(process.argv.length > 1 ? ['--', ...process.argv.slice(1)] : []),
      paths: watchPaths, preserveOutput: watchPreserveOutput, killSignal: watchKillSignal,
      envFiles: internalRequire('internal/options').environmentFiles(native.argv.slice(1)), env: startupEnvironment ?? { ...process.env },
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
  // Only a preload can register a hook or a mock that resolves it differently.
  const resolved = early !== undefined && !requirePreloads.length && !importPreloads.length ? early : loader.resolveMain(path);
  mainModuleName = resolved.filename;
  armInspectorEntry();
  return afterMain(loader.runMain(path, inputTypeSet, resolved));
  });
}
function referencedWork() {
  if (native.hasPendingIO()) return true;
  // Most I/O-bound turns have no timers: skip creating the iterators.
  if (timers.size !== 0) for (const timer of timers.values()) if (timer._refed && !timer._destroyed) return true;
  if (immediates.size !== 0) for (const timer of immediates.values()) if (timer._refed && !timer._destroyed) return true;
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
  if (ticksPending() || immediates.size) return 0;
  if (pendingPromise !== undefined && native.promiseState(pendingPromise) !== 0) return 0;
  const referenced = referencedWork();
  if (!referenced && pendingPromise === undefined) return 0;
  let due = Infinity;
  if (timers.size !== 0) for (const timer of timers.values()) if (!timer._destroyed && timer._due < due) due = timer._due;
  // A hook may await an unreferenced timer or an externally settled promise.
  // Keep nested waits interruptible without emitting main-loop lifecycle events.
  if (!referenced && due === Infinity) return 1;
  if (due === Infinity) return native.hasPendingIO() ? -1 : 0;
  // To the fraction of a millisecond: rounding up would wait up to one more.
  return Math.max(0, due - native.now());
}
function loopTurn(pendingPromise) {
  const now = native.now();
  // Only the due timers are ordered; most turns have none.
  let due;
  if (timers.size !== 0) for (const timer of timers.values()) if (!timer._destroyed && timer._due <= now) (due ||= []).push(timer);
  if (due !== undefined) {
    if (due.length > 1) due.sort((a, b) => a._due - b._due || a._id - b._id);
    for (const timer of due) if (!timer._destroyed && timer._due <= now) fireTimer(timer, timers);
  }
  native.pollIO(pollTimeout(pendingPromise));
  pollWorkers();
  checkpoint();
  if (loopListeners.size !== 0) for (const listener of loopListeners) listener();
  if (immediates.size !== 0) {
    for (const timer of [...immediates.values()]) {
      if (!timer._destroyed) fireTimer(timer, immediates);
    }
  }
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
      if (!referencedWork()) break;
    }
    loopTurn();
  }
  performanceMilestones.loopExit = native.now() - startTime;
  process._exiting = true;
  invoke(emitProcessEvent, undefined, ['exit']);
  if (moduleHas('internal/compile_cache')) internalRequire('internal/compile_cache').flushCompileCache();
  return Number(process.exitCode) || 0;
}
const imageModules = ['fs', 'fs/promises', 'internal/fs_streams', 'internal/fs_utf8_stream', 'path', 'os',
  'events', 'stream', 'stream/promises', 'string_decoder', 'util', 'assert', 'console', 'net', 'tty',
  'internal/tty/write', 'url', 'internal/web/url', 'internal/web/encoding', 'internal/abort_controller'];
globalThis.__silkRuntime = {
  normalize(name, parent, attributes) { return loader.resolve(name, parent, 'import', attributes).filename; },
  load(name, attributes) { return loader.loadESM(name, attributes).source; },
  registerSource(filename, source, metadata) {
    host.registerSource(filename, source, { ...metadata, owner: metadata });
    if (!metadata.generated && typeof filename === 'string') {
      return /^[A-Za-z][A-Za-z\d+.-]*:/.test(filename) ? filename : fileHref(filename);
    }
  },
  importMeta(name) {
    const asURL = value => /^[A-Za-z][A-Za-z\d+.-]*:/.test(value) ? value : fileHref(value);
    const url = asURL(name);
    const meta = {
      url,
      main: mainModuleName !== undefined && url === asURL(mainModuleName),
      resolve(specifier) { return asURL(loader.resolve(specifier, name, 'import').filename); }
    };
    if (url.startsWith('file:')) {
      meta.filename = url === 'file://' + name ? name : internalRequire('url').fileURLToPath(url);
      meta.dirname = host.path.dirname(meta.filename);
    }
    return meta;
  },
  asyncEvent: asyncHooks._nativeEvent,
  asyncDestroy: asyncHooks._nativeDestroy,
  drainDestroy: asyncHooks._drainDestroy,
  workerError: workerThreads._reportError,
  run: () => invoke(run, undefined, []), loop, onRejection,
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
  },
  // Starts a process from a heap image: everything the bootstrap took from the
  // process that built the image is taken again from this one.
  hydrate(argv, runtimeStartTime, environmentTime) {
    native.argv = argv;
    startTime = runtimeStartTime;
    performanceMilestones.environment = environmentTime - startTime;
    host.performanceStartTime = startTime;
    host.performanceTimeOrigin = Date.now() - (native.now() - startTime);
    process.argv = argv.slice(); process.argv0 = argv[0];
    process.execPath = native.osNative('execPath', []); process.pid = rawOS.getpid();
    native.wasmNative('register', wasmResolver);
    loader.Module._initPaths();
    internalRequire('internal/child_process/ipc').installChild(process);
    internalRequire('internal/watch_mode/dependencies').initialize();
    if (process.env.NODE_UNIQUE_ID !== undefined) internalRequire('cluster');
    for (const refresh of hydrations) refresh();
    performanceMilestones.bootstrapComplete = native.now() - startTime;
  }
};
performanceMilestones.bootstrapComplete = native.now() - startTime;
