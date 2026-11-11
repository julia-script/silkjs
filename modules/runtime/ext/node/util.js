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

// Adapted from Node.js v24.22.1 lib/util.js: the formatter, promisify and
// deprecate come from their internal modules as in Node; debuglog, call sites,
// SIGINT tracing and the lazily loaded members are the runtime's own.

'use strict';

const {
  ArrayIsArray,
  ArrayPrototypePop,
  Error,
  ErrorCaptureStackTrace,
  FunctionPrototypeBind,
  ObjectDefineProperties,
  ObjectDefineProperty,
  ObjectGetOwnPropertyDescriptors,
  ObjectGetOwnPropertyNames,
  ObjectKeys,
  ObjectSetPrototypeOf,
  ObjectValues,
  ReflectApply,
  RegExpPrototypeExec,
  SafeMap,
  StringPrototypeSlice,
} = require('internal/per_context/primordials');

const host = require('internal/host');
const { debuglog } = require('internal/util/debuglog');
const types = require('util/types');
const {
  ErrnoException,
  ExceptionWithHostPort,
  codes: {
    ERR_FALSY_VALUE_REJECTION,
    ERR_INVALID_ARG_TYPE,
    ERR_INVALID_ARG_VALUE,
    ERR_OUT_OF_RANGE,
  },
  isErrorStackTraceLimitWritable,
} = require('internal/errors');
const {
  format,
  formatWithOptions,
  inspect,
  stripVTControlCharacters,
} = require('internal/util/inspect');
const {
  validateBoolean,
  validateFunction,
  validateString,
  validateOneOf,
  validateObject,
} = require('internal/validators');
const {
  deprecate: internalDeprecate,
  promisify,
} = require('internal/util');
let internalDeepEqual;

let utilColors;
function lazyUtilColors() {
  utilColors ??= require('internal/util/colors');
  return utilColors;
}
// The stream predicates load with the stream stack, which console.log does not need.
let streamUtils;
function lazyStreamUtils() {
  streamUtils ??= require('internal/streams/utils');
  return streamUtils;
}
let Buffer;
function lazyBuffer() {
  Buffer ??= require('buffer').Buffer;
  return Buffer;
}

// Pre-computed ANSI escape code constants
const kEscape = '\u001b[';
const kEscapeEnd = 'm';

// Codes for dim (2) and bold (1) - these share close code 22
const kDimCode = 2;
const kBoldCode = 1;

// Close sequence for 24-bit foreground colors (reset to default foreground)
const kHexCloseSeq = kEscape + '39' + kEscapeEnd;

let styleCache;

const kHexStyleCacheMax = 256;

let hexStyleCache;

function getHexStyleCache() {
  hexStyleCache ??= new SafeMap();
  return hexStyleCache;
}

function codesToStyle(codes) {
  const openNum = codes[0];
  return {
    __proto__: null,
    openSeq: kEscape + openNum + kEscapeEnd,
    closeSeq: kEscape + codes[1] + kEscapeEnd,
    keepClose: openNum === kDimCode || openNum === kBoldCode,
  };
}

function getStyleCache() {
  if (styleCache === undefined) {
    styleCache = { __proto__: null };
    const colors = inspect.colors;
    for (const key of ObjectGetOwnPropertyNames(colors)) {
      const codes = colors[key];
      if (codes) {
        styleCache[key] = codesToStyle(codes);
      }
    }
  }
  return styleCache;
}

/**
 * Returns the cached ANSI escape sequences for a hex color.
 * Computes and caches on first use to avoid repeated Buffer allocations.
 * @param {string} hex A valid hex color string (#RGB or #RRGGBB)
 * @returns {{openSeq: string, closeSeq: string}}
 */
function getHexStyle(hex) {
  const cache = getHexStyleCache();
  const cached = cache.get(hex);
  if (cached !== undefined) return cached;
  const { 0: r, 1: g, 2: b } = hexToRgb(hex);
  const style = {
    __proto__: null,
    openSeq: kEscape + rgbToAnsi24Bit(r, g, b) + kEscapeEnd,
    closeSeq: kHexCloseSeq,
  };
  if (cache.size >= kHexStyleCacheMax)
    cache.delete(cache.keys().next().value);
  cache.set(hex, style);
  return style;
}

