// Adapted from Node.js v24.22.1 lib/internal/util.js: the helpers that
// util.inspect, assert, util and http use. Bindings are replaced by the runtime's
// util/types predicates.
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

const {
  ArrayFrom,
  ArrayPrototypePush,
  ArrayPrototypeSort,
  Error,
  ErrorCaptureStackTrace,
  FunctionPrototypeCall,
  FunctionPrototypeSymbolHasInstance,
  ObjectDefineProperties,
  ObjectDefineProperty,
  ObjectFreeze,
  ObjectGetOwnPropertyDescriptor,
  ObjectGetOwnPropertyDescriptors,
  ObjectGetPrototypeOf,
  ObjectSetPrototypeOf,
  ObjectValues,
  Promise,
  ReflectApply,
  ReflectConstruct,
  RegExpPrototypeGetDotAll,
  RegExpPrototypeGetGlobal,
  RegExpPrototypeGetHasIndices,
  RegExpPrototypeGetIgnoreCase,
  RegExpPrototypeGetMultiline,
  RegExpPrototypeGetSource,
  RegExpPrototypeGetSticky,
  RegExpPrototypeGetUnicode,
  SafeMap,
  SafeSet,
  SafeWeakMap,
  SymbolPrototypeGetDescription,
  StringPrototypeReplace,
  StringPrototypeToLowerCase,
  Symbol,
  SymbolFor,
  SymbolReplace,
  SymbolSplit,
} = require('internal/per_context/primordials');

const { isNativeError, isPromise } = require('util/types');

