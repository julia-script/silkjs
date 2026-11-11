'use strict';

function createNapiAdapter(host) {
  // Native API semantics use the realm's intrinsics, not later replacements.
  const { Object, Array, Symbol, Number, String, BigInt, Date, DataView, Uint8Array,
    Promise, Error, TypeError, RangeError, SyntaxError, Set } = globalThis;
  const { getPrototypeOf, getOwnPropertyDescriptor, defineProperty, hasOwn, create } = Object;
  const { construct, deleteProperty, ownKeys } = Reflect;
  const symbolFor = Symbol.for, dateTime = Date.prototype.getTime;
  const asIntN = BigInt.asIntN, asUintN = BigInt.asUintN;
  const isInteger = Number.isInteger, evaluate = globalThis.eval;
  const { Buffer } = require('buffer');
  const bufferFrom = Buffer.from;
  const types = require('util/types');
  const wraps = new WeakMap();
  const externals = new WeakMap();
  const tags = new WeakMap();
  const finalizers = new FinalizationRegistry(id => host.napiNative(3, [id]));
  const typed = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
    Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array, globalThis.Float16Array];
  const typedNames = ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
    'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'Float16Array'];
  const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
  const typedGet = name => Object.getOwnPropertyDescriptor(typedPrototype, name).get;
  const getBuffer = typedGet('buffer'), getLength = typedGet('length'), getOffset = typedGet('byteOffset');
  const getTypedName = Object.getOwnPropertyDescriptor(typedPrototype, Symbol.toStringTag).get;
  const viewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer').get;
  const viewLength = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength').get;
  const viewOffset = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteOffset').get;
  const apply = Reflect.apply;
  const externalHas = WeakMap.prototype.has, externalGet = WeakMap.prototype.get;
  const arrayIndexOf = Array.prototype.indexOf, arrayPush = Array.prototype.push;
  const ops = {
    global: () => globalThis,
    moduleFilename(module) {
      const filename = module.filename;
      return typeof filename === 'string' ? require('url').pathToFileURL(filename).href : '';
    },
    object: () => ({}),
    array: length => new Array(length ?? 0),
    symbol: description => Symbol(description),
    symbolFor: description => symbolFor(description),
    externalType: value => apply(externalHas, externals, [value]),
    bool: value => !!value,
    number: value => +value,
    string: value => `${value}`,
    objectCoerce(value) { if (value == null) throw new TypeError('Cannot convert undefined or null to object'); return Object(value); },
    prototype: value => getPrototypeOf(value),
    get: (object, key) => object[key],
    set(object, key, value) { object[key] = value; },
    has: (object, key) => key in object,
    hasOwn: (object, key) => hasOwn(object, key),
    delete: (object, key) => deleteProperty(object, key),
    equal: (left, right) => left === right,
    instanceOf: (value, constructor) => value instanceof constructor,
    isArray: Array.isArray,
    arrayLength: value => value.length,
    isError: types.isNativeError,
    isDate: types.isDate,
    date: value => new Date(value),
    dateValue: value => apply(dateTime, value, []),
    isPromise: types.isPromise,
    isArrayBuffer: types.isArrayBuffer,
    isTypedArray: types.isTypedArray,
    isDataView: types.isDataView,
    isBuffer: Buffer.isBuffer,
    freeze: Object.freeze,
    seal: Object.seal,
    runScript: source => evaluate(source),
    error(kind, code, message) {
      const Type = [Error, TypeError, RangeError, SyntaxError][kind];
      const error = new Type(message);
      if (code !== undefined) error.code = code;
      return error;
    },
    makeFunction(name, id) {
      const fn = function(...args) { return host.napiNative(2, [id, this, new.target, args]); };
      defineProperty(fn, 'name', { value: name, configurable: true });
      return fn;
    },
    call: (receiver, fn, args) => apply(fn, receiver, args),
    construct: (fn, args) => construct(fn, args),
    define(object, key, value, getter, setter, attributes) {
      const descriptor = { __proto__: null, enumerable: !!(attributes & 2), configurable: !!(attributes & 4) };
      if (getter !== undefined || setter !== undefined) { descriptor.get = getter; descriptor.set = setter; }
      else { descriptor.value = value; descriptor.writable = !!(attributes & 1); }
      defineProperty(object, key, descriptor);
    },
    keys(object, mode, filter, conversion) {
      const result = [], seen = new Set();
      for (let current = object; current !== null; current = mode ? null : getPrototypeOf(current)) {
        for (const key of ownKeys(current)) {
          if (seen.has(key)) continue;
          seen.add(key);
          if (typeof key === 'symbol' ? filter & 16 : filter & 8) continue;
          const descriptor = getOwnPropertyDescriptor(current, key);
          if (!descriptor || ((filter & 1) && !descriptor.writable) || ((filter & 2) && !descriptor.enumerable) || ((filter & 4) && !descriptor.configurable)) continue;
          const index = typeof key === 'string' && key !== '' ? Number(key) : -1;
          result.push(!conversion && isInteger(index) && index >= 0 && index < 0xffffffff && String(index) === key ? index : key);
        }
      }
      return result;
    },
    wrap(object, id) {
      if (wraps.has(object)) return false;
      const token = {};
      wraps.set(object, { id, token });
      finalizers.register(object, id, token);
      return true;
    },
    unwrap: object => wraps.get(object)?.id ?? 0,
    removeWrap(object) {
      const record = wraps.get(object);
      if (!record) return 0;
      wraps.delete(object); finalizers.unregister(record.token);
      return record.id;
    },
    external(id) {
      const value = create(null);
      externals.set(value, id); finalizers.register(value, id);
      return value;
    },
    externalId: value => apply(externalGet, externals, [value]) ?? 0,
    addFinalizer(object, id) { finalizers.register(object, id); },
    tag(object, tag) { if (tags.has(object)) return false; tags.set(object, tag); return true; },
    checkTag: (object, tag) => tags.get(object) === tag,
    buffer: (backing, offset, length) => bufferFrom(backing, offset ?? 0, length),
    typedArray: (type, length, backing, offset) => new typed[type](backing, offset, length),
    dataView: (length, backing, offset) => new DataView(backing, offset, length),
    typedInfo(value) { return [apply(arrayIndexOf, typedNames, [apply(getTypedName, value, [])]), apply(getLength, value, []), apply(getBuffer, value, []), apply(getOffset, value, [])]; },
    viewInfo(value) { return [apply(viewLength, value, []), apply(viewBuffer, value, []), apply(viewOffset, value, [])]; },
    detached(value) { try { new Uint8Array(value); return false; } catch { return true; } },
    promise() {
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      return [promise, resolve, reject];
    },
    settle: (record, value, reject) => record[reject ? 2 : 1](value),
    bigint: (text, negative) => negative ? -BigInt(text) : BigInt(text),
    bigintWords(value) {
      const sign = value < 0n;
      if (sign) value = -value;
      const words = [sign ? 1 : 0];
      while (value) { apply(arrayPush, words, [Number(value & 0xffffffffn), Number((value >> 32n) & 0xffffffffn)]); value >>= 64n; }
      return words;
    },
    bigint64(value, signed) {
      const word = signed ? asIntN(64, value) : asUintN(64, value);
      const bits = asUintN(64, word);
      return [Number(bits & 0xffffffffn), Number(bits >> 32n), value === word];
    },
    asyncInit: (resource, name) => require('async_hooks')._createResource(name, resource),
    asyncBefore: resource => require('async_hooks')._enterResource(resource, true),
    asyncBeforeCallback: resource => require('async_hooks')._enterResource(resource),
    asyncAfter: resource => require('async_hooks')._leaveResource(resource),
    asyncDestroy: resource => resource.emitDestroy(),
    fatalException(error) {
      if (process.domain && require('domain')._handleException(error)) return true;
      try { require('internal/startup_controls').handleUncaught(error, 'uncaughtException'); return true; }
      catch (uncaught) {
        const workers = require('worker_threads');
        if (!workers.isMainThread) {
          try { workers._reportError(uncaught); }
          finally { workers._requestExit(1); }
        }
        try {
          let message;
          try { message = String(uncaught?.stack ?? uncaught); }
          catch { message = 'Uncaught exception in native addon callback'; }
          host.writeStartupDiagnostic(message + '\n');
        } finally {
          host.rawStd.exit(1);
        }
        return false;
      }
    },
  };
  return function dispatch(operation, ...args) {
    if (!hasOwn(ops, operation)) throw new Error('Unknown Node-API operation: ' + operation);
    return apply(ops[operation], undefined, args);
  };
}

function install(host, process) {
  const adapter = createNapiAdapter(host);
  host.napiNative(0, [adapter]);
  // Native state does not come with a heap image: a start from one hands the adapter over again.
  host.onHydrate(() => { host.napiNative(0, [adapter]); });
  process.dlopen = function dlopen(module, filename, flags = 1) {
    if (module === null || typeof module !== 'object') throw Object.assign(new TypeError('The "module" argument must be an object'), { code: 'ERR_INVALID_ARG_TYPE' });
    if (typeof filename !== 'string') throw Object.assign(new TypeError('The "filename" argument must be a string'), { code: 'ERR_INVALID_ARG_TYPE' });
    if (!Number.isInteger(flags) || flags < -0x80000000 || flags > 0x7fffffff) throw Object.assign(new TypeError('The "flags" argument must be a 32-bit integer'), { code: 'ERR_INVALID_ARG_TYPE' });
    module.exports = host.napiNative(1, [filename, module, flags]);
  };
  host.loadAddon = (filename, module) => process.dlopen(module, filename);
}
module.exports = { createNapiAdapter, install };
