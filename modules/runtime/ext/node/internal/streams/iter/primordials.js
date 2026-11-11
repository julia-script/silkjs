'use strict';

const uncurry = fn => Function.prototype.call.bind(fn);
const getter = (prototype, key) => uncurry(Object.getOwnPropertyDescriptor(prototype, key).get);
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const promiseThen = uncurry(Promise.prototype.then);
const promiseAll = Promise.all.bind(Promise);
module.exports = {
  ...require('internal/streams/primordials'),
  Array,
  ArrayBufferIsView: ArrayBuffer.isView,
  ArrayBufferPrototypeGetByteLength: getter(ArrayBuffer.prototype, 'byteLength'),
  ArrayBufferPrototypeSlice: uncurry(ArrayBuffer.prototype.slice),
  ArrayPrototypeEvery: uncurry(Array.prototype.every),
  ArrayPrototypeShift: uncurry(Array.prototype.shift),
  DataViewPrototypeGetBuffer: getter(DataView.prototype, 'buffer'),
  DataViewPrototypeGetByteLength: getter(DataView.prototype, 'byteLength'),
  DataViewPrototypeGetByteOffset: getter(DataView.prototype, 'byteOffset'),
  MathMax: Math.max,
  NumberMAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER,
  ObjectFreeze: Object.freeze,
  SafeMap: Map,
  SafeWeakMap: WeakMap,
  SafeWeakSet: WeakSet,
  SafePromiseRace: Promise.race.bind(Promise),
  SafePromiseAllReturnVoid(values, mapper) {
    return promiseThen(promiseAll(mapper === undefined ? values : values.map(mapper)), () => undefined);
  },
  String,
  StringPrototypeStartsWith: uncurry(String.prototype.startsWith),
  TypedArrayPrototypeFill: uncurry(typedArray.fill),
  TypedArrayPrototypeSlice: uncurry(typedArray.slice),
  Uint32Array,
};