const colorRegExp = /\u001b\[\d\d?m/g; // eslint-disable-line no-control-regex

function removeColors(str) {
  return StringPrototypeReplace(str, colorRegExp, '');
}

function isError(e) {
  // An error could be an instance of Error while not being a native error
  // or could be from a different realm and not be instance of Error but still
  // be a native error.
  return isNativeError(e) || FunctionPrototypeSymbolHasInstance(Error, e);
}

// Keep a list of deprecation codes that have been warned on so we only warn on
// each one once.
const codesWarned = new SafeSet();

let validateString;

function getDeprecationWarningEmitter(
  code, msg, deprecated, useEmitSync,
  shouldEmitWarning = () => true,
) {
  let warned = false;
  return function(arg) {
    if (!warned && shouldEmitWarning(arg)) {
      warned = true;
      if (code === 'ExperimentalWarning') {
        process.emitWarning(msg, code, deprecated);
      } else if (code !== undefined) {
        if (!codesWarned.has(code)) {
          process.emitWarning(msg, 'DeprecationWarning', code, deprecated);
          codesWarned.add(code);
        }
      } else {
        process.emitWarning(msg, 'DeprecationWarning', deprecated);
      }
    }
  };
}

function isPendingDeprecation() {
  const { getOptionValue } = require('internal/options');
  return getOptionValue('--pending-deprecation') &&
    !getOptionValue('--no-deprecation');
}

function deprecateProperty(key, msg, code, isPendingDeprecation) {
  const emitDeprecationWarning = getDeprecationWarningEmitter(
    code, msg, undefined, false, isPendingDeprecation,
  );
  return (options) => {
    if (key in options) {
      emitDeprecationWarning();
    }
  };
}

// Internal deprecator for pending --pending-deprecation. This can be invoked
// at snapshot building time as the warning permission is only queried at
// run time.
function pendingDeprecate(fn, msg, code) {
  const emitDeprecationWarning = getDeprecationWarningEmitter(
    code, msg, deprecated, false, isPendingDeprecation,
  );
  function deprecated(...args) {
    emitDeprecationWarning();
    return ReflectApply(fn, this, args);
  }

  ObjectDefineProperty(deprecated, 'length', {
    __proto__: null,
    ...ObjectGetOwnPropertyDescriptor(fn, 'length'),
  });

  return deprecated;
}

// Mark that a method should not be used.
// Returns a modified function which warns once by default.
// If --no-deprecation is set, then it is a no-op.
function deprecate(fn, msg, code, useEmitSync, modifyPrototype = true) {
  // Lazy-load to avoid a circular dependency.
  if (validateString === undefined)
    ({ validateString } = require('internal/validators'));

  if (code !== undefined)
    validateString(code, 'code');

  const emitDeprecationWarning = getDeprecationWarningEmitter(
    code, msg, deprecated, useEmitSync,
  );

  function deprecated(...args) {
    if (!process.noDeprecation) {
      emitDeprecationWarning();
    }
    if (new.target) {
      return ReflectConstruct(fn, args, new.target);
    }
    return ReflectApply(fn, this, args);
  }

  if (modifyPrototype) {
    // The wrapper will keep the same prototype as fn to maintain prototype chain
    ObjectSetPrototypeOf(deprecated, fn);
    if (fn.prototype) {
      // Setting this (rather than using Object.setPrototype, as above) ensures
      // that calling the unwrapped constructor gives an instanceof the wrapped
      // constructor.
      deprecated.prototype = fn.prototype;
    }

    ObjectDefineProperty(deprecated, 'length', {
      __proto__: null,
      ...ObjectGetOwnPropertyDescriptor(fn, 'length'),
    });
  }

  return deprecated;
}

/**
 * @param {unknown} enc
 * @returns {string | undefined} Returns undefined if there is no match.
 */
function normalizeEncoding(enc) {
  if (enc == null || enc === 'utf8' || enc === 'utf-8') return 'utf8';
  return slowCases(enc);
}

function slowCases(enc) {
  switch (enc.length) {
    case 4:
      if (enc === 'UTF8') return 'utf8';
      if (enc === 'ucs2' || enc === 'UCS2') return 'utf16le';
      enc = StringPrototypeToLowerCase(enc);
      if (enc === 'utf8') return 'utf8';
      if (enc === 'ucs2') return 'utf16le';
      break;
    case 3:
      if (enc === 'hex' || enc === 'HEX' ||
      StringPrototypeToLowerCase(enc) === 'hex')
        return 'hex';
      break;
    case 5:
      if (enc === 'ascii') return 'ascii';
      if (enc === 'ucs-2') return 'utf16le';
      if (enc === 'UTF-8') return 'utf8';
      if (enc === 'ASCII') return 'ascii';
      if (enc === 'UCS-2') return 'utf16le';
      enc = StringPrototypeToLowerCase(enc);
      if (enc === 'utf-8') return 'utf8';
      if (enc === 'ascii') return 'ascii';
      if (enc === 'ucs-2') return 'utf16le';
      break;
    case 6:
      if (enc === 'base64') return 'base64';
      if (enc === 'latin1' || enc === 'binary') return 'latin1';
      if (enc === 'BASE64') return 'base64';
      if (enc === 'LATIN1' || enc === 'BINARY') return 'latin1';
      enc = StringPrototypeToLowerCase(enc);
      if (enc === 'base64') return 'base64';
      if (enc === 'latin1' || enc === 'binary') return 'latin1';
      break;
    case 7:
      if (enc === 'utf16le' || enc === 'UTF16LE' ||
      StringPrototypeToLowerCase(enc) === 'utf16le')
        return 'utf16le';
      break;
    case 8:
      if (enc === 'utf-16le' || enc === 'UTF-16LE' ||
      StringPrototypeToLowerCase(enc) === 'utf-16le')
        return 'utf16le';
      break;
    case 9:
      if (enc === 'base64url' || enc === 'BASE64URL' ||
      StringPrototypeToLowerCase(enc) === 'base64url')
        return 'base64url';
      break;
    default:
      if (enc === '') return 'utf8';
  }
}

const kCustomPromisifiedSymbol = SymbolFor('nodejs.util.promisify.custom');
const kCustomPromisifyArgsSymbol = Symbol('customPromisifyArgs');

let validateFunction;

function promisify(original) {
  // Lazy-load to avoid a circular dependency.
  if (validateFunction === undefined)
    ({ validateFunction } = require('internal/validators'));

  validateFunction(original, 'original');

  if (original[kCustomPromisifiedSymbol]) {
    const fn = original[kCustomPromisifiedSymbol];

    validateFunction(fn, 'util.promisify.custom');

    return ObjectDefineProperty(fn, kCustomPromisifiedSymbol, {
      __proto__: null,
      value: fn, enumerable: false, writable: false, configurable: true,
    });
  }

  // Names to create an object from in case the callback receives multiple
  // arguments, e.g. ['bytesRead', 'buffer'] for fs.read.
  const argumentNames = original[kCustomPromisifyArgsSymbol];

  function fn(...args) {
    return new Promise((resolve, reject) => {
      ArrayPrototypePush(args, (err, ...values) => {
        if (err) {
          return reject(err);
        }
        if (argumentNames !== undefined && values.length > 1) {
          const obj = {};
          for (let i = 0; i < argumentNames.length; i++)
            obj[argumentNames[i]] = values[i];
          resolve(obj);
        } else {
          resolve(values[0]);
        }
      });
      if (isPromise(ReflectApply(original, this, args))) {
        process.emitWarning('Calling promisify on a function that returns a Promise is likely a mistake.',
                            'DeprecationWarning', 'DEP0174');
      }
    });
  }

  ObjectSetPrototypeOf(fn, ObjectGetPrototypeOf(original));

  ObjectDefineProperty(fn, kCustomPromisifiedSymbol, {
    __proto__: null,
    value: fn, enumerable: false, writable: false, configurable: true,
  });

  const descriptors = ObjectGetOwnPropertyDescriptors(original);
  const propertiesValues = ObjectValues(descriptors);
  for (let i = 0; i < propertiesValues.length; i++) {
    // We want to use null-prototype objects to not rely on globally mutable
    // %Object.prototype%.
    ObjectSetPrototypeOf(propertiesValues[i], null);
  }
  return ObjectDefineProperties(fn, descriptors);
}

promisify.custom = kCustomPromisifiedSymbol;

// The build-in Array#join is slower in v8 6.0
function join(output, separator) {
  let str = '';
  if (output.length !== 0) {
    const lastIndex = output.length - 1;
    for (let i = 0; i < lastIndex; i++) {
      // It is faster not to use a template string here
      str += output[i];
      str += separator;
    }
    str += output[lastIndex];
  }
  return str;
}

function setOwnProperty(obj, key, value) {
  ObjectDefineProperty(obj, key, {
    __proto__: null,
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
  return value;
}

// Node takes DOMException from internalBinding('messaging'); here the
// runtime's event_target module defines it.
let _DOMException;
let isErrorStackTraceLimitWritable;
const lazyDOMExceptionClass = () => {
  _DOMException ??= require('internal/path_events/event_target').DOMException;
  return _DOMException;
};

const lazyDOMException = (message, name) => {
  _DOMException ??= require('internal/path_events/event_target').DOMException;
  // Lazy-load to avoid a circular dependency.
  isErrorStackTraceLimitWritable ??= require('internal/errors').isErrorStackTraceLimitWritable;
  if (isErrorStackTraceLimitWritable()) {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    const ex = new _DOMException(message, name);
    Error.stackTraceLimit = limit;
    ErrorCaptureStackTrace(ex, lazyDOMException);
    return ex;
  }
  return new _DOMException(message, name);

};

const kEnumerableProperty = ObjectFreeze({
  __proto__: null,
  enumerable: true,
});

const kEmptyObject = ObjectFreeze({ __proto__: null });

function assignFunctionName(name, fn) {
  if (typeof name === 'symbol') {
    const description = SymbolPrototypeGetDescription(name);
    name = description === undefined ? '' : `[${description}]`;
  }
  return ObjectDefineProperty(fn, 'name', {
    __proto__: null,
    configurable: true,
    value: name,
  });
}

function deprecateInstantiation(target, code, ...args) {
  require('internal/assert')(typeof code === 'string');

  getDeprecationWarningEmitter(code, `Instantiating ${target.name} without the 'new' keyword has been deprecated.`, target)();

  return ReflectConstruct(target, args);
}

// Prefixes the arrow (the source line and caret of a compile error) to the stack
// of an error that has one, once.
function decorateErrorStack(err) {
  const { privateSymbols: { arrow_message_private_symbol, decorated_private_symbol } } = require('internal/util/binding');
  if (!(isError(err) && err.stack) || err[decorated_private_symbol])
    return;
  const arrow = err[arrow_message_private_symbol];
  if (arrow) {
    err.stack = arrow + err.stack;
    err[decorated_private_symbol] = true;
  }
}

// RegExp methods from another realm, so user changes to this realm's RegExp
// prototype (lastIndex accessors, a replaced exec) cannot run.
let internalGlobal;
function getInternalGlobal() {
  if (internalGlobal == null) {
    const { runInNewContext } = require('vm');
    internalGlobal = runInNewContext('this', undefined, { contextName: 'internal' });
  }
  return internalGlobal;
}
function SideEffectFreeRegExpPrototypeExec(regex, string) {
  const { RegExp: RegExpFromAnotherRealm } = getInternalGlobal();
  return FunctionPrototypeCall(RegExpFromAnotherRealm.prototype.exec, regex, string);
}
const crossRealmRegexes = new SafeWeakMap();
function getCrossRealmRegex(regex) {
  const cached = crossRealmRegexes.get(regex);
  if (cached) return cached;
  let flagString = '';
  if (RegExpPrototypeGetHasIndices(regex)) flagString += 'd';
  if (RegExpPrototypeGetGlobal(regex)) flagString += 'g';
  if (RegExpPrototypeGetIgnoreCase(regex)) flagString += 'i';
  if (RegExpPrototypeGetMultiline(regex)) flagString += 'm';
  if (RegExpPrototypeGetDotAll(regex)) flagString += 's';
  if (RegExpPrototypeGetUnicode(regex)) flagString += 'u';
  if (RegExpPrototypeGetSticky(regex)) flagString += 'y';
  const { RegExp: RegExpFromAnotherRealm } = getInternalGlobal();
  const crossRealmRegex = new RegExpFromAnotherRealm(RegExpPrototypeGetSource(regex), flagString);
  crossRealmRegexes.set(regex, crossRealmRegex);
  return crossRealmRegex;
}
function SideEffectFreeRegExpPrototypeSymbolReplace(regex, string, replacement) {
  return getCrossRealmRegex(regex)[SymbolReplace](string, replacement);
}
function SideEffectFreeRegExpPrototypeSymbolSplit(regex, string, limit = undefined) {
  return getCrossRealmRegex(regex)[SymbolSplit](string, limit);
}

// Node builds this from internalBinding('string_decoder').encodings.
const encodingsMap = { __proto__: null, ascii: 0, utf8: 1, base64: 2, utf16le: 3, latin1: 4, hex: 5, buffer: 6, base64url: 7 };

// The system error tables live in internal/util_public/system here.
function getSystemErrorName(err) {
  return require('internal/util_public/system').getSystemErrorName(err);
}

// Node's assertCrypto. This module loads during bootstrap, before process.versions
// exists, so the check reads it when called.
function assertCrypto() {
  if (!process.versions.openssl) {
    const { ERR_NO_CRYPTO } = require('internal/errors').codes;
    throw new ERR_NO_CRYPTO();
  }
}

const experimentalWarnings = new SafeSet();
function emitExperimentalWarning(feature, messagePrefix, code, ctor) {
  if (experimentalWarnings.has(feature)) return;
  experimentalWarnings.add(feature);
  let msg = `${feature} is an experimental feature and might change at any time`;
  if (messagePrefix) {
    msg = messagePrefix + msg;
  }
  process.emitWarning(msg, 'ExperimentalWarning', code, ctor);
}

function getLazy(initializer) {
  let value;
  let initialized = false;
  return function() {
    if (initialized === false) {
      value = initializer();
      initialized = true;
    }
    return value;
  };
}

function once(callback, { preserveReturnValue = false } = kEmptyObject) {
  let called = false;
  let returnValue;
  return function(...args) {
    if (called) return returnValue;
    called = true;
    const result = ReflectApply(callback, this, args);
    returnValue = preserveReturnValue ? result : undefined;
    return result;
  };
}


function filterDuplicateStrings(items, low) {
  const map = new SafeMap();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const key = StringPrototypeToLowerCase(item);
    if (low) {
      map.set(key, key);
    } else {
      map.set(key, item);
    }
  }
  return ArrayPrototypeSort(ArrayFrom(map.values()));
}

function getConstructorOf(obj) {
  while (obj) {
    const descriptor = ObjectGetOwnPropertyDescriptor(obj, 'constructor');
    if (descriptor !== undefined &&
        typeof descriptor.value === 'function' &&
        descriptor.value.name !== '') {
      return descriptor.value;
    }

    obj = ObjectGetPrototypeOf(obj);
  }

  return null;
}

let validateUint32;
function sleep(msec) {
  // Lazy-load to avoid a circular dependency.
  if (validateUint32 === undefined)
    ({ validateUint32 } = require('internal/validators'));

  validateUint32(msec, 'msec');
  require('internal/util/binding').sleep(msec);
}

module.exports = {
  assertCrypto,
  sleep,
  assignFunctionName,
  customInspectSymbol: SymbolFor('nodejs.util.inspect.custom'),
  customPromisifyArgs: kCustomPromisifyArgsSymbol,
  decorateErrorStack,
  deprecate,
  deprecateInstantiation,
  deprecateProperty,
  emitExperimentalWarning,
  filterDuplicateStrings,
  encodingsMap,
  getConstructorOf,
  getDeprecationWarningEmitter,
  getLazy,
  getSystemErrorName,
  isError,
  isPendingDeprecation,
  join,
  kEmptyObject,
  kEnumerableProperty,
  lazyDOMException,
  lazyDOMExceptionClass,
  normalizeEncoding,
  once,
  pendingDeprecate,
  SideEffectFreeRegExpPrototypeExec,
  SideEffectFreeRegExpPrototypeSymbolReplace,
  SideEffectFreeRegExpPrototypeSymbolSplit,
  promisify,
  removeColors,
  setOwnProperty,
};
