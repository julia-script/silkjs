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

// The operations Node's lib/buffer.js and lib/internal/buffer.js take from
// internalBinding('buffer') (src/node_buffer.cc), with the same argument
// contracts, return codes and errors. UTF-8, UTF-16LE, latin1 and ASCII
// encode/decode go through the runtime's native Buffer codec (host 18); the
// rest is plain byte work on Uint8Array views.
//
// The error codes and validators below are the subset of Node's
// internal/errors and internal/validators that Buffer needs, with Node's
// messages. They are kept here until those shared modules land.

const host = require('internal/host');
const { bufferCodec } = host;
const types = require('util/types');
const { ERR_INVALID_ARG_TYPE } = require('internal/path_events/support').codes;

// Node's limits on 64-bit hosts. A Buffer longer than the engine can back
// (16 GiB) fails with the engine's ArrayBuffer RangeError. kStringMaxLength is
// V8's string length limit, which Buffer enforces; it is below the engine's
// own limit of 2 ** 30 - 1 units.
const kMaxLength = 2 ** 53 - 1;
const kStringMaxLength = 0x1fffffe8;

let inspect;
function lazyInspect(value) {
  inspect ??= require('internal/util_inspect').inspect;
  return inspect(value);
}
function makeError(Base, code, message) {
  const error = new Base(message);
  Object.defineProperty(error, 'code', { value: code, enumerable: true, writable: true, configurable: true });
  return error;
}
function addNumericalSeparator(val) {
  let res = '';
  let i = val.length;
  const start = val[0] === '-' ? 1 : 0;
  for (; i >= start + 4; i -= 3) res = `_${val.slice(i - 3, i)}${res}`;
  return `${val.slice(0, i)}${res}`;
}
class ERR_OUT_OF_RANGE extends RangeError {
  constructor(str, range, input, replaceDefaultBoolean = false) {
    let msg = replaceDefaultBoolean ? str : `The value of "${str}" is out of range.`;
    let received;
    if (Number.isInteger(input) && Math.abs(input) > 2 ** 32) {
      received = addNumericalSeparator(String(input));
    } else if (typeof input === 'bigint') {
      received = String(input);
      if (input > 2n ** 32n || input < -(2n ** 32n)) received = addNumericalSeparator(received);
      received += 'n';
    } else {
      received = lazyInspect(input);
    }
    super(`${msg} It must be ${range}. Received ${received}`);
    this.code = 'ERR_OUT_OF_RANGE';
  }
}
class ERR_BUFFER_OUT_OF_BOUNDS extends RangeError {
  constructor(name = undefined) {
    super(name ? `"${name}" is outside of buffer bounds` : 'Attempt to access memory outside buffer bounds');
    this.code = 'ERR_BUFFER_OUT_OF_BOUNDS';
  }
}
function invalidArgValueMessage(name, value, reason = 'is invalid') {
  let inspected = lazyInspect(value);
  if (inspected.length > 128) inspected = `${inspected.slice(0, 128)}...`;
  return `The ${name.includes('.') ? 'property' : 'argument'} '${name}' ${reason}. Received ${inspected}`;
}
class ERR_INVALID_ARG_VALUE extends TypeError {
  constructor(name, value, reason) {
    super(invalidArgValueMessage(name, value, reason));
    this.code = 'ERR_INVALID_ARG_VALUE';
  }
}
class ERR_INVALID_BUFFER_SIZE extends RangeError {
  constructor(size) {
    super(`Buffer size must be a multiple of ${size}`);
    this.code = 'ERR_INVALID_BUFFER_SIZE';
  }
}
class ERR_MISSING_ARGS extends TypeError {
  constructor(...args) {
    let msg = 'The ';
    const wrap = (a) => `"${a}"`;
    args = args.map((a) => (Array.isArray(a) ? a.map(wrap).join(' or ') : wrap(a)));
    switch (args.length) {
      case 1: msg += `${args[0]} argument`; break;
      case 2: msg += `${args[0]} and ${args[1]} arguments`; break;
      default: msg += `${args.slice(0, -1).join(', ')}, and ${args[args.length - 1]} arguments`; break;
    }
    super(`${msg} must be specified`);
    this.code = 'ERR_MISSING_ARGS';
  }
}
class ERR_UNKNOWN_ENCODING extends TypeError {
  constructor(encoding) {
    super(require('util').format('Unknown encoding: %s', encoding));
    this.code = 'ERR_UNKNOWN_ENCODING';
  }
}
class ERR_STRING_TOO_LONG extends Error {
  constructor() {
    super(`Cannot create a string longer than 0x${kStringMaxLength.toString(16)} characters`);
    this.code = 'ERR_STRING_TOO_LONG';
  }
}
for (const E of [ERR_OUT_OF_RANGE, ERR_BUFFER_OUT_OF_BOUNDS, ERR_INVALID_ARG_VALUE, ERR_INVALID_BUFFER_SIZE,
  ERR_MISSING_ARGS, ERR_UNKNOWN_ENCODING, ERR_STRING_TOO_LONG]) {
  // Instances report the base class name, as Node's errors do.
  Object.defineProperty(E.prototype, 'name', {
    value: Object.getPrototypeOf(E.prototype).constructor.name, writable: true, configurable: true,
  });
}

