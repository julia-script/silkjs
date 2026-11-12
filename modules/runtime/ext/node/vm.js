'use strict';
// vm creates realms, not a security boundary. Native handles own context/bytecode
// edges; JavaScript keeps only weak associations with public sandbox objects.
const host = require('internal/host');
const { Buffer } = require('buffer');
const { createHash } = require('crypto');
const {
  ArrayBufferIsView, DataViewPrototypeGetBuffer, DataViewPrototypeGetByteOffset,
  DataViewPrototypeGetByteLength, TypedArrayPrototypeGetBuffer,
  TypedArrayPrototypeGetByteOffset, TypedArrayPrototypeGetByteLength, Uint8Array,
} = require('internal/streams/iter/primordials');
const { isDataView, isModuleNamespaceObject } = require('util/types');
const contexts = new WeakMap();
const scripts = new WeakMap();
const modules = new WeakMap();
let nextModuleId = 0;
const cacheMagic = Buffer.from('SILKVM01');
const cacheIdentity = Buffer.from(host.cacheBuildIdentity, 'hex');
const CACHE_HEADER = 120;
const DONT_CONTEXTIFY = Symbol('vm_context_no_contextify');
const USE_MAIN_CONTEXT_DEFAULT_LOADER = Symbol('vm_dynamic_import_main_context_default');
const constants = Object.freeze(Object.assign(Object.create(null), { USE_MAIN_CONTEXT_DEFAULT_LOADER, DONT_CONTEXTIFY }));
function error(code, message, Type = TypeError) {
  return Object.assign(new Type(message), { code });
}
const { ERR_INVALID_ARG_TYPE } = require('internal/path_events/support').codes;
// Node's ERR_INVALID_ARG_TYPE wording, with what was received.
function invalid(name, expected, value) { return new ERR_INVALID_ARG_TYPE(name, expected, value); }
function unsupported(surface) {
  throw error('ERR_NOT_IMPLEMENTED', `${surface} is not supported by this runtime`, Error);
}
function options(value, string = false) {
  if (value === undefined) return {};
  if (string && typeof value === 'string') return { filename: value };
  if (value === null || typeof value !== 'object') throw invalid('options', 'object', value);
  return value;
}
function integer(value, name, min, max) {
  if (typeof value !== 'number') throw invalid(name, 'number', value);
  if (!Number.isInteger(value) || value < min || value > max)
    throw error('ERR_OUT_OF_RANGE', `The value of "${name}" is out of range`, RangeError);
  return value;
}
function boolean(value, name) {
  if (typeof value !== 'boolean') throw invalid(name, 'boolean', value);
  return value;
}
function contextData(value) {
  const data = contexts.get(value);
  if (!data) throw value === null || typeof value !== 'object' ? invalid('object', 'object', value) : invalid('contextifiedObject', 'vm.Context', value);
  return data;
}
function contextOptions(value) {
  const opts = options(value);
  // Index loops: user code may have removed Array.prototype[Symbol.iterator].
  if (opts.name !== undefined && typeof opts.name !== 'string') throw invalid('options.name', 'string', opts.name);
  if (opts.origin !== undefined && typeof opts.origin !== 'string') throw invalid('options.origin', 'string', opts.origin);
  if (opts.microtaskMode !== undefined && opts.microtaskMode !== 'afterEvaluate')
    throw error('ERR_INVALID_ARG_VALUE', 'options.microtaskMode must be "afterEvaluate"');
  let strings = true, wasm = true;
  if (opts.codeGeneration !== undefined) {
    const generation = options(opts.codeGeneration);
    if (generation.strings !== undefined) strings = boolean(generation.strings, 'options.codeGeneration.strings');
    if (generation.wasm !== undefined) wasm = boolean(generation.wasm, 'options.codeGeneration.wasm');
  }
  return { strings, wasm, afterEvaluate: opts.microtaskMode === 'afterEvaluate', name: opts.name, origin: opts.origin };
}
function createContext(sandbox = {}, value) {
  if (sandbox !== DONT_CONTEXTIFY && (sandbox === null || typeof sandbox !== 'object')) throw invalid('contextObject', 'object', sandbox);
  const config = contextOptions(value);
  if (sandbox !== DONT_CONTEXTIFY && contexts.has(sandbox)) return sandbox;
  const handle = host.vmCreateContext(config.afterEvaluate);
  const global = host.vmGlobal(handle);
  host.initializeRealmBuiltins(handle, global, config.wasm);
  let result = global;
  if (sandbox !== DONT_CONTEXTIFY) {
    // The sandbox mirror and the realm's binding record have distinct property
    // attributes. A host exotic object preserves both without Proxy invariants.
    const proxy = host.vmContextGlobal(handle, {
      has(key) { return Reflect.has(sandbox, key) || Reflect.has(global, key); },
      get(key) {
        return Reflect.has(sandbox, key) ? Reflect.get(sandbox, key, sandbox) : Reflect.get(global, key, global);
      },
      set(key, value, receiver) {
        if (receiver !== proxy) return Reflect.set(sandbox, key, value, receiver);
        const own = Reflect.getOwnPropertyDescriptor(sandbox, key);
        const backing = Reflect.getOwnPropertyDescriptor(global, key);
        const descriptor = own || backing;
        if (descriptor && (('writable' in descriptor && !descriptor.writable) || ('set' in descriptor && !descriptor.set))) return false;
        const mirrored = Reflect.set(sandbox, key, value, sandbox);
        const stored = Reflect.set(global, key, value, global);
        return mirrored || stored;
      },
      defineProperty(key, descriptor, declaration) {
        if (!Reflect.defineProperty(global, key, descriptor)) return false;
        const own = Reflect.getOwnPropertyDescriptor(sandbox, key);
        const visible = declaration && (!own || own.configurable) ? { ...descriptor, configurable: true } : descriptor;
        Reflect.defineProperty(sandbox, key, visible);
        return true;
      },
      deleteProperty(key) {
        if (Object.hasOwn(sandbox, key) && !Reflect.deleteProperty(sandbox, key)) return false;
        return Reflect.deleteProperty(global, key);
      },
      getOwnPropertyDescriptor(key) {
        return Reflect.getOwnPropertyDescriptor(sandbox, key) || Reflect.getOwnPropertyDescriptor(global, key);
      },
      ownKeys() {
        const keys = Reflect.ownKeys(sandbox);
        const globalKeys = Reflect.ownKeys(global);
        for (let i = 0; i < globalKeys.length; i++) if (!keys.includes(globalKeys[i])) keys.push(globalKeys[i]);
        return keys;
      },
      getPrototypeOf() { return Reflect.getPrototypeOf(global); },
      setPrototypeOf(prototype) { return Reflect.setPrototypeOf(global, prototype); },
      isExtensible() { return Reflect.isExtensible(global); },
      preventExtensions() { return false; },
    }, host.vmClassId, sandbox, global);
    Reflect.defineProperty(global, 'globalThis', { value: proxy, configurable: true, writable: true });
    host.vmSetGlobal(handle, proxy);
    host.rebindRealmBuiltins(global, proxy);
    result = sandbox;
  }
  host.vmSetCodeGeneration(handle, config.strings);
  contexts.set(result, { handle, afterEvaluate: config.afterEvaluate });
  require('internal/inspector_contexts').register(result, handle, config);
  return result;
}
function isContext(value) {
  if (value === null || typeof value !== 'object') throw invalid('object', 'object', value);
  return contexts.has(value);
}
function compileOptions(value, defaultFilename = 'evalmachine.<anonymous>') {
  const opts = options(value, true);
  const filename = opts.filename === undefined ? defaultFilename : opts.filename;
  if (typeof filename !== 'string') throw invalid('options.filename', 'string', filename);
  const line = opts.lineOffset === undefined ? 0 : integer(opts.lineOffset, 'options.lineOffset', -2147483648, 2147483647);
  const column = opts.columnOffset === undefined ? 0 : integer(opts.columnOffset, 'options.columnOffset', -2147483648, 2147483647);
  validateImportCallback(opts.importModuleDynamically);
  if (opts.cachedData !== undefined && !ArrayBufferIsView(opts.cachedData)) throw invalid('options.cachedData', ['Buffer', 'TypedArray', 'DataView'], opts.cachedData);
  if (opts.produceCachedData !== undefined) boolean(opts.produceCachedData, 'options.produceCachedData');
  return { opts, filename, line, column };
}
// Parser locations are real lexical coordinates. Presentation offsets never
// alter source bytes, directive prologues, line continuations, or parser state.
function syntaxDiagnostic(cause, source, filename, line, column, prefix = 0) {
  if (!cause || cause.name !== 'SyntaxError' || !Number.isInteger(cause.lineNumber)) throw cause;
  const sourceLine = cause.lineNumber;
  const sourceColumn = cause.columnNumber - (sourceLine === 1 ? prefix : 0);
  const lines = source.split(/\r\n|[\n\r\u2028\u2029]/);
  const text = lines[sourceLine - 1] || '';
  cause.lineNumber = (sourceLine + line) | 0;
  cause.columnNumber = (sourceColumn + (sourceLine === 1 ? column : 0)) | 0;
  cause.fileName = filename;
  const frames = typeof cause.stack === 'string' ? cause.stack.split('\n').slice(1).join('\n') : '';
  const caret = text.slice(0, Math.max(0, sourceColumn - 1)).replace(/[^\t]/g, ' ') +
    (cause.columnNumber === 0 ? '' : '^');
  cause.stack = `${filename}:${cause.lineNumber}\n${text}\n${caret}\n\n${cause.name}: ${cause.message}\n${frames}`;
  throw cause;
}
function compile(source, filename, line, column, prefix = 0, body = source) {
  try { return host.vmCompile(source, filename, undefined, line, column, prefix); }
  catch (cause) { syntaxDiagnostic(cause, body, filename, line, column, prefix); }
}
function runOptions(value) {
  const opts = options(value);
  const { timeout: duration, displayErrors, breakOnSigint = false } = opts;
  const timeout = duration === undefined ? 0 : integer(duration, 'options.timeout', 1, 4294967295);
  if (displayErrors !== undefined) boolean(displayErrors, 'options.displayErrors');
  boolean(breakOnSigint, 'options.breakOnSigint');
  return { timeout, breakOnSigint };
}
function digest(value, encoding) { return createHash('sha256').update(value, encoding).digest(); }
function writeCache(handle, source, kind) {
  const payload = Buffer.from(host.vmWriteCache(handle));
  const cache = Buffer.allocUnsafe(CACHE_HEADER + payload.byteLength);
  cacheMagic.copy(cache, 0);
  cache.writeUInt32LE(kind, 8);
  cache.writeUInt32LE(0, 12);
  cache.writeBigUInt64LE(BigInt(payload.byteLength), 16);
  cacheIdentity.copy(cache, 24);
  digest(source, 'utf16le').copy(cache, 56);
  digest(payload).copy(cache, 88);
  payload.copy(cache, CACHE_HEADER);
  return cache;
}
function cachedHandle(value, source, filename, line, column, prefix = 0, kind = 0) {
  let cache;
  try {
    // Snapshot before hashing: a SharedArrayBuffer writer must not race admission.
    const view = isDataView(value) ?
      new Uint8Array(DataViewPrototypeGetBuffer(value), DataViewPrototypeGetByteOffset(value), DataViewPrototypeGetByteLength(value)) :
      new Uint8Array(TypedArrayPrototypeGetBuffer(value), TypedArrayPrototypeGetByteOffset(value), TypedArrayPrototypeGetByteLength(value));
    cache = Buffer.from(view);
  } catch (cause) {
    if (cause instanceof TypeError || cause instanceof RangeError) return undefined;
    throw cause;
  }
  if (cache.byteLength < CACHE_HEADER ||
      !cache.subarray(0, 8).equals(cacheMagic) ||
      cache.readUInt32LE(8) !== kind || cache.readUInt32LE(12) !== 0 ||
      cache.readBigUInt64LE(16) !== BigInt(cache.byteLength - CACHE_HEADER) ||
      !cache.subarray(24, 56).equals(cacheIdentity) ||
      !cache.subarray(56, 88).equals(digest(source, 'utf16le')) ||
      !cache.subarray(88, 120).equals(digest(cache.subarray(CACHE_HEADER)))) return undefined;
  try {
    return host.vmReadCache(cache.buffer, cache.byteOffset + CACHE_HEADER,
      cache.byteLength - CACHE_HEADER, filename, line, column, prefix);
  } catch (cause) {
    // Checksums do not make externally supplied bytecode safe. The native reader
    // independently validates operands, control flow, metadata and ownership.
    // null: the cache is valid, but a debugger needs code compiled with metadata.
    if (cause instanceof SyntaxError && cause.message === 'Silk script cache has no debugger metadata') return null;
    if (cause instanceof SyntaxError || cause instanceof TypeError || cause instanceof RangeError) return undefined;
    throw cause;
  }
}
const terminationErrors = new WeakSet();
function terminationError(code, message) {
  const result = error(code, message, Error);
  terminationErrors.add(result);
  return result;
}
function run(handle, { timeout, breakOnSigint }, afterEvaluate, wrapSignals = true) {
  let listeners;
  if (breakOnSigint && wrapSignals && process.listenerCount('SIGINT') > 0) {
    listeners = process.rawListeners('SIGINT');
    process.removeAllListeners('SIGINT');
  }
  try { return host.vmRun(handle, timeout, afterEvaluate, breakOnSigint); }
  catch (cause) {
    if (cause && typeof cause.message === 'string' && cause.message.startsWith('ERR_SCRIPT_EXECUTION_TIMEOUT:')) {
      throw terminationError('ERR_SCRIPT_EXECUTION_TIMEOUT', `Script execution timed out${timeout ? ` after ${timeout}ms` : ''}`);
    }
    if (cause && typeof cause.message === 'string' && cause.message.startsWith('ERR_SCRIPT_EXECUTION_INTERRUPTED:')) {
      throw terminationError('ERR_SCRIPT_EXECUTION_INTERRUPTED', 'Script execution was interrupted by `SIGINT`');
    }
    if (cause && typeof cause.message === 'string' && cause.message.startsWith('ERR_CANNOT_WATCH_SIGINT:')) {
      throw error('ERR_CANNOT_WATCH_SIGINT', 'Cannot watch for SIGINT signals', Error);
    }
    throw cause;
  } finally {
    if (listeners) for (let i = 0; i < listeners.length; i++) process.addListener('SIGINT', listeners[i]);
  }
}
function validateImportCallback(callback, module = false) {
  if (callback !== undefined && typeof callback !== 'function' &&
      (module || callback !== USE_MAIN_CONTEXT_DEFAULT_LOADER)) {
    throw invalid('options.importModuleDynamically', 'function', callback);
  }
}
function importCallback(callback, referrer, filename, functionRef = false) {
  if (callback === USE_MAIN_CONTEXT_DEFAULT_LOADER) return host.vmCreateDefaultImporter(filename);
  return async (specifier, attributes) => {
    if (callback === undefined) throw error('ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING', 'A dynamic import callback was not specified.', TypeError);
    if (!host.experimentalVmModules) throw error('ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG', 'A dynamic import callback was invoked without --experimental-vm-modules', TypeError);
    const imported = await callback(specifier, functionRef ? referrer() : referrer, attributes || Object.create(null), 'evaluation');
    if (isModuleNamespaceObject(imported)) return imported;
    if (!modules.has(imported)) throw error('ERR_VM_MODULE_NOT_MODULE', 'Provided module is not an instance of Module', Error);
    if (imported.status === 'errored') throw imported.error;
    return imported.namespace;
  };
}
const { kInternalImportModuleDynamically } = require('internal/vm');
class Script {
  constructor(code, value) {
    const source = String(code);
    const { opts, filename, line, column } = compileOptions(value);
    let handle;
    if (opts.cachedData !== undefined) {
      handle = cachedHandle(opts.cachedData, source, filename, line, column);
      this.cachedDataRejected = handle === undefined;
    }
    if (handle == null) handle = compile(source, filename, line, column);
    // A built-in (makeContextifyScript) may give its own import() handler, which
    // like Node's internal referrers needs no --experimental-vm-modules.
    const internalImport = opts[kInternalImportModuleDynamically];
    const dynamicImport = internalImport !== undefined ? (specifier, attributes) => internalImport(specifier, this, attributes || Object.create(null), 'evaluation')
      : importCallback(opts.importModuleDynamically, this, filename);
    host.vmSetImportModuleDynamically(handle, dynamicImport);
    scripts.set(this, { source, handle, dynamicImport, realms: new WeakMap() });
    // The last "//# sourceMappingURL=" magic comment, as V8 reports it.
    let mapURL;
    for (const match of source.matchAll(/\/\/[#@][ \t]+sourceMappingURL=[ \t]*([^\s'"]+)[ \t]*$/gm)) mapURL = match[1];
    this.sourceMapURL = mapURL;
    if (opts.produceCachedData) {
      this.cachedData = this.createCachedData();
      this.cachedDataProduced = true;
    }
  }
  runInThisContext(value) {
    const data = scriptData(this);
    return run(data.handle, runOptions(value), false);
  }
  runInContext(contextifiedObject, value) {
    const data = scriptData(this);
    const context = contextData(contextifiedObject);
    const execution = runOptions(value);
    let handle = data.realms.get(contextifiedObject);
    if (!handle) {
      handle = host.vmCloneScript(data.handle, context.handle);
      host.vmSetImportModuleDynamically(handle, data.dynamicImport);
      data.realms.set(contextifiedObject, handle);
    }
    return run(handle, execution, context.afterEvaluate);
  }
  runInNewContext(sandbox, value) {
    // As in Node, the context takes its options under context-prefixed names.
    const contextOptions = value === null || typeof value !== 'object' ? undefined : {
      name: value.contextName, origin: value.contextOrigin,
      codeGeneration: value.contextCodeGeneration, microtaskMode: value.microtaskMode,
    };
    return this.runInContext(createContext(sandbox, contextOptions), value);
  }
  createCachedData() {
    const data = scriptData(this);
    return writeCache(data.handle, data.source, 0);
  }
}
function scriptData(value) {
  const data = scripts.get(value);
  if (!data) throw error('ERR_INVALID_THIS', 'Value of "this" must be a Script');
  return data;
}
function createScript(code, value) { return new Script(code, value); }
// The functions take a filename string in place of options, as Node's do.
const scriptOptions = value => typeof value === 'string' ? { filename: value } : value;
function runInContext(code, contextifiedObject, value) {
  contextData(contextifiedObject);
  value = scriptOptions(value);
  return new Script(code, value).runInContext(contextifiedObject, value);
}
function runInNewContext(code, sandbox, value) { value = scriptOptions(value); return new Script(code, value).runInNewContext(sandbox, value); }
function runInThisContext(code, value) { value = scriptOptions(value); return new Script(code, value).runInThisContext(value); }
function compileFunction(code, params = [], value) {
  if (typeof code !== 'string') throw invalid('code', 'string', code);
  if (!Array.isArray(params)) throw invalid('params', 'Array', params);
  for (let i = 0; i < params.length; i++) {
    const name = params[i];
    if (typeof name !== 'string') throw invalid(`params[${i}]`, 'string', name);
    if (!/^[$_\p{ID_Start}][$\u200c\u200d_\p{ID_Continue}]*$/u.test(name)) throw new SyntaxError('Invalid function parameter name');
  }
  const { opts, filename, line, column } = compileOptions(value, '');
  const context = opts.parsingContext === undefined ? undefined : contextData(opts.parsingContext);
  const extensions = opts.contextExtensions === undefined ? [] : opts.contextExtensions;
  if (!Array.isArray(extensions)) throw invalid('options.contextExtensions', 'Array', extensions);
  for (let i = 0; i < extensions.length; i++) {
    if (extensions[i] === null || typeof extensions[i] !== 'object') throw invalid(`options.contextExtensions[${i}]`, 'object', extensions[i]);
  }
  // This factory is compiled in the actual parsing realm. with-environments hold
  // live extension objects, not copied bindings. The function has its own this
  // and arguments; no hidden identifier is injected into its lexical scope.
  let source = '(function(){';
  for (let i = 0; i < extensions.length; i++) source += `with(this[${i}]){`;
  source += `return function(${params.join(',')}){`;
  const prefix = source.length;
  source += `${code}\n};`;
  source += '}'.repeat(extensions.length) + '})';
  let handle = opts.cachedData === undefined ? undefined : cachedHandle(opts.cachedData, source, filename, line, column, prefix, 1);
  const rejected = opts.cachedData !== undefined && handle === undefined;
  if (handle == null) {
    try { host.vmValidateFunctionBody(code, filename, context && context.handle); }
    catch (cause) { syntaxDiagnostic(cause, code, filename, line, column); }
    handle = compile(source, filename, line, column, prefix, code);
  }
  const factoryHandle = context ? host.vmCloneScript(handle, context.handle) : handle;
  let result;
  // compileFunction's callback receives the returned function, not its factory.
  const callback = importCallback(opts.importModuleDynamically, () => result, filename, true);
  host.vmSetImportModuleDynamically(factoryHandle, callback);
  const factory = run(factoryHandle, { timeout: 0, breakOnSigint: false }, false);
  result = Reflect.apply(factory, extensions, []);
  host.setFunctionSource(result, code, line, column);
  if (opts.cachedData !== undefined) result.cachedDataRejected = rejected;
  if (opts.produceCachedData) {
    result.cachedData = writeCache(handle, source, 1);
    result.cachedDataProduced = true;
  }
  return result;
}
function moduleData(value) {
  const data = modules.get(value);
  if (!data) throw error('ERR_INVALID_THIS', 'Value of "this" must be a Module');
  return data;
}
function moduleStatus(data) {
  const status = host.vmModule(8, data.handle);
  return status === 0 && data.linking ? 'linking' :
    ['unlinked', 'linking', 'linked', 'evaluating', 'evaluated', 'errored'][status];
}
function moduleOptions(value) {
  const opts = options(value);
  if (opts.identifier !== undefined && typeof opts.identifier !== 'string') throw invalid('options.identifier', 'string', opts.identifier);
  const context = opts.context === undefined ? undefined : contextData(opts.context);
  return { opts, context, identifier: opts.identifier === undefined ? `vm:module(${nextModuleId++})` : opts.identifier };
}
function requireDependency(value, owner) {
  if (!modules.has(value)) throw error('ERR_VM_MODULE_NOT_MODULE', 'Provided module is not an instance of Module', Error);
  const data = moduleData(value);
  if (data.context !== owner.context) throw error('ERR_VM_MODULE_DIFFERENT_CONTEXT', 'Linked modules must use the same context', Error);
  if (moduleStatus(data) === 'errored') throw error('ERR_VM_MODULE_LINK_FAILURE', 'request for an errored module', Error);
  return data;
}
function bindRequests(data, dependencies) {
  if (!Array.isArray(dependencies)) throw invalid('modules', 'Array', dependencies);
  if (dependencies.length !== data.requests.length) throw error('ERR_MODULE_LINK_MISMATCH', 'Expected one module for each module request', Error);
  for (const dependency of dependencies) requireDependency(dependency, data);
  for (let i = 0; i < dependencies.length; i++) host.vmModule(5, data.handle, i, moduleData(dependencies[i]).handle);
  data.dependencies = dependencies.slice();
}
async function stageLink(module, linker, visited) {
  if (visited.has(module)) return;
  visited.add(module);
  const data = moduleData(module);
  if (moduleStatus(data) !== 'unlinked' && moduleStatus(data) !== 'linking') return;
  if (!data.requestsPromise) {
    data.linking = true;
    data.requestsPromise = Promise.all(data.requests.map(async request => {
      const attributes = Object.assign(Object.create(null), request.attributes);
      const dependency = await linker(request.specifier, module, { attributes, assert: attributes });
      requireDependency(dependency, data);
      return dependency;
    })).then(dependencies => { bindRequests(data, dependencies); });
  }
  await data.requestsPromise;
  for (const dependency of data.dependencies) await stageLink(dependency, linker, visited);
}
function instantiateModule(module) {
  const visited = new Set();
  function collect(current) {
    if (visited.has(current)) return;
    visited.add(current);
    const data = moduleData(current);
    if (moduleStatus(data) === 'errored') throw current.error;
    if (data.dependencies === undefined && data.requests.length !== 0) throw error('ERR_VM_MODULE_LINK_FAILURE', 'Module requests must be linked before instantiation', Error);
    for (const dependency of data.dependencies || []) collect(dependency);
  }
  collect(module);
  try { host.vmModule(6, moduleData(module).handle); }
  finally { for (const current of visited) moduleData(current).linking = false; }
}
const moduleToken = {};
class Module {
  constructor(token, data) {
    if (token !== moduleToken) throw error('ERR_ILLEGAL_CONSTRUCTOR', 'Illegal constructor');
    modules.set(this, data);
  }
  get identifier() { return moduleData(this).identifier; }
  get context() { return moduleData(this).context; }
  [Symbol.for('nodejs.util.inspect.custom')](depth, options) {
    moduleData(this);
    if (typeof depth === 'number' && depth < 0) return this;
    const constructor = Object.getPrototypeOf(this)?.constructor || Module;
    const view = { __proto__: { constructor } };
    view.status = this.status;
    view.identifier = this.identifier;
    view.context = this.context;
    Object.setPrototypeOf(view, Object.getPrototypeOf(this));
    Object.defineProperty(view, Symbol.toStringTag, { value: constructor.name, configurable: true });
    return require('util').inspect(view, { ...options, customInspect: false });
  }
  get status() { return moduleStatus(moduleData(this)); }
  get namespace() {
    const data = moduleData(this);
    if (host.vmModule(8, data.handle) < 2) throw error('ERR_VM_MODULE_STATUS', 'Module status must not be unlinked or linking', Error);
    return host.vmModule(7, data.handle);
  }
  get error() {
    const data = moduleData(this);
    if (moduleStatus(data) !== 'errored') throw error('ERR_VM_MODULE_STATUS', 'Module status must be errored', Error);
    return data.terminated ? null : host.vmModule(9, data.handle);
  }
  async link(linker) {
    const data = moduleData(this);
    if (typeof linker !== 'function') throw invalid('linker', 'function', linker);
    // Node 24 synthetic modules are already instantiated at construction.
    if (data.synthetic) return;
    if (moduleStatus(data) !== 'unlinked') throw error('ERR_VM_MODULE_STATUS', 'Module status must be unlinked', Error);
    await stageLink(this, linker, new Set());
    instantiateModule(this);
  }
  // As in Node, the engine's own evaluation promise: already settled when the module
  // (or a synthetic one's evaluation step) finished synchronously.
  evaluate(value) {
    try {
      const data = moduleData(this);
      const execution = runOptions(value);
      const status = moduleStatus(data);
      if (status === 'unlinked' || status === 'linking') throw error('ERR_VM_MODULE_STATUS', 'Module status must be one of linked, evaluated, or errored', Error);
      if (data.terminated) throw null;
      let result;
      try { result = run(data.handle, execution, data.realm ? data.realm.afterEvaluate : false, false); }
      catch (cause) {
        if (terminationErrors.has(cause)) {
          const visited = new Set();
          const terminate = current => {
            if (visited.has(current)) return;
            visited.add(current);
            const state = moduleData(current);
            if (moduleStatus(state) === 'errored') state.terminated = true;
            const dependencies = state.dependencies || [];
            for (let i = 0; i < dependencies.length; i++) terminate(dependencies[i]);
          };
          terminate(this);
        }
        throw cause;
      }
      return result instanceof Promise ? result : Promise.resolve(result);
    } catch (cause) { return Promise.reject(cause); }
  }
}
class SourceTextModule extends Module {
  constructor(code, value) {
    if (typeof code !== 'string') throw invalid('code', 'string', code);
    const { opts, context, identifier } = moduleOptions(value);
    validateImportCallback(opts.importModuleDynamically, true);
    if (opts.initializeImportMeta !== undefined && typeof opts.initializeImportMeta !== 'function') throw invalid('options.initializeImportMeta', 'function', opts.initializeImportMeta);
    const line = opts.lineOffset === undefined ? 0 : integer(opts.lineOffset, 'options.lineOffset', -2147483648, 2147483647);
    const column = opts.columnOffset === undefined ? 0 : integer(opts.columnOffset, 'options.columnOffset', -2147483648, 2147483647);
    let handle;
    try { handle = host.vmModule(0, code, identifier, context && context.handle, line, column); }
    catch (cause) { syntaxDiagnostic(cause, code, identifier, line, column); }
    const requests = [];
    const count = host.vmModule(3, handle);
    for (let i = 0; i < count; i++) {
      const attributes = Object.freeze(Object.assign(Object.create(null), host.vmModule(4, handle, i, 1)));
      requests.push(Object.freeze(Object.assign(Object.create(null), { specifier: host.vmModule(4, handle, i, 0), attributes, phase: 'evaluation' })));
    }
    super(moduleToken, { handle, identifier, context: opts.context, realm: context, requests: Object.freeze(requests), linking: false });
    host.vmSetImportModuleDynamically(handle, importCallback(opts.importModuleDynamically, this, identifier));
    const initializeImportMeta = opts.initializeImportMeta;
    if (initializeImportMeta !== undefined) host.vmModule(11, handle, meta => initializeImportMeta(meta, this));
  }
  get dependencySpecifiers() { return Object.freeze(moduleData(this).requests.map(request => request.specifier)); }
  get moduleRequests() { return moduleData(this).requests; }
  linkRequests(dependencies) {
    const data = moduleData(this);
    if (moduleStatus(data) !== 'unlinked') throw error('ERR_VM_MODULE_STATUS', 'Module status must be unlinked', Error);
    bindRequests(data, dependencies);
  }
  instantiate() {
    const data = moduleData(this);
    if (moduleStatus(data) !== 'unlinked') throw error('ERR_VM_MODULE_STATUS', 'Module status must be unlinked', Error);
    instantiateModule(this);
  }
  hasTopLevelAwait() { return host.vmModule(12, moduleData(this).handle); }
  hasAsyncGraph() {
    const data = moduleData(this);
    if (moduleStatus(data) === 'unlinked' || moduleStatus(data) === 'linking') throw error('ERR_VM_MODULE_STATUS', 'Module status must be linked', Error);
    const seen = new Set(), pending = [this];
    while (pending.length) {
      const current = pending.pop();
      if (seen.has(current)) continue;
      seen.add(current);
      const entry = moduleData(current);
      if (host.vmModule(12, entry.handle)) return true;
      pending.push(...(entry.dependencies || []));
    }
    return false;
  }
}
class SyntheticModule extends Module {
  constructor(exportNames, evaluateCallback, value) {
    if (!Array.isArray(exportNames)) throw invalid('exportNames', 'Array', exportNames);
    const names = new Set();
    for (let i = 0; i < exportNames.length; i++) {
      const name = exportNames[i];
      if (typeof name !== 'string') throw invalid(`exportNames[${i}]`, 'string', name);
      if (names.has(name)) throw error('ERR_INVALID_ARG_VALUE', `The property 'exportNames' contains duplicate export '${name}'`);
      names.add(name);
    }
    if (typeof evaluateCallback !== 'function') throw invalid('evaluateCallback', 'function', evaluateCallback);
    const { opts, context, identifier } = moduleOptions(value);
    let module;
    const handle = host.vmModule(1, identifier, context && context.handle, () => Reflect.apply(evaluateCallback, module, []));
    for (const name of names) host.vmModule(2, handle, name);
    host.vmModule(6, handle);
    super(moduleToken, { handle, identifier, context: opts.context, realm: context, requests: [], dependencies: [], synthetic: true, names });
    module = this;
  }
  setExport(name, value) {
    const data = moduleData(this);
    if (typeof name !== 'string') throw invalid('name', 'string', name);
    if (!data.synthetic) throw error('ERR_INVALID_THIS', 'Value of "this" must be a SyntheticModule');
    if (!data.names.has(name)) throw new ReferenceError(`Export '${name}' is not defined in module`);
    host.vmModule(10, data.handle, name, value);
  }
}
module.exports = { Script, createContext, createScript, isContext, runInContext, runInNewContext, runInThisContext, compileFunction, constants };
if (host.experimentalVmModules) Object.assign(module.exports, { Module, SourceTextModule, SyntheticModule });
