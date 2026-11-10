// Boundary-state algorithm adapted from Node.js src/string_decoder.cc.
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

const { Buffer } = require('buffer');
const state = new WeakMap();
function decoderError(code, message) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}
function normalizeEncoding(value) {
  if (value === undefined || value === null || value === '') return 'utf8';
  if (typeof value !== 'string') return undefined;
  switch (value.toLowerCase()) {
    case 'utf8': case 'utf-8': return 'utf8';
    case 'utf16le': case 'utf-16le': case 'ucs2': case 'ucs-2': return 'utf16le';
    case 'binary': case 'latin1': return 'latin1';
    case 'ascii': case 'hex': case 'base64': case 'base64url': return value.toLowerCase();
  }
}
function StringDecoder(encoding) {
  this.encoding = normalizeEncoding(encoding);
  if (this.encoding === undefined) throw decoderError('ERR_UNKNOWN_ENCODING', `Unknown encoding: ${String(encoding)}`);
  state.set(this, { encoding: this.encoding, bytes: Buffer.alloc(4), count: 0, total: 0 });
}
function getState(self) {
  const s = state.get(self);
  if (!s) throw decoderError('ERR_INVALID_THIS', 'Value of "this" must be of type StringDecoder');
  return s;
}
function utf8Tail(bytes) {
  const end = bytes.length;
  if (!(bytes[end - 1] & 128)) return { start: end, total: 0 };
  // Match the native decoder's structural boundary scan. Semantic errors
  // (overlong sequences, surrogate scalars) are left to Buffer's UTF-8 decoder.
  for (let start = end - 1; start >= 0; start--) {
    const count = end - start, a = bytes[start];
    if ((a & 0xc0) === 0x80) {
      if (count >= 4 || start === 0) break;
      continue;
    }
    const total = (a & 0xe0) === 0xc0 ? 2 : (a & 0xf0) === 0xe0 ? 3 : (a & 0xf8) === 0xf0 ? 4 : 0;
    if (count < total) return { start, total };
    break;
  }
  return { start: end, total: 0 };
}
StringDecoder.prototype.write = function write(input) {
  if (typeof input === 'string') return input;
  if (!ArrayBuffer.isView(input)) throw decoderError('ERR_INVALID_ARG_TYPE', 'The "buf" argument must be an instance of Buffer, TypedArray, or DataView');
  const s = getState(this);
  let bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length === 0) return '';
  let prefix = '';
  if (s.count) {
    let needed = s.total - s.count;
    if (s.encoding === 'utf8') {
      for (let i = 0; i < bytes.length && i < needed; i++) {
        if ((bytes[i] & 0xc0) !== 0x80) {
          // Decode only the continuation bytes belonging to the old sequence.
          s.total = s.count + i;
          needed = i;
          break;
        }
      }
    }
    const taken = Math.min(needed, bytes.length);
    s.bytes.set(bytes.subarray(0, taken), s.count);
    s.count += taken;
    bytes = bytes.subarray(taken);
    if (s.count !== s.total) return '';
    prefix = s.bytes.toString(s.encoding, 0, s.count);
    s.count = 0;
    s.total = 0;
    if (bytes.length === 0) return prefix;
  }
  let end = bytes.length, total = 0;
  switch (s.encoding) {
    case 'utf8': {
      const tail = utf8Tail(bytes);
      end = tail.start; total = tail.total;
      break;
    }
    case 'utf16le': {
      if (end % 2) { end--; total = 2; }
      else if (end >= 2 && (bytes[end - 1] & 0xfc) === 0xd8) { end -= 2; total = 4; }
      break;
    }
    case 'base64': case 'base64url':
      end -= end % 3;
      if (end !== bytes.length) total = 3;
      break;
  }
  s.count = bytes.length - end;
  s.total = total;
  if (s.count) s.bytes.set(bytes.subarray(end));
  return prefix + bytes.toString(s.encoding, 0, end);
};
StringDecoder.prototype.end = function end(input) {
  let result = input === undefined ? '' : this.write(input);
  const s = getState(this);
  if (s.count) result += s.bytes.toString(s.encoding, 0, s.count);
  s.count = 0;
  s.total = 0;
  return result;
};
StringDecoder.prototype.text = function text(input, offset) {
  const s = getState(this);
  s.count = 0;
  s.total = 0;
  return this.write(input.slice(offset));
};
Object.defineProperties(StringDecoder.prototype, {
  lastChar: { configurable: true, enumerable: true, get() { return getState(this).bytes; } },
  lastNeed: { configurable: true, enumerable: true, get() { const s = getState(this); return s.total - s.count; } },
  lastTotal: { configurable: true, enumerable: true, get() { return getState(this).total; } }
});
exports.StringDecoder = StringDecoder;
