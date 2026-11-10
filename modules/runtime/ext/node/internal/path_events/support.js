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

function specificType(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  switch (typeof value) {
    case 'bigint': return `type bigint (${value}n)`;
    case 'number': return `type number (${Object.is(value, -0) ? '-0' : value})`;
    case 'boolean': return `type boolean (${value})`;
    case 'symbol': return `type symbol (${String(value)})`;
    case 'function': return `function ${value.name}`;
    case 'object': {
      const name = value.constructor?.name;
      return typeof name === 'string' && name !== ''
        ? `an instance of ${name}` : require('util').inspect(value, { depth: -1 });
    }
    case 'string':
      if (value.length > 28) value = `${value.slice(0, 25)}...`;
      return `type string (${value.includes("'") ? JSON.stringify(value) : `'${value}'`})`;
  }
}
function formatList(values) {
  return values.length < 3 ? values.join(' or ')
    : `${values.slice(0, -1).join(', ')}, or ${values[values.length - 1]}`;
}
class ERR_INVALID_ARG_TYPE extends TypeError {
  constructor(name, expected, value) {
    const types = [];
    const instances = [];
    const other = [];
    for (const entry of Array.isArray(expected) ? expected : [expected]) {
      if (['string', 'function', 'number', 'object', 'Function', 'Object', 'boolean', 'bigint', 'symbol'].includes(entry)) {
        types.push(entry.toLowerCase());
      } else if (/^[A-Z][a-zA-Z0-9]*$/.test(entry)) instances.push(entry);
      else other.push(entry);
    }
    const objectIndex = types.indexOf('object');
    if (instances.length && objectIndex !== -1) {
      types.splice(objectIndex, 1);
      instances.push('Object');
    }
    const descriptions = [];
    if (types.length) descriptions.push(`${types.length > 1 ? 'one of type' : 'of type'} ${formatList(types)}`);
    if (instances.length) descriptions.push(`an instance of ${formatList(instances)}`);
    if (other.length) descriptions.push(other.length > 1 ? `one of ${formatList(other)}` :
      `${other[0].toLowerCase() !== other[0] ? 'an ' : ''}${other[0]}`);
    const argument = name.endsWith(' argument') ? name : `"${name}" ${name.includes('.') ? 'property' : 'argument'}`;
    super(`The ${argument} must be ${descriptions.join(' or ')}. Received ${specificType(value)}`);
    this.code = 'ERR_INVALID_ARG_TYPE';
  }
}
class ERR_UNHANDLED_ERROR extends Error {
  constructor(value) {
    super(value === undefined ? 'Unhandled error.' : `Unhandled error. (${value})`);
    this.code = 'ERR_UNHANDLED_ERROR';
  }
}
class AbortError extends Error {
  constructor(message = 'The operation was aborted', options) {
    super(message, options);
    this.name = 'AbortError';
    this.code = 'ABORT_ERR';
  }
}
function outOfRange(name, range, value) {
  const error = new RangeError(`The value of "${name}" is out of range. It must be ${range}. Received ${value}`);
  error.code = 'ERR_OUT_OF_RANGE';
  throw error;
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
  genericNodeError: (message, properties) => Object.assign(new Error(message), properties),
  validateString, validateObject, validateBoolean, validateFunction,
  validateNumber, validateInteger, validateAbortSignal,
  kEmptyObject: Object.freeze(Object.create(null)),
  isWindows: require('internal/host').platform === 'win32',
  getLazy, spliceOne,
};
