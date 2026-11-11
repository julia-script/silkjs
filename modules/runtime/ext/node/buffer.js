'use strict';

const host = require('internal/host');
// Buffer storage is a real Uint8Array. Unsafe allocations are zeroed by SilkJS;
// their contents are deliberately unspecified by the Buffer API.
const MAX_LENGTH = 0x7fffffff;
const MAX_STRING_LENGTH = 0x1fffffe8;
const inspectSymbol = Symbol.for('nodejs.util.inspect.custom');
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const arraySlice = Uint8Array.prototype.subarray;
function error(Type, code, message) {
  const e = new Type(message);
  e.code = code;
  return e;
}
function received(value) {
  if (typeof value === 'string') return `type string (${JSON.stringify(value)})`;
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'object') return `an instance of ${value.constructor ? value.constructor.name : 'Object'}`;
  return `type ${typeof value} (${String(value)})`;
}
function type(name, expected, value) {
  return error(TypeError, 'ERR_INVALID_ARG_TYPE', `The "${name}" argument must be of type ${expected}. Received ${received(value)}`);
}
function range(name, bounds, value) {
  return error(RangeError, 'ERR_OUT_OF_RANGE', `The value of "${name}" is out of range. It must be ${bounds}. Received ${String(value)}`);
}
function integer(value, name, min, max) {
  if (typeof value !== 'number') throw type(name, 'number', value);
  if (!Number.isInteger(value)) throw range(name, 'an integer', value);
  if (value < min || value > max) throw range(name, `>= ${min} && <= ${max}`, value);
  return value;
}
function normalizeEncoding(enc) {
  if (enc === undefined || enc === null || enc === '' || enc === 'utf8' || enc === 'utf-8') return 'utf8';
  if (enc === 'latin1') return 'latin1';
  if (typeof enc !== 'string') return undefined;
  switch (enc.toLowerCase()) {
    case 'utf8': case 'utf-8': return 'utf8';
    case 'utf16le': case 'utf-16le': case 'ucs2': case 'ucs-2': return 'utf16le';
    case 'binary': case 'latin1': return 'latin1';
    case 'ascii': case 'hex': case 'base64': case 'base64url': return enc.toLowerCase();
  }
}
function encoding(enc) {
  const normalized = normalizeEncoding(enc);
  if (normalized === undefined) throw error(TypeError, 'ERR_UNKNOWN_ENCODING', `Unknown encoding: ${String(enc)}`);
  return normalized;
}
function make(length) {
  return Object.setPrototypeOf(new Uint8Array(length), Buffer.prototype);
}
function size(value) {
  if (typeof value !== 'number') throw type('size', 'number', value);
  if (!Number.isFinite(value) || value < 0 || value > MAX_LENGTH) throw range('size', `>= 0 && <= ${MAX_LENGTH}`, value);
  return Math.trunc(value);
}
function isArrayBuffer(value) {
  if (value instanceof ArrayBuffer) return true;
  // Views and primitives are never buffers; skip building their tag strings.
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) return false;
  return Object.prototype.toString.call(value) === '[object ArrayBuffer]' ||
    Object.prototype.toString.call(value) === '[object SharedArrayBuffer]';
}
function isUint8(value) {
  return value instanceof Uint8Array || Object.prototype.toString.call(value) === '[object Uint8Array]';
}
function checkBytes(value, name) {
  if (!isUint8(value)) throw type(name, 'Buffer or Uint8Array', value);
}
let bufferWarningEmitted = false;
let bufferWarningChecks = 0;
function Buffer(value, encodingOrOffset, length) {
  if (!bufferWarningEmitted && bufferWarningChecks < 10000 && globalThis.process?.emitWarning) {
    bufferWarningChecks++;
    const caller = host.pendingDeprecation ? undefined : host.captureCallSites(1, Buffer)[0];
    if (!caller || !/[\\/]node_modules[\\/]/.test(caller.scriptName)) {
      bufferWarningEmitted = true;
      process.emitWarning('Buffer() is deprecated due to security and usability ' +
        'issues. Please use the Buffer.alloc(), Buffer.allocUnsafe(), or Buffer.from() methods instead.',
        'DeprecationWarning', 'DEP0005', Buffer);
    }
  }
  if (typeof value === 'number') {
    if (typeof encodingOrOffset === 'string') throw type('string', 'string', value);
    return Buffer.alloc(value);
  }
  return Buffer.from(value, encodingOrOffset, length);
}
Object.setPrototypeOf(Buffer.prototype, Uint8Array.prototype);
Object.setPrototypeOf(Buffer, Uint8Array);
function FastBuffer(length, byteOffset, count) {
  return Object.setPrototypeOf(new Uint8Array(length, byteOffset, count), Buffer.prototype);
}
Object.defineProperty(Buffer, Symbol.species, { configurable: true, get() { return FastBuffer; } });
Buffer.poolSize = 8192;
let pool = new ArrayBuffer(Buffer.poolSize);
let poolOffset = 0;
function unsafe(length) {
  if (length === 0 || length >= (Buffer.poolSize >>> 1)) return make(length);
  if (length > pool.byteLength - poolOffset) {
    pool = new ArrayBuffer(size(Buffer.poolSize));
    poolOffset = 0;
  }
  const result = Object.setPrototypeOf(new Uint8Array(pool, poolOffset, length), Buffer.prototype);
  poolOffset = Math.ceil((poolOffset + length) / 8) * 8;
  return result;
}
Buffer.alloc = function alloc(length, fill, enc) {
  const result = make(size(length));
  if (fill !== undefined && fill !== 0 && result.length > 0) result.fill(fill, typeof enc === 'string' ? enc : undefined);
  return result;
};
Buffer.allocUnsafe = function allocUnsafe(length) { return unsafe(size(length)); };
Buffer.allocUnsafeSlow = function allocUnsafeSlow(length) { return make(size(length)); };
function SlowBuffer(length) { return Buffer.alloc(+length || 0); }
Buffer.from = function from(value, enc, length) {
  if (typeof value === 'string') {
    const normalized = typeof enc === 'string' && enc !== '' ? encoding(enc) : 'utf8';
    if (normalized === 'utf8' || normalized === 'utf16le') {
      const capacity = normalized === 'utf8' ? host.bufferCodec(0, value) : value.length * 2;
      const result = unsafe(size(capacity));
      host.bufferCodec(normalized === 'utf8' ? 1 : 2, value, result, 0, capacity);
      return result;
    }
    if ((normalized === 'latin1' || normalized === 'ascii') && value.length !== 0) {
      const result = unsafe(size(value.length));
      host.bufferCodec(5, value, result, 0, value.length);
      return result;
    }
    const bytes = encode(value, normalized);
    if (bytes.length > 0 && bytes.length < (Buffer.poolSize >>> 1)) {
      const result = unsafe(bytes.length);
      result.set(bytes);
      return result;
    }
    return Object.setPrototypeOf(bytes, Buffer.prototype);
  }
  if (isArrayBuffer(value)) {
    let offset = enc === undefined ? 0 : +enc;
    if (Number.isNaN(offset)) offset = 0;
    const maximum = value.byteLength - offset;
    if (maximum < 0) throw error(RangeError, 'ERR_BUFFER_OUT_OF_BOUNDS', '"offset" is outside of buffer bounds');
    let count = length === undefined ? undefined : +length;
    if (count !== undefined) {
      if (!(count > 0)) count = 0;
      else if (count > maximum) throw error(RangeError, 'ERR_BUFFER_OUT_OF_BOUNDS', '"length" is outside of buffer bounds');
    }
    return Object.setPrototypeOf(new Uint8Array(value, offset, count), Buffer.prototype);
  }
  if (value !== null && typeof value === 'object') {
    if (typeof value.valueOf === 'function') {
      const primitive = value.valueOf();
      if (primitive != null && primitive !== value && (typeof primitive === 'string' || typeof primitive === 'object')) return Buffer.from(primitive, enc, length);
    }
    if (value.length !== undefined || Array.isArray(value) || isArrayBuffer(value.buffer)) return fromArrayLike(value);
    if (value.type === 'Buffer' && Array.isArray(value.data)) return fromArrayLike(value.data);
    if (typeof value[Symbol.toPrimitive] === 'function') return Buffer.from(value[Symbol.toPrimitive]('string'), enc, length);
  }
  throw type('first argument', 'string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object', value);
};
function fromArrayLike(value) {
  let length = value.length;
  if (typeof length !== 'number' || Number.isNaN(length) || length <= 0) length = 0;
  const result = unsafe(size(length));
  for (let i = 0; i < result.length; i++) result[i] = value[i];
  return result;
}
Buffer.copyBytesFrom = function copyBytesFrom(view, offset, length) {
  if (!ArrayBuffer.isView(view) || view instanceof DataView) throw type('view', 'TypedArray', view);
  if (offset === undefined) offset = 0;
  else integer(offset, 'offset', 0, Number.MAX_SAFE_INTEGER);
  if (length !== undefined) integer(length, 'length', 0, Number.MAX_SAFE_INTEGER);
  if (offset >= view.length || length === 0) return make(0);
  const count = Math.min(length === undefined ? view.length - offset : length, view.length - offset);
  const bytes = new Uint8Array(view.buffer, view.byteOffset + offset * view.BYTES_PER_ELEMENT, count * view.BYTES_PER_ELEMENT);
  const result = unsafe(bytes.length);
  result.set(bytes);
  return result;
};
Buffer.isBuffer = function isBuffer(value) { return value instanceof Buffer; };
Buffer.isEncoding = function isEncoding(enc) { return typeof enc === 'string' && enc.length > 0 && normalizeEncoding(enc) !== undefined; };
Buffer.byteLength = function byteLength(value, enc) {
  if (typeof value === 'string' && enc === undefined) return host.bufferCodec(0, value);
  if (isArrayBuffer(value) || ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof value !== 'string') throw type('string', 'string or an instance of Buffer or ArrayBuffer', value);
  switch (normalizeEncoding(enc) || 'utf8') {
    case 'ascii': case 'latin1': return value.length;
    case 'utf16le': return value.length * 2;
    case 'hex': return value.length >>> 1;
    case 'base64': case 'base64url': {
      let length = value.length;
      if (length && value.charCodeAt(length - 1) === 61) length--;
      if (length && value.charCodeAt(length - 1) === 61) length--;
      return Math.floor(length * 3 / 4);
    }
    default: return host.bufferCodec(0, value);
  }
};
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
function encode(string, enc, limit = Infinity) {
  let capacity;
  if (enc === 'utf8') capacity = host.bufferCodec(0, string);
  else if (enc === 'utf16le') capacity = string.length * 2;
  else if (enc === 'hex') capacity = string.length >>> 1;
  else if (enc === 'base64' || enc === 'base64url') capacity = Math.floor(string.length * 3 / 4);
  else capacity = string.length;
  const result = new Uint8Array(Math.min(capacity, limit));
  let out = 0;
  if (enc === 'hex') {
    for (let i = 0; i + 1 < string.length && out < result.length; i += 2) {
      const a = hexValue(string.charCodeAt(i)), b = hexValue(string.charCodeAt(i + 1));
      if (a < 0 || b < 0) break;
      result[out++] = (a << 4) | b;
    }
  } else if (enc === 'base64' || enc === 'base64url') {
    let bits = 0, count = 0;
    for (let i = 0; i < string.length && out < result.length; i++) {
      const c = string.charCodeAt(i);
      if (c === 61) break;
      const n = base64Value(c);
      if (n < 0) continue;
      bits = (bits << 6) | n;
      count += 6;
      if (count >= 8) { count -= 8; result[out++] = (bits >>> count) & 255; }
    }
  } else if (enc === 'utf8' || enc === 'utf16le') {
    out = host.bufferCodec(enc === 'utf8' ? 1 : 2, string, result, 0, result.length);
  } else if (result.length !== 0) {
    out = host.bufferCodec(5, string, result, 0, result.length);
  }
  return out === result.length ? result : result.subarray(0, out);
}
function decode(bytes, enc, start, end) {
  if (enc === 'utf8' || enc === 'utf16le') return host.bufferCodec(enc === 'utf8' ? 3 : 4, bytes, start, end);
  let result = '';
  if (enc === 'base64' || enc === 'base64url') {
    const chars = enc === 'base64url' ? alphabet.slice(0, 62) + '-_' : alphabet;
    for (let i = start; i < end; i += 3) {
      const a = bytes[i], b = i + 1 < end ? bytes[i + 1] : 0, c = i + 2 < end ? bytes[i + 2] : 0;
      result += chars[a >>> 2] + chars[((a & 3) << 4) | (b >>> 4)];
      if (i + 1 < end) result += chars[((b & 15) << 2) | (c >>> 6)];
      else if (enc === 'base64') result += '=';
      if (i + 2 < end) result += chars[c & 63];
      else if (enc === 'base64') result += '=';
    }
    return result;
  }
  if (enc === 'hex') {
    const digits = '0123456789abcdef';
    for (let i = start; i < end; i++) result += digits[bytes[i] >>> 4] + digits[bytes[i] & 15];
  } else {
    return host.bufferCodec(enc === 'ascii' ? 7 : 6, bytes, start, end);
  }
  return result;
}
Buffer.prototype.toString = function toString(enc, start, end) {
  const length = this.length;
  if (length === 0) return '';
  start = start === undefined ? 0 : +start;
  end = end === undefined ? length : +end;
  if (start < 0 || Number.isNaN(start)) start = 0;
  if (end > length) end = length;
  if (start >= length || end <= start || end <= 0 || Number.isNaN(end)) return '';
  start = Math.trunc(start); end = Math.trunc(end);
  return decode(this, enc ? encoding(enc + '') : 'utf8', start, end);
};
Buffer.prototype.toLocaleString = Buffer.prototype.toString;
Buffer.prototype.write = function write(string, offset, length, enc) {
  if (typeof string !== 'string') throw type('string', 'string', string);
  if (offset === undefined) { offset = 0; length = this.length; enc = 'utf8'; }
  else if (typeof offset === 'string' && length === undefined) { enc = offset; offset = 0; length = this.length; }
  else {
    integer(offset, 'offset', 0, this.length);
    if (typeof length === 'string') { enc = length; length = this.length - offset; }
    else if (length === undefined) length = this.length - offset;
    else { integer(length, 'length', 0, this.length); length = Math.min(length, this.length - offset); }
  }
  const normalized = enc ? encoding(enc + '') : 'utf8';
  if (normalized === 'utf8' || normalized === 'utf16le') {
    // Encoding coercion may detach or resize a view after overload validation.
    const remaining = this.length - offset;
    if (remaining < 0) throw error(RangeError, 'ERR_BUFFER_OUT_OF_BOUNDS', '"offset" is outside of buffer bounds');
    if (normalized === 'utf16le') length = Math.min(length, remaining);
    else if (length > remaining) throw error(RangeError, 'ERR_BUFFER_OUT_OF_BOUNDS', '"length" is outside of buffer bounds');
    return host.bufferCodec(normalized === 'utf8' ? 1 : 2, string, this, offset, length);
  }
  if (normalized === 'latin1' || normalized === 'ascii') {
    const remaining = this.length - offset;
    if (remaining < 0) throw error(RangeError, 'ERR_BUFFER_OUT_OF_BOUNDS', '"offset" is outside of buffer bounds');
    return host.bufferCodec(5, string, this, offset, Math.min(length, remaining, string.length));
  }
  const bytes = encode(string, normalized, length);
  this.set(bytes, offset);
  return bytes.length;
};
function sliceIndex(value, length, defaultValue) {
  if (value === undefined) return defaultValue;
  value = Math.trunc(+value);
  if (Number.isNaN(value)) value = 0;
  return value < 0 ? Math.max(length + value, 0) : Math.min(value, length);
}
Buffer.prototype.subarray = function subarray(start, end) {
  const a = sliceIndex(start, this.length, 0), b = sliceIndex(end, this.length, this.length);
  return Object.setPrototypeOf(new Uint8Array(this.buffer, this.byteOffset + a, Math.max(b - a, 0)), Buffer.prototype);
};
Buffer.prototype.slice = function slice(start, end) { return this.subarray(start, end); };
Buffer.prototype.copy = function copy(target, targetStart, sourceStart, sourceEnd) {
  checkBytes(target, 'target');
  function copyIndex(value, fallback) {
    if (value === undefined) return fallback;
    const n = +value;
    return !Number.isFinite(n) ? 0 : Math.floor(n);
  }
  targetStart = copyIndex(targetStart, 0);
  sourceStart = copyIndex(sourceStart, 0);
  sourceEnd = copyIndex(sourceEnd, this.length);
  if (targetStart < 0) throw range('targetStart', '>= 0', targetStart);
  if (sourceStart < 0 || sourceStart > this.length) throw range('sourceStart', `>= 0 && <= ${this.length}`, sourceStart);
  if (sourceEnd < 0) throw range('sourceEnd', '>= 0', sourceEnd);
  const count = Math.max(0, Math.min(sourceEnd, this.length) - sourceStart);
  const actual = Math.max(0, Math.min(count, target.length - targetStart));
  if (actual) target.set(arraySlice.call(this, sourceStart, sourceStart + actual), targetStart);
  return actual;
};
Buffer.prototype.fill = function fill(value, start, end, enc) {
  if (typeof value === 'string') {
    if (start === undefined || typeof start === 'string') { enc = start; start = 0; end = this.length; }
    else if (typeof end === 'string') { enc = end; end = this.length; }
    if (enc !== undefined && typeof enc !== 'string') throw type('encoding', 'string', enc);
    enc = encoding(enc);
  }
  if (start === undefined) { start = 0; end = this.length; } else integer(start, 'offset', 0, MAX_LENGTH);
  if (end === undefined) end = this.length; else integer(end, 'end', 0, this.length);
  if (start >= end) return this;
  if (typeof value === 'number' || typeof value === 'boolean' || value === undefined || value === null || value === '') {
    Uint8Array.prototype.fill.call(this, Number(value) & 255, start, end);
    return this;
  }
  let pattern;
  if (typeof value === 'string') pattern = encode(value, enc);
  else if (isUint8(value)) pattern = value;
  else {
    Uint8Array.prototype.fill.call(this, +value & 255, start, end);
    return this;
  }
  if (pattern.length === 0) throw error(TypeError, 'ERR_INVALID_ARG_VALUE', `The argument 'value' is invalid. Received ${String(value)}`);
  // Capture an overlapping pattern before filling its source storage.
  if (pattern.buffer === this.buffer) pattern = new Uint8Array(pattern);
  for (let i = start; i < end; i++) this[i] = pattern[(i - start) % pattern.length];
  return this;
};
Buffer.compare = function compare(a, b) {
  checkBytes(a, 'buf1'); checkBytes(b, 'buf2');
  if (a === b) return 0;
  const count = Math.min(a.length, b.length);
  for (let i = 0; i < count; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
};
Buffer.prototype.equals = function equals(other) { checkBytes(other, 'otherBuffer'); return Buffer.compare(this, other) === 0; };
Buffer.prototype.compare = function compare(target, targetStart, targetEnd, sourceStart, sourceEnd) {
  checkBytes(target, 'target');
  targetStart = targetStart === undefined ? 0 : integer(targetStart, 'targetStart', 0, MAX_LENGTH);
  targetEnd = targetEnd === undefined ? target.length : integer(targetEnd, 'targetEnd', 0, target.length);
  sourceStart = sourceStart === undefined ? 0 : integer(sourceStart, 'sourceStart', 0, MAX_LENGTH);
  sourceEnd = sourceEnd === undefined ? this.length : integer(sourceEnd, 'sourceEnd', 0, this.length);
  return Buffer.compare(arraySlice.call(this, sourceStart, sourceEnd), arraySlice.call(target, targetStart, targetEnd));
};
Buffer.concat = function concat(list, totalLength) {
  if (!Array.isArray(list)) throw type('list', 'Array', list);
  if (list.length === 0) return make(0);
  if (totalLength === undefined) {
    totalLength = 0;
    for (let i = 0; i < list.length; i++) { checkBytes(list[i], `list[${i}]`); totalLength += list[i].length; }
  } else integer(totalLength, 'length', 0, MAX_LENGTH);
  const result = unsafe(size(totalLength));
  let position = 0;
  for (let i = 0; i < list.length; i++) {
    const item = list[i]; checkBytes(item, `list[${i}]`);
    const count = Math.min(item.length, totalLength - position);
    if (count > 0) { result.set(arraySlice.call(item, 0, count), position); position += count; }
  }
  if (position < totalLength) Uint8Array.prototype.fill.call(result, 0, position);
  return result;
};
function search(buffer, value, byteOffset, enc, backwards) {
  if (typeof byteOffset === 'string') { enc = byteOffset; byteOffset = undefined; }
  let needle, width = 1;
  if (typeof value === 'string') {
    if (enc !== undefined) {
      const name = enc + '';
      if (!Buffer.isEncoding(name)) throw error(TypeError, 'ERR_UNKNOWN_ENCODING', `Unknown encoding: ${name}`);
      enc = encoding(name);
    } else enc = 'utf8';
    needle = encode(value, enc);
    if (enc === 'utf16le') width = 2;
  } else if (typeof value === 'number') needle = [value & 255];
  else if (isUint8(value)) { needle = value; if (normalizeEncoding(enc) === 'utf16le') width = 2; }
  else throw type('value', 'number or string or an instance of Buffer or Uint8Array', value);
  let offset = byteOffset === undefined ? (backwards ? buffer.length : 0) : +byteOffset;
  if (Number.isNaN(offset)) offset = backwards ? buffer.length : 0;
  offset = Math.trunc(Math.max(-2147483648, Math.min(2147483647, offset)));
  if (offset < 0) offset += buffer.length;
  if (needle.length === 0) return Math.max(0, Math.min(buffer.length, offset));
  if (width === 2 && (buffer.length < 2 || needle.length < 2)) return -1;
  const hayLength = Math.floor(buffer.length / width), needleLength = Math.floor(needle.length / width);
  offset = Math.floor(offset / width);
  if (backwards) { offset = Math.min(offset, hayLength - needleLength); if (offset < 0) return -1; }
  else { offset = Math.max(0, offset); if (offset + needleLength > hayLength) return -1; }
  const last = hayLength - needleLength;
  for (let i = offset; backwards ? i >= 0 : i <= last; backwards ? i-- : i++) {
    let same = true;
    for (let j = 0; j < needleLength * width; j++) if (buffer[i * width + j] !== needle[j]) { same = false; break; }
    if (same) return i * width;
  }
  return -1;
}
Buffer.prototype.indexOf = function indexOf(value, offset, enc) { return search(this, value, offset, enc, false); };
Buffer.prototype.lastIndexOf = function lastIndexOf(value, offset, enc) { return search(this, value, offset, enc, true); };
Buffer.prototype.includes = function includes(value, offset, enc) { return this.indexOf(value, offset, enc) !== -1; };
function checkOffset(buffer, offset, width) {
  if (typeof offset !== 'number') throw type('offset', 'number', offset);
  if (Math.floor(offset) !== offset) throw range('offset', 'an integer', offset);
  if (width > buffer.length) throw error(RangeError, 'ERR_BUFFER_OUT_OF_BOUNDS', 'Attempt to access memory outside buffer bounds');
  if (offset < 0 || offset > buffer.length - width) throw range('offset', `>= 0 and <= ${buffer.length - width}`, offset);
}
function readInteger(buffer, offset, width, little, signed) {
  checkOffset(buffer, offset, width);
  let value = 0;
  if (little) for (let i = width - 1; i >= 0; i--) value = value * 256 + buffer[offset + i];
  else for (let i = 0; i < width; i++) value = value * 256 + buffer[offset + i];
  if (signed && value >= 2 ** (width * 8 - 1)) value -= 2 ** (width * 8);
  return value;
}
function writeInteger(buffer, value, offset, width, little, signed) {
  value = +value;
  const min = signed ? -(2 ** (width * 8 - 1)) : 0;
  const max = signed ? 2 ** (width * 8 - 1) - 1 : 2 ** (width * 8) - 1;
  if (width === 1 && typeof offset !== 'number') throw type('offset', 'number', offset);
  if (value < min || value > max) {
    const bounds = width > 4
      ? (signed ? `>= -(2 ** ${width * 8 - 1}) and < 2 ** ${width * 8 - 1}` : `>= 0 and < 2 ** ${width * 8}`)
      : `>= ${min} and <= ${max}`;
    throw range('value', bounds, value);
  }
  checkOffset(buffer, offset, width);
  value = Math.trunc(value);
  if (value < 0) value += 2 ** (width * 8);
  for (let i = 0; i < width; i++) {
    buffer[offset + (little ? i : width - i - 1)] = value % 256;
    value = Math.floor(value / 256);
  }
  return offset + width;
}
for (const signed of [false, true]) {
  const stem = signed ? 'Int' : 'UInt';
  for (const little of [true, false]) {
    const endian = little ? 'LE' : 'BE';
    Buffer.prototype['read' + stem + endian] = function (offset, byteLength) {
      integer(byteLength, 'byteLength', 1, 6);
      return readInteger(this, offset, byteLength, little, signed);
    };
    Buffer.prototype['write' + stem + endian] = function (value, offset, byteLength) {
      integer(byteLength, 'byteLength', 1, 6);
      return writeInteger(this, value, offset, byteLength, little, signed);
    };
    for (const width of [1, 2, 4]) {
      const suffix = width === 1 ? '8' : width * 8 + endian;
      Buffer.prototype['read' + stem + suffix] = function (offset = 0) { return readInteger(this, offset, width, little, signed); };
      Buffer.prototype['write' + stem + suffix] = function (value, offset = 0) { return writeInteger(this, value, offset, width, little, signed); };
    }
  }
}
for (const little of [true, false]) {
  const endian = little ? 'LE' : 'BE';
  for (const width of [4, 8]) {
    const stem = width === 4 ? 'Float' : 'Double';
    Buffer.prototype['read' + stem + endian] = function (offset = 0) {
      checkOffset(this, offset, width);
      const view = new DataView(this.buffer, this.byteOffset + offset, width);
      return width === 4 ? view.getFloat32(0, little) : view.getFloat64(0, little);
    };
    Buffer.prototype['write' + stem + endian] = function (value, offset = 0) {
      value = +value;
      checkOffset(this, offset, width);
      const view = new DataView(this.buffer, this.byteOffset + offset, width);
      if (width === 4) view.setFloat32(0, value, little); else view.setFloat64(0, value, little);
      return offset + width;
    };
  }
  for (const signed of [false, true]) {
    const stem = signed ? 'BigInt64' : 'BigUInt64';
    Buffer.prototype['read' + stem + endian] = function (offset = 0) {
      checkOffset(this, offset, 8);
      let value = 0n;
      for (let i = 0; i < 8; i++) value = (value << 8n) | BigInt(this[offset + (little ? 7 - i : i)]);
      return signed && value >= 0x8000000000000000n ? value - 0x10000000000000000n : value;
    };
    Buffer.prototype['write' + stem + endian] = function (value, offset = 0) {
      const min = signed ? -0x8000000000000000n : 0n;
      const max = signed ? 0x7fffffffffffffffn : 0xffffffffffffffffn;
      if (value < min || value > max) throw range('value', signed ? '>= -(2n ** 63n) and < 2n ** 63n' : '>= 0n and < 2n ** 64n', value);
      checkOffset(this, offset, 8);
      // BigInt arithmetic intentionally rejects Number and other non-BigInt values.
      value &= 0xffffffffffffffffn;
      for (let i = 0; i < 8; i++) { this[offset + (little ? i : 7 - i)] = Number(value & 255n); value >>= 8n; }
      return offset + 8;
    };
  }
}
for (const name of Object.getOwnPropertyNames(Buffer.prototype)) {
  if (name.includes('UInt')) Buffer.prototype[name.replace('UInt', 'Uint')] = Buffer.prototype[name];
}
for (const width of [2, 4, 8]) {
  Buffer.prototype['swap' + width * 8] = function () {
    if (this.length % width) throw error(RangeError, 'ERR_INVALID_BUFFER_SIZE', `Buffer size must be a multiple of ${width * 8}-bits`);
    for (let i = 0; i < this.length; i += width) for (let j = 0; j < width / 2; j++) {
      const b = this[i + j]; this[i + j] = this[i + width - j - 1]; this[i + width - j - 1] = b;
    }
    return this;
  };
}
Buffer.prototype.toJSON = function toJSON() { return { type: 'Buffer', data: Array.from(this) }; };
Buffer.prototype.inspect = function inspect() {
  const max = exports.INSPECT_MAX_BYTES;
  const count = Math.min(this.length, max);
  let result = '';
  for (let i = 0; i < count; i++) result += (i ? ' ' : '') + this[i].toString(16).padStart(2, '0');
  if (this.length > count) { const remaining = this.length - count; result += ` ... ${remaining} more byte${remaining === 1 ? '' : 's'}`; }
  return `<Buffer${result ? ' ' + result : ''}>`;
};
Buffer.prototype[inspectSymbol] = Buffer.prototype.inspect;
Object.defineProperties(Buffer.prototype, {
  parent: { enumerable: true, get() { return Buffer.isBuffer(this) ? this.buffer : undefined; } },
  offset: { enumerable: true, get() { return Buffer.isBuffer(this) ? this.byteOffset : undefined; } }
});
function inputBytes(value) {
  if (isArrayBuffer(value)) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw type('input', 'ArrayBuffer, Buffer, or TypedArray', value);
}
function isAscii(input) {
  const bytes = inputBytes(input);
  for (let i = 0; i < bytes.length; i++) if (bytes[i] > 127) return false;
  return true;
}
function isUtf8(input) {
  const bytes = inputBytes(input);
  for (let i = 0; i < bytes.length;) {
    const a = bytes[i++];
    if (a < 128) continue;
    const needed = a >= 0xc2 && a <= 0xdf ? 1 : a >= 0xe0 && a <= 0xef ? 2 : a >= 0xf0 && a <= 0xf4 ? 3 : 0;
    if (!needed || i + needed > bytes.length) return false;
    for (let j = 0; j < needed; j++) {
      const b = bytes[i++];
      if (b < 0x80 || b > 0xbf || (j === 0 && ((a === 0xe0 && b < 0xa0) || (a === 0xed && b > 0x9f) || (a === 0xf0 && b < 0x90) || (a === 0xf4 && b > 0x8f)))) return false;
    }
  }
  return true;
}
function transcode(source, fromEncoding, toEncoding) {
  checkBytes(source, 'source');
  if (source.length === 0) return make(0);
  const from = normalizeEncoding(fromEncoding), to = normalizeEncoding(toEncoding);
  const supported = ['utf8', 'utf16le', 'latin1', 'ascii'];
  if (!supported.includes(from) || !supported.includes(to)) {
    const e = error(Error, 'U_ILLEGAL_ARGUMENT_ERROR', 'Unable to transcode Buffer [U_ILLEGAL_ARGUMENT_ERROR]'); e.errno = 1; throw e;
  }
  function invalidUnicode() {
    const e = error(Error, 'U_INVALID_CHAR_FOUND', 'Unable to transcode Buffer [U_INVALID_CHAR_FOUND]');
    e.errno = 10;
    throw e;
  }
  if (from === 'utf8' && to === 'utf16le' && !isUtf8(source)) invalidUnicode();
  let text;
  if (from === 'ascii' && to !== 'utf16le') {
    text = '';
    for (let i = 0; i < source.length; i++) text += source[i] < 128 ? String.fromCharCode(source[i]) : '\ufffd';
  } else text = decode(source, from === 'ascii' ? 'latin1' : from, 0, source.length);
  if (from === 'utf16le') {
    if (to === 'utf8') {
      if (text.length === 0) invalidUnicode();
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
          const next = text.charCodeAt(++i);
          if (!(next >= 0xdc00 && next <= 0xdfff)) invalidUnicode();
        } else if (c >= 0xdc00 && c <= 0xdfff) invalidUnicode();
      }
    } else {
      const utf8 = encode(text, 'utf8');
      text = decode(utf8, 'utf8', 0, utf8.length);
      if (to === 'utf16le' && source.length % 2) text += '\ufffd';
    }
  }
  if (to === 'ascii' || to === 'latin1') {
    const bytes = [];
    const max = to === 'ascii' ? 127 : 255;
    for (const char of text) { const cp = char.codePointAt(0); bytes.push(cp <= max ? cp : 63); }
    return Buffer.from(bytes);
  }
  return Buffer.from(text, to);
}
function invalidCharacter(message) {
  if (typeof DOMException === 'function') return new DOMException(message, 'InvalidCharacterError');
  const e = new Error(message); e.name = 'InvalidCharacterError'; e.code = 5; return e;
}
function btoa(input) {
  if (arguments.length === 0) throw error(TypeError, 'ERR_MISSING_ARGS', 'The "input" argument must be specified');
  const string = `${input}`;
  for (let i = 0; i < string.length; i++) if (string.charCodeAt(i) > 255) throw invalidCharacter('Invalid character');
  return Buffer.from(string, 'latin1').toString('base64');
}
function atob(input) {
  if (arguments.length === 0) throw error(TypeError, 'ERR_MISSING_ARGS', 'The "input" argument must be specified');
  let string = `${input}`.replace(/[\t\n\f\r ]/g, '');
  if (string.length % 4 === 0) string = string.replace(/==?$/, '');
  if (string.length % 4 === 1) throw invalidCharacter('The string to be decoded is not correctly encoded.');
  if (/[^A-Za-z0-9+/]/.test(string)) throw invalidCharacter('Invalid character');
  return Buffer.from(string, 'base64').toString('latin1');
}
exports.Buffer = Buffer;
exports.SlowBuffer = SlowBuffer;
exports.INSPECT_MAX_BYTES = 50;
exports.kMaxLength = MAX_LENGTH;
exports.kStringMaxLength = MAX_STRING_LENGTH;
exports.constants = Object.defineProperties({}, {
  MAX_LENGTH: { enumerable: true, value: MAX_LENGTH },
  MAX_STRING_LENGTH: { enumerable: true, value: MAX_STRING_LENGTH }
});
exports.transcode = transcode;
exports.isUtf8 = isUtf8;
exports.isAscii = isAscii;
exports.atob = atob;
exports.btoa = btoa;
for (const name of ['Blob', 'File', 'resolveObjectURL']) {
  Object.defineProperty(exports, name, {
    configurable: true,
    enumerable: true,
    get() {
      const value = require('internal/web/blob')[name];
      Object.defineProperty(exports, name, { configurable: true, enumerable: true, writable: true, value });
      return value;
    },
    set(value) {
      Object.defineProperty(exports, name, { configurable: true, enumerable: true, writable: true, value });
    }
  });
}
