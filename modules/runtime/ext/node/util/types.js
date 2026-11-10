'use strict';

const host = require('internal/host');
const apply = Reflect.apply;
const descriptor = Object.getOwnPropertyDescriptor;
const typedArrayTag = descriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag).get;
function accepts(method, value, args = []) {
  try { apply(method, value, args); return true; } catch { return false; }
}
function getterBrand(prototype, name) {
  const get = descriptor(prototype, name).get;
  return value => accepts(get, value);
}
function native(name) {
  return function(value) {
    if (host.types && typeof host.types[name] === 'function') return host.types[name](value);
    const error = new Error('The runtime does not expose the intrinsic predicate util.types.' + name);
    error.code = 'ERR_METHOD_NOT_IMPLEMENTED';
    throw error;
  };
}
const types = module.exports = {
  isDate: value => accepts(Date.prototype.getTime, value),
  isRegExp: getterBrand(RegExp.prototype, 'source'),
  isMap: getterBrand(Map.prototype, 'size'),
  isSet: getterBrand(Set.prototype, 'size'),
  isWeakMap: value => accepts(WeakMap.prototype.has, value, [types]),
  isWeakSet: value => accepts(WeakSet.prototype.has, value, [types]),
  isArrayBuffer: getterBrand(ArrayBuffer.prototype, 'byteLength'),
  isSharedArrayBuffer: typeof SharedArrayBuffer === 'undefined' ? native('isSharedArrayBuffer') : getterBrand(SharedArrayBuffer.prototype, 'byteLength'),
  isArrayBufferView: ArrayBuffer.isView,
  isDataView: value => ArrayBuffer.isView(value) && apply(typedArrayTag, value, []) === undefined,
  isTypedArray: value => apply(typedArrayTag, value, []) !== undefined,
  isBooleanObject: value => typeof value === 'object' && value !== null && accepts(Boolean.prototype.valueOf, value),
  isNumberObject: value => typeof value === 'object' && value !== null && accepts(Number.prototype.valueOf, value),
  isStringObject: value => typeof value === 'object' && value !== null && accepts(String.prototype.valueOf, value),
  isSymbolObject: value => typeof value === 'object' && value !== null && accepts(Symbol.prototype.valueOf, value),
  isBigIntObject: value => typeof value === 'object' && value !== null && accepts(BigInt.prototype.valueOf, value),
};
types.isAnyArrayBuffer = value => types.isArrayBuffer(value) || (typeof SharedArrayBuffer !== 'undefined' && types.isSharedArrayBuffer(value));
types.isBoxedPrimitive = value => types.isBooleanObject(value) || types.isNumberObject(value) || types.isStringObject(value) || types.isSymbolObject(value) || types.isBigIntObject(value);
for (const name of ['Uint8Array', 'Uint8ClampedArray', 'Uint16Array', 'Uint32Array', 'Int8Array', 'Int16Array', 'Int32Array', 'Float16Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array']) {
  types['is' + name] = value => apply(typedArrayTag, value, []) === name;
}
for (const name of ['isArgumentsObject', 'isAsyncFunction', 'isGeneratorFunction', 'isGeneratorObject', 'isNativeError', 'isPromise', 'isProxy', 'isMapIterator', 'isSetIterator', 'isModuleNamespaceObject', 'isExternal', 'isKeyObject', 'isCryptoKey']) types[name] = native(name);
