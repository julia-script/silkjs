'use strict';

const { wasmNative: native, wasmRealmState, registerWasmRealm, wasmCodeGeneration } = require('internal/host');
const { Buffer } = require('buffer');
const compileOptions = require('internal/web/wasm/compile_options');
const { records, wrappers, suspension, exceptionStacks, builtinTraps } = wasmRealmState;
const apply = Reflect.apply;
const arrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;
const typedOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset').get;
const typedLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;
const dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer').get;
const dataViewOffset = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteOffset').get;
const dataViewLength = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength').get;
const valueTypes = new Set(['i32', 'i64', 'f32', 'f64', 'v128', 'externref', 'anyfunc', 'exnref', 'anyref', 'eqref', 'i31ref', 'structref', 'arrayref']);
const tableTypes = new Set(['externref', 'anyfunc', 'anyref', 'eqref', 'i31ref', 'structref', 'arrayref']);

function object(value) { return value !== null && (typeof value === 'object' || typeof value === 'function'); }
function descriptor(value, name) {
  if (!object(value)) throw new TypeError(`WebAssembly.${name}(): Argument 0 must be an object`);
  return value;
}
function string(value) {
  if (typeof value === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
  return String(value);
}
function primitive(value) {
  if (!object(value)) return value;
  const exotic = value[Symbol.toPrimitive];
  if (exotic !== undefined && exotic !== null) {
    if (typeof exotic !== 'function') throw new TypeError('Cannot convert object to primitive value');
    const result = apply(exotic, value, ['number']);
    if (object(result)) throw new TypeError('Cannot convert object to primitive value');
    return result;
  }
  for (const name of ['valueOf', 'toString']) {
    const method = value[name];
    if (typeof method === 'function') {
      const result = apply(method, value, []);
      if (!object(result)) return result;
    }
  }
  throw new TypeError('Cannot convert object to primitive value');
}
function index(value, address, name) {
  if (address === 'i64') {
    value = primitive(value);
    if (typeof value === 'number') throw new TypeError(`Cannot convert ${value} to a BigInt`);
    const result = BigInt(value);
    if (result < 0n || result > 18446744073709551615n) throw new TypeError(`${name} must be in u64 range`);
    return result;
  }
  const result = +value;
  if (!Number.isFinite(result)) throw new TypeError(`${name} must be convertible to a valid number`);
  if (result < 0) throw new TypeError(`${name} must be non-negative`);
  if (result > 4294967295) throw new TypeError(`${name} must be in the unsigned long range`);
  return Math.trunc(result);
}
function addressType(value) {
  if (value === undefined) return 'i32';
  value = string(value);
  if (value !== 'i32' && value !== 'i64') throw new TypeError("Property 'address' must be 'i32' or 'i64'");
  return value;
}
function limits(value, address, initialLimit, maximumLimit) {
  const first = value.initial;
  if (first === undefined) throw new TypeError("Property 'initial' is required");
  const initial = index(first, address, "Property 'initial'");
  if (initial > initialLimit) throw new RangeError("Property 'initial' is above the upper bound");
  const last = value.maximum;
  const maximum = last === undefined ? undefined : index(last, address, "Property 'maximum'");
  if (maximum !== undefined && maximum < initial) throw new RangeError("Property 'maximum' is below the lower bound");
  if (maximum !== undefined && maximum > maximumLimit) throw new RangeError("Property 'maximum' is above the upper bound");
  return { initial, maximum };
}
function valueType(value, name) {
  const type = string(value);
  if (!valueTypes.has(type)) throw new TypeError(`${name} must be a value type`);
  return type;
}
function arrayLikeLength(value, name) {
  if (!object(value)) throw new TypeError(`${name} must be an array-like object`);
  const length = +value.length;
  if (!Number.isInteger(length) || length < 0 || length >= 4294967295) throw new TypeError(`${name} has no valid length`);
  return length;
}
function brand(value, kind) {
  const state = records.get(value);
  if (!state || state.kind !== kind) throw new TypeError(`WebAssembly.${kind}: incompatible receiver`);
  return state;
}
function remember(value, kind, handle, type) {
  records.set(value, { kind, handle, type, exports: undefined });
  wrappers.set(handle, new WeakRef(value));
  return value;
}
function sourceBytes(value, streaming = false) {
  try {
    return { buffer: value, offset: 0, length: apply(arrayBufferLength, value, []) };
  } catch (_) {
    // These captured getters perform genuine brands, not user properties or
    // Symbol.toStringTag. Node 24 accepts TypedArrays, not DataViews/raw SABs.
  }
  try {
    return {
      buffer: apply(typedBuffer, value, []),
      offset: apply(typedOffset, value, []),
      length: apply(typedLength, value, []),
    };
  } catch (_) {}
  if (streaming) {
    try {
      const buffer = apply(dataViewBuffer, value, []);
      try {
        return { buffer, offset: apply(dataViewOffset, value, []), length: apply(dataViewLength, value, []) };
      } catch (_) {
        // The native streaming API treats detached views as empty chunks.
        if (apply(arrayBufferLength, buffer, []) === 0) return { buffer, offset: 0, length: 0 };
      }
    } catch (_) {}
    const error = new TypeError('chunk must be an ArrayBufferView or an ArrayBuffer');
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  throw new TypeError('Argument 0 must be a buffer source');
}
function checkCodeGeneration() {
  if (wasmCodeGeneration === false) throw new CompileError('Wasm code generation disallowed by embedder');
}
function compileHandle(source, options) {
  checkCodeGeneration();
  const { buffer, offset, length } = sourceBytes(source);
  if (!length) throw new CompileError('BufferSource argument is empty');
  return native('compile', buffer, offset, length, options);
}
function makeError(name) {
  const Constructor = { [name]: function(message, options = undefined) {
    return Reflect.construct(Error, arguments, new.target || Constructor);
  } }[name];
  Object.setPrototypeOf(Constructor, Error);
  Constructor.prototype = Object.create(Error.prototype, {
    constructor: { value: Constructor, writable: true, configurable: true },
    name: { value: name, writable: true, configurable: true },
    message: { value: '', writable: true, configurable: true },
  });
  Object.defineProperty(Constructor, 'prototype', { writable: false });
  return Constructor;
}
const CompileError = makeError('CompileError');
const LinkError = makeError('LinkError');
const RuntimeError = makeError('RuntimeError');
const SuspendError = makeError('SuspendError');

// %AbstractModuleSource% (source phase imports): the abstract superclass of
// module source objects, whose @@toStringTag getter names the source's class.
class AbstractModuleSource {
  constructor() { throw new TypeError('Abstract class AbstractModuleSource not directly constructable'); }
  get [Symbol.toStringTag]() {
    const state = object(this) ? records.get(this) : undefined;
    return state !== undefined && state.kind === 'module' ? 'WebAssembly.Module' : undefined;
  }
}
class Module extends AbstractModuleSource {
  constructor(source, options = undefined) {
    // AbstractModuleSource cannot be constructed: Module makes its own instance.
    const self = Object.create(new.target.prototype);
    remember(self, 'module', compileHandle(source, options));
    return self;
  }
  static imports(module) {
    return native('moduleImports', brand(module, 'module').handle).map(({ module, name, kind }) => ({ module, name, kind }));
  }
  static exports(module) {
    return native('moduleExports', brand(module, 'module').handle).map(({ name, kind }) => ({ name, kind }));
  }
  static customSections(module, name) {
    const handle = brand(module, 'module').handle;
    return native('customSections', handle, string(name));
  }
}
class Instance {
  constructor(module, imports = undefined) {
    const handle = brand(module, 'module').handle;
    if (imports !== undefined && !object(imports)) throw new TypeError('Imports argument must be present and must be an object');
    remember(this, 'instance', native('instantiate', handle, imports));
    const state = records.get(this);
    state.exports = native('instanceExports', state.handle);
  }
  get exports() {
    const state = brand(this, 'instance');
    if (state.exports === undefined) state.exports = native('instanceExports', state.handle);
    return state.exports;
  }
}
class Table {
  constructor(type, value = undefined) {
    type = descriptor(type, 'Table');
    const element = string(type.element);
    if (!tableTypes.has(element)) throw new TypeError("Property 'element' must be a WebAssembly reference type");
    const address = addressType(type.address);
    const { initial, maximum } = limits(type, address, 10000000, address === 'i64' ? 18446744073709551615n : 4294967295);
    // Node does not convert an unused initial value for an empty table.
    if (initial === 0 || initial === 0n || value === undefined) value = defaultReference(element);
    remember(this, 'table', native('table', element, initial, maximum, value, address), { element, address });
  }
  get length() { return native('tableLength', brand(this, 'table').handle); }
  grow(delta, value = undefined) {
    const state = brand(this, 'table');
    delta = index(delta, state.type.address, 'Argument 0');
    if (arguments.length < 2) value = defaultReference(state.type.element);
    return native('tableGrow', state.handle, delta, value);
  }
  set(position, value = undefined) {
    const state = brand(this, 'table');
    position = index(position, state.type.address, 'Argument 0');
    if (arguments.length < 2) value = defaultReference(state.type.element);
    return native('tableSet', state.handle, position, value);
  }
  get(position) {
    const state = brand(this, 'table');
    return native('tableGet', state.handle, index(position, state.type.address, 'Argument 0'));
  }
}
function defaultReference(type) { return type === 'externref' ? undefined : null; }
class Memory {
  constructor(type) {
    type = descriptor(type, 'Memory');
    const address = addressType(type.address);
    const bound = address === 'i64' ? 262144n : 65536;
    const { initial, maximum } = limits(type, address, bound, bound);
    const shared = !!type.shared;
    if (shared && maximum === undefined) throw new TypeError('If shared is true, maximum property should be defined');
    remember(this, 'memory', native('memory', initial, maximum, shared, address), { address, shared });
  }
  grow(delta) {
    const state = brand(this, 'memory');
    return native('memoryGrow', state.handle, index(delta, state.type.address, 'Argument 0'));
  }
  get buffer() { return native('memoryBuffer', brand(this, 'memory').handle); }
}
class Global {
  constructor(type, value = undefined) {
    type = descriptor(type, 'Global');
    const mutable = !!type.mutable;
    const valueTypeName = valueType(type.value, "Property 'value'");
    if (valueTypeName === 'v128') throw new TypeError('A v128 value cannot be represented in JavaScript');
    // Omitted/undefined initial values use the Wasm type's default, not the
    // conversion applied when assigning .value later.
    if (value === undefined) {
      if (valueTypeName === 'i64') value = 0n;
      else if (['i32', 'f32', 'f64'].includes(valueTypeName)) value = 0;
      else if (arguments.length < 2) value = defaultReference(valueTypeName);
    }
    remember(this, 'global', native('global', valueTypeName, mutable, value), { value: valueTypeName, mutable });
  }
  valueOf() { return native('globalGet', brand(this, 'global').handle); }
  get value() { return native('globalGet', brand(this, 'global').handle); }
  set value(value) { native('globalSet', brand(this, 'global').handle, value); }
}
class Tag {
  constructor(type) {
    type = descriptor(type, 'Tag');
    const parameters = type.parameters;
    const length = arrayLikeLength(parameters, 'Tag parameters');
    if (length > 1000) throw new TypeError('Tag contains too many parameters');
    const converted = [];
    for (let i = 0; i < length; i++) converted.push(valueType(parameters[i], `Parameter ${i}`));
    // These three Node native constructors return their own branded object;
    // unlike Memory/Table/Global they do not transfer new.target's prototype.
    return wrap('tag', native('tag', converted), { parameters: converted });
  }
}
function getExceptionStack() { return exceptionStacks.get(this); }
function setExceptionStack(value) {
  if (exceptionStacks.has(this)) exceptionStacks.set(this, value);
}
class Exception {
  constructor(tag, values, options = undefined) {
    const handle = brand(tag, 'tag').handle;
    if (tag === JSTag) throw new TypeError('Argument 0 cannot be WebAssembly.JSTag');
    // Let the native bridge convert each payload immediately after its indexed
    // getter. Eager Array.from would reorder throws and observable coercions.
    const exception = wrap('exception', native('exception', handle, values));
    if (options !== undefined && options !== null) {
      if (!object(options)) throw new TypeError('Argument 2 is not an object');
      if (options.traceStack) {
        const error = new Error();
        if (typeof Error.captureStackTrace === 'function') Error.captureStackTrace(error, Exception);
        exceptionStacks.set(exception, error.stack);
        Object.defineProperty(exception, 'stack', {
          get: getExceptionStack, set: setExceptionStack, configurable: true,
        });
      }
    }
    return exception;
  }
  getArg(tag, position) {
    const handle = brand(this, 'exception').handle;
    const tagHandle = brand(tag, 'tag').handle;
    return native('exceptionGetArg', handle, tagHandle, index(position, 'i32', 'Argument 1'));
  }
  is(tag) { return native('exceptionIs', brand(this, 'exception').handle, brand(tag, 'tag').handle); }
  get stack() {
    brand(this, 'exception');
    return undefined;
  }
}
class Suspending {
  constructor(callable) {
    if (typeof callable !== 'function') throw new TypeError('Argument 0 must be a function');
    const result = Object.create(Suspending.prototype);
    suspension.set(result, callable);
    return result;
  }
}
function wrap(kind, handle, metadata) {
  const prior = wrappers.get(handle);
  const existing = prior && prior.deref();
  if (existing !== undefined) return existing;
  if (kind === 'function') return remember(native('exportFunction', handle, false, metadata), kind, handle, metadata);
  if (kind === 'gc') return remember(native('gcObject', handle), kind, handle, metadata);
  const Constructor = constructors[kind];
  if (!Constructor) throw new TypeError('Invalid native WebAssembly resource kind');
  if ((kind === 'memory' || kind === 'table' || kind === 'global' || kind === 'tag') && metadata === undefined) {
    metadata = native('resourceType', handle);
  }
  return remember(Object.create(Constructor.prototype), kind, handle, metadata);
}
const constructors = { module: Module, instance: Instance, table: Table, memory: Memory, global: Global, tag: Tag, exception: Exception };
function promising(callable) {
  const state = brand(callable, 'function');
  return wrap('function', native('promising', state.handle), state.type);
}
async function compile(source, options = undefined) {
  return wrap('module', compileHandle(source, options));
}
function validate(source, options = undefined) {
  const { buffer, offset, length } = sourceBytes(source);
  if (!length) return false;
  return native('validate', buffer, offset, length, options);
}
async function instantiate(source, imports = undefined, options = undefined) {
  if (!object(source)) throw new TypeError('Argument 0 must be a buffer source or a WebAssembly.Module object');
  if (imports !== undefined && !object(imports)) throw new TypeError('Argument 1 must be an object');
  const state = records.get(source);
  if (state && state.kind === 'module') return new Instance(source, imports);
  const module = wrap('module', compileHandle(source, options));
  return { module, instance: new Instance(module, imports) };
}
function responseError(message) {
  const error = new TypeError('WebAssembly response ' + message);
  error.code = 'ERR_WEBASSEMBLY_RESPONSE';
  return error;
}
async function responseBytes(source) {
  const response = await source;
  const { Response } = require('internal/web/fetch');
  if (!(response instanceof Response)) {
    const error = new TypeError('The "source" argument must be an instance of Response or a Promise resolving to Response');
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  const contentType = response.headers.get('Content-Type');
  if (contentType !== 'application/wasm') throw responseError(`has unsupported MIME type '${contentType}'`);
  if (!response.ok) throw responseError(`has status code ${response.status}`);
  if (response.bodyUsed !== false) throw responseError('body has already been used');
  let url;
  if (response.url) {
    url = response.url;
    if (typeof url !== 'string') throw new TypeError('Response URL must be a string');
  }
  const chunks = [];
  let length = 0;
  const body = response.body;
  if (body !== null && body !== undefined) {
    // Async iteration owns stream locking/cancellation. Snapshot each actual
    // chunk before requesting another; producers may reuse their byte storage.
    for await (const chunk of body) {
      const source = sourceBytes(chunk, true);
      const snapshot = source.length ? Buffer.from(new Uint8Array(source.buffer, source.offset, source.length)) : Buffer.alloc(0);
      chunks.push(snapshot);
      length += snapshot.byteLength;
    }
  }
  return { bytes: Buffer.concat(chunks, length), url };
}
async function compileStreaming(source, options = undefined) {
  checkCodeGeneration();
  const parsed = compileOptions.parse(options);
  const { bytes, url } = await responseBytes(source);
  const { buffer, offset, length } = sourceBytes(bytes);
  if (!length) throw new CompileError('BufferSource argument is empty');
  return wrap('module', native('compileParsed', buffer, offset, length, parsed, url));
}
async function instantiateStreaming(source, imports = undefined, options = undefined) {
  if (imports !== undefined && !object(imports)) throw new TypeError('Argument 1 must be an object');
  const module = await compileStreaming(source, options);
  return { module, instance: new Instance(module, imports) };
}

for (const Constructor of Object.values(constructors).concat(Suspending)) {
  Object.defineProperty(Constructor.prototype, Symbol.toStringTag, { value: 'WebAssembly.' + Constructor.name, configurable: true });
  for (const key of Object.getOwnPropertyNames(Constructor.prototype)) {
    if (key !== 'constructor') Object.defineProperty(Constructor.prototype, key, { enumerable: true });
  }
}
for (const key of ['imports', 'exports', 'customSections']) Object.defineProperty(Module, key, { enumerable: true });
const builtins = compileOptions.createBuiltins(RuntimeError, native, builtinTraps);
registerWasmRealm(globalThis, {
  wrap,
  parseOptions: compileOptions.parse,
  builtin: builtins.resolve,
  builtinTrap: builtins.isTrap,
  error(kind, message) {
    const Constructor = { compile: CompileError, link: LinkError, runtime: RuntimeError, suspend: SuspendError, type: TypeError, range: RangeError }[kind];
    if (!Constructor) throw new TypeError('Invalid native WebAssembly error kind');
    return new Constructor(message);
  },
  unwrap(value, kind) {
    const state = records.get(value);
    return state && state.kind === kind ? state.handle : undefined;
  },
  suspending(value) { return suspension.get(value); },
  jsTag() { return records.get(JSTag).handle; },
});
// JSTag's native tag is made when first asked for: loading this module opens no store.
const JSTag = Object.create(Tag.prototype);
const jsTagState = { kind: 'tag', type: { parameters: ['externref'] }, exports: undefined };
Object.defineProperty(jsTagState, 'handle', {
  configurable: true,
  get() {
    const handle = native('tag', ['externref']);
    Object.defineProperty(jsTagState, 'handle', { value: handle });
    wrappers.set(handle, new WeakRef(JSTag));
    return handle;
  },
});
records.set(JSTag, jsTagState);
const WebAssembly = {};
const definitions = {
  compile, validate, instantiate, Module, Instance, Table, Memory, Global, Tag, JSTag,
  Exception, CompileError, LinkError, RuntimeError, compileStreaming, instantiateStreaming,
  Suspending, promising, SuspendError,
};
const enumerable = new Set(['compile', 'validate', 'instantiate', 'compileStreaming', 'instantiateStreaming', 'promising']);
for (const [name, value] of Object.entries(definitions)) {
  Object.defineProperty(WebAssembly, name, { value, writable: name !== 'JSTag', enumerable: enumerable.has(name), configurable: true });
}
Object.defineProperty(WebAssembly, Symbol.toStringTag, { value: 'WebAssembly', configurable: true });
function isMemory(value) { return records.get(value)?.kind === 'memory'; }
function getMemoryBuffer(value) { return native('memoryBuffer', brand(value, 'memory').handle); }
module.exports = { WebAssembly, isMemory, getMemoryBuffer };