function replaceCloseCode(str, closeSeq, openSeq, keepClose) {
  const closeLen = closeSeq.length;
  let index = str.indexOf(closeSeq);
  if (index === -1) return str;

  let result = '';
  let lastIndex = 0;
  const replacement = keepClose ? closeSeq + openSeq : openSeq;

  do {
    const afterClose = index + closeLen;
    if (afterClose < str.length) {
      result += str.slice(lastIndex, index) + replacement;
      lastIndex = afterClose;
    } else {
      break;
    }
    index = str.indexOf(closeSeq, lastIndex);
  } while (index !== -1);

  return result + str.slice(lastIndex);
}

// Matches #RGB or #RRGGBB
const hexColorRegExp = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * Parses a hex color string into RGB components.
 * Supports both 3-digit (#RGB) and 6-digit (#RRGGBB) formats.
 * @param {string} hex A valid hex color string
 * @returns {Buffer} The RGB components
 */
function hexToRgb(hex) {
  // Normalize to 6 digits
  let hexStr;
  if (hex.length === 4) {
    // Expand #RGB to #RRGGBB
    hexStr = hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
  } else if (hex.length === 7) {
    hexStr = StringPrototypeSlice(hex, 1);
  } else {
    throw new ERR_OUT_OF_RANGE('hex', '#RGB or #RRGGBB', hex);
  }

  // TODO(araujogui): use Uint8Array.fromHex
  return lazyBuffer().from(hexStr, 'hex');
}

/**
 * Generates the ANSI TrueColor (24-bit) escape sequence for a foreground color.
 * @param {number} r Red component (0-255)
 * @param {number} g Green component (0-255)
 * @param {number} b Blue component (0-255)
 * @returns {string} The ANSI escape sequence
 */
function rgbToAnsi24Bit(r, g, b) {
  return `38;2;${r};${g};${b}`;
}

/**
 * @param {string | string[]} format
 * @param {string} text
 * @param {object} [options]
 * @param {boolean} [options.validateStream] - Whether to validate the stream.
 * @param {Stream} [options.stream] - The stream used for validation.
 * @returns {string}
 */
function styleText(format, text, options) {
  const validateStream = options?.validateStream ?? true;

  // Fast path: single format string with validateStream=false
  if (!validateStream && typeof format === 'string' && typeof text === 'string') {
    const cache = getStyleCache();
    if (format === 'none') return text;
    const style = cache[format];
    if (style !== undefined) {
      const processed = replaceCloseCode(text, style.closeSeq, style.openSeq, style.keepClose);
      return style.openSeq + processed + style.closeSeq;
    }

    if (format[0] === '#') {
      let hexStyle = getHexStyleCache().get(format);
      if (hexStyle === undefined && RegExpPrototypeExec(hexColorRegExp, format) !== null) {
        hexStyle = getHexStyle(format);
      }
      if (hexStyle !== undefined) {
        const processed = replaceCloseCode(text, hexStyle.closeSeq, hexStyle.openSeq, false);
        return hexStyle.openSeq + processed + hexStyle.closeSeq;
      }
    }
  }

  validateString(text, 'text');
  if (options !== undefined) {
    validateObject(options, 'options');
  }
  validateBoolean(validateStream, 'options.validateStream');

  let skipColorize;
  if (validateStream) {
    const stream = options?.stream ?? process.stdout;
    const { isReadableStream, isWritableStream, isNodeStream } = lazyStreamUtils();
    if (
      !isReadableStream(stream) &&
      !isWritableStream(stream) &&
      !isNodeStream(stream)
    ) {
      throw new ERR_INVALID_ARG_TYPE('stream', ['ReadableStream', 'WritableStream', 'Stream'], stream);
    }
    skipColorize = !lazyUtilColors().shouldColorize(stream);
  }

  const formatArray = ArrayIsArray(format) ? format : [format];
  const colors = inspect.colors;

  let openCodes = '';
  let closeCodes = '';
  let processedText = text;

  for (const key of formatArray) {
    if (key === 'none') continue;

    if (typeof key === 'string' && key[0] === '#') {
      if (RegExpPrototypeExec(hexColorRegExp, key) === null) {
        throw new ERR_INVALID_ARG_VALUE('format', key,
                                        'must be a valid hex color (#RGB or #RRGGBB)');
      }
      if (skipColorize) continue;
      const { 0: r, 1: g, 2: b } = hexToRgb(key);
      const hexOpenSeq = kEscape + rgbToAnsi24Bit(r, g, b) + kEscapeEnd;
      openCodes += hexOpenSeq;
      closeCodes = kHexCloseSeq + closeCodes;
      processedText = replaceCloseCode(processedText, kHexCloseSeq, hexOpenSeq, false);
      continue;
    }

    const codes = colors[key];
    if (!codes) {
      validateOneOf(key, 'format', ObjectGetOwnPropertyNames(inspect.colors));
    }
    const { openSeq, closeSeq, keepClose } = codesToStyle(codes);
    openCodes += openSeq;
    closeCodes = closeSeq + closeCodes;
    processedText = replaceCloseCode(processedText, closeSeq, openSeq, keepClose);
  }

  if (skipColorize) return text;

  return `${openCodes}${processedText}${closeCodes}`;
}

/**
 * Inherit the prototype methods from one constructor into another.
 *
 * The Function.prototype.inherits from lang.js rewritten as a standalone
 * function (not on Function.prototype). NOTE: If this file is to be loaded
 * during bootstrapping this function needs to be rewritten using some native
 * functions as prototype setup using normal JavaScript does not work as
 * expected during bootstrapping (see mirror.js in r114903).
 * @param {Function} ctor Constructor function which needs to inherit the
 *   prototype.
 * @param {Function} superCtor Constructor function to inherit prototype from.
 * @throws {TypeError} Will error if either constructor is null, or if
 * the super constructor lacks a prototype.
 */
function inherits(ctor, superCtor) {

  if (ctor === undefined || ctor === null)
    throw new ERR_INVALID_ARG_TYPE('ctor', 'Function', ctor);

  if (superCtor === undefined || superCtor === null)
    throw new ERR_INVALID_ARG_TYPE('superCtor', 'Function', superCtor);

  if (superCtor.prototype === undefined) {
    throw new ERR_INVALID_ARG_TYPE('superCtor.prototype',
                                   'Object', superCtor.prototype);
  }
  ObjectDefineProperty(ctor, 'super_', {
    __proto__: null,
    value: superCtor,
    writable: true,
    configurable: true,
  });
  ObjectSetPrototypeOf(ctor.prototype, superCtor.prototype);
}

/**
 * @deprecated since v6.0.0
 * @template T
 * @template S
 * @param {T} target
 * @param {S} source
 * @returns {(T & S) | null}
 */
function _extend(target, source) {
  // Don't do anything if source isn't an object
  if (source === null || typeof source !== 'object') return target;

  const keys = ObjectKeys(source);
  let i = keys.length;
  while (i--) {
    target[keys[i]] = source[keys[i]];
  }
  return target;
}

const callbackifyOnRejected = (reason, cb) => {
  // `!reason` guard inspired by bluebird (Ref: https://goo.gl/t5IS6M).
  // Because `null` is a special error value in callbacks which means "no error
  // occurred", we error-wrap so the callback consumer can distinguish between
  // "the promise rejected with null" or "the promise fulfilled with undefined".
  if (!reason) {
    reason = new ERR_FALSY_VALUE_REJECTION.HideStackFramesError(reason);
    ErrorCaptureStackTrace(reason, callbackifyOnRejected);
  }
  return cb(reason);
};

/**
 * Converts a Promise-returning function to callback style
 * @param {Function} original
 * @returns {Function}
 */
function callbackify(original) {
  validateFunction(original, 'original');

  // We DO NOT return the promise as it gives the user a false sense that
  // the promise is actually somehow related to the callback's execution
  // and that the callback throwing will reject the promise.
  function callbackified(...args) {
    const maybeCb = ArrayPrototypePop(args);
    validateFunction(maybeCb, 'last argument');
    const cb = FunctionPrototypeBind(maybeCb, this);
    // In true node style we process the callback on `nextTick` with all the
    // implications (stack, `uncaughtException`, `async_hooks`)
    ReflectApply(original, this, args)
      .then((ret) => process.nextTick(cb, null, ret),
            (rej) => process.nextTick(callbackifyOnRejected, rej, cb));
  }

  const descriptors = ObjectGetOwnPropertyDescriptors(original);
  // It is possible to manipulate a functions `length` or `name` property. This
  // guards against the manipulation.
  if (typeof descriptors.length.value === 'number') {
    descriptors.length.value++;
  }
  if (typeof descriptors.name.value === 'string') {
    descriptors.name.value += 'Callbackified';
  }
  const propertiesValues = ObjectValues(descriptors);
  for (let i = 0; i < propertiesValues.length; i++) {
  // We want to use null-prototype objects to not rely on globally mutable
  // %Object.prototype%.
    ObjectSetPrototypeOf(propertiesValues[i], null);
  }
  ObjectDefineProperties(callbackified, descriptors);
  return callbackified;
}

function _errnoException(...args) {
  if (isErrorStackTraceLimitWritable()) {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    const e = new ErrnoException(...args);
    Error.stackTraceLimit = limit;
    ErrorCaptureStackTrace(e, _errnoException);
    return e;
  }
  return new ErrnoException(...args);
}

function _exceptionWithHostPort(...args) {
  if (isErrorStackTraceLimitWritable()) {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    const e = new ExceptionWithHostPort(...args);
    Error.stackTraceLimit = limit;
    ErrorCaptureStackTrace(e, _exceptionWithHostPort);
    return e;
  }
  return new ExceptionWithHostPort(...args);
}

// Public util.deprecate API
function deprecate(fn, msg, code, { modifyPrototype } = {}) {
  return internalDeprecate(fn, msg, code, undefined, modifyPrototype);
}


let traceSigintStarted = false;
let traceSigintEffective = false;
function traceSigintNative(enable) {
  const status = host.processNative('traceSigint', [enable]);
  if (status < 0) throw Object.assign(new Error('Cannot watch for SIGINT signals'), { code: 'ERR_CANNOT_WATCH_SIGINT' });
  traceSigintEffective = enable;
}
function traceSigintNewListener(name) {
  if (name === 'SIGINT' && traceSigintEffective) traceSigintNative(false);
}
function traceSigintRemoveListener(name) {
  if (name === 'SIGINT' && process.listenerCount('SIGINT') === 0 && !traceSigintEffective) traceSigintNative(true);
}
function setTraceSigInt(enable) {
  if (!require('worker_threads').isMainThread) {
    throw Object.assign(new TypeError('Calling util.setTraceSigInt is not supported in workers'), { code: 'ERR_WORKER_UNSUPPORTED_OPERATION' });
  }
  // Node intentionally uses truthiness here, not validateBoolean.
  if (enable) {
    if (traceSigintStarted) return;
    traceSigintStarted = true;
    process.prependListener('newListener', traceSigintNewListener);
    process.on('removeListener', traceSigintRemoveListener);
    if (process.listenerCount('SIGINT') === 0) traceSigintNative(true);
  } else {
    if (!traceSigintStarted) return;
    traceSigintStarted = false;
    process.removeListener('newListener', traceSigintNewListener);
    process.removeListener('removeListener', traceSigintRemoveListener);
    if (traceSigintEffective) traceSigintNative(false);
  }
}
function markPromiseAsHandled(promise) {
  if (!types.isPromise(promise)) {
    const { codes: { ERR_INVALID_ARG_TYPE } } = require('internal/util_public/support');
    throw new ERR_INVALID_ARG_TYPE('promise', 'Promise', promise);
  }
  host.markPromiseAsHandled(promise);
}
function getCallSites(frameCount = 10, options) {
  const { validateObject, validateBoolean, validateInteger } = require('internal/util_public/support');
  if (options === undefined) {
    if (typeof frameCount === 'object') {
      options = frameCount;
      validateObject(options, 'options');
      if (options.sourceMap !== undefined) validateBoolean(options.sourceMap, 'options.sourceMap');
      frameCount = 10;
    } else {
      options = {};
    }
  } else {
    validateObject(options, 'options');
    if (options.sourceMap !== undefined) validateBoolean(options.sourceMap, 'options.sourceMap');
  }
  validateInteger(frameCount, 'frameCount', 1, 200);
  // util's implicit policy is the startup flag, not mutable process support.
  const sourceMap = options.sourceMap === true ||
    (require('internal/options').getOptionValue('--enable-source-maps') && options.sourceMap !== false);
  const frames = host.captureCallSites(frameCount, getCallSites);
  if (sourceMap) {
    const { mapPosition } = require('internal/source_maps');
    for (let index = 0; index < frames.length; index++)
      frames[index] = mapPosition(frames[index], { kind: 'callsite' });
  }
  return frames;
}
module.exports = {
  format, formatWithOptions, inspect, types, promisify, callbackify, inherits, deprecate, debuglog, debug: debuglog,
  isDeepStrictEqual(a, b, skipPrototype) {
    if (internalDeepEqual === undefined) {
      internalDeepEqual = require('internal/util/comparisons').isDeepStrictEqual;
    }
    return internalDeepEqual(a, b, skipPrototype);
  },
  stripVTControlCharacters,
  toUSVString(input) {
    return `${input}`.toWellFormed();
  },
  styleText,
  markPromiseAsHandled, getCallSites, setTraceSigInt,
  _errnoException,
  _exceptionWithHostPort,
  // Placeholders keep the key order; the loop below turns each into a load-on-first-read property.
  transferableAbortController: undefined,
  transferableAbortSignal: undefined,
  aborted: undefined,
  parseArgs: undefined,
  parseEnv: undefined,
  MIMEParams: undefined,
  MIMEType: undefined,
  diff: undefined,
  getSystemErrorMap: undefined,
  getSystemErrorName: undefined,
  getSystemErrorMessage: undefined,
  convertProcessSignalToExitCode: undefined,
  debounce: undefined,
  throttle: undefined,
  TextEncoder: undefined,
  TextDecoder: undefined,
  isArray: internalDeprecate(ArrayIsArray,
                             'The `util.isArray` API is deprecated. Please use `Array.isArray()` instead.',
                             'DEP0044'),
  _extend: internalDeprecate(_extend,
                             'The `util._extend` API is deprecated. Please use Object.assign() instead.',
                             'DEP0060'),
};
// The formatter is on every console.log path; argument parsing, MIME types,
// diffing and the text codecs are not, so each loads when it is first read.
for (const [name, load] of [
  ['transferableAbortController', () => require('internal/abort_controller').util.transferableAbortController],
  ['transferableAbortSignal', () => require('internal/abort_controller').util.transferableAbortSignal],
  ['aborted', () => require('internal/abort_controller').util.aborted],
  ['parseArgs', () => require('internal/util_public/parse_args').parseArgs],
  ['parseEnv', () => require('internal/util_public/parse_env').parseEnv],
  ['MIMEParams', () => require('internal/util_public/mime').MIMEParams],
  ['MIMEType', () => require('internal/util_public/mime').MIMEType],
  ['diff', () => require('internal/util_public/diff').diff],
  ['getSystemErrorMap', () => require('internal/util_public/system').getSystemErrorMap],
  ['getSystemErrorName', () => require('internal/util_public/system').getSystemErrorName],
  ['getSystemErrorMessage', () => require('internal/util_public/system').getSystemErrorMessage],
  ['convertProcessSignalToExitCode', () => require('internal/util_public/system').convertProcessSignalToExitCode],
  ['debounce', () => require('internal/util_public/debounce')],
  ['throttle', () => require('internal/util_public/throttle')],
  ['TextEncoder', () => require('internal/web/encoding').TextEncoder],
  ['TextDecoder', () => require('internal/web/encoding').TextDecoder],
]) {
  const settle = value => Object.defineProperty(module.exports, name, { value, writable: true, enumerable: true, configurable: true });
  Object.defineProperty(module.exports, name, {
    enumerable: true, configurable: true,
    get() { const value = load(); settle(value); return value; },
    set(value) { settle(value); },
  });
}
