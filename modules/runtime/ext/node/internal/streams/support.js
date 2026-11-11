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

const shared = require('internal/path_events/support');
const codes = { ...shared.codes };
function defineError(code, Base, message) {
  codes[code] = class extends Base {
    constructor(...args) {
      super(typeof message === 'function' ? message(...args) : message);
      this.code = code;
    }
  };
  Object.defineProperty(codes[code], 'name', { value: code });
}
const inspect = (value) => require('util').inspect(value);
defineError('ERR_ILLEGAL_CONSTRUCTOR', TypeError, 'Illegal constructor');
defineError('ERR_INVALID_ARG_VALUE', TypeError, (name, value, reason = 'is invalid') => {
  let received = inspect(value);
  if (received.length > 128) received = `${received.slice(0, 128)}...`;
  return `The ${name.includes('.') ? 'property' : 'argument'} '${name}' ${reason}. Received ${received}`;
});
defineError('ERR_INVALID_RETURN_VALUE', TypeError, (expected, name, value) =>
  `Expected ${expected} to be returned from the "${name}" function but got ${inspect(value)}.`);
defineError('ERR_METHOD_NOT_IMPLEMENTED', Error, (method) => `The ${method} method is not implemented`);
defineError('ERR_MISSING_ARGS', TypeError, (...args) => {
  const names = args.map((arg) => Array.isArray(arg) ? arg.map((name) => `"${name}"`).join(' or ') : `"${arg}"`);
  const last = names.pop();
  return `The ${names.length ? `${names.join(', ')} and ` : ''}${last} argument${args.length > 1 ? 's' : ''} must be specified`;
});
defineError('ERR_MULTIPLE_CALLBACK', Error, 'Callback called multiple times');
defineError('ERR_OUT_OF_RANGE', RangeError, (name, range, value) =>
  `The value of "${name}" is out of range. It must be ${range}. Received ${inspect(value)}`);
defineError('ERR_STREAM_ALREADY_FINISHED', Error, (method) => `Cannot call ${method} after a stream was finished`);
defineError('ERR_STREAM_CANNOT_PIPE', Error, 'Cannot pipe, not readable');
defineError('ERR_STREAM_DESTROYED', Error, (method) => `Cannot call ${method} after a stream was destroyed`);
defineError('ERR_STREAM_NULL_VALUES', TypeError, 'May not write null values to stream');
defineError('ERR_STREAM_PREMATURE_CLOSE', Error, 'Premature close');
defineError('ERR_STREAM_PUSH_AFTER_EOF', Error, 'stream.push() after EOF');
defineError('ERR_STREAM_UNABLE_TO_PIPE', Error, 'Cannot pipe to a closed or destroyed stream');
defineError('ERR_STREAM_UNSHIFT_AFTER_END_EVENT', Error, 'stream.unshift() after end event');
defineError('ERR_STREAM_WRITE_AFTER_END', Error, 'write after end');
defineError('ERR_STREAM_WRAP', Error, 'Stream has StringDecoder set or is in objectMode');
defineError('ERR_UNKNOWN_ENCODING', TypeError, (encoding) => `Unknown encoding: ${encoding}`);

function aggregateTwoErrors(innerError, outerError) {
  if (innerError && outerError && innerError !== outerError) {
    if (Array.isArray(outerError.errors)) {
      outerError.errors.push(innerError);
      return outerError;
    }
    const error = new AggregateError([outerError, innerError], outerError.message);
    error.code = outerError.code;
    return error;
  }
  return innerError || outerError;
}
function once(callback, { preserveReturnValue = false } = shared.kEmptyObject) {
  let called = false;
  let returnValue;
  return function(...args) {
    if (called) return returnValue;
    called = true;
    const result = Reflect.apply(callback, this, args);
    returnValue = preserveReturnValue ? result : undefined;
    return result;
  };
}
function assignFunctionName(name, fn) {
  if (typeof name === 'symbol') {
    const description = name.description;
    name = description === undefined ? '' : `[${description}]`;
  }
  Object.defineProperty(fn, 'name', { __proto__: null, value: name, configurable: true });
  return fn;
}
function normalizeEncoding(encoding) {
  if (!encoding) return 'utf8';
  switch (String(encoding).toLowerCase()) {
    case 'utf8': case 'utf-8': return 'utf8';
    case 'ucs2': case 'ucs-2': case 'utf16le': case 'utf-16le': return 'utf16le';
    case 'binary': case 'latin1': return 'latin1';
    case 'ascii': return 'ascii';
    case 'base64': return 'base64';
    case 'base64url': return 'base64url';
    case 'hex': return 'hex';
    default: return undefined;
  }
}
module.exports = {
  ...shared,
  codes,
  aggregateTwoErrors,
  once,
  assignFunctionName,
  normalizeEncoding,
  promisify: { custom: Symbol.for('nodejs.util.promisify.custom') },
};
