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
  codes: { ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE, ERR_MISSING_ARGS, ERR_OUT_OF_RANGE, ERR_SOCKET_BAD_PORT, ERR_UNKNOWN_SIGNAL },
} = require('internal/errors');

function codedError(Base, code, message) {
  const error = new Base(message);
  error.code = code;
  return error;
}
function unknownSignal(signal) { return new ERR_UNKNOWN_SIGNAL(signal); }

const isUint32 = (value) => value === (value >>> 0);
function validateString(value, name) {
  if (typeof value !== 'string') throw new ERR_INVALID_ARG_TYPE(name, 'string', value);
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
      (port === 0 && !allowZero)) {
    throw new ERR_SOCKET_BAD_PORT(name, port, allowZero);
  }
  return port | 0;
}
function validateBoolean(value, name) {
  if (typeof value !== 'boolean') throw new ERR_INVALID_ARG_TYPE(name, 'boolean', value);
}
function validateFunction(value, name) {
  if (typeof value !== 'function') throw new ERR_INVALID_ARG_TYPE(name, 'Function', value);
}
function validateNumber(value, name, min, max) {
  if (typeof value !== 'number') throw new ERR_INVALID_ARG_TYPE(name, 'number', value);
  if ((min != null && value < min) || (max != null && value > max) || ((min != null || max != null) && Number.isNaN(value))) {
    throw new ERR_OUT_OF_RANGE(name,
      `${min != null ? `>= ${min}` : ''}${min != null && max != null ? ' && ' : ''}${max != null ? `<= ${max}` : ''}`, value);
  }
}
function validateInteger(value, name, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'number') throw new ERR_INVALID_ARG_TYPE(name, 'number', value);
  if (!Number.isInteger(value)) throw new ERR_OUT_OF_RANGE(name, 'an integer', value);
  if (value < min || value > max) throw new ERR_OUT_OF_RANGE(name, `>= ${min} && <= ${max}`, value);
}
function validateInt32(value, name, min = -2147483648, max = 2147483647) { validateInteger(value, name, min, max); }
function validateUint32(value, name, positive = false) { validateInteger(value, name, positive ? 1 : 0, 4294967295); }
const kValidateObjectAllowNullable = 1;
const kValidateObjectAllowArray = 2;
const kValidateObjectAllowFunction = 4;
function validateObject(value, name, options = 0) {
  if ((value === null && !(options & kValidateObjectAllowNullable)) ||
      (Array.isArray(value) && !(options & kValidateObjectAllowArray)) ||
      (typeof value !== 'object' && (typeof value !== 'function' || !(options & kValidateObjectAllowFunction)))) {
    throw new ERR_INVALID_ARG_TYPE(name, 'Object', value);
  }
}
function validateArray(value, name, minLength = 0) {
  if (!Array.isArray(value)) throw new ERR_INVALID_ARG_TYPE(name, 'Array', value);
  if (value.length < minLength) throw new ERR_INVALID_ARG_VALUE(name, value, `must have a length of at least ${minLength}`);
}
function validateOneOf(value, name, oneOf) {
  if (!oneOf.includes(value)) {
    const allowed = oneOf.map(v => typeof v === 'string' ? `'${v}'` : String(v)).join(', ');
    throw new ERR_INVALID_ARG_VALUE(name, value, 'must be one of: ' + allowed);
  }
}
function validateAbortSignal(signal, name) {
  if (signal !== undefined && (signal === null || typeof signal !== 'object' || !('aborted' in signal))) {
    throw new ERR_INVALID_ARG_TYPE(name, 'AbortSignal', signal);
  }
}
function validateBuffer(buffer, name = 'buffer') {
  if (!ArrayBuffer.isView(buffer)) throw new ERR_INVALID_ARG_TYPE(name, ['Buffer', 'TypedArray', 'DataView'], buffer);
}
const linkValueRegExp = /^(?:<[^>]*>)(?:\s*;\s*[^;"\s]+(?:=(")?[^;"\s]*\1)?)*$/;
function validateLinkHeaderFormat(value, name) {
  if (typeof value === 'undefined' || !linkValueRegExp.exec(value)) {
    throw new ERR_INVALID_ARG_VALUE(name, value, 'must be an array or string of format "</styles.css>; rel=preload; as=style"');
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
  throw new ERR_INVALID_ARG_VALUE('hints', hints, 'must be an array or string of format "</styles.css>; rel=preload; as=style"');
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
  throw unknownSignal(signal);
}
function isUint8Array(value) { return value instanceof Uint8Array; }
function toPathIfFileURL(value) {
  if (value == null || typeof value !== 'object' || value.href === undefined || value.protocol === undefined) return value;
  return require('url').fileURLToPath(value);
}
function validatePath(path, name = 'path') {
  if (typeof path !== 'string' && !isUint8Array(path)) throw new ERR_INVALID_ARG_TYPE(name, ['string', 'Buffer', 'URL'], path);
  if (typeof path === 'string' ? path.includes('\u0000') : path.includes(0)) {
    throw new ERR_INVALID_ARG_VALUE(name, path, 'must be a string, Uint8Array, or URL without null bytes');
  }
}
function getValidatedPath(value, name = 'path') {
  const path = toPathIfFileURL(value);
  validatePath(path, name);
  return path;
}

// Node wraps its validators in hideStackFrames(), whose callers inside other
// hidden frames use fn.withoutStackTrace.
for (const fn of [validateString, validateBoolean, validateFunction, validateNumber, validateInteger, validateInt32,
  validateUint32, validateObject, validateArray, validateOneOf, validateAbortSignal, validateBuffer]) {
  fn.withoutStackTrace = fn;
}

module.exports = {
  codes: { ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE, ERR_MISSING_ARGS, ERR_OUT_OF_RANGE },
  codedError, unknownSignal,
  kValidateObjectAllowNullable, kValidateObjectAllowArray, kValidateObjectAllowFunction,
  validateString, validateBoolean, validateFunction, validateNumber, validateInteger, validateInt32,
  validateUint32, validateObject, validateArray, validateOneOf, validateAbortSignal,
  isUint32, validateBuffer, validateLinkHeaderValue,
  convertToValidSignal, signalName, toPathIfFileURL, validatePath, getValidatedPath, validatePort,
};