function validateNumber(value, name, min = undefined, max) {
  if (typeof value !== 'number') throw new ERR_INVALID_ARG_TYPE(name, 'number', value);
  if ((min != null && value < min) || (max != null && value > max) ||
      ((min != null || max != null) && Number.isNaN(value))) {
    throw new ERR_OUT_OF_RANGE(
      name,
      `${min != null ? `>= ${min}` : ''}${min != null && max != null ? ' && ' : ''}${max != null ? `<= ${max}` : ''}`,
      value);
  }
}
function validateInteger(value, name, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'number') throw new ERR_INVALID_ARG_TYPE(name, 'number', value);
  if (!Number.isInteger(value)) throw new ERR_OUT_OF_RANGE(name, 'an integer', value);
  if (value < min || value > max) throw new ERR_OUT_OF_RANGE(name, `>= ${min} && <= ${max}`, value);
}
function validateArray(value, name) {
  if (!Array.isArray(value)) throw new ERR_INVALID_ARG_TYPE(name, 'Array', value);
}
function validateString(value, name) {
  if (typeof value !== 'string') throw new ERR_INVALID_ARG_TYPE(name, 'string', value);
}
function validateBuffer(buffer, name = 'buffer') {
  if (!ArrayBuffer.isView(buffer)) throw new ERR_INVALID_ARG_TYPE(name, ['Buffer', 'TypedArray', 'DataView'], buffer);
}

// Node's internal/util normalizeEncoding.
function normalizeEncoding(enc) {
  if (enc == null || enc === 'utf8' || enc === 'utf-8') return 'utf8';
  return slowCases(enc);
}
function slowCases(enc) {
  switch (enc.length) {
    case 4:
      if (enc === 'UTF8') return 'utf8';
      if (enc === 'ucs2' || enc === 'UCS2') return 'utf16le';
      enc = `${enc}`.toLowerCase();
      if (enc === 'utf8') return 'utf8';
      if (enc === 'ucs2') return 'utf16le';
      break;
    case 3:
      if (enc === 'hex' || enc === 'HEX' || `${enc}`.toLowerCase() === 'hex') return 'hex';
      break;
    case 5:
      if (enc === 'ascii') return 'ascii';
      if (enc === 'ucs-2') return 'utf16le';
      if (enc === 'UTF-8') return 'utf8';
      if (enc === 'ASCII') return 'ascii';
      if (enc === 'UCS-2') return 'utf16le';
      enc = `${enc}`.toLowerCase();
      if (enc === 'utf-8') return 'utf8';
      if (enc === 'ascii') return 'ascii';
      if (enc === 'ucs-2') return 'utf16le';
      break;
    case 6:
      if (enc === 'base64') return 'base64';
      if (enc === 'latin1' || enc === 'binary') return 'latin1';
      if (enc === 'BASE64') return 'base64';
      if (enc === 'LATIN1' || enc === 'BINARY') return 'latin1';
      enc = `${enc}`.toLowerCase();
      if (enc === 'base64') return 'base64';
      if (enc === 'latin1' || enc === 'binary') return 'latin1';
      break;
    case 7:
      if (enc === 'utf16le' || enc === 'UTF16LE' || `${enc}`.toLowerCase() === 'utf16le') return 'utf16le';
      break;
    case 8:
      if (enc === 'utf-16le' || enc === 'UTF-16LE' || `${enc}`.toLowerCase() === 'utf-16le') return 'utf16le';
      break;
    case 9:
      if (enc === 'base64url' || enc === 'BASE64URL' || `${enc}`.toLowerCase() === 'base64url') return 'base64url';
      break;
    default:
      if (enc === '') return 'utf8';
  }
}
const encodingsMap = { __proto__: null, ascii: 0, utf8: 1, base64: 2, utf16le: 3, latin1: 4, hex: 5, buffer: 6, base64url: 7 };

