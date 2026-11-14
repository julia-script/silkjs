'use strict';

const host = require('internal/host');
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
};
// The typed array brands too (isUint8Array guards every Buffer binding call and
// stream write): one native class check each, not the toStringTag getter.
for (const name of ['isDate', 'isRegExp', 'isMap', 'isSet', 'isWeakMap', 'isWeakSet', 'isArrayBuffer', 'isDataView',
  'isBooleanObject', 'isNumberObject', 'isStringObject', 'isSymbolObject', 'isBigIntObject', 'isSharedArrayBuffer',
  'isAnyArrayBuffer', 'isTypedArray', 'isUint8Array', 'isUint8ClampedArray', 'isUint16Array', 'isUint32Array', 'isInt8Array',
  'isInt16Array', 'isInt32Array', 'isFloat16Array', 'isFloat32Array', 'isFloat64Array', 'isBigInt64Array', 'isBigUint64Array']) types[name] = classCheck(name);
types.isBoxedPrimitive = value => types.isBooleanObject(value) || types.isNumberObject(value) || types.isStringObject(value) || types.isSymbolObject(value) || types.isBigIntObject(value);
for (const name of ['isArgumentsObject', 'isAsyncFunction', 'isGeneratorFunction', 'isGeneratorObject', 'isNativeError', 'isPromise', 'isProxy', 'isMapIterator', 'isSetIterator', 'isModuleNamespaceObject', 'isExternal', 'isKeyObject', 'isCryptoKey']) types[name] = native(name);
