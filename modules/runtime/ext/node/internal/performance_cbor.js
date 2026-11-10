'use strict';

// Node's histogram wire format uses only unsigned integers, float64, arrays,
// and integer-keyed maps (src/histogram.cc, format version 1).
function invalid() { throw Object.assign(new TypeError('Invalid histogram export data'), { code: 'ERR_INVALID_ARG_VALUE' }); }
function encode(value) {
  const bytes = [];
  function uint(major, value) {
    value = BigInt(value);
    if (value < 0n || value > 18446744073709551615n) invalid();
    if (value < 24n) { bytes.push(major | Number(value)); return; }
    const width = value <= 255n ? 1 : value <= 65535n ? 2 : value <= 4294967295n ? 4 : 8;
    bytes.push(major | (width === 1 ? 24 : width === 2 ? 25 : width === 4 ? 26 : 27));
    for (let shift = BigInt((width - 1) * 8); shift >= 0n; shift -= 8n) bytes.push(Number((value >> shift) & 255n));
  }
  function write(value) {
    if (typeof value === 'bigint') { uint(0, value); return; }
    if (typeof value === 'number') {
      bytes.push(251);
      const buffer = new ArrayBuffer(8); new DataView(buffer).setFloat64(0, value);
      bytes.push(...new Uint8Array(buffer)); return;
    }
    if (Array.isArray(value)) { uint(128, value.length); for (const entry of value) write(entry); return; }
    if (value instanceof Map) { uint(160, value.size); for (const [key, entry] of value) { uint(0, key); write(entry); } return; }
    invalid();
  }
  write(value);
  return Uint8Array.from(bytes);
}
function decode(bytes) {
  if (!(bytes instanceof Uint8Array)) throw Object.assign(new TypeError('data must be a Uint8Array'), { code: 'ERR_INVALID_ARG_TYPE' });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  function read(depth) {
    if (depth > 8 || offset >= bytes.length) invalid();
    const first = bytes[offset++], major = first >> 5, additional = first & 31;
    if (first === 251) {
      if (offset + 8 > bytes.length) invalid();
      const result = view.getFloat64(offset); offset += 8; return result;
    }
    if (major !== 0 && major !== 4 && major !== 5) invalid();
    let count;
    if (additional < 24) count = BigInt(additional);
    else {
      const width = additional === 24 ? 1 : additional === 25 ? 2 : additional === 26 ? 4 : additional === 27 ? 8 : 0;
      if (!width || offset + width > bytes.length) invalid();
      count = 0n;
      for (let i = 0; i < width; i++) count = (count << 8n) | BigInt(bytes[offset++]);
    }
    if (major === 0) return count;
    if (count > BigInt(bytes.length - offset)) invalid();
    if (major === 4) { const result = []; for (let i = 0n; i < count; i++) result.push(read(depth + 1)); return result; }
    const result = new Map();
    for (let i = 0n; i < count; i++) {
      const key = read(depth + 1);
      if (typeof key !== 'bigint' || result.has(key)) invalid();
      result.set(key, read(depth + 1));
    }
    return result;
  }
  const result = read(0);
  if (offset !== bytes.length) invalid();
  return result;
}
module.exports = { encode, decode, invalid };