function bufferError() {
  const error = new TypeError('argument must be a buffer');
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}
// A Uint8Array over the bytes of any ArrayBufferView. Detached and out of
// bounds views have no bytes.
const empty = new Uint8Array(0);
function bytes(view) {
  if (types.isUint8Array(view)) return view;
  const length = view.byteLength;
  return length === 0 ? empty : new Uint8Array(view.buffer, view.byteOffset, length);
}
function viewBytes(view) {
  if (!ArrayBuffer.isView(view)) throw bufferError();
  return bytes(view);
}
// ParseArrayIndex: undefined takes the default, negative is out of range.
function arrayIndex(value, fallback) {
  if (value === undefined) return fallback;
  const n = Math.trunc(+value) || 0;
  if (n < 0) throw new RangeError('Index out of range');
  return n;
}
function indexError() {
  const error = new RangeError('Index out of range');
  error.code = 'ERR_OUT_OF_RANGE';
  return error;
}
function sliceRange(view, start, end) {
  const length = view.byteLength;
  let s, e;
  try {
    s = arrayIndex(start, 0);
    e = arrayIndex(end, length);
  } catch {
    throw indexError();
  }
  if (e < s) e = s;
  if (e > length) throw indexError();
  return [s, e];
}

// Slices.
function codecSlice(operation, view, start, end) {
  const source = viewBytes(view);
  const [s, e] = sliceRange(source, start, end);
  if (s === e) return '';
  const units = operation === 4 ? (e - s) >>> 1 : e - s;
  if (operation !== 3 && units > kStringMaxLength) throw new ERR_STRING_TOO_LONG();
  let result;
  try {
    result = bufferCodec(operation, source, s, e);
  } catch (error) {
    if (units > kStringMaxLength) throw new ERR_STRING_TOO_LONG();
    throw error;
  }
  if (result.length > kStringMaxLength) throw new ERR_STRING_TOO_LONG();
  return result;
}
const utf8Slice = (view, start, end) => codecSlice(3, view, start, end);
const ucs2Slice = (view, start, end) => codecSlice(4, view, start, end);
const latin1Slice = (view, start, end) => codecSlice(6, view, start, end);
const asciiSlice = (view, start, end) => codecSlice(7, view, start, end);
const hexDigits = '0123456789abcdef';
const hexTable = [];
for (let i = 0; i < 256; i++) hexTable.push(hexDigits[i >>> 4] + hexDigits[i & 15]);
function hexSlice(view, start, end) {
  const source = viewBytes(view);
  const [s, e] = sliceRange(source, start, end);
  if ((e - s) * 2 > kStringMaxLength) throw new ERR_STRING_TOO_LONG();
  let result = '';
  for (let i = s; i < e; i++) result += hexTable[source[i]];
  return result;
}
const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const base64urlAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function base64Encode(source, s, e, url) {
  const chars = url ? base64urlAlphabet : base64Alphabet;
  let result = '';
  for (let i = s; i < e; i += 3) {
    const a = source[i], b = i + 1 < e ? source[i + 1] : 0, c = i + 2 < e ? source[i + 2] : 0;
    result += chars[a >>> 2] + chars[((a & 3) << 4) | (b >>> 4)];
    if (i + 1 < e) result += chars[((b & 15) << 2) | (c >>> 6)];
    else if (!url) result += '=';
    if (i + 2 < e) result += chars[c & 63];
    else if (!url) result += '=';
  }
  return result;
}
function base64SliceWith(view, start, end, url) {
  const source = viewBytes(view);
  const [s, e] = sliceRange(source, start, end);
  if (Math.ceil((e - s) / 3) * 4 > kStringMaxLength) throw new ERR_STRING_TOO_LONG();
  return base64Encode(source, s, e, url);
}
const base64Slice = (view, start, end) => base64SliceWith(view, start, end, false);
const base64urlSlice = (view, start, end) => base64SliceWith(view, start, end, true);

