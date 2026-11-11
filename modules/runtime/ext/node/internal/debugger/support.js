// Silk support for the Node.js v24.22.1 debugger client (MIT; see PROVENANCE.json).
'use strict';

// Shared pieces for the `node inspect` client (internal/debugger/*), adapted from
// Node.js v24.22.1 lib/internal/debugger. Primordials, error codes, validators and
// the exit codes the client uses.

const uncurryThis = Function.prototype.bind.bind(Function.prototype.call);
const applyBind = Function.prototype.bind.bind(Function.prototype.apply);
const SafeMap = class SafeMap extends Map {};
const SafeSet = class SafeSet extends Set {};
const primordials = {
  Array,
  ArrayFrom: Array.from,
  ArrayIsArray: Array.isArray,
  ArrayPrototypeFilter: uncurryThis(Array.prototype.filter),
  ArrayPrototypeFind: uncurryThis(Array.prototype.find),
  ArrayPrototypeForEach: uncurryThis(Array.prototype.forEach),
  ArrayPrototypeIncludes: uncurryThis(Array.prototype.includes),
  ArrayPrototypeIndexOf: uncurryThis(Array.prototype.indexOf),
  ArrayPrototypeJoin: uncurryThis(Array.prototype.join),
  ArrayPrototypeMap: uncurryThis(Array.prototype.map),
  ArrayPrototypePop: uncurryThis(Array.prototype.pop),
  ArrayPrototypePush: uncurryThis(Array.prototype.push),
  ArrayPrototypePushApply: applyBind(Array.prototype.push),
  ArrayPrototypeShift: uncurryThis(Array.prototype.shift),
  ArrayPrototypeSlice: uncurryThis(Array.prototype.slice),
  ArrayPrototypeSome: uncurryThis(Array.prototype.some),
  ArrayPrototypeSplice: uncurryThis(Array.prototype.splice),
  Date,
  ErrorCaptureStackTrace: Error.captureStackTrace,
  FunctionPrototypeBind: uncurryThis(Function.prototype.bind),
  FunctionPrototypeCall: uncurryThis(Function.prototype.call),
  JSONParse: JSON.parse,
  JSONStringify: JSON.stringify,
  MapPrototypeGet: uncurryThis(Map.prototype.get),
  MathMax: Math.max,
  Number,
  NumberIsNaN: Number.isNaN,
  NumberParseInt: Number.parseInt,
  ObjectAssign: Object.assign,
  ObjectDefineProperties: Object.defineProperties,
  ObjectDefineProperty: Object.defineProperty,
  ObjectEntries: Object.entries,
  ObjectGetOwnPropertyDescriptors: Object.getOwnPropertyDescriptors,
  ObjectKeys: Object.keys,
  ObjectSetPrototypeOf: Object.setPrototypeOf,
  ObjectValues: Object.values,
  Promise,
  PromisePrototypeThen: uncurryThis(Promise.prototype.then),
  PromiseResolve: Promise.resolve.bind(Promise),
  PromiseWithResolvers: Promise.withResolvers.bind(Promise),
  Proxy,
  ReflectGetOwnPropertyDescriptor: Reflect.getOwnPropertyDescriptor,
  RegExpPrototypeExec: uncurryThis(RegExp.prototype.exec),
  RegExpPrototypeSymbolReplace: uncurryThis(RegExp.prototype[Symbol.replace]),
  RegExpPrototypeSymbolSplit: uncurryThis(RegExp.prototype[Symbol.split]),
  SafeMap,
  SafePromiseAllReturnArrayLike: (values) => Promise.all(Array.from(values)),
  SafePromiseAllReturnVoid: (values) => Promise.all(Array.from(values)).then(() => {}),
  SafePromiseRace: (values) => Promise.race(Array.from(values)),
  SafeSet,
  String,
  StringFromCharCode: String.fromCharCode,
  StringPrototypeEndsWith: uncurryThis(String.prototype.endsWith),
  StringPrototypeIncludes: uncurryThis(String.prototype.includes),
  StringPrototypeIndexOf: uncurryThis(String.prototype.indexOf),
  StringPrototypeRepeat: uncurryThis(String.prototype.repeat),
  StringPrototypeReplaceAll: uncurryThis(String.prototype.replaceAll),
  StringPrototypeSlice: uncurryThis(String.prototype.slice),
  StringPrototypeSplit: uncurryThis(String.prototype.split),
  StringPrototypeStartsWith: uncurryThis(String.prototype.startsWith),
  StringPrototypeToUpperCase: uncurryThis(String.prototype.toUpperCase),
  StringPrototypeTrim: uncurryThis(String.prototype.trim),
  Symbol,
};

class ERR_DEBUGGER_ERROR extends Error {
  constructor(message) {
    super(message);
    this.code = 'ERR_DEBUGGER_ERROR';
  }
  get name() { return 'Error'; }
}
class ERR_DEBUGGER_STARTUP_ERROR extends Error {
  constructor(message, details = undefined) {
    super(message);
    if (details !== undefined) Object.assign(this, details);
    this.code = 'ERR_DEBUGGER_STARTUP_ERROR';
  }
  get name() { return 'Error'; }
}
for (const Type of [ERR_DEBUGGER_ERROR, ERR_DEBUGGER_STARTUP_ERROR]) {
  Object.defineProperty(Type.prototype, 'toString', {
    __proto__: null, writable: true, configurable: true,
    value() { return `${this.name} [${this.code}]: ${this.message}`; },
  });
}

// Mirrors internal/util's cross-realm-safe replace; every regex here is a literal.
function SideEffectFreeRegExpPrototypeSymbolReplace(regex, string, replacement) {
  return RegExp.prototype[Symbol.replace].call(new RegExp(regex.source, regex.flags), string, replacement);
}
function isObjectLiteral(code) {
  return /^\s*{/.exec(code) !== null && /;\s*$/.exec(code) === null;
}

module.exports = {
  primordials,
  codes: { ERR_DEBUGGER_ERROR, ERR_DEBUGGER_STARTUP_ERROR },
  customInspectSymbol: Symbol.for('nodejs.util.inspect.custom'),
  SideEffectFreeRegExpPrototypeSymbolReplace,
  isObjectLiteral,
  exitCodes: { kNoFailure: 0, kGenericUserError: 1, kInvalidCommandLineArgument: 9 },
  debuglog: (name) => require('util').debuglog(name),
};
