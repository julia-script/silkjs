'use strict';

const host = require('internal/host');
const apply = Reflect.apply;
const typedArrayTag = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag).get;
// The engine's own class-ID checks, which nothing replaces later.
function classCheck(name) {
  if (typeof host.types?.[name] === 'function') return host.types[name];
  return native(name);
}
// Looked up per call: crypto installs isKeyObject and isCryptoKey after this module loads.
function native(name) {
  return function(value) {
    if (host.types && typeof host.types[name] === 'function') return host.types[name](value);
    const error = new Error('The runtime does not expose the intrinsic predicate util.types.' + name);
    error.code = 'ERR_METHOD_NOT_IMPLEMENTED';
    throw error;
  };
}
// Brand checks read the engine's class IDs (V8's IsDate and the rest): a throwing
// getter per failed check made each one cost an error object.
const types = module.exports = {
  isArrayBufferView: ArrayBuffer.isView,
  isTypedArray: value => apply(typedArrayTag, value, []) !== undefined,
};
for (const name of ['isDate', 'isRegExp', 'isMap', 'isSet', 'isWeakMap', 'isWeakSet', 'isArrayBuffer', 'isDataView',
  'isBooleanObject', 'isNumberObject', 'isStringObject', 'isSymbolObject', 'isBigIntObject', 'isSharedArrayBuffer']) types[name] = classCheck(name);
types.isAnyArrayBuffer = value => types.isArrayBuffer(value) || types.isSharedArrayBuffer(value);
types.isBoxedPrimitive = value => types.isBooleanObject(value) || types.isNumberObject(value) || types.isStringObject(value) || types.isSymbolObject(value) || types.isBigIntObject(value);
for (const name of ['Uint8Array', 'Uint8ClampedArray', 'Uint16Array', 'Uint32Array', 'Int8Array', 'Int16Array', 'Int32Array', 'Float16Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array']) {
  types['is' + name] = value => apply(typedArrayTag, value, []) === name;
}
for (const name of ['isArgumentsObject', 'isAsyncFunction', 'isGeneratorFunction', 'isGeneratorObject', 'isNativeError', 'isPromise', 'isProxy', 'isMapIterator', 'isSetIterator', 'isModuleNamespaceObject', 'isExternal', 'isKeyObject', 'isCryptoKey']) types[name] = native(name);