// Writes.
function base64Value(c) {
  if (c >= 65 && c <= 90) return c - 65;
  if (c >= 97 && c <= 122) return c - 71;
  if (c >= 48 && c <= 57) return c + 4;
  if (c === 43 || c === 45) return 62;
  if (c === 47 || c === 95) return 63;
  return -1;
}
function hexValue(c) {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 65 && c <= 70) return c - 55;
  if (c >= 97 && c <= 102) return c - 87;
  return -1;
}
// Both base64 alphabets decode, stopping at padding and skipping other bytes.
function base64Decode(string, target, offset, capacity) {
  let out = 0, bits = 0, count = 0;
  for (let i = 0; i < string.length && out < capacity; i++) {
    const c = string.charCodeAt(i);
    if (c === 61) break;
    const n = base64Value(c);
    if (n < 0) continue;
    bits = ((bits << 6) | n) & 0xffffff;
    count += 6;
    if (count >= 8) { count -= 8; target[offset + out++] = (bits >>> count) & 255; }
  }
  return out;
}
function hexDecode(string, target, offset, capacity) {
  let out = 0;
  for (let i = 0; i + 1 < string.length && out < capacity; i += 2) {
    const a = hexValue(string.charCodeAt(i)), b = hexValue(string.charCodeAt(i + 1));
    if (a < 0 || b < 0) break;
    target[offset + out++] = (a << 4) | b;
  }
  return out;
}
function stringWriteArgs(view, string, offset, length) {
  const target = viewBytes(view);
  if (typeof string !== 'string') {
    const error = new TypeError('argument must be a string');
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  const total = target.byteLength;
  let start, max;
  try { start = arrayIndex(offset, 0); } catch { throw indexError(); }
  if (start > total) throw new ERR_BUFFER_OUT_OF_BOUNDS('offset');
  try { max = arrayIndex(length, total - start); } catch { throw indexError(); }
  return [target, start, Math.min(total - start, max)];
}
function stringWrite(kind) {
  return function(view, string, offset, length) {
    const [target, start, max] = stringWriteArgs(view, string, offset, length);
    if (max === 0) return 0;
    if (kind === 'hex') return hexDecode(string, target, start, max);
    if (kind === 'base64') return base64Decode(string, target, start, max);
    return bufferCodec(2, string, target, start, max);
  };
}
const base64Write = stringWrite('base64');
const base64urlWrite = base64Write;
const hexWrite = stringWrite('hex');
const ucs2Write = stringWrite('ucs2');
// The *WriteStatic forms take offset and length already checked by JS.
function staticWrite(operation) {
  return function(view, string, offset, length) {
    const target = viewBytes(view);
    if (typeof string !== 'string') {
      const error = new TypeError('argument must be a string');
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }
    // Encoding coercion may detach or shrink a view after the JS checks.
    const available = target.byteLength - offset;
    if (available < 0) throw new ERR_BUFFER_OUT_OF_BOUNDS('offset');
    if (length > available) length = available;
    if (length <= 0 || string.length === 0) return 0;
    return bufferCodec(operation, string, target, offset, length);
  };
}
const utf8WriteStatic = staticWrite(1);
const latin1WriteStatic = staticWrite(5);
const asciiWriteStatic = latin1WriteStatic;

// Encodes a string as `encoding` (an encodingsMap value) into new bytes.
function encodeString(string, encoding) {
  switch (encoding) {
    case encodingsMap.utf8: {
      const out = new Uint8Array(bufferCodec(0, string));
      if (out.length) bufferCodec(1, string, out, 0, out.length);
      return out;
    }
    case encodingsMap.utf16le: {
      const out = new Uint8Array(string.length * 2);
      if (out.length) bufferCodec(2, string, out, 0, out.length);
      return out;
    }
    case encodingsMap.hex: {
      const out = new Uint8Array(string.length >>> 1);
      return out.subarray(0, hexDecode(string, out, 0, out.length));
    }
    case encodingsMap.base64: case encodingsMap.base64url: {
      const out = new Uint8Array(Math.ceil(string.length * 3 / 4));
      return out.subarray(0, base64Decode(string, out, 0, out.length));
    }
    default: {
      const out = new Uint8Array(string.length);
      if (out.length) bufferCodec(5, string, out, 0, out.length);
      return out;
    }
  }
}

function byteLengthUtf8(string) {
  return bufferCodec(0, string);
}

function normalizeCompareVal(val, aLength, bLength) {
  if (val === 0) return aLength > bLength ? 1 : aLength < bLength ? -1 : 0;
  return val > 0 ? 1 : -1;
}
function compareBytes(a, aStart, b, bStart, count) {
  for (let i = 0; i < count; i++) {
    const x = a[aStart + i], y = b[bStart + i];
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
function compare(a, b) {
  const x = viewBytes(a), y = viewBytes(b);
  const count = Math.min(x.byteLength, y.byteLength);
  return normalizeCompareVal(compareBytes(x, 0, y, 0, count), x.byteLength, y.byteLength);
}
function compareOffset(source, target, targetStart, sourceStart, targetEnd, sourceEnd) {
  const s = viewBytes(source), t = viewBytes(target);
  targetStart = arrayIndex(targetStart, 0);
  sourceStart = arrayIndex(sourceStart, 0);
  targetEnd = arrayIndex(targetEnd, t.byteLength);
  sourceEnd = arrayIndex(sourceEnd, s.byteLength);
  if (sourceStart > s.byteLength) throw makeError(RangeError, 'ERR_OUT_OF_RANGE', 'The value of "sourceStart" is out of range.');
  if (targetStart > t.byteLength) throw makeError(RangeError, 'ERR_OUT_OF_RANGE', 'The value of "targetStart" is out of range.');
  const count = Math.min(sourceEnd - sourceStart, targetEnd - targetStart, s.byteLength - sourceStart, t.byteLength - targetStart);
  const val = count > 0 ? compareBytes(s, sourceStart, t, targetStart, count) : 0;
  return normalizeCompareVal(val, sourceEnd - sourceStart, targetEnd - targetStart);
}
function copy(source, target, targetStart, sourceStart, nb) {
  const s = viewBytes(source), t = viewBytes(target);
  nb = Math.min(nb, s.byteLength - sourceStart, t.byteLength - targetStart);
  if (nb <= 0) return 0;
  Uint8Array.prototype.set.call(t, Uint8Array.prototype.subarray.call(s, sourceStart, sourceStart + nb), targetStart);
  return nb;
}
// Returns -1 for a fill value that writes no bytes and -2 when out of bounds.
function fill(buffer, value, start, end, encoding) {
  const target = viewBytes(buffer);
  start = arrayIndex(start, 0);
  end = arrayIndex(end, 0);
  const fillLength = end - start;
  if (start > end || fillLength + start > target.byteLength) return -2;
  let written;
  if (ArrayBuffer.isView(value)) {
    const pattern = bytes(value);
    written = Math.min(pattern.byteLength, fillLength);
    // Copy first: the pattern may share storage with the target.
    if (written) target.set(Uint8Array.prototype.slice.call(pattern, 0, written), start);
    written = pattern.byteLength;
  } else if (typeof value !== 'string') {
    Uint8Array.prototype.fill.call(target, (value >>> 0) & 255, start, end);
    return;
  } else {
    const enc = encodingsMap[normalizeEncoding(encoding) ?? 'utf8'] ?? encodingsMap.utf8;
    const encoded = encodeString(value, enc);
    written = Math.min(encoded.length, fillLength);
    if (written) target.set(encoded.subarray(0, written), start);
    if (enc === encodingsMap.utf8 || enc === encodingsMap.utf16le) written = encoded.length;
  }
  if (written >= fillLength) return;
  if (written === 0) return -1;
  let inThere = written;
  while (inThere < fillLength) {
    const count = Math.min(inThere, fillLength - inThere);
    target.copyWithin(start + inThere, start, start + count);
    inThere += count;
  }
}

// IndexOfOffset in node_buffer.cc.
function indexOfOffset(length, offset, needleLength, isForward) {
  if (offset < 0) {
    if (offset + length >= 0) return length + offset;
    if (isForward || needleLength === 0) return 0;
    return -1;
  }
  if (offset + needleLength <= length) return offset;
  if (needleLength === 0) return length;
  if (isForward) return -1;
  return length - 1;
}
function searchEnd(end, length) {
  if (end === undefined) return length;
  end = Math.trunc(+end) || 0;
  return end < 0 ? 0 : end > length ? length : end;
}
// First match at or after `start`, or last match at or before it.
function search(haystack, hayLength, needle, needleLength, start, isForward, width) {
  const last = hayLength - needleLength;
  if (last < 0) return -1;
  if (isForward) {
    for (let i = start; i <= last; i++) if (matches(haystack, needle, i, needleLength, width)) return i;
  } else {
    for (let i = Math.min(start, last); i >= 0; i--) if (matches(haystack, needle, i, needleLength, width)) return i;
  }
  return -1;
}
function matches(haystack, needle, unit, needleLength, width) {
  const base = unit * width;
  for (let j = 0, n = needleLength * width; j < n; j++) if (haystack[base + j] !== needle[j]) return false;
  return true;
}
function indexOfBytes(haystack, hayLength, needle, offset, encoding, isForward) {
  const needleLength = needle.byteLength;
  offset = Math.trunc(offset);
  const optOffset = indexOfOffset(hayLength, offset, needleLength, isForward);
  if (needleLength === 0) return optOffset;
  if (hayLength === 0 || optOffset <= -1) return -1;
  if ((isForward && needleLength + optOffset > hayLength) || needleLength > hayLength) return -1;
  if (encoding === encodingsMap.utf16le) {
    if (hayLength < 2 || needleLength < 2) return -1;
    const result = search(haystack, hayLength >>> 1, needle, needleLength >>> 1, optOffset >>> 1, isForward, 2);
    return result === -1 ? -1 : result * 2;
  }
  return search(haystack, hayLength, needle, needleLength, optOffset, isForward, 1);
}
function indexOfString(buffer, needle, offset, encoding, isForward, end) {
  const haystack = viewBytes(buffer);
  let hayLength = searchEnd(end, haystack.byteLength);
  if (encoding === encodingsMap.utf16le) hayLength &= ~1;
  return indexOfBytes(haystack, hayLength, encodeString(needle, encoding), offset, encoding, isForward);
}
function indexOfBuffer(buffer, needle, offset, encoding, isForward, end) {
  const haystack = viewBytes(buffer);
  const hayLength = searchEnd(end, haystack.byteLength);
  return indexOfBytes(haystack, hayLength, bytes(needle), offset, encoding, isForward);
}
function indexOfNumber(buffer, needle, offset, isForward, end) {
  const haystack = viewBytes(buffer);
  const hayLength = searchEnd(end, haystack.byteLength);
  const optOffset = indexOfOffset(hayLength, Math.trunc(offset), 1, isForward);
  if (optOffset <= -1 || hayLength === 0) return -1;
  needle &= 255;
  if (isForward) {
    for (let i = optOffset; i < hayLength; i++) if (haystack[i] === needle) return i;
  } else {
    for (let i = optOffset; i >= 0; i--) if (haystack[i] === needle) return i;
  }
  return -1;
}

function swap(width) {
  return function(view) {
    const b = viewBytes(view);
    for (let i = 0; i + width <= b.length; i += width) {
      for (let j = 0, k = width - 1; j < k; j++, k--) {
        const t = b[i + j]; b[i + j] = b[i + k]; b[i + k] = t;
      }
    }
  };
}
const swap16 = swap(2), swap32 = swap(4), swap64 = swap(8);

function inputBytes(input) {
  if (ArrayBuffer.isView(input)) return bytes(input);
  return input.byteLength === 0 ? empty : new Uint8Array(input);
}
function isAscii(input) {
  const b = inputBytes(input);
  for (let i = 0; i < b.length; i++) if (b[i] > 127) return false;
  return true;
}
function isUtf8(input) {
  const b = inputBytes(input);
  for (let i = 0; i < b.length;) {
    const a = b[i++];
    if (a < 128) continue;
    const needed = a >= 0xc2 && a <= 0xdf ? 1 : a >= 0xe0 && a <= 0xef ? 2 : a >= 0xf0 && a <= 0xf4 ? 3 : 0;
    if (!needed || i + needed > b.length) return false;
    for (let j = 0; j < needed; j++) {
      const c = b[i++];
      if (c < 0x80 || c > 0xbf || (j === 0 && ((a === 0xe0 && c < 0xa0) || (a === 0xed && c > 0x9f) ||
          (a === 0xf0 && c < 0x90) || (a === 0xf4 && c > 0x8f)))) return false;
    }
  }
  return true;
}

// btoa returns -1 for a code unit above 0xff; atob returns -2 for an invalid
// character and -1 for a length that leaves a single trailing character.
function btoa(input) {
  for (let i = 0; i < input.length; i++) if (input.charCodeAt(i) > 255) return -1;
  const source = new Uint8Array(input.length);
  if (source.length) bufferCodec(5, input, source, 0, source.length);
  return base64Encode(source, 0, source.length, false);
}
function atob(input) {
  let string = input.replace(/[\t\n\f\r ]/g, '');
  if (string.length % 4 === 0) string = string.replace(/==?$/, '');
  if (string.length % 4 === 1) return -1;
  if (/[^A-Za-z0-9+/]/.test(string)) return -2;
  const out = new Uint8Array(Math.floor(string.length * 3 / 4));
  const count = base64Decode(string, out, 0, out.length);
  return bufferCodec(6, out, 0, count);
}

function createUnsafeArrayBuffer(size) {
  return new ArrayBuffer(size);
}

// Objects that structured clone and postMessage must not transfer
// (util_object_private_symbol untransferable_object_private_symbol in Node).
const untransferable = new WeakSet();

module.exports = {
  kMaxLength,
  kStringMaxLength,
  codes: {
    ERR_BUFFER_OUT_OF_BOUNDS,
    ERR_INVALID_ARG_TYPE,
    ERR_INVALID_ARG_VALUE,
    ERR_INVALID_BUFFER_SIZE,
    ERR_MISSING_ARGS,
    ERR_OUT_OF_RANGE,
    ERR_STRING_TOO_LONG,
    ERR_UNKNOWN_ENCODING,
  },
  genericNodeError: (message, properties) => Object.assign(new Error(message), properties),
  validateArray,
  validateBuffer,
  validateInteger,
  validateNumber,
  validateString,
  normalizeEncoding,
  encodingsMap,
  asciiSlice,
  base64Slice,
  base64urlSlice,
  latin1Slice,
  hexSlice,
  ucs2Slice,
  utf8Slice,
  asciiWriteStatic,
  base64Write,
  base64urlWrite,
  latin1WriteStatic,
  hexWrite,
  ucs2Write,
  utf8WriteStatic,
  byteLengthUtf8,
  compare,
  compareOffset,
  copy,
  fill,
  isAscii,
  isUtf8,
  indexOfBuffer,
  indexOfNumber,
  indexOfString,
  swap16,
  swap32,
  swap64,
  atob,
  btoa,
  createUnsafeArrayBuffer,
  untransferable,
  kIsEncodingSymbol: Symbol('kIsEncodingSymbol'),
};
