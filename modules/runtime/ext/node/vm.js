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
const { isDataView } = require('util/types');
const {
  contexts, error, invalid, contextData, isContext, syntaxDiagnostic, run,
} = require('internal/vm');
const scripts = new WeakMap();
const cacheMagic = Buffer.from('SILKVM01');
const cacheIdentity = Buffer.from(host.cacheBuildIdentity, 'hex');
const CACHE_HEADER = 120;
const DONT_CONTEXTIFY = Symbol('vm_context_no_contextify');
const USE_MAIN_CONTEXT_DEFAULT_LOADER = Symbol('vm_dynamic_import_main_context_default');
const constants = Object.freeze(Object.assign(Object.create(null), { USE_MAIN_CONTEXT_DEFAULT_LOADER, DONT_CONTEXTIFY }));
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
function contextOptions(value) {
  const opts = options(value);
  for (const key of ['name', 'origin']) if (opts[key] !== undefined && typeof opts[key] !== 'string') throw invalid(`options.${key}`, 'string', opts[key]);
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
        for (const key of Reflect.ownKeys(global)) if (!keys.includes(key)) keys.push(key);
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
function validateImportCallback(callback, module = false) {
  if (callback !== undefined && typeof callback !== 'function' &&
      (module || callback !== USE_MAIN_CONTEXT_DEFAULT_LOADER)) {
    throw invalid('options.importModuleDynamically', 'function', callback);
  }
}
function importCallback(callback, referrer, filename, functionRef = false) {
  if (callback === USE_MAIN_CONTEXT_DEFAULT_LOADER) return host.vmCreateDefaultImporter(filename);
  // internal/vm registerImportModuleDynamically: the callback answers through
  // importModuleDynamicallyWrap, which unwraps a vm.Module to its namespace or source.
  return async (specifier, attributes, sourcePhase) => {
    if (callback === undefined) throw error('ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING', 'A dynamic import callback was not specified.', TypeError);
    if (!host.experimentalVmModules) throw error('ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG', 'A dynamic import callback was invoked without --experimental-vm-modules', TypeError);
    const { importModuleDynamicallyWrap } = require('internal/vm/module');
    const { kSourcePhase, kEvaluationPhase } = require('internal/vm/module_wrap');
    return importModuleDynamicallyWrap(callback)(specifier, functionRef ? referrer() : referrer,
      attributes || Object.create(null), sourcePhase ? kSourcePhase : kEvaluationPhase);
  };
}
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
    const dynamicImport = importCallback(opts.importModuleDynamically, this, filename);
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
module.exports = { Script, createContext, createScript, isContext, runInContext, runInNewContext, runInThisContext, compileFunction, constants };
if (host.experimentalVmModules) {
  const { Module, SourceTextModule, SyntheticModule } = require('internal/vm/module');
  Object.assign(module.exports, { Module, SourceTextModule, SyntheticModule });
}
