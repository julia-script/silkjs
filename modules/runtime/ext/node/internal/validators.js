// Argument validators adapted from Node.js v24.22.1 lib/internal/validators.js and
// lib/internal/errors.js. Messages and codes match Node's, so tests and callers that
// compare them see the same text.
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
  codes: { ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE, ERR_MISSING_ARGS, ERR_OUT_OF_RANGE, ERR_SOCKET_BAD_PORT, ERR_UNKNOWN_SIGNAL, ERR_INVALID_THIS },
} = require('internal/errors');

// hideStackFrames: Node wraps each validator so the error it throws starts at the
// validator's caller. Capturing again where a validator throws gives the same stack
// without a wrapper on every call.
function hidden(validator, error) {
  if (Error.stackTraceLimit) Error.captureStackTrace(error, validator);
  return error;
}
function isInt32(value) {
  return value === (value | 0);
}

function codedError(Base, code, message) {
  const error = new Base(message);
  error.code = code;
  return error;
}
function unknownSignal(signal) { return new ERR_UNKNOWN_SIGNAL(signal); }

const isUint32 = (value) => value === (value >>> 0);
function validateString(value, name) {
  if (typeof value !== 'string') throw hidden(validateString, new ERR_INVALID_ARG_TYPE(name, 'string', value));
}
/**
 * @param {number|string} port
 * @param {string} [name]
 * @param {boolean} [allowZero]
 * @returns {number}
 */
