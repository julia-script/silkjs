'use strict';

const uncurryThis = (fn) => Function.prototype.call.bind(fn);
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const promiseThen = uncurryThis(Promise.prototype.then);
const promiseResolve = Promise.resolve.bind(Promise);
const promiseAll = Promise.all.bind(Promise);
module.exports = {
  ArrayIsArray: Array.isArray,
  ArrayPrototypeFilter: uncurryThis(Array.prototype.filter),
  ArrayPrototypeIndexOf: uncurryThis(Array.prototype.indexOf),
  ArrayPrototypeMap: uncurryThis(Array.prototype.map),
  ArrayPrototypePop: uncurryThis(Array.prototype.pop),
  ArrayPrototypePush: uncurryThis(Array.prototype.push),
  ArrayPrototypeSlice: uncurryThis(Array.prototype.slice),
  Boolean,
  Error,
  FunctionPrototypeCall: uncurryThis(Function.prototype.call),
  FunctionPrototypeSymbolHasInstance: uncurryThis(Function.prototype[Symbol.hasInstance]),
  JSONParse: JSON.parse,
  MathFloor: Math.floor,
  Number,
  NumberIsInteger: Number.isInteger,
  NumberIsNaN: Number.isNaN,
  NumberParseInt: Number.parseInt,
  ObjectDefineProperties: Object.defineProperties,
  ObjectDefineProperty: Object.defineProperty,
  ObjectEntries: Object.entries,
  ObjectGetOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
  ObjectKeys: Object.keys,
  ObjectSetPrototypeOf: Object.setPrototypeOf,
  Promise,
  PromisePrototypeThen: promiseThen,
  PromiseReject: Promise.reject.bind(Promise),
  PromiseResolve: promiseResolve,
  PromiseWithResolvers() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  },
  ReflectApply: Reflect.apply,
  ReflectOwnKeys: Reflect.ownKeys,
  SafePromiseAll(values, mapper) {
    if (mapper === undefined) return promiseAll(values);
    const promises = new Array(values.length);
    for (let i = 0; i < values.length; i++) promises[i] = mapper(values[i], i);
    return promiseAll(promises);
  },
  SafePromisePrototypeFinally(promise, onFinally) {
    return promiseThen(promise,
      (value) => promiseThen(promiseResolve(onFinally()), () => value),
      (error) => promiseThen(promiseResolve(onFinally()), () => { throw error; }));
  },
  SafeSet: Set,
  StringPrototypeToLowerCase: uncurryThis(String.prototype.toLowerCase),
  Symbol,
  SymbolAsyncDispose: Symbol.asyncDispose,
  SymbolAsyncIterator: Symbol.asyncIterator,
  SymbolDispose: Symbol.dispose,
  SymbolFor: Symbol.for,
  SymbolHasInstance: Symbol.hasInstance,
  SymbolIterator: Symbol.iterator,
  SymbolSpecies: Symbol.species,
  TypeError,
  TypedArrayPrototypeGetBuffer: uncurryThis(Object.getOwnPropertyDescriptor(typedArray, 'buffer').get),
  TypedArrayPrototypeGetByteLength: uncurryThis(Object.getOwnPropertyDescriptor(typedArray, 'byteLength').get),
  TypedArrayPrototypeGetByteOffset: uncurryThis(Object.getOwnPropertyDescriptor(typedArray, 'byteOffset').get),
  TypedArrayPrototypeSet: uncurryThis(Uint8Array.prototype.set),
  Uint8Array,
};
