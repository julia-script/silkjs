'use strict';

const uncurryThis = fn => Function.prototype.call.bind(fn);
module.exports = {
  ...require('internal/streams/primordials'),
  ArrayPrototypeFind: uncurryThis(Array.prototype.find),
  ArrayPrototypeForEach: uncurryThis(Array.prototype.forEach),
  ArrayPrototypeReverse: uncurryThis(Array.prototype.reverse),
  ArrayPrototypeShift: uncurryThis(Array.prototype.shift),
  ArrayPrototypePushApply: Function.prototype.apply.bind(Array.prototype.push),
  ArrayPrototypeUnshiftApply: Function.prototype.apply.bind(Array.prototype.unshift),
  ObjectPrototypeHasOwnProperty: uncurryThis(Object.prototype.hasOwnProperty),
  RegExpPrototypeExec: uncurryThis(RegExp.prototype.exec),
  SafeMap: Map,
  SafeStringPrototypeSearch: uncurryThis(String.prototype.search),
  StringPrototypeCharAt: uncurryThis(String.prototype.charAt),
  StringPrototypeEndsWith: uncurryThis(String.prototype.endsWith),
  StringPrototypeIncludes: uncurryThis(String.prototype.includes),
  StringPrototypeIndexOf: uncurryThis(String.prototype.indexOf),
  StringPrototypeSlice: uncurryThis(String.prototype.slice),
  StringPrototypeStartsWith: uncurryThis(String.prototype.startsWith),
  Int32Array,
};
