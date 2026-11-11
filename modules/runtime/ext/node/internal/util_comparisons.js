'use strict';

const types = require('util/types');
const typedArrayTag = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag).get;
const enumerable = (v, symbols) => Reflect.ownKeys(v).filter(k => (symbols || typeof k === 'string') && Object.prototype.propertyIsEnumerable.call(v, k));
const object = v => v !== null && typeof v === 'object';
function compare(actual, expected, strict = true, skipPrototype = false, partial = false) {
  const left = new Map();
  const right = new Map();
  function equal(a, b) {
    if (Object.is(a, b)) return true;
    if (!object(a) || !object(b)) {
      if (strict) return false;
      return a == b || typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b);
    }
    if (strict && !skipPrototype && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
    if (left.has(a) || right.has(b)) return left.get(a) === b && right.get(b) === a;
    left.set(a, b); right.set(b, a);
    try {
      const aa = Array.isArray(a), ba = Array.isArray(b);
      if (aa !== ba) return false;
      if (aa && (partial ? a.length < b.length : a.length !== b.length)) return false;
      for (const predicate of ['isDate', 'isRegExp', 'isMap', 'isSet', 'isArrayBuffer', 'isAnyArrayBuffer', 'isArrayBufferView', 'isBoxedPrimitive', 'isNativeError', 'isArgumentsObject']) {
        if (types[predicate](a) !== types[predicate](b)) return false;
      }
      if (types.isDate(a)) {
        const av = Date.prototype.getTime.call(a), bv = Date.prototype.getTime.call(b);
        if (!(av === bv || Number.isNaN(av) && Number.isNaN(bv))) return false;
      } else if (types.isRegExp(a)) {
        if (a.source !== b.source || a.flags !== b.flags || a.lastIndex !== b.lastIndex) return false;
      } else if (types.isNativeError(a)) {
        if (a.name !== b.name || a.message !== b.message) return false;
        for (const key of ['cause', 'errors']) {
          if (Object.prototype.hasOwnProperty.call(a, key) !== Object.prototype.hasOwnProperty.call(b, key) || !equal(a[key], b[key])) return false;
        }
      } else if (types.isBoxedPrimitive(a)) {
        let matched = false;
        for (const proto of [Number.prototype, String.prototype, Boolean.prototype, BigInt.prototype, Symbol.prototype]) {
          let av, bv;
          try { av = proto.valueOf.call(a); bv = proto.valueOf.call(b); } catch { continue; }
          matched = Object.is(av, bv); break;
        }
        if (!matched) return false;
      } else if (types.isArrayBufferView(a) || types.isAnyArrayBuffer(a)) {
        if (types.isArrayBufferView(a) !== types.isArrayBufferView(b)) return false;
        if (types.isArrayBufferView(a) && Reflect.apply(typedArrayTag, a, []) !== Reflect.apply(typedArrayTag, b, [])) return false;
        let av, bv;
        try {
          av = types.isArrayBufferView(a) ? new Uint8Array(a.buffer, a.byteOffset, a.byteLength) : new Uint8Array(a);
          bv = types.isArrayBufferView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b);
        } catch { return false; }
        if (av.length !== bv.length) return false;
        if (!strict && (types.isFloat32Array(a) || types.isFloat64Array(a))) {
          for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
        } else for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) return false;
      } else if (types.isMap(a) || types.isSet(a)) {
        if (partial ? a.size < b.size : a.size !== b.size) return false;
        const map = types.isMap(a);
        const candidates = Array.from(map ? Map.prototype.entries.call(a) : Set.prototype.values.call(a));
        const wanted = Array.from(map ? Map.prototype.entries.call(b) : Set.prototype.values.call(b));
        const used = new Set();
        function match(index) {
          if (index === wanted.length) return true;
          for (let i = 0; i < candidates.length; i++) {
            if (used.has(i)) continue;
            const ok = map ? equal(candidates[i][0], wanted[index][0]) && equal(candidates[i][1], wanted[index][1]) : equal(candidates[i], wanted[index]);
            if (ok) { used.add(i); if (match(index + 1)) return true; used.delete(i); }
          }
          return false;
        }
        if (!match(0)) return false;
      } else {
        for (const predicate of ['isPromise', 'isWeakMap', 'isWeakSet', 'isModuleNamespaceObject']) if (types[predicate](a) || types[predicate](b)) return false;
      }
      const ak = enumerable(a, strict), bk = enumerable(b, strict);
      if (!partial && ak.length !== bk.length) return false;
      if (partial && aa) {
        let index = 0;
        for (let i = 0; i < b.length; i++) {
          let found = false;
          while (index < a.length) {
            const candidate = index++;
            if ((i in b) === (candidate in a) && equal(a[candidate], b[i])) { found = true; break; }
          }
          if (!found) return false;
        }
      }
      for (const key of bk) {
        if (partial && aa && typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) continue;
        if (!Object.prototype.propertyIsEnumerable.call(a, key) || !equal(a[key], b[key])) return false;
      }
      return true;
    } finally { left.delete(a); right.delete(b); }
  }
  return equal(actual, expected);
}
module.exports = { isDeepEqual: (a, b) => compare(a, b, false), isDeepStrictEqual: (a, b, skipPrototype = false) => compare(a, b, true, skipPrototype), isPartialStrictEqual: (a, b) => compare(a, b, true, false, true) };
