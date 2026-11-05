'use strict';

// Node 24's pinned V8 consumes an array-like, not an iterator, and only
// primitive string values opt in. Keep observable Has/Get operations ordered.
const apply = Reflect.apply;
const floor = Math.floor;
const min = Math.min;
const charCodeAt = String.prototype.charCodeAt;
const codePointAt = String.prototype.codePointAt;
const slice = String.prototype.slice;
const fromCharCode = String.fromCharCode;
const fromCodePoint = String.fromCodePoint;
const weakAdd = WeakSet.prototype.add;
const weakHas = WeakSet.prototype.has;
function object(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}
function utf8Lossy(value) {
  let result = '';
  let copied = 0;
  for (let i = 0; i < value.length; ++i) {
    const unit = apply(charCodeAt, value, [i]);
    if (unit < 0xd800 || unit > 0xdfff) continue;
    if (unit <= 0xdbff && i + 1 < value.length) {
      const next = apply(charCodeAt, value, [i + 1]);
      if (next >= 0xdc00 && next <= 0xdfff) { ++i; continue; }
    }
    result += apply(slice, value, [copied, i]) + '\ufffd';
    copied = i + 1;
  }
  return copied ? result + apply(slice, value, [copied]) : value;
}
function parse(options) {
  let jsString = false;
  let constants;
  if (object(options)) {
    const builtins = options.builtins;
    if (object(builtins)) {
      const number = +builtins.length;
      const length = number > 0 ? min(floor(number), 4294967295) : 0;
      for (let i = 0; i < length; ++i) {
        if (i in builtins && builtins[i] === 'js-string') jsString = true;
      }
    }
    if ('importedStringConstants' in options) {
      const value = options.importedStringConstants;
      if (typeof value === 'string') constants = utf8Lossy(value);
    }
  }
  return { jsString, constants };
}

function createBuiltins(RuntimeError, native, traps) {
  function trap(message) {
    const error = new RuntimeError(message);
    apply(weakAdd, traps, [error]);
    throw error;
  }
  function cast(value) {
    if (typeof value !== 'string') trap('illegal cast');
    return value;
  }
  function nullable(value) {
    if (value !== null) cast(value);
    return value;
  }
  function arrayLength(array) {
    if (array === null) trap('dereferencing a null pointer');
    return native('stringArrayLength', array);
  }
  const builtins = [undefined, undefined,
    cast,
    function test(value) { return typeof value === 'string' ? 1 : 0; },
    function fromCharCodeBuiltin(code) { return fromCharCode(code & 0xffff); },
    function fromCodePointBuiltin(code) {
      if ((code >>> 0) > 0x10ffff) trap('Invalid code point ' + code);
      return fromCodePoint(code >>> 0);
    },
    function charCodeAtBuiltin(value, position) {
      cast(value);
      if ((position >>> 0) >= value.length) trap('string offset out of bounds');
      return apply(charCodeAt, value, [position >>> 0]);
    },
    function codePointAtBuiltin(value, position) {
      cast(value);
      if ((position >>> 0) >= value.length) trap('string offset out of bounds');
      return apply(codePointAt, value, [position >>> 0]);
    },
    function length(value) { return cast(value).length; },
    function concat(a, b) { return cast(a) + cast(b); },
    function substring(value, start, end) {
      cast(value);
      return apply(slice, value, [start >>> 0, end >>> 0]);
    },
    function equals(a, b) { return nullable(a) === nullable(b) ? 1 : 0; },
    function compare(a, b) {
      cast(a); cast(b);
      return a < b ? -1 : a > b ? 1 : 0;
    },
    function fromCharCodeArray(array, start, end) {
      const length = arrayLength(array);
      start >>>= 0; end >>>= 0;
      if (start > end || end > length) trap('array element access out of bounds');
      let result = '';
      // Bounded chunks avoid argument-stack overflow and preserve lone UTF16
      // surrogates; no UTF8 round trip or second JavaScript engine is involved.
      while (start < end) {
        const units = [];
        const stop = min(start + 512, end);
        while (start < stop) units[units.length] = native('stringArrayGet', array, start++);
        result += apply(fromCharCode, undefined, units);
      }
      return result;
    },
    function intoCharCodeArray(value, array, start) {
      cast(value);
      const length = arrayLength(array);
      start >>>= 0;
      if (start > length || value.length > length - start)
        trap('array element access out of bounds');
      for (let i = 0; i < value.length; ++i)
        native('stringArraySet', array, start + i, apply(charCodeAt, value, [i]));
      return value.length;
    },
  ];
  return {
    resolve(id) { return builtins[id]; },
    isTrap(error) { return object(error) && apply(weakHas, traps, [error]); },
  };
}

module.exports = { parse, createBuiltins };