function validatePort(port, name = 'Port', allowZero = true) {
  if ((typeof port !== 'number' && typeof port !== 'string') ||
      (typeof port === 'string' && port.trim().length === 0) ||
      +port !== (+port >>> 0) ||
      port > 0xFFFF ||
      (+port === 0 && !allowZero)) {
    throw hidden(validatePort, new ERR_SOCKET_BAD_PORT(name, port, allowZero));
  }
  return port | 0;
}
function validateBoolean(value, name) {
  if (typeof value !== 'boolean') throw hidden(validateBoolean, new ERR_INVALID_ARG_TYPE(name, 'boolean', value));
}
function validateFunction(value, name) {
  if (typeof value !== 'function') throw hidden(validateFunction, new ERR_INVALID_ARG_TYPE(name, 'Function', value));
}
// A function that is neither async nor a generator.
function validatePlainFunction(value, name) {
  validateFunction(value, name);
  const types = require('util/types');
  if (types.isAsyncFunction(value) || types.isGeneratorFunction(value)) throw hidden(validatePlainFunction, new ERR_INVALID_ARG_TYPE(name, 'function', value));
}
function validateNumber(value, name, min, max) {
  if (typeof value !== 'number') throw hidden(validateNumber, new ERR_INVALID_ARG_TYPE(name, 'number', value));
  if ((min != null && value < min) || (max != null && value > max) || ((min != null || max != null) && Number.isNaN(value))) {
    throw hidden(validateNumber, new ERR_OUT_OF_RANGE(name,
      `${min != null ? `>= ${min}` : ''}${min != null && max != null ? ' && ' : ''}${max != null ? `<= ${max}` : ''}`, value));
  }
}
function checkInteger(value, name, min, max, validator) {
  if (typeof value !== 'number') throw hidden(validator, new ERR_INVALID_ARG_TYPE(name, 'number', value));
  if (!Number.isInteger(value)) throw hidden(validator, new ERR_OUT_OF_RANGE(name, 'an integer', value));
  if (value < min || value > max) throw hidden(validator, new ERR_OUT_OF_RANGE(name, `>= ${min} && <= ${max}`, value));
}
function validateInteger(value, name, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) { checkInteger(value, name, min, max, validateInteger); }
function validateInt32(value, name, min = -2147483648, max = 2147483647) { checkInteger(value, name, min, max, validateInt32); }
function validateUint32(value, name, positive = false) { checkInteger(value, name, positive ? 1 : 0, 4294967295, validateUint32); }
const kValidateObjectAllowNullable = 1;
const kValidateObjectAllowArray = 2;
const kValidateObjectAllowFunction = 4;
const kValidateObjectAllowObjects = kValidateObjectAllowArray | kValidateObjectAllowFunction;
const kValidateObjectAllowObjectsAndNull = kValidateObjectAllowNullable | kValidateObjectAllowArray | kValidateObjectAllowFunction;
function validateObject(value, name, options = 0) {
  if ((value === null && !(options & kValidateObjectAllowNullable)) ||
      (Array.isArray(value) && !(options & kValidateObjectAllowArray)) ||
      (typeof value !== 'object' && (typeof value !== 'function' || !(options & kValidateObjectAllowFunction)))) {
    throw hidden(validateObject, new ERR_INVALID_ARG_TYPE(name, 'Object', value));
  }
}
function validateDictionary(value, name) {
  if (value != null && typeof value !== 'object' && typeof value !== 'function')
    throw hidden(validateDictionary, new ERR_INVALID_ARG_TYPE(name, 'a dictionary', value));
}
function validateArray(value, name, minLength = 0) {
  if (!Array.isArray(value)) throw hidden(validateArray, new ERR_INVALID_ARG_TYPE(name, 'Array', value));
  if (value.length < minLength) throw hidden(validateArray, new ERR_INVALID_ARG_VALUE(name, value, `must have a length of at least ${minLength}`));
}
function validateStringArray(value, name) {
  validateArray(value, name);
  for (let i = 0; i < value.length; ++i) validateString(value[i], `${name}[${i}]`);
}
function validateOneOf(value, name, oneOf) {
  if (!oneOf.includes(value)) {
    const allowed = oneOf.map(v => typeof v === 'string' ? `'${v}'` : String(v)).join(', ');
    throw hidden(validateOneOf, new ERR_INVALID_ARG_VALUE(name, value, 'must be one of: ' + allowed));
  }
}
function validateAbortSignal(signal, name) {
  if (signal !== undefined && (signal === null || typeof signal !== 'object' || !('aborted' in signal))) {
    throw hidden(validateAbortSignal, new ERR_INVALID_ARG_TYPE(name, 'AbortSignal', signal));
  }
}
function validateThisInternalField(object, fieldKey, className) {
  if (typeof object !== 'object' || object === null || !Object.prototype.hasOwnProperty.call(object, fieldKey)) {
    throw hidden(validateThisInternalField, new ERR_INVALID_THIS(className));
  }
}
function validateBuffer(buffer, name = 'buffer') {
  if (!ArrayBuffer.isView(buffer)) throw hidden(validateBuffer, new ERR_INVALID_ARG_TYPE(name, ['Buffer', 'TypedArray', 'DataView'], buffer));
}
const linkValueRegExp = /^(?:<[^>\r\n]*>)(?:\s*;\s*[^;"\s]+(?:=(")?[^;"\s]*\1)?)*$/;
function validateLinkHeaderFormat(value, name) {
  if (typeof value === 'undefined' || !linkValueRegExp.exec(value)) {
    throw hidden(validateLinkHeaderFormat, new ERR_INVALID_ARG_VALUE(name, value, 'must be an array or string of format "</styles.css>; rel=preload; as=style"'));
  }
}
function validateLinkHeaderValue(hints) {
  if (typeof hints === 'string') {
    validateLinkHeaderFormat(hints, 'hints');
    return hints;
  } else if (Array.isArray(hints)) {
    let result = '';
    for (let i = 0; i < hints.length; i++) {
      validateLinkHeaderFormat(hints[i], 'hints');
      result += hints[i];
      if (i !== hints.length - 1) result += ', ';
    }
    return result;
  }
  throw hidden(validateLinkHeaderValue, new ERR_INVALID_ARG_VALUE('hints', hints, 'must be an array or string of format "</styles.css>; rel=preload; as=style"'));
}
let signals;
const signalTable = () => signals ??= require('os').constants.signals;
let signalNames;
function signalName(number) {
  if (!signalNames) {
    signalNames = new Map();
    const table = signalTable();
    for (const key of Object.keys(table)) if (!signalNames.has(table[key])) signalNames.set(table[key], key);
  }
  return signalNames.get(number);
}
// Node's convertToValidSignal: a known signal number or a case-insensitive known name.
function convertToValidSignal(signal) {
  if (typeof signal === 'number' && signalName(signal) !== undefined) return signal;
  if (typeof signal === 'string') {
    const number = signalTable()[signal.toUpperCase()];
    if (number) return number;
  }
  throw hidden(convertToValidSignal, unknownSignal(signal));
}
function isUint8Array(value) { return value instanceof Uint8Array; }
function toPathIfFileURL(value) {
  if (value == null || typeof value !== 'object' || value.href === undefined || value.protocol === undefined) return value;
  return require('url').fileURLToPath(value);
}
function validatePath(path, name = 'path') {
  if (typeof path !== 'string' && !isUint8Array(path)) throw hidden(validatePath, new ERR_INVALID_ARG_TYPE(name, ['string', 'Buffer', 'URL'], path));
  if (typeof path === 'string' ? path.includes('\u0000') : path.includes(0)) {
    throw hidden(validatePath, new ERR_INVALID_ARG_VALUE(name, path, 'must be a string, Uint8Array, or URL without null bytes'));
  }
}
function getValidatedPath(value, name = 'path') {
  const path = toPathIfFileURL(value);
  validatePath(path, name);
  return path;
}

const octalReg = /^[0-7]+$/;
const modeDesc = 'must be a 32-bit unsigned integer or an octal string';
// Values that become a mode_t: valid numbers and octal strings.
function parseFileMode(value, name, def) {
  value ??= def;
  if (typeof value === 'string') {
    if (octalReg.exec(value) === null) throw hidden(parseFileMode, new ERR_INVALID_ARG_VALUE(name, value, modeDesc));
    value = Number.parseInt(value, 8);
  }
  validateUint32(value, name);
  // Coerce -0 to +0.
  return value + 0;
}
// Node's validateFiniteNumber and checkRangesOrGetDefault (used by zlib).
function validateFiniteNumber(number, name) {
  // Common case
  if (number === undefined) return false;
  if (Number.isFinite(number)) return true; // Is a valid number
  if (Number.isNaN(number)) return false;
  validateNumber(number, name);
  // Infinite numbers
  throw hidden(validateFiniteNumber, new ERR_OUT_OF_RANGE(name, 'a finite number', number));
}
function checkRangesOrGetDefault(number, name, lower, upper, def) {
  if (!validateFiniteNumber(number, name)) return def;
  if (number < lower || number > upper) {
    throw hidden(checkRangesOrGetDefault, new ERR_OUT_OF_RANGE(name, `>= ${lower} and <= ${upper}`, number));
  }
  return number;
}
function validateStringWithoutNullBytes(value, name) {
  validateString(value, name);
  if (value.includes('\u0000')) {
    throw hidden(validateStringWithoutNullBytes, new ERR_INVALID_ARG_VALUE(name, value, 'must be a string without null bytes'));
  }
}

// Node wraps its validators in hideStackFrames(), whose callers inside other
// hidden frames use fn.withoutStackTrace.
for (const fn of [validateString, validateBoolean, validateFunction, validatePlainFunction, validateNumber, validateInteger, validateInt32,
  validateUint32, validateObject, validateDictionary, validateArray, validateStringArray, validateOneOf, validateAbortSignal, validateBuffer,
  validateStringWithoutNullBytes]) {
  fn.withoutStackTrace = fn;
}

module.exports = {
  codes: { ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE, ERR_MISSING_ARGS, ERR_OUT_OF_RANGE },
  codedError, unknownSignal, isInt32,
  kValidateObjectAllowNullable, kValidateObjectAllowArray, kValidateObjectAllowFunction,
  kValidateObjectAllowObjects, kValidateObjectAllowObjectsAndNull,
  validateString, validateBoolean, validateFunction, validatePlainFunction, validateNumber, validateInteger, validateInt32,
  validateUint32, validateObject, validateDictionary, validateArray, validateStringArray, validateOneOf, validateAbortSignal,
  isUint32, parseFileMode, validateBuffer, validateLinkHeaderValue,
  convertToValidSignal, signalName, toPathIfFileURL, validatePath, getValidatedPath, validatePort,
  validateFiniteNumber, checkRangesOrGetDefault, validateThisInternalField,
  validateStringWithoutNullBytes,
};
