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
const { codes, aggregateTwoErrors } = require('internal/errors');
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
  normalizeEncoding,
  promisify: { custom: Symbol.for('nodejs.util.promisify.custom') },
};
