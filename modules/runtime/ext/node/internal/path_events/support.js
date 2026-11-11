// Argument-error formatting adapted from Node.js.
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
  AbortError,
  codes: { ERR_INVALID_ARG_TYPE, ERR_OUT_OF_RANGE, ERR_UNHANDLED_ERROR },
  genericNodeError,
} = require('internal/errors');

function outOfRange(name, range, value) {
  throw new ERR_OUT_OF_RANGE(name, range, value);
}
function validateString(value, name) {
  if (typeof value !== 'string') throw new ERR_INVALID_ARG_TYPE(name, 'string', value);
}
function validateObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ERR_INVALID_ARG_TYPE(name, 'Object', value);
  }
}
function validateBoolean(value, name) {
  if (typeof value !== 'boolean') throw new ERR_INVALID_ARG_TYPE(name, 'boolean', value);
}
function validateFunction(value, name) {
  if (typeof value !== 'function') throw new ERR_INVALID_ARG_TYPE(name, 'function', value);
}
function validateNumber(value, name, min, max) {
  if (typeof value !== 'number') throw new ERR_INVALID_ARG_TYPE(name, 'number', value);
  if ((min !== undefined && (value < min || Number.isNaN(value))) ||
      (max !== undefined && (value > max || Number.isNaN(value)))) {
    outOfRange(name, max === undefined ? `>= ${min}` : `>= ${min} && <= ${max}`, value);
  }
}
function validateInteger(value, name, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'number') throw new ERR_INVALID_ARG_TYPE(name, 'number', value);
  if (!Number.isInteger(value)) outOfRange(name, 'an integer', value);
  if (value < min || value > max) outOfRange(name, `>= ${min} && <= ${max}`, value);
}
function validateAbortSignal(value, name) {
  if (value !== undefined && (value === null || typeof value !== 'object' || !('aborted' in value))) {
    throw new ERR_INVALID_ARG_TYPE(name, 'AbortSignal', value);
  }
}
function getLazy(factory) {
  let value;
  return () => value ??= factory();
}
function spliceOne(array, index) {
  for (let i = index; i + 1 < array.length; i++) array[i] = array[i + 1];
  array.pop();
}
module.exports = {
  AbortError,
  codes: { ERR_INVALID_ARG_TYPE, ERR_UNHANDLED_ERROR },
  genericNodeError,
  validateString, validateObject, validateBoolean, validateFunction,
  validateNumber, validateInteger, validateAbortSignal,
  kEmptyObject: Object.freeze(Object.create(null)),
  isWindows: require('internal/host').platform === 'win32',
  getLazy, spliceOne,
};
