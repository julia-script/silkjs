// crypto adapted from Node.js v24.22.1 lib/crypto.js and lib/internal/crypto (keys.js,
// sig.js, diffiehellman.js, keygen.js, cipher.js, hash.js): the same argument handling,
// validation and error shapes, with the checks of src/crypto/*.cc, on the runtime's
// native OpenSSL host (src/ext/crypto_native.silk).
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
const c = require('internal/crypto_core');
const { Buffer, call, submit, packed, bytes, binary, integer, callback, error, invalid, output, attach, handle, release, name, kHandle } = c;
const { Transform, Writable } = require('stream');
const constants = Object.freeze({ SSL_OP_ALL: 2147485776, SSL_OP_ALLOW_NO_DHE_KEX: 1024, SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION: 262144, SSL_OP_CIPHER_SERVER_PREFERENCE: 4194304, SSL_OP_CISCO_ANYCONNECT: 32768, SSL_OP_COOKIE_EXCHANGE: 8192, SSL_OP_CRYPTOPRO_TLSEXT_BUG: 2147483648, SSL_OP_DONT_INSERT_EMPTY_FRAGMENTS: 2048, SSL_OP_LEGACY_SERVER_CONNECT: 4, SSL_OP_NO_COMPRESSION: 131072, SSL_OP_NO_ENCRYPT_THEN_MAC: 524288, SSL_OP_NO_QUERY_MTU: 4096, SSL_OP_NO_RENEGOTIATION: 1073741824, SSL_OP_NO_SESSION_RESUMPTION_ON_RENEGOTIATION: 65536, SSL_OP_NO_SSLv2: 0, SSL_OP_NO_SSLv3: 33554432, SSL_OP_NO_TICKET: 16384, SSL_OP_NO_TLSv1: 67108864, SSL_OP_NO_TLSv1_1: 268435456, SSL_OP_NO_TLSv1_2: 134217728, SSL_OP_NO_TLSv1_3: 536870912, SSL_OP_PRIORITIZE_CHACHA: 2097152, SSL_OP_TLS_ROLLBACK_BUG: 8388608, RSA_PKCS1_PADDING: 1, RSA_NO_PADDING: 3, RSA_PKCS1_OAEP_PADDING: 4, RSA_X931_PADDING: 5, RSA_PKCS1_PSS_PADDING: 6, RSA_PSS_SALTLEN_DIGEST: -1, RSA_PSS_SALTLEN_MAX_SIGN: -2, RSA_PSS_SALTLEN_AUTO: -2, POINT_CONVERSION_COMPRESSED: 2, POINT_CONVERSION_UNCOMPRESSED: 4, POINT_CONVERSION_HYBRID: 6, DH_CHECK_P_NOT_PRIME: 1, DH_CHECK_P_NOT_SAFE_PRIME: 2, DH_UNABLE_TO_CHECK_GENERATOR: 4, DH_NOT_SUITABLE_GENERATOR: 8, ENGINE_METHOD_RSA: 1, ENGINE_METHOD_DSA: 2, ENGINE_METHOD_DH: 4, ENGINE_METHOD_RAND: 8, ENGINE_METHOD_CIPHERS: 64, ENGINE_METHOD_DIGESTS: 128, ENGINE_METHOD_PKEY_METHS: 512, ENGINE_METHOD_PKEY_ASN1_METHS: 1024, ENGINE_METHOD_EC: 2048, ENGINE_METHOD_ALL: 65535, ENGINE_METHOD_NONE: 0, defaultCoreCipherList: require('internal/tls/options').DEFAULT_CIPHER_LIST, defaultCipherList: require('internal/tls/options').getOptionValue('--tls-cipher-list') });
const { codes, validate, isAnyArrayBuffer, normalize } = c;
// lib/internal/crypto/random.js
const kMaxPossibleLength = Math.min(require('buffer').kMaxLength, 2 ** 31 - 1);
function assertOffset(offset, elementSize, length) {
  validate.number(offset, 'offset'); offset *= elementSize;
  const maxLength = Math.min(length, kMaxPossibleLength);
  if (Number.isNaN(offset) || offset > maxLength || offset < 0) throw codes.ERR_OUT_OF_RANGE('offset', `>= 0 && <= ${maxLength}`, offset);
  return offset >>> 0;
}
function assertSize(size, elementSize, offset, length) {
  validate.number(size, 'size'); size *= elementSize;
  if (Number.isNaN(size) || size > kMaxPossibleLength || size < 0) throw codes.ERR_OUT_OF_RANGE('size', `>= 0 && <= ${kMaxPossibleLength}`, size);
  if (size + offset > length) throw codes.ERR_OUT_OF_RANGE('size + offset', `<= ${length}`, size + offset);
  return size >>> 0;
}
function randomView(buf) { return isAnyArrayBuffer(buf) ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength); }
function randomBytes(size, cb) {
  size = assertSize(size, 1, 0, Infinity);
  if (cb !== undefined) validate.function(cb, 'callback');
  if (cb === undefined) return Buffer.from(call('random', [size]));
  submit('random', [size], cb, Buffer.from);
}
function randomBuffer(buf) {
  if (!isAnyArrayBuffer(buf) && !ArrayBuffer.isView(buf)) throw codes.ERR_INVALID_ARG_TYPE('buf', ['ArrayBuffer', 'ArrayBufferView'], buf);
}
function randomFillSync(buf, offset = 0, size) {
  randomBuffer(buf); const elementSize = buf.BYTES_PER_ELEMENT || 1;
  offset = assertOffset(offset, elementSize, buf.byteLength);
  size = size === undefined ? buf.byteLength - offset : assertSize(size, elementSize, offset, buf.byteLength);
  if (size !== 0) randomView(buf).set(new Uint8Array(call('random', [size])), offset);
  return buf;
}
function randomFill(buf, offset, size, cb) {
  randomBuffer(buf); const elementSize = buf.BYTES_PER_ELEMENT || 1;
  if (typeof offset === 'function') { cb = offset; offset = 0; size = buf.length; }
  else if (typeof size === 'function') { cb = size; size = (buf.length ?? buf.byteLength) - offset; }
  else validate.function(cb, 'callback');
  offset = assertOffset(offset, elementSize, buf.byteLength);
  size = size === undefined ? buf.byteLength - offset : assertSize(size, elementSize, offset, buf.byteLength);
  if (size === 0) { cb(null, buf); return; }
  submit('random', [size], (e, data) => { if (e) return cb(e); randomView(buf).set(new Uint8Array(data), offset); cb(null, buf); });
}
const RAND_MAX = 0xFFFF_FFFF_FFFF;
const randomCache = Buffer.alloc(6 * 1024); let randomCacheOffset = randomCache.length, asyncCacheFillInProgress = false; const asyncCachePendingTasks = [];
function randomInt(min, max, cb) {
  const minNotSpecified = typeof max === 'undefined' || typeof max === 'function';
  if (minNotSpecified) { cb = max; max = min; min = 0; }
  const isSync = typeof cb === 'undefined';
  if (!isSync) validate.function(cb, 'callback');
  if (!Number.isSafeInteger(min)) throw codes.ERR_INVALID_ARG_TYPE('min', 'a safe integer', min);
  if (!Number.isSafeInteger(max)) throw codes.ERR_INVALID_ARG_TYPE('max', 'a safe integer', max);
  if (max <= min) throw codes.ERR_OUT_OF_RANGE('max', `greater than the value of "min" (${min})`, max);
  const range = max - min;
  if (!(range <= RAND_MAX)) throw codes.ERR_OUT_OF_RANGE(`max${minNotSpecified ? '' : ' - min'}`, `<= ${RAND_MAX}`, range);
  const randLimit = RAND_MAX - (RAND_MAX % range);
  while (isSync || randomCacheOffset < randomCache.length) {
    if (randomCacheOffset === randomCache.length) { randomFillSync(randomCache); randomCacheOffset = 0; }
    const x = randomCache.readUIntBE(randomCacheOffset, 6); randomCacheOffset += 6;
    if (x < randLimit) { const n = (x % range) + min; if (isSync) return n; process.nextTick(cb, undefined, n); return; }
  }
  asyncCachePendingTasks.push({ min, max, cb });
  if (asyncCacheFillInProgress) return;
  asyncCacheFillInProgress = true;
  randomFill(randomCache, (err) => {
    asyncCacheFillInProgress = false;
    const errorReceiver = err && asyncCachePendingTasks.shift();
    if (!err) randomCacheOffset = 0;
    for (const task of asyncCachePendingTasks.splice(0)) randomInt(task.min, task.max, task.cb);
    if (errorReceiver) errorReceiver.cb(err);
  });
}
function uuid(buf, version, variant, offset = 0) {
  const h = i => (buf[offset + i] < 16 ? '0' : '') + buf[offset + i].toString(16);
  const v = (i, bits, mask) => { const byte = (buf[offset + i] & mask) | bits; return (byte < 16 ? '0' : '') + byte.toString(16); };
  return h(0) + h(1) + h(2) + h(3) + '-' + h(4) + h(5) + '-' + v(6, version, 0x0f) + h(7) + '-' + v(8, variant, 0x3f) + h(9) + '-' + h(10) + h(11) + h(12) + h(13) + h(14) + h(15);
}
const kBatchSize = 128; let uuidData, uuidBatch = 0;
function uuidOptions(options) {
  if (options !== undefined) validate.object(options, 'options');
  const { disableEntropyCache = false } = options || {};
  validate.boolean(disableEntropyCache, 'options.disableEntropyCache');
  return disableEntropyCache;
}
function uuidBytes(unbuffered) {
  if (unbuffered) return [randomFillSync(Buffer.alloc(16)), 0];
  uuidData ??= Buffer.alloc(16 * kBatchSize);
  if (uuidBatch === 0) randomFillSync(uuidData);
  uuidBatch = (uuidBatch + 1) % kBatchSize;
  return [uuidData, uuidBatch * 16];
}
// Node's lib/internal/crypto/random.js: a snapshot carries no random data of the process that built it.
if (require('internal/v8/startup_snapshot').namespace.isBuildingSnapshot()) {
  const snapshot = require('internal/v8/startup_snapshot');
  const resetRandomCaches = () => {
    randomCache.fill(0);
    randomCacheOffset = randomCache.length;
    if (uuidData !== undefined) { uuidData.fill(0); uuidData = undefined; }
    uuidBatch = 0;
  };
  snapshot.addAfterUserSerializeCallback(resetRandomCaches);
  // Microtasks and exit handlers can refill the caches after serialization
  // callbacks, so they are reset again before any user deserialization callback.
  snapshot.addBeforeUserDeserializeCallback(resetRandomCaches);
}
function randomUUID(options) { const [buf, offset] = uuidBytes(uuidOptions(options)); return uuid(buf, 0x40, 0x80, offset); }
function randomUUIDv7(options) {
  const [buf, offset] = uuidBytes(uuidOptions(options));
  const now = Date.now(), msb = now / 2 ** 32;
  buf[offset] = msb >>> 8; buf[offset + 1] = msb; buf[offset + 2] = now >>> 24; buf[offset + 3] = now >>> 16; buf[offset + 4] = now >>> 8; buf[offset + 5] = now;
  return uuid(buf, 0x70, 0x80, offset);
}
function unsignedBigIntToBuffer(bigint, name) {
  if (bigint < 0) throw codes.ERR_OUT_OF_RANGE(name, '>= 0', bigint);
  const hex = bigint.toString(16); return Buffer.from(hex.padStart(hex.length + (hex.length % 2), '0'), 'hex');
}
function unsignedValue(value) { const hex = Buffer.from(value).toString('hex'); return hex ? BigInt('0x' + hex) : 0n; }
const bigIntOrBufferTypes = ['ArrayBuffer', 'TypedArray', 'Buffer', 'DataView', 'bigint'];
function bigIntOrBuffer(value, name) {
  if (typeof value === 'bigint') return unsignedBigIntToBuffer(value, name);
  if (!isAnyArrayBuffer(value) && !ArrayBuffer.isView(value)) throw codes.ERR_INVALID_ARG_TYPE(name, bigIntOrBufferTypes, value);
  return value;
}
// Node converts the candidate to a BIGNUM before it queues the job, so an oversized one
// fails synchronously: BN_bin2bn refuses more than INT_MAX / (4 * BN_BITS2) words.
const kMaxBignumBytes = Math.floor(0x7fffffff / 256) * 8;
function checkPrimeArgs(candidate, options) {
  validate.object(options, 'options');
  const { checks = 0 } = options;
  validate.int32(checks, 'options.checks', 0);
  if (bytes(candidate).byteLength > kMaxBignumBytes) throw normalize(new Error('error:01800072:bignum routines::bignum too long'));
  return [packed(candidate), checks];
}
function checkPrimeSync(candidate, options = {}) { candidate = bigIntOrBuffer(candidate, 'candidate'); return !!call('checkPrime', checkPrimeArgs(candidate, options)); }
function checkPrime(candidate, options = {}, cb) {
  candidate = bigIntOrBuffer(candidate, 'candidate');
  if (typeof options === 'function') { cb = options; options = {}; }
  validate.function(cb, 'callback');
  submit('checkPrime', checkPrimeArgs(candidate, options), cb, value => !!value);
}
function primeArgs(size, options) {
  validate.object(options, 'options');
  const { safe = false, bigint = false } = options; let { add, rem } = options;
  validate.boolean(safe, 'options.safe'); validate.boolean(bigint, 'options.bigint');
  if (add !== undefined) add = bigIntOrBuffer(add, 'options.add');
  if (rem !== undefined) rem = bigIntOrBuffer(rem, 'options.rem');
  if (add !== undefined) {
    const a = unsignedValue(randomView(add));
    if (a.toString(2).length > size) throw error('ERR_OUT_OF_RANGE', 'invalid options.add', RangeError);
    if (rem !== undefined && a <= unsignedValue(randomView(rem))) throw error('ERR_OUT_OF_RANGE', 'invalid options.rem', RangeError);
  }
  return { args: [size, safe ? 1 : 0, add === undefined ? undefined : packed(add), rem === undefined ? undefined : packed(rem)], bigint };
}
function generatePrimeSync(size, options = {}) { validate.int32(size, 'size', 1); const job = primeArgs(size, options); const value = call('generatePrime', job.args); return job.bigint ? unsignedValue(value) : value; }
function generatePrime(size, options, cb) {
  validate.int32(size, 'size', 1);
  if (typeof options === 'function') { cb = options; options = {}; }
  validate.function(cb, 'callback');
  const job = primeArgs(size, options);
  submit('generatePrime', job.args, (e, value) => e ? cb(e) : cb(undefined, value), value => job.bigint ? unsignedValue(value) : value);
}
function getCipherInfo(nameOrNid, options) {
  if (typeof nameOrNid !== 'string' && typeof nameOrNid !== 'number') throw codes.ERR_INVALID_ARG_TYPE('nameOrNid', ['string', 'number'], nameOrNid);
  if (typeof nameOrNid === 'number') validate.int32(nameOrNid, 'nameOrNid');
  let keyLength, ivLength;
  if (options !== undefined) {
    validate.object(options, 'options'); ({ keyLength, ivLength } = options);
    if (keyLength !== undefined) { validate.int32(keyLength, 'options.keyLength'); keyLength += 0; }
    if (ivLength !== undefined) { validate.int32(ivLength, 'options.ivLength'); ivLength += 0; }
  }
  const info = cipherDetails(nameOrNid, keyLength, ivLength);
  if (info === undefined) return undefined;
  const result = { name: info.name.toLowerCase(), keyLength: info.keyLength };
  const modeName = cipherModes[info.mode];
  if (modeName !== undefined) result.mode = modeName;
  if (info.nid !== 0) result.nid = info.nid;
  if (info.mode !== 0) result.blockSize = info.blockSize;
  if (info.ivLength !== 0) result.ivLength = info.ivLength;
  return result;
}
const cipherModes = { 0: 'stream', 1: 'ecb', 2: 'cbc', 3: 'cfb', 4: 'ofb', 5: 'ctr', 6: 'gcm', 7: 'ccm', 65537: 'xts', 65538: 'wrap', 65539: 'ocb', 65540: 'siv', 65541: 'gcm-siv' };
function cipherDetails(nameOrNid, keyLength, ivLength) {
  const value = call('cipherInfo', [nameOrNid, keyLength === undefined ? 0 : keyLength, ivLength === undefined ? 0 : ivLength, typeof nameOrNid === 'number' ? 1 : 0, keyLength === undefined ? 0 : 1, ivLength === undefined ? 0 : 1]);
  if (value === undefined) return undefined;
  const b = Buffer.from(value);
  return { mode: b.readInt32LE(0), nid: b.readInt32LE(4), blockSize: b.readInt32LE(8), keyLength: b.readInt32LE(12), ivLength: b.readInt32LE(16), name: b.subarray(20).toString() };
}
// No secure heap is configured by this runtime. These are Node's disabled-heap
// configuration values; used is queried from OpenSSL rather than estimated.
// lib/internal/crypto/util.js secureHeapUsed over the heap that
// --secure-heap sets up (InitCryptoOnce's CRYPTO_secure_malloc_init).
function secureHeapUsed() {
  const total = secureHeapOption('--secure-heap');
  if (total === 0) return { total: 0, used: 0, utilization: 0, min: 0 };
  const min = secureHeapOption('--secure-heap-min'), used = call('secureHeapUsed', []);
  return { total, used, utilization: used / total, min };
}
function secureHeapOption(name) { return require('internal/options').getOptionValue(name); }
if (secureHeapOption('--secure-heap')) call('secureHeapInit', [secureHeapOption('--secure-heap'), secureHeapOption('--secure-heap-min')]);
function setEngine(id, flags) { name(id, 'id'); if (flags && typeof flags !== 'number') throw invalid('flags', 'a number'); flags = flags >>> 0; if (!call('setEngine', [id, flags || 65535])) throw error('ERR_CRYPTO_ENGINE_UNKNOWN', `Engine "${id}" was not found`); }
function timingSafeEqual(a, b) { a = binary(a); b = binary(b); if (a.length !== b.length) throw error('ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH', 'Input buffers must have the same byte length', RangeError); return !!call('equal', [packed(a), packed(b)]); }
// lib/internal/crypto/hash.js
const LazyTransform = require('internal/streams/lazy_transform');
const kState = Symbol('kState'), kFinalized = Symbol('kFinalized');
const { emitWarning } = process;
let shakeWarned = false;
function warnShake(algorithm) {
  if (shakeWarned || !require('internal/options').getOptionValue('--pending-deprecation')) return;
  const normalized = algorithm.toLowerCase().replace('-', '');
  if (normalized !== 'shake128' && normalized !== 'shake256') return;
  shakeWarned = true; emitWarning('Creating SHAKE128/256 digests without an explicit options.outputLength is deprecated.', 'DeprecationWarning', 'DEP0198');
}
function digestSize(algorithm) { try { return call('hashSize', [algorithm]); } catch { return undefined; } }
// The native digest has no output length: XOF lengths are applied when the digest is read.
function hashState(algorithm, xofLen, existing) {
  const size = digestSize(algorithm), xof = /^shake-?(?:128|256)$/i.test(algorithm);
  if (xofLen !== undefined && !xof && xofLen !== size) throw error('ERR_OSSL_EVP_NOT_XOF_OR_INVALID_LENGTH', 'Invalid XOF digest length');
  return { algorithm, length: xof ? xofLen ?? (/128$/.test(algorithm) ? 16 : 32) : -1, [kFinalized]: false, existing };
}
// The native half of Node's Hash (crypto::Hash): update() reports an OpenSSL
// failure as false, and digest() keeps the first digest so _flush() can read it
// without finalizing.
class HashHandle {
  constructor(algorithm, length, source) {
    this.algorithm = algorithm; this.length = length;
    attach(this, source === undefined ? call('hashCreate', [algorithm]) : call('hashCopy', [handle(source)]));
  }
  update(data, encoding) {
    try { call('hashUpdate', [handle(this), packed(typeof data === 'string' ? Buffer.from(data, encoding) : data)]); } catch { return false; }
    return true;
  }
  digest(outputEncoding) { return hashDigest(this, 'hashFinal', () => [handle(this), this.length], outputEncoding); }
}
function Hash(algorithm, options) {
  if (!new.target) return new Hash(algorithm, options);
  const isCopy = algorithm instanceof HashHandle;
  if (!isCopy) validate.string(algorithm, 'algorithm');
  let xofLen = typeof options === 'object' && options !== null ? options.outputLength : undefined;
  if (xofLen !== undefined) { validate.uint32(xofLen, 'options.outputLength'); xofLen += 0; }
  const name = isCopy ? algorithm.algorithm : algorithm;
  if (!isCopy && digestSize(name) === undefined) throw new Error('Digest method not supported');
  const state = hashState(name, xofLen);
  try { this[kHandle] = new HashHandle(name, state.length, isCopy ? algorithm : undefined); }
  catch (e) { if (!isCopy && e.code === 'ERR_OSSL_CRYPTO_OPERATION_FAILED' && digestSize(algorithm) === undefined) throw new Error('Digest method not supported'); throw e; }
  this[kState] = { [kFinalized]: false };
  if (!isCopy && xofLen === undefined) warnShake(algorithm);
  LazyTransform.call(this, options);
}
Object.setPrototypeOf(Hash.prototype, LazyTransform.prototype);
Object.setPrototypeOf(Hash, LazyTransform);
function hashData(data, encoding) {
  if (typeof data === 'string') { validate.encoding(data, encoding); return Buffer.from(data, encoding); }
  if (!ArrayBuffer.isView(data)) throw codes.ERR_INVALID_ARG_TYPE('data', ['string', 'Buffer', 'TypedArray', 'DataView'], data);
  return data;
}
// Like Node's native handles, the first digest is kept: _flush() reads it without finalizing.
const kDigest = Symbol('kDigest');
function hashDigest(object, op, args, outputEncoding) {
  let result = object[kDigest];
  if (result === undefined) { result = object[kDigest] = Buffer.from(call(op, args())); release(object); }
  // Explicit conversion of truthy values for backward compatibility.
  outputEncoding = outputEncoding && `${outputEncoding}`;
  return outputEncoding && outputEncoding !== 'buffer' ? result.toString(outputEncoding) : Buffer.from(result);
}
Hash.prototype.copy = function copy(options) { if (this[kState][kFinalized]) throw codes.ERR_CRYPTO_HASH_FINALIZED(); return new Hash(this[kHandle], options); };
Hash.prototype._transform = function _transform(chunk, encoding, cb) { if (!this[kHandle].update(chunk, encoding)) return cb(codes.ERR_CRYPTO_HASH_UPDATE_FAILED()); cb(); };
Hash.prototype._flush = function _flush(cb) { this.push(this[kHandle].digest()); cb(); };
Hash.prototype.update = function update(data, encoding) {
  if (this[kState][kFinalized]) throw codes.ERR_CRYPTO_HASH_FINALIZED();
  if (!this[kHandle].update(hashData(data, encoding))) throw codes.ERR_CRYPTO_HASH_UPDATE_FAILED();
  return this;
};
Hash.prototype.digest = function digest(outputEncoding) {
  const state = this[kState]; if (state[kFinalized]) throw codes.ERR_CRYPTO_HASH_FINALIZED();
  const result = this[kHandle].digest(outputEncoding); state[kFinalized] = true; return result;
};
Hash.prototype._destroy = function _destroy(e, cb) { release(this[kHandle]); cb(e); };
function Hmac(hmac, key, options) {
  if (!(this instanceof Hmac)) return new Hmac(hmac, key, options);
  validate.string(hmac, 'hmac');
  const encoding = options && options.encoding;
  if (encoding !== undefined && options !== null && typeof options === 'object') validate.string(encoding, 'options.encoding');
  key = prepareSecretKey(key, encoding);
  if (digestSize(hmac) === undefined) throw codes.ERR_CRYPTO_INVALID_DIGEST(hmac);
  let id; try { id = call('hmacCreate', [hmac, packed(key)]); } catch (e) { if (e.library !== undefined) throw e; throw codes.ERR_CRYPTO_OPERATION_FAILED('Failed to initialize HMAC'); }
  attach(this, id); this[kState] = { [kFinalized]: false };
  LazyTransform.call(this, options);
}
Object.setPrototypeOf(Hmac.prototype, LazyTransform.prototype);
Object.setPrototypeOf(Hmac, LazyTransform);
Hmac.prototype.update = function update(data, encoding) {
  if (this[kState][kFinalized]) throw codes.ERR_CRYPTO_HASH_FINALIZED();
  call('hmacUpdate', [handle(this), packed(hashData(data, encoding))]); return this;
};
Hmac.prototype.digest = function digest(outputEncoding) {
  const state = this[kState];
  if (state[kFinalized]) { const buf = Buffer.from(''); return outputEncoding && outputEncoding !== 'buffer' ? buf.toString(outputEncoding) : buf; }
  const result = hashDigest(this, 'hmacFinal', () => [handle(this)], outputEncoding); state[kFinalized] = true; return result;
};
Hmac.prototype._transform = function _transform(chunk, encoding, cb) { call('hmacUpdate', [handle(this), packed(typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk)]); cb(); };
Hmac.prototype._flush = function _flush(cb) { this.push(hashDigest(this, 'hmacFinal', () => [handle(this)])); this[kState][kFinalized] = true; cb(); };
Hmac.prototype._destroy = function _destroy(e, cb) { release(this); cb(e); };
function createHash(algorithm, options) { return new Hash(algorithm, options); }
function createHmac(hmac, key, options) { return new Hmac(hmac, key, options); }
function hash(algorithm, input, options) {
  validate.string(algorithm, 'algorithm');
  if (typeof input !== 'string' && !ArrayBuffer.isView(input)) throw codes.ERR_INVALID_ARG_TYPE('input', ['Buffer', 'TypedArray', 'DataView', 'string'], input);
  let outputEncoding, outputLength;
  if (typeof options === 'string') outputEncoding = options;
  else if (options !== undefined) { validate.object(options, 'options'); outputLength = options.outputLength; outputEncoding = options.outputEncoding; }
  outputEncoding ??= 'hex';
  let normalized = outputEncoding;
  if (normalized !== 'hex') {
    validate.string(outputEncoding, 'outputEncoding');
    normalized = outputEncoding.toLowerCase() === 'buffer' ? 'buffer' : Buffer.isEncoding(outputEncoding) ? outputEncoding : undefined;
    if (normalized === undefined) throw codes.ERR_INVALID_ARG_VALUE('outputEncoding', outputEncoding);
  }
  if (outputLength !== undefined) { validate.uint32(outputLength, 'outputLength'); outputLength += 0; }
  const size = digestSize(algorithm), xof = /^shake-?(?:128|256)$/i.test(algorithm);
  if (size === undefined) throw new Error(`Digest method ${algorithm} is not supported`);
  if (!xof && outputLength !== undefined && outputLength !== size) throw new Error(`Output length ${outputLength} is invalid for ${algorithm}, which does not support XOF`);
  if (xof && outputLength === 0) return normalized === 'buffer' ? Buffer.alloc(0) : '';
  const digest = new Hash(algorithm, outputLength === undefined ? undefined : { outputLength });
  return digest.update(input, typeof input === 'string' ? 'utf8' : undefined).digest(normalized);
}
// lib/internal/crypto/cipher.js, with the checks and auth tag states of Node's CipherBase (src/crypto/crypto_cipher.cc).
const { StringDecoder } = require('string_decoder');
const kCipher = Symbol('kCipher');
const kNoAuthTagLength = -1, kAuthTagUnknown = 0, kAuthTagComputed = 1, kAuthTagSetByUser = 2;
function getStringOption(options, key) { let value; if (options && (value = options[key]) != null) validate.string(value, `options.${key}`); return value; }
function getUIntOption(options, key) { let value; if (options && (value = options[key]) != null) { if (value >>> 0 !== value) throw codes.ERR_INVALID_ARG_VALUE(`options.${key}`, value); return value + 0; } return -1; }
function getDecoder(decoder, encoding) {
  const normalized = Buffer.isEncoding(encoding) ? new StringDecoder(encoding).encoding : undefined;
  decoder ||= new StringDecoder(encoding);
  if (decoder.encoding !== normalized) {
    if (normalized === undefined) throw codes.ERR_UNKNOWN_ENCODING(encoding);
    throw codes.ERR_INVALID_ARG_VALUE('outputEncoding', encoding, `cannot be changed from '${decoder.encoding}'`);
  }
  return decoder;
}
// Node's CipherBase::kMaxSivAADComponents: OpenSSL's SIV takes at most 126 AAD components.
const kMaxSivAADComponents = 126;
const validGcmTag = n => n === 4 || n === 8 || (n >= 12 && n <= 16);
// A failed native step reports OpenSSL's error when there is one, else Node's message.
function cipherFailure(e, message) { if (e.code === 'ERR_OSSL_CRYPTO_OPERATION_FAILED' && e.library === undefined) return new Error(message); return e; }
function initCipher(object, cipher, key, iv, authTagLength, ctsMode, xtsStandard, encrypt) {
  const info = cipherDetails(cipher);
  if (info === undefined) throw codes.ERR_CRYPTO_UNKNOWN_CIPHER();
  const mode = info.mode, lower = cipher.toLowerCase();
  const chacha = info.name.toLowerCase() === 'chacha20-poly1305', siv = mode === 65540, gcmSiv = mode === 65541;
  const gcm = mode === 6, ccm = mode === 7, ocb = mode === 65539, wrap = mode === 65538, xts = mode === 65537;
  const cts = /-cts$/.test(lower), aead = gcm || ccm || ocb || chacha || siv || gcmSiv;
  const ivBytes = iv === null ? Buffer.alloc(0) : bytes(iv), hasIv = ivBytes.length > 0, expected = info.ivLength;
  if (!hasIv && expected !== 0) throw codes.ERR_CRYPTO_INVALID_IV();
  if (!aead && hasIv && ivBytes.length !== expected) throw codes.ERR_CRYPTO_INVALID_IV();
  if (chacha && ivBytes.length > 12) throw codes.ERR_CRYPTO_INVALID_IV();
  if (siv && hasIv) throw codes.ERR_CRYPTO_INVALID_IV();
  if (gcmSiv && (!hasIv || ivBytes.length !== expected)) throw codes.ERR_CRYPTO_INVALID_IV();
  if (ctsMode !== undefined && !cts) throw error('ERR_CRYPTO_UNSUPPORTED_OPERATION', `${cipher} does not support the ctsMode option`);
  if (xtsStandard !== undefined && !(xts && /^sm4-/.test(lower))) throw error('ERR_CRYPTO_UNSUPPORTED_OPERATION', `${cipher} does not support the xtsStandard option`);
  const state = { encrypt, gcm, ccm, chacha, siv: siv || gcmSiv, sivMode: siv, sivAadComponents: 0, aead, oneShot: (ccm && !encrypt) || siv || gcmSiv || cts || xts || wrap, hasOneShotUpdate: false, pendingAuthFailed: false, authTagLength: kNoAuthTagLength, authTagState: kAuthTagUnknown, tag: undefined, maxMessage: 0x7fffffff, blockSize: Math.max(info.blockSize, 1), open: false };
  if (aead) {
    if (!siv && !gcmSiv) {
      const n = ivBytes.length;
      if (ccm ? n < 7 || n > 13 : ocb ? n < 1 || n > 15 : chacha ? n < 1 || n > 12 : n < 1) throw codes.ERR_CRYPTO_INVALID_IV();
    }
    if (ccm) { if (ivBytes.length === 12) state.maxMessage = 16777215; if (ivBytes.length === 13) state.maxMessage = 65535; }
    let length = authTagLength;
    if (length === kNoAuthTagLength) {
      if (siv || gcmSiv || chacha) length = 16;
      else if (!gcm) throw codes.ERR_CRYPTO_INVALID_AUTH_TAG(`authTagLength required for ${cipher}`);
    } else if (siv || gcmSiv ? length !== 16 : gcm ? !validGcmTag(length) : ccm ? length < 4 || length > 16 || length % 2 : length < 1 || length > 16) {
      throw codes.ERR_CRYPTO_INVALID_AUTH_TAG(`Invalid authentication tag length: ${length}`);
    }
    state.authTagLength = length;
  }
  let id;
  try { id = call('cipherCreate', [cipher, packed(key), packed(ivBytes), encrypt ? 1 : 0, state.authTagLength === kNoAuthTagLength ? 16 : state.authTagLength, aead ? 1 : 0, ctsMode ?? '', xtsStandard ?? '']); }
  catch (e) { if (e.code === 'ERR_CRYPTO_INVALID_KEYLEN') throw codes.ERR_CRYPTO_INVALID_KEYLEN(); throw cipherFailure(e, 'Failed to initialize cipher'); }
  attach(object, id); state.open = true; object[kCipher] = state;
}
function createCipherBase(cipher, credential, options, isEncrypt, iv) {
  let authTagLength = -1, ctsMode, xtsStandard;
  if (options != null) {
    authTagLength = getUIntOption(options, 'authTagLength');
    ctsMode = getStringOption(options, 'ctsMode') ?? undefined;
    xtsStandard = getStringOption(options, 'xtsStandard') ?? undefined;
    if (ctsMode !== undefined) validate.oneOf(ctsMode, 'options.ctsMode', ['CS1', 'CS2', 'CS3']);
    if (xtsStandard !== undefined) validate.oneOf(xtsStandard, 'options.xtsStandard', ['GB', 'IEEE']);
  }
  initCipher(this, cipher, credential, iv, authTagLength, ctsMode, xtsStandard, isEncrypt);
  this._decoder = null;
  LazyTransform.call(this, options);
}
function createCipherWithIV(cipher, key, options, isEncrypt, iv) {
  validate.string(cipher, 'cipher');
  const encoding = getStringOption(options, 'encoding');
  key = bytes(prepareSecretKey(key, encoding));
  iv = iv === null ? null : validate.bufferSource(iv, 'iv');
  createCipherBase.call(this, cipher, key, options, isEncrypt, iv);
}
function cipherUpdate(object, data) {
  const state = object[kCipher];
  if (!state.open) throw new Error('Trying to add data in unsupported state');
  if (state.ccm && data.byteLength > state.maxMessage) throw error('ERR_CRYPTO_INVALID_MESSAGELEN', 'Invalid message length', RangeError);
  if ((state.oneShot && state.hasOneShotUpdate) || data.byteLength + state.blockSize > 0x7fffffff) throw new Error('Trying to add data in unsupported state');
  // Node pops OpenSSL's errors before reporting a failed update.
  let result;
  try { result = Buffer.from(call('cipherUpdate', [handle(object), packed(data)])); }
  catch {
    if (!state.encrypt && (state.ccm || state.siv)) { state.hasOneShotUpdate = true; state.pendingAuthFailed = true; return Buffer.alloc(0); }
    throw new Error('Trying to add data in unsupported state');
  }
  if (state.oneShot) state.hasOneShotUpdate = true;
  return result;
}
function cipherFinal(object) {
  const state = object[kCipher];
  if (!state.open) throw error('ERR_CRYPTO_INVALID_STATE', 'Invalid state');
  const message = state.aead ? 'Unsupported state or unable to authenticate data' : 'Unsupported state';
  state.open = false;
  try {
    if (state.oneShot && !state.hasOneShotUpdate && !state.ccm) throw new Error(message);
    if (!state.encrypt && state.ccm) {
      if (!(state.authTagState === kAuthTagSetByUser && state.hasOneShotUpdate && !state.pendingAuthFailed)) throw new Error(message);
      return Buffer.alloc(0);
    }
    if (state.pendingAuthFailed) throw new Error(message);
    let result;
    try { result = Buffer.from(call('cipherFinal', [handle(object)])); } catch (e) { throw cipherFailure(e, message); }
    if (state.encrypt && state.aead) {
      if (state.authTagLength === kNoAuthTagLength) state.authTagLength = 16;
      state.tag = Buffer.from(call('cipherGetTag', [handle(object), state.authTagLength])); state.authTagState = kAuthTagComputed;
    }
    return result;
  } finally { release(object); }
}
function cipherData(data, inputEncoding) {
  if (typeof data === 'string') { validate.encoding(data, inputEncoding); return Buffer.from(data, inputEncoding); }
  if (!ArrayBuffer.isView(data)) throw codes.ERR_INVALID_ARG_TYPE('data', ['string', 'Buffer', 'TypedArray', 'DataView'], data);
  return data;
}
const cipherPrototype = {
  _transform(chunk, encoding, cb) { this.push(cipherUpdate(this, typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk)); cb(); },
  _flush(cb) { try { this.push(cipherFinal(this)); } catch (e) { cb(e); return; } cb(); },
  update(data, inputEncoding, outputEncoding) {
    const ret = cipherUpdate(this, cipherData(data, inputEncoding));
    if (outputEncoding && outputEncoding !== 'buffer') { this._decoder = getDecoder(this._decoder, outputEncoding); return this._decoder.write(ret); }
    return ret;
  },
  final(outputEncoding) {
    const ret = cipherFinal(this);
    if (outputEncoding && outputEncoding !== 'buffer') { this._decoder = getDecoder(this._decoder, outputEncoding); return this._decoder.end(ret); }
    return ret;
  },
  setAutoPadding(ap) {
    if (!this[kCipher].open) throw codes.ERR_CRYPTO_INVALID_STATE('setAutoPadding');
    try { call('cipherPadding', [handle(this), ap ? 1 : 0]); } catch { throw codes.ERR_CRYPTO_INVALID_STATE('setAutoPadding'); }
    return this;
  },
  setAAD(aadbuf, options) {
    const encoding = getStringOption(options, 'encoding'), plaintextLength = getUIntOption(options, 'plaintextLength');
    aadbuf = validate.bufferSource(aadbuf, 'aadbuf', encoding);
    const state = this[kCipher];
    if (!state.open || !state.aead || (state.siv && state.hasOneShotUpdate) || (state.sivMode && state.sivAadComponents >= kMaxSivAADComponents)) throw codes.ERR_CRYPTO_INVALID_STATE('setAAD');
    if (state.ccm) {
      if (plaintextLength < 0) throw error('ERR_MISSING_ARGS', 'options.plaintextLength required for CCM mode with AAD', TypeError);
      if (plaintextLength > state.maxMessage) throw error('ERR_CRYPTO_INVALID_MESSAGELEN', 'Invalid message length', RangeError);
    }
    try { call('cipherAAD', [handle(this), packed(aadbuf), state.ccm ? plaintextLength : -1]); } catch { throw codes.ERR_CRYPTO_INVALID_STATE('setAAD'); }
    if (state.sivMode) state.sivAadComponents++;
    return this;
  },
};
function getAuthTag() {
  const state = this[kCipher];
  if (state.open || !state.encrypt || state.authTagLength === kNoAuthTagLength || state.authTagState !== kAuthTagComputed) throw codes.ERR_CRYPTO_INVALID_STATE('getAuthTag');
  return Buffer.from(state.tag);
}
let gcmTagWarned = false;
function setAuthTag(tagbuf, encoding) {
  tagbuf = validate.bufferSource(tagbuf, 'buffer', encoding);
  const state = this[kCipher];
  if (!state.open || !state.aead || state.encrypt || state.authTagState !== kAuthTagUnknown || (state.siv && state.hasOneShotUpdate)) throw codes.ERR_CRYPTO_INVALID_STATE('setAuthTag');
  const length = tagbuf.byteLength;
  const valid = state.gcm ? (state.authTagLength === kNoAuthTagLength || state.authTagLength === length) && validGcmTag(length) : state.authTagLength === length;
  if (!valid) throw codes.ERR_CRYPTO_INVALID_AUTH_TAG(`Invalid authentication tag length: ${length}`);
  if (state.gcm && state.authTagLength === kNoAuthTagLength && length !== 16 && !gcmTagWarned) {
    gcmTagWarned = true;
    process.emitWarning('Using AES-GCM authentication tags of less than 128 bits without specifying the authTagLength option when initializing decryption is deprecated.', 'DeprecationWarning', 'DEP0182');
  }
  state.authTagLength = length;
  try { call('cipherTag', [handle(this), packed(tagbuf)]); } catch { throw codes.ERR_CRYPTO_INVALID_STATE('setAuthTag'); }
  state.authTagState = kAuthTagSetByUser;
  return this;
}
function Cipheriv(cipher, key, iv, options) {
  if (!(this instanceof Cipheriv)) return new Cipheriv(cipher, key, iv, options);
  createCipherWithIV.call(this, cipher, key, options, true, iv);
}
function Decipheriv(cipher, key, iv, options) {
  if (!(this instanceof Decipheriv)) return new Decipheriv(cipher, key, iv, options);
  createCipherWithIV.call(this, cipher, key, options, false, iv);
}
for (const constructor of [Cipheriv, Decipheriv]) {
  Object.setPrototypeOf(constructor.prototype, LazyTransform.prototype); Object.setPrototypeOf(constructor, LazyTransform);
  Object.assign(constructor.prototype, cipherPrototype);
  if (constructor === Cipheriv) constructor.prototype.getAuthTag = getAuthTag; else constructor.prototype.setAuthTag = setAuthTag;
  constructor.prototype._destroy = function _destroy(e, cb) { release(this); cb(e); };
}
function createCipheriv(cipher, key, iv, options) { return new Cipheriv(cipher, key, iv, options); }
function createDecipheriv(cipher, key, iv, options) { return new Decipheriv(cipher, key, iv, options); }
// lib/internal/crypto/pbkdf2.js, scrypt.js and hkdf.js; the job checks of src/crypto/crypto_{pbkdf2,scrypt,hkdf}.cc.
function knownDigest(name) { if (digestSize(name) === undefined) throw codes.ERR_CRYPTO_INVALID_DIGEST(name); }
function pbkdf2Check(password, salt, iterations, keylen, digest) {
  validate.string(digest, 'digest');
  password = validate.bufferSource(password, 'password'); salt = validate.bufferSource(salt, 'salt');
  validate.int32(iterations, 'iterations', 1); validate.int32(keylen, 'keylen', 0); keylen += 0;
  knownDigest(digest);
  return [packed(password), packed(salt), iterations, keylen, digest];
}
function pbkdf2(password, salt, iterations, keylen, digest, cb) {
  if (typeof digest === 'function') { cb = digest; digest = undefined; }
  const args = pbkdf2Check(password, salt, iterations, keylen, digest);
  validate.function(cb, 'callback');
  submit('pbkdf2', args, cb, Buffer.from);
}
function pbkdf2Sync(password, salt, iterations, keylen, digest) { return Buffer.from(call('pbkdf2', pbkdf2Check(password, salt, iterations, keylen, digest))); }
const scryptDefaults = { N: 16384, r: 8, p: 1, maxmem: 32 << 20 };
// OpenSSL's scrypt parameter checks (providers/implementations/kdfs/scrypt.c), which Node runs first.
function scryptParamsError(N, r, p, maxmem) {
  const memory = () => error('ERR_CRYPTO_INVALID_SCRYPT_PARAMS', 'Invalid scrypt params: error:030000AC:digital envelope routines::memory limit exceeded', RangeError);
  if (r > 0xffffffff || p > 0xffffffff) return error('ERR_CRYPTO_INVALID_SCRYPT_PARAMS', 'Invalid scrypt params: error:03000085:digital envelope routines::parameter too large', RangeError);
  if (maxmem === 0) maxmem = scryptDefaults.maxmem;
  if (r === 0 || p === 0 || N < 2 || (N & (N - 1)) !== 0) return codes.ERR_CRYPTO_INVALID_SCRYPT_PARAMS();
  const n = BigInt(N), rr = BigInt(r), pp = BigInt(p), max64 = (1n << 64n) - 1n;
  if (pp > BigInt((1 << 30) - 1) / rr) return memory();
  if (16n * rr <= 63n && n >= 1n << (16n * rr)) return memory();
  const Blen = pp * 128n * rr;
  if (Blen > 0x7fffffffn) return memory();
  if (n + 2n > (max64 / 128n) / rr) return memory();
  const Vlen = 32n * rr * (n + 2n) * 4n;
  if (Blen > max64 - Vlen || Blen + Vlen > BigInt(maxmem)) return memory();
  return undefined;
}
function scryptCheck(password, salt, keylen, options) {
  password = validate.bufferSource(password, 'password'); salt = validate.bufferSource(salt, 'salt');
  validate.int32(keylen, 'keylen', 0); keylen += 0;
  let { N, r, p, maxmem } = scryptDefaults;
  if (options && options !== scryptDefaults) {
    const hasN = options.N !== undefined;
    if (hasN) { N = options.N; validate.uint32(N, 'N'); }
    if (options.cost !== undefined) { if (hasN) throw codes.ERR_INCOMPATIBLE_OPTION_PAIR('N', 'cost'); N = options.cost; validate.uint32(N, 'cost'); }
    const hasR = options.r !== undefined;
    if (hasR) { r = options.r; validate.uint32(r, 'r'); }
    if (options.blockSize !== undefined) { if (hasR) throw codes.ERR_INCOMPATIBLE_OPTION_PAIR('r', 'blockSize'); r = options.blockSize; validate.uint32(r, 'blockSize'); }
    const hasP = options.p !== undefined;
    if (hasP) { p = options.p; validate.uint32(p, 'p'); }
    if (options.parallelization !== undefined) { if (hasP) throw codes.ERR_INCOMPATIBLE_OPTION_PAIR('p', 'parallelization'); p = options.parallelization; validate.uint32(p, 'parallelization'); }
    if (options.maxmem !== undefined) { maxmem = options.maxmem; validate.integer(maxmem, 'maxmem', 0); }
    if (N === 0) N = scryptDefaults.N; if (r === 0) r = scryptDefaults.r; if (p === 0) p = scryptDefaults.p; if (maxmem === 0) maxmem = scryptDefaults.maxmem;
  }
  const failure = scryptParamsError(N, r, p, maxmem);
  if (failure) throw failure;
  return [packed(password), packed(salt), keylen, N, r, p, maxmem];
}
function scrypt(password, salt, keylen, options, cb = scryptDefaults) {
  if (cb === scryptDefaults) { cb = options; options = scryptDefaults; }
  const args = scryptCheck(password, salt, keylen, options);
  validate.function(cb, 'callback');
  submit('scrypt', args, cb, Buffer.from);
}
function scryptSync(password, salt, keylen, options = scryptDefaults) { return Buffer.from(call('scrypt', scryptCheck(password, salt, keylen, options))); }
function byteSource(value, name) {
  if (typeof value === 'string') value = Buffer.from(value);
  if (isAnyArrayBuffer(value) || ArrayBuffer.isView(value)) return value;
  throw codes.ERR_INVALID_ARG_TYPE(name, ['string', 'ArrayBuffer', 'TypedArray', 'DataView', 'Buffer'], value);
}
function hkdfCheck(hash, key, salt, info, length) {
  validate.string(hash, 'digest');
  if (isKeyObject(key)) key = prepareSecretKey(key);
  else if (!isAnyArrayBuffer(key)) {
    if (typeof key === 'string') key = Buffer.from(key);
    if (!ArrayBuffer.isView(key)) throw codes.ERR_INVALID_ARG_TYPE('ikm', ['string', 'SecretKeyObject', 'ArrayBuffer', 'TypedArray', 'DataView', 'Buffer'], key);
  }
  salt = byteSource(salt, 'salt'); info = byteSource(info, 'info');
  validate.integer(length, 'length', 0, require('buffer').kMaxLength); length += 0;
  const infoLength = c.byteLength(info);
  if (infoLength > 1024) throw codes.ERR_OUT_OF_RANGE('info', 'must not contain more than 1024 bytes', infoLength);
  const size = digestSize(hash);
  if (size === undefined) throw codes.ERR_CRYPTO_INVALID_DIGEST(hash);
  if (length > 255 * size) throw codes.ERR_CRYPTO_INVALID_KEYLEN();
  return [hash, packed(key), packed(salt), packed(info), length];
}
function hkdfSync(hash, key, salt, info, length) { return call('hkdf', hkdfCheck(hash, key, salt, info, length)); }
function hkdf(hash, key, salt, info, length, cb) { const args = hkdfCheck(hash, key, salt, info, length); validate.function(cb, 'callback'); submit('hkdf', args, cb); }
// lib/internal/crypto/keys.js. Each KeyObject's slots live in a WeakMap, so keys carry no own
// properties. A KeyObjectHandle is internal: like Node, user code cannot construct a KeyObject.
const keySlots = new WeakMap();
const kCreatePrivate = 0, kCreatePublic = 1, kConsumePrivate = 2, kConsumePublic = 3;
const binding = require('internal/crypto/binding');
const { KeyObjectHandle } = binding;
let dep0203Warned = false, dep0204Warned = false;
function emitDEP0203() { if (dep0203Warned) return; dep0203Warned = true; process.emitWarning('Passing a CryptoKey to node:crypto functions is deprecated.', 'DeprecationWarning', 'DEP0203'); }
function isKeyObject(key) { return key !== null && typeof key === 'object' && keySlots.has(key); }
require('internal/host').types.isKeyObject = isKeyObject;
function keySlotsOf(key, expected = 'KeyObject') { const slots = key !== null && typeof key === 'object' ? keySlots.get(key) : undefined; if (slots === undefined) throw codes.ERR_INVALID_THIS(expected); return slots; }
function isCryptoKey(value) { return require('internal/host').types.isCryptoKey(value); }
function cryptoKeyObject(value) { const keys = require('internal/crypto/keys'); return keyObjectFromHandle(keys.getCryptoKeyType(value), keys.getCryptoKeyHandle(value)); }
function keyObjectFromHandle(type, handle) { return type === 'secret' ? new SecretKeyObject(handle) : type === 'public' ? new PublicKeyObject(handle) : new PrivateKeyObject(handle); }
class KeyObject {
  constructor(type, handle) {
    if (type !== 'secret' && type !== 'public' && type !== 'private') throw codes.ERR_INVALID_ARG_VALUE('type', type);
    if (typeof handle !== 'object' || !binding.isKeyObjectHandle(handle)) throw codes.ERR_INVALID_ARG_TYPE('handle', 'object', handle);
    const slots = { type, handle, secret: undefined, asymmetricKeyType: undefined, details: undefined };
    if (type === 'secret') slots.secret = binding.handleSecret(handle); else c.share(this, handle);
    keySlots.set(this, slots);
  }
  get type() { return keySlotsOf(this).type; }
  toCryptoKey(algorithm, extractable, keyUsages) {
    const slots = keySlotsOf(this);
    const webidl = require('internal/crypto/webidl'), keys = require('internal/crypto/keys');
    algorithm = require('internal/crypto/util').normalizeAlgorithm(webidl.converters.AlgorithmIdentifier(algorithm), 'importKey');
    extractable = webidl.converters.boolean(extractable);
    keyUsages = webidl.converters['sequence<KeyUsage>'](keyUsages);
    return slots.type === 'secret' ? keys.toCryptoKeySecret(slots.handle, algorithm, extractable, keyUsages) : keys.toCryptoKey(slots.handle, algorithm, extractable, keyUsages);
  }
  static from(key) {
    if (!isCryptoKey(key)) throw codes.ERR_INVALID_ARG_TYPE('key', 'CryptoKey', key);
    const keys = require('internal/crypto/keys');
    if (!keys.getCryptoKeyExtractable(key) && !dep0204Warned) { dep0204Warned = true; process.emitWarning('Passing a non-extractable CryptoKey to KeyObject.from() is deprecated.', 'DeprecationWarning', 'DEP0204'); }
    if (keys.getCryptoKeySecondaryHandle(key) !== undefined) throw codes.ERR_INVALID_ARG_VALUE('key', key, 'cannot be represented by a single KeyObject');
    return cryptoKeyObject(key);
  }
  equals(otherKeyObject) {
    if (!isKeyObject(otherKeyObject)) throw codes.ERR_INVALID_ARG_TYPE('otherKeyObject', 'KeyObject', otherKeyObject);
    return keyObjectEquals(this, otherKeyObject);
  }
}
function keyObjectEquals(left, right) {
  const a = keySlotsOf(left), b = keySlotsOf(right);
  if (a.type !== b.type) return false;
  if (a.type === 'secret') return a.secret.length === b.secret.length && timingSafeEqual(a.secret, b.secret);
  const options = { format: 'der', type: a.type === 'private' ? 'pkcs8' : 'spki' };
  const x = exportAsymmetric(left, options), y = exportAsymmetric(right, options);
  return x.length === y.length && timingSafeEqual(x, y);
}
Object.defineProperty(KeyObject.prototype, Symbol.toStringTag, { __proto__: null, configurable: true, value: 'KeyObject' });
class SecretKeyObject extends KeyObject {
  constructor(handle) { super('secret', handle); }
  get symmetricKeySize() { const slots = keySlotsOf(this, 'SecretKeyObject'); if (slots.type !== 'secret') throw codes.ERR_INVALID_THIS('SecretKeyObject'); return slots.secret.length; }
  export(options) {
    const slots = keySlotsOf(this, 'SecretKeyObject');
    if (options !== undefined) {
      validate.object(options, 'options');
      validate.oneOf(options.format, 'options.format', [undefined, 'buffer', 'jwk']);
      if (options.format === 'jwk') return { kty: 'oct', k: slots.secret.toString('base64url') };
    }
    return Buffer.from(slots.secret);
  }
}
function asymmetricKeyTypeOf(key) {
  const slots = keySlotsOf(key, 'AsymmetricKeyObject');
  if (slots.type === 'secret') throw codes.ERR_INVALID_THIS('AsymmetricKeyObject');
  if (slots.asymmetricKeyType === undefined) { const type = call('keyType', [handle(key)]).toLowerCase(); slots.asymmetricKeyType = ({ dhx: 'dh' })[type] || type; }
  return slots.asymmetricKeyType;
}
function keyParam(key, name, kind) { try { return call('keyParam', [handle(key), name, kind]); } catch { return undefined; } }
function asymmetricKeyDetailsOf(key) {
  const slots = keySlotsOf(key, 'AsymmetricKeyObject'), type = asymmetricKeyTypeOf(key);
  if (slots.details === undefined) {
    let details = {};
    if (type === 'rsa' || type === 'rsa-pss') {
      details = { modulusLength: call('keyBits', [handle(key)]), publicExponent: unsignedBig(Buffer.from(keyParam(key, 'e', 0) ?? [])) };
      if (type === 'rsa-pss') {
        // OpenSSL leaves out restriction fields that hold the RFC 8017 defaults
        // (SHA-1, MGF1 with SHA-1, salt 20); an unrestricted key has none. A
        // negative salt length makes ncrypto treat the parameters as absent.
        const digest = keyParam(key, 'digest', 1), mgf1 = keyParam(key, 'mgf1-digest', 1), saltLength = keyParam(key, 'saltlen', 2);
        if ((digest !== undefined || mgf1 !== undefined || saltLength !== undefined) && !(saltLength < 0)) {
          details.hashAlgorithm = digest === undefined ? 'sha1' : digestLongName(Buffer.from(digest).toString());
          details.mgf1HashAlgorithm = mgf1 === undefined ? 'sha1' : digestLongName(Buffer.from(mgf1).toString());
          details.saltLength = saltLength ?? 20;
        }
      }
    } else if (type === 'dsa') {
      details = { modulusLength: call('keyBits', [handle(key)]), divisorLength: call('keyQBits', [handle(key), 'q']) };
    } else if (type === 'ec') {
      const group = keyParam(key, 'group', 1);
      details = { namedCurve: group === undefined ? undefined : Buffer.from(group).toString() };
    }
    slots.details = details;
  }
  return slots.details;
}
// Node reports OBJ_nid2ln names ("sha256"); providers report "SHA2-256" style names.
function digestLongName(name) { return ({ 'SHA1': 'sha1', 'SHA2-224': 'sha224', 'SHA2-256': 'sha256', 'SHA2-384': 'sha384', 'SHA2-512': 'sha512', 'SHA2-512/224': 'sha512-224', 'SHA2-512/256': 'sha512-256', 'SHA3-224': 'sha3-224', 'SHA3-256': 'sha3-256', 'SHA3-384': 'sha3-384', 'SHA3-512': 'sha3-512', 'MD5': 'md5' })[name.toUpperCase()] ?? name.toLowerCase(); }
class AsymmetricKeyObject extends KeyObject {
  get asymmetricKeyType() { return asymmetricKeyTypeOf(this); }
  get asymmetricKeyDetails() { return { ...asymmetricKeyDetailsOf(this) }; }
}
class PublicKeyObject extends AsymmetricKeyObject {
  constructor(handle) { super('public', handle); }
  export(options) {
    keySlotsOf(this, 'PublicKeyObject');
    switch (options?.format) {
      case 'jwk': return require('internal/crypto_keys').exportJwk(this);
      case 'raw-public': return c.providerRawExport(this, options);
      default: return exportAsymmetric(this, options);
    }
  }
}
class PrivateKeyObject extends AsymmetricKeyObject {
  constructor(handle) { super('private', handle); }
  export(options) {
    keySlotsOf(this, 'PrivateKeyObject');
    if (options?.passphrase !== undefined && options.format !== 'pem' && options.format !== 'der') throw codes.ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS(options.format, 'does not support encryption');
    switch (options?.format) {
      case 'jwk': return require('internal/crypto_keys').exportJwk(this);
      case 'raw-private': case 'raw-seed': return c.providerRawExport(this, options);
      default: return exportAsymmetric(this, options);
    }
  }
}
const encodingNames = { pkcs1: 'pkcs1', pkcs8: 'pkcs8', spki: 'spki', sec1: 'sec1' };
// GetPrivateKeyEncodingFromJs: the cipher must be known (Cipher::FromNameForKeyEncoding).
function checkKeyCipher(cipher) { if (cipher != null && cipherDetails(cipher) === undefined) throw codes.ERR_CRYPTO_UNKNOWN_CIPHER(); }
function exportAsymmetric(key, options) {
  const isPrivate = keySlotsOf(key).type === 'private', keyType = asymmetricKeyTypeOf(key);
  const { format, type, cipher, passphrase } = isPrivate ? parsePrivateKeyEncoding(options, keyType) : parsePublicKeyEncoding(options, keyType);
  checkKeyCipher(cipher);
  const structure = type === 'spki' ? 'SubjectPublicKeyInfo' : type === 'pkcs8' ? 'PrivateKeyInfo' : 'type-specific';
  const traditional = format === 'pem' && cipher != null && (type === 'pkcs1' || type === 'sec1') ? 1 : 0;
  const result = call('keyExport', [handle(key), format.toUpperCase(), structure, isPrivate ? 1 : 0, cipher == null ? '' : cipher, packed(passphrase === undefined ? Buffer.alloc(0) : passphrase), traditional]);
  return format === 'pem' ? Buffer.from(result).toString() : Buffer.from(result);
}
function option(name, prefix) { return prefix === undefined ? `options.${name}` : `${prefix}.${name}`; }
function parseKeyFormat(formatStr, defaultFormat, objName) {
  if (formatStr === undefined && defaultFormat !== undefined) return defaultFormat;
  if (['pem', 'der', 'jwk', 'raw-public', 'raw-private', 'raw-seed'].includes(formatStr)) return formatStr;
  throw codes.ERR_INVALID_ARG_VALUE(option('format', objName), formatStr);
}
function parseKeyType(typeStr, required, keyType, isPublic, objName) {
  if (typeStr === undefined && !required) return undefined;
  if (typeStr === 'pkcs1') { if (keyType !== undefined && keyType !== 'rsa') throw codes.ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS(typeStr, 'can only be used for RSA keys'); return 'pkcs1'; }
  if (typeStr === 'spki' && isPublic !== false) return 'spki';
  if (typeStr === 'pkcs8' && isPublic !== true) return 'pkcs8';
  if (typeStr === 'sec1' && isPublic !== true) { if (keyType !== undefined && keyType !== 'ec') throw codes.ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS(typeStr, 'can only be used for EC keys'); return 'sec1'; }
  throw codes.ERR_INVALID_ARG_VALUE(option('type', objName), typeStr);
}
function parseKeyFormatAndType(enc, keyType, isPublic, objName) {
  const { format: formatStr, type: typeStr } = enc;
  const isInput = keyType === undefined;
  const format = parseKeyFormat(formatStr, isInput ? 'pem' : undefined, objName);
  if (format === 'raw-public') {
    if (isPublic === false) throw codes.ERR_INVALID_ARG_VALUE(option('format', objName), 'raw-public');
    if (typeStr !== undefined && typeStr !== 'uncompressed' && typeStr !== 'compressed') throw codes.ERR_INVALID_ARG_VALUE(option('type', objName), typeStr);
    return { format, type: typeStr ?? 'uncompressed' };
  }
  if (format === 'raw-private' || format === 'raw-seed') {
    if (isPublic === true) throw codes.ERR_INVALID_ARG_VALUE(option('format', objName), format);
    if (typeStr !== undefined) throw codes.ERR_INVALID_ARG_VALUE(option('type', objName), typeStr);
    return { format };
  }
  const isRequired = (!isInput || format === 'der') && format !== 'jwk';
  return { format, type: parseKeyType(typeStr, isRequired, keyType, isPublic, objName) };
}
function isStringOrBuffer(value) { return typeof value === 'string' || ArrayBuffer.isView(value) || isAnyArrayBuffer(value); }
function encodeKeyString(value, encoding) { return Buffer.from(value, encoding === 'buffer' ? 'utf8' : encoding); }
function parseKeyEncoding(enc, keyType, isPublic, objName) {
  validate.object(enc, 'options');
  const isInput = keyType === undefined;
  const { format, type } = parseKeyFormatAndType(enc, keyType, isPublic, objName);
  let cipher, passphrase, encoding;
  if (isPublic !== true) {
    ({ cipher, passphrase, encoding } = enc);
    if (format === 'raw-private' || format === 'raw-seed') {
      if (cipher != null || passphrase !== undefined) throw codes.ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS('raw format', 'does not support encryption');
      return { format, type };
    }
    if (!isInput) {
      if (cipher != null) {
        if (typeof cipher !== 'string') throw codes.ERR_INVALID_ARG_VALUE(option('cipher', objName), cipher);
        if (format === 'der' && (type === 'pkcs1' || type === 'sec1')) throw codes.ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS(encodingNames[type], 'does not support encryption');
      } else if (passphrase !== undefined) {
        throw codes.ERR_INVALID_ARG_VALUE(option('cipher', objName), cipher, 'is required when a passphrase is specified');
      }
    }
    if ((isInput && passphrase !== undefined && !isStringOrBuffer(passphrase)) || (!isInput && cipher != null && !isStringOrBuffer(passphrase)))
      throw codes.ERR_INVALID_ARG_VALUE(option('passphrase', objName), passphrase);
  }
  if (typeof passphrase === 'string') passphrase = encodeKeyString(passphrase, encoding);
  return { format, type, cipher, passphrase };
}
function parsePublicKeyEncoding(enc, keyType, objName) { return parseKeyEncoding(enc, keyType, keyType ? true : undefined, objName); }
function parsePrivateKeyEncoding(enc, keyType, objName) { return parseKeyEncoding(enc, keyType, false, objName); }
function keyTypes(allowKeyObject, allowURL = false) { return ['ArrayBuffer', 'Buffer', 'TypedArray', 'DataView', 'string', ...(allowKeyObject ? ['KeyObject', 'CryptoKey'] : []), ...(allowURL ? ['URL'] : [])]; }
function validateAsymmetricKeyType(type, ctx, key) {
  if (ctx === kCreatePrivate) throw codes.ERR_INVALID_ARG_TYPE('key', keyTypes(false, true), key);
  if (type !== 'private') {
    if (ctx === kConsumePrivate || ctx === kCreatePublic) throw codes.ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE(type, 'private');
    if (type !== 'public') throw codes.ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE(type, 'private or public');
  }
}
function prepareAsymmetricKey(key, ctx, name = 'key') {
  if (typeof key === 'string') return { format: 'pem', data: encodeKeyString(key) };
  if (ArrayBuffer.isView(key)) return { format: 'pem', data: key };
  const isPrivateKeyInput = ctx === kConsumePrivate || ctx === kCreatePrivate;
  if (isKeyObject(key)) { const slots = keySlotsOf(key); validateAsymmetricKeyType(slots.type, ctx, key); return { data: slots.handle, keyObject: key }; }
  if (isCryptoKey(key)) { emitDEP0203(); const object = cryptoKeyObject(key), slots = keySlotsOf(object); validateAsymmetricKeyType(slots.type, ctx, key); return { data: slots.handle, keyObject: object }; }
  // A private key referenced by a URI for an OpenSSL STORE loader.
  if (isPrivateKeyInput && webURL().isURLInstance(key)) return prepareStorePrivateKey(key, name);
  if (isAnyArrayBuffer(key)) return { format: 'pem', data: key };
  if (typeof key === 'object' && key !== null) return prepareAsymmetricKeyOptions(key, ctx, name, isPrivateKeyInput);
  throw codes.ERR_INVALID_ARG_TYPE(name, keyTypes(ctx !== kCreatePrivate, isPrivateKeyInput), key);
}
function prepareAsymmetricKeyOptions(key, ctx, name, isPrivateKeyInput) {
  const { key: data, encoding, format, properties } = key;
  let isData = typeof data === 'string' || ArrayBuffer.isView(data);
  if (!isData && isKeyObject(data)) { const slots = keySlotsOf(data); validateAsymmetricKeyType(slots.type, ctx, data); return { data: slots.handle, keyObject: data }; }
  if (!isData && isCryptoKey(data)) { emitDEP0203(); const object = cryptoKeyObject(data), slots = keySlotsOf(object); validateAsymmetricKeyType(slots.type, ctx, data); return { data: slots.handle, keyObject: object }; }
  isData ||= isAnyArrayBuffer(data);
  // A STORE URI, with an optional passphrase or PIN.
  if (!isData && isPrivateKeyInput && webURL().isURLInstance(data)) return prepareStorePrivateKey(data, name, key.passphrase, encoding, properties);
  if (format === 'jwk') { validate.object(data, `${name}.key`); return { data, format: 'jwk' }; }
  if (format === 'raw-public' || format === 'raw-private' || format === 'raw-seed') {
    if (isPrivateKeyInput && format === 'raw-public') throw codes.ERR_INVALID_ARG_VALUE(`${name}.format`, format);
    if (!isData || typeof data === 'string') throw codes.ERR_INVALID_ARG_TYPE(`${name}.key`, ['ArrayBuffer', 'Buffer', 'TypedArray', 'DataView'], data);
    validate.string(key.asymmetricKeyType, `${name}.asymmetricKeyType`);
    if (key.asymmetricKeyType === 'ec') validate.string(key.namedCurve, `${name}.namedCurve`);
    return { data, format, type: key.asymmetricKeyType, namedCurve: key.namedCurve ?? null };
  }
  if (!isData) throw codes.ERR_INVALID_ARG_TYPE(`${name}.key`, keyTypes(ctx !== kCreatePrivate, isPrivateKeyInput), data);
  const keyData = typeof data === 'string' ? encodeKeyString(data, encoding) : data;
  const parsed = parseKeyEncoding(key, undefined, isPrivateKeyInput ? false : undefined, name);
  return { data: keyData, format: parsed.format, type: parsed.type, passphrase: parsed.passphrase };
}
function webURL() { return require('internal/url'); }
// lib/internal/crypto/keys.js prepareStorePrivateKey: the URI comes from the
// URL's private state, file: URLs become paths, and NUL bytes are refused
// because OpenSSL reads both strings as C strings.
function prepareStorePrivateKey(url, name, passphrase, encoding, properties) {
  let uri = webURL().getURLHref(url);
  if (uri.startsWith('file:')) uri = webURL().fileURLToPath(uri);
  validate.string(uri, name);
  if (uri.includes('\u0000')) throw codes.ERR_INVALID_ARG_VALUE(name, url, 'must be a URL without null bytes');
  if (passphrase !== undefined) {
    if (!isStringOrBuffer(passphrase)) throw codes.ERR_INVALID_ARG_VALUE(option('passphrase', name), passphrase);
    if (typeof passphrase === 'string') passphrase = encodeKeyString(passphrase, encoding);
  }
  if (properties !== undefined) {
    validate.string(properties, option('properties', name));
    if (properties.includes('\u0000')) throw codes.ERR_INVALID_ARG_VALUE(option('properties', name), properties, 'must be a string without null bytes');
  }
  return { format: 'store', data: { uri, properties: properties ?? null }, passphrase };
}
// The passphrase block the native STORE callback reads: has a passphrase,
// asked without one, length (u32 LE), bytes.
function storePassphraseBlock(passphrase) {
  const bytes = passphrase === undefined ? Buffer.alloc(0) : c.bytes(passphrase);
  const block = Buffer.alloc(6 + bytes.length);
  block[0] = passphrase === undefined ? 0 : 1;
  block.writeUInt32LE(bytes.length, 2);
  bytes.copy(block, 6);
  return block;
}
function newKeyObject(type, value) { return keyObjectFromHandle(type, binding.createHandle(type, value)); }
// Turns prepared key input into a KeyObject of the given type.
function keyFromPrepared(prepared, type) {
  if (prepared.keyObject !== undefined) {
    const object = prepared.keyObject;
    if (type === 'public' && keySlotsOf(object).type === 'private') return newKeyObject('public', call('keyPublic', [handle(object)]));
    return object;
  }
  if (prepared.format === 'jwk') return require('internal/crypto_keys').importJwk(prepared.data, type);
  if (prepared.format === 'store') {
    // Node checks openssl.store (resource '') before it opens any OSSL_STORE URI, file: included.
    if (require('internal/host').builtinLoaded('internal/permission')) require('internal/permission').check('openssl.store', '');
    const { uri, properties } = prepared.data;
    return newKeyObject('private', call('storeLoad', [uri, properties ?? '', packed(storePassphraseBlock(prepared.passphrase)), 0]));
  }
  if (prepared.format === 'raw-public' || prepared.format === 'raw-private' || prepared.format === 'raw-seed') return c.providerRawImport({ key: prepared.data, format: prepared.format, asymmetricKeyType: prepared.type, namedCurve: prepared.namedCurve ?? undefined }, type);
  const { format, passphrase } = prepared;
  let data = bytes(prepared.data);
  // PEM_read_bio_PrivateKey and friends skip blocks that hold no key, such
  // as the EC PARAMETERS block `openssl ecparam -genkey` writes first.
  if (format === 'pem') data = skipPemParameters(data);
  const [structure, keyType] = keyStructure(format, prepared.type, data);
  let importFormat = format.toUpperCase(), rsaPublicKey = 0;
  if (type === 'public' && keyType === 'RSA') {
    // Node reads a public PKCS#1 key with d2i_RSAPublicKey (PEM: the first
    // RSA PUBLIC KEY block, PEM_read_bio_RSAPublicKey).
    rsaPublicKey = 1;
    if (format === 'pem') { data = pemBlock(data, 'RSA PUBLIC KEY'); importFormat = 'DER'; }
  }
  let id;
  try { id = call('keyImport', [packed(data), importFormat, type === 'private' ? 1 : 0, packed(passphrase === undefined ? Buffer.alloc(0) : passphrase), passphrase === undefined ? 0 : 1, structure, keyType, rsaPublicKey]); }
  catch (e) { if (e.code === 'ERR_MISSING_PASSPHRASE') throw codes.ERR_MISSING_PASSPHRASE(); throw e; }
  return newKeyObject(type, id);
}
// Node parses each named encoding with its own reader (d2i_RSAPublicKey,
// d2i_PUBKEY, d2i_ECPrivateKey, PEM labels), so other structures are refused.
const kDerStructures = { pkcs1: ['type-specific', 'RSA'], spki: ['SubjectPublicKeyInfo', ''], sec1: ['type-specific', 'EC'] };
const kPemStructures = { 'RSA PUBLIC KEY': ['type-specific', 'RSA'], 'PUBLIC KEY': ['SubjectPublicKeyInfo', ''] };
function keyStructure(format, type, data) {
  if (format === 'der') return kDerStructures[type] ?? ['', ''];
  const label = /-----BEGIN ([A-Z0-9 ]+)-----/.exec(data.toString('latin1'));
  return (label && kPemStructures[label[1]]) ?? ['', ''];
}
function pemBlock(data, label) {
  const block = new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`).exec(data.toString('latin1'));
  return block ? Buffer.from(block[1].replace(/\s+/g, ''), 'base64') : Buffer.alloc(0);
}
function skipPemParameters(data) {
  const text = data.toString('latin1');
  const block = /^\s*-----BEGIN ([A-Z0-9 ]*PARAMETERS)-----[\s\S]*?-----END \1-----/.exec(text);
  return block && text.slice(block[0].length).includes('-----BEGIN ') ? skipPemParameters(data.subarray(block[0].length)) : data;
}
function importDer(data, type) { return newKeyObject(type, call('keyImport', [packed(data), 'DER', type === 'private' ? 1 : 0, packed(Buffer.alloc(0)), 0])); }
// lib/internal/crypto/keys.js prepareSecretKey: the secret's bytes.
function prepareSecretKey(key, encoding, bufferOnly = false) {
  if (!bufferOnly) {
    let object = isKeyObject(key) ? key : undefined;
    if (object === undefined && isCryptoKey(key)) { emitDEP0203(); object = cryptoKeyObject(key); }
    if (object !== undefined) { const slots = keySlotsOf(object); if (slots.type !== 'secret') throw codes.ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE(slots.type, 'secret'); return slots.secret; }
  }
  if (typeof key !== 'string' && !ArrayBuffer.isView(key) && !isAnyArrayBuffer(key))
    throw codes.ERR_INVALID_ARG_TYPE('key', ['ArrayBuffer', 'Buffer', 'TypedArray', 'DataView', ...(bufferOnly ? [] : ['string', 'KeyObject', 'CryptoKey'])], key);
  return validate.bufferSource(key, 'key', encoding);
}
function createSecretKey(key, encoding) { key = prepareSecretKey(key, encoding, true); return newKeyObject('secret', bytes(key)); }
function createPublicKey(key) { return keyFromPrepared(prepareAsymmetricKey(key, kCreatePublic), 'public'); }
function createPrivateKey(key) { return keyFromPrepared(prepareAsymmetricKey(key, kCreatePrivate), 'private'); }
// Key input for operations: a KeyObject (owned when it was created here) of a public or private key.
// `before` runs between input validation and key import, like the JS checks
// Node performs before handing the key data to C++.
// `anyType` imports key data as public or private whatever the context, like
// GetPublicOrPrivateKeyFromJs in the RSA cipher operations.
function preparedKeyObject(key, ctx, name, before, anyType = false) {
  const prepared = prepareAsymmetricKey(key, ctx, name);
  if (before !== undefined) before();
  if (prepared.keyObject !== undefined) return { key: prepared.keyObject, owned: false };
  if (prepared.format === 'store' || ctx === kConsumePrivate && !anyType) return { key: keyFromPrepared(prepared, 'private'), owned: true };
  if (anyType) { try { return { key: keyFromPrepared(prepared, 'private'), owned: true }; } catch (e) { try { return { key: keyFromPrepared(prepared, 'public'), owned: true }; } catch { throw e; } } }
  try { return { key: keyFromPrepared(prepared, 'public'), owned: true }; } catch (e) { try { return { key: keyFromPrepared(prepared, 'private'), owned: true }; } catch { throw e; } }
}
// lib/internal/crypto/keygen.js createJob, with the checks of the C++ key
// generation configs (crypto_rsa.cc, crypto_dsa.cc, crypto_ec.cc, crypto_dh.cc).
const kNamedKeyPairs = { __proto__: null, ed25519: 'ED25519', ed448: 'ED448', x25519: 'X25519', x448: 'X448', 'ml-kem-512': 'ML-KEM-512', 'ml-kem-768': 'ML-KEM-768', 'ml-kem-1024': 'ML-KEM-1024', 'ml-dsa-44': 'ML-DSA-44', 'ml-dsa-65': 'ML-DSA-65', 'ml-dsa-87': 'ML-DSA-87' };
for (const hash of ['SHA2', 'SHAKE']) for (const size of ['128', '192', '256']) for (const kind of ['s', 'f']) { const name = `SLH-DSA-${hash}-${size}${kind}`; kNamedKeyPairs[name.toLowerCase()] = name; }
const kNistCurves = ['B-163', 'B-233', 'B-283', 'B-409', 'B-571', 'K-163', 'K-233', 'K-283', 'K-409', 'K-571', 'P-192', 'P-224', 'P-256', 'P-384', 'P-521'];
function keygenEncoding(type, options) {
  const { publicKeyEncoding, privateKeyEncoding } = options ?? {};
  const result = {};
  if (publicKeyEncoding != null) {
    if (typeof publicKeyEncoding !== 'object') throw codes.ERR_INVALID_ARG_VALUE('options.publicKeyEncoding', publicKeyEncoding);
    parsePublicKeyEncoding(publicKeyEncoding, type, 'options.publicKeyEncoding'); result.publicKeyEncoding = publicKeyEncoding;
  }
  if (privateKeyEncoding != null) {
    if (typeof privateKeyEncoding !== 'object') throw codes.ERR_INVALID_ARG_VALUE('options.privateKeyEncoding', privateKeyEncoding);
    checkKeyCipher(parsePrivateKeyEncoding(privateKeyEncoding, type, 'options.privateKeyEncoding').cipher); result.privateKeyEncoding = privateKeyEncoding;
  }
  return result;
}
function keygenDigest(value, message) { if (value === undefined) return ''; if (digestSize(value) === undefined) throw error('ERR_CRYPTO_INVALID_DIGEST', `${message}: ${value}`, TypeError); return value; }
function keygenArgs(type, options) {
  validate.string(type, 'type');
  if (options !== undefined) validate.object(options, 'options');
  switch (type) {
    case 'rsa': case 'rsa-pss': {
      validate.object(options, 'options');
      let { modulusLength, publicExponent } = options;
      validate.uint32(modulusLength, 'options.modulusLength'); modulusLength += 0;
      if (publicExponent == null) publicExponent = 0x10001; else { validate.uint32(publicExponent, 'options.publicExponent'); publicExponent += 0; }
      const exponent = Buffer.alloc(4); exponent.writeUInt32BE(publicExponent);
      if (type === 'rsa') return ['RSA', modulusLength, '', packed(exponent), '', '', -1];
      const { hash, mgf1Hash, hashAlgorithm, mgf1HashAlgorithm } = options;
      let { saltLength } = options;
      if (saltLength !== undefined) { validate.int32(saltLength, 'options.saltLength', 0); saltLength += 0; }
      if (hashAlgorithm !== undefined) validate.string(hashAlgorithm, 'options.hashAlgorithm');
      if (mgf1HashAlgorithm !== undefined) validate.string(mgf1HashAlgorithm, 'options.mgf1HashAlgorithm');
      if (hash !== undefined) {
        process.emitWarning('"options.hash" is deprecated, use "options.hashAlgorithm" instead.', 'DeprecationWarning', 'DEP0154');
        validate.string(hash, 'options.hash');
        if (hashAlgorithm && hash !== hashAlgorithm) throw codes.ERR_INVALID_ARG_VALUE('options.hash', hash);
      }
      if (mgf1Hash !== undefined) {
        process.emitWarning('"options.mgf1Hash" is deprecated, use "options.mgf1HashAlgorithm" instead.', 'DeprecationWarning', 'DEP0154');
        validate.string(mgf1Hash, 'options.mgf1Hash');
        if (mgf1HashAlgorithm && mgf1Hash !== mgf1HashAlgorithm) throw codes.ERR_INVALID_ARG_VALUE('options.mgf1Hash', mgf1Hash);
      }
      // RFC 8017 9.1: without an MGF1 digest, MGF1 uses the message digest (ncrypto RSA-PSS keygen).
      const digest = keygenDigest(hashAlgorithm || hash, 'Invalid digest'), mgf1 = keygenDigest(mgf1HashAlgorithm || mgf1Hash, 'Invalid MGF1 digest');
      return ['RSA-PSS', modulusLength, '', packed(exponent), digest, mgf1 || digest, saltLength ?? (digest ? digestSize(digest) : -1)];
    }
    case 'dsa': {
      validate.object(options, 'options');
      let { modulusLength, divisorLength } = options;
      validate.uint32(modulusLength, 'options.modulusLength'); modulusLength += 0;
      if (divisorLength == null) divisorLength = -1; else { validate.int32(divisorLength, 'options.divisorLength', 0); divisorLength += 0; }
      return ['DSA', modulusLength, '', packed(Buffer.alloc(0)), '', '', divisorLength, 1];
    }
    case 'ec': {
      validate.object(options, 'options');
      const { namedCurve, paramEncoding } = options;
      validate.string(namedCurve, 'options.namedCurve');
      let explicit = false;
      if (paramEncoding == null || paramEncoding === 'named') explicit = false;
      else if (paramEncoding === 'explicit') explicit = true;
      else throw codes.ERR_INVALID_ARG_VALUE('options.paramEncoding', paramEncoding);
      if (!kNistCurves.includes(namedCurve) && !names('curves').includes(namedCurve)) throw codes.ERR_CRYPTO_INVALID_CURVE();
      return ['EC', -1, namedCurve, packed(Buffer.alloc(0)), '', '', -1, explicit ? 3 : 4];
    }
    case 'dh': {
      validate.object(options, 'options');
      const { group } = options; let { prime, primeLength, generator } = options;
      if (group != null) {
        if (prime != null) throw codes.ERR_INCOMPATIBLE_OPTION_PAIR('group', 'prime');
        if (primeLength != null) throw codes.ERR_INCOMPATIBLE_OPTION_PAIR('group', 'primeLength');
        if (generator != null) throw codes.ERR_INCOMPATIBLE_OPTION_PAIR('group', 'generator');
        validate.string(group, 'options.group');
        // DHPointer::FindGroup matches names without regard to case.
        const known = DiffieHellmanGroup(group.toLowerCase());
        try { prime = known.getPrime(); } finally { release(known); }
        primeLength = undefined; generator = 2;
      } else if (prime != null) {
        if (primeLength != null) throw codes.ERR_INCOMPATIBLE_OPTION_PAIR('prime', 'primeLength');
        validate.buffer(prime, 'options.prime');
      } else if (primeLength != null) {
        validate.int32(primeLength, 'options.primeLength', 0); primeLength += 0;
      } else throw codes.ERR_MISSING_OPTION('At least one of the group, prime, or primeLength options');
      if (generator != null) { validate.int32(generator, 'options.generator', 0); generator += 0; } else generator = 2;
      const g = Buffer.alloc(4); g.writeUInt32BE(generator);
      return ['DH', prime == null ? primeLength : 0, '', packed(g), prime == null ? undefined : packed(prime), '', generator, 2];
    }
    default:
      if (kNamedKeyPairs[type] === undefined) throw codes.ERR_INVALID_ARG_VALUE('type', type, 'must be a supported key type');
      return [kNamedKeyPairs[type], -1, '', packed(Buffer.alloc(0)), '', '', -1];
  }
}
function keypair(id, encoding) { const privateKey = newKeyObject('private', id); let publicKey; try { publicKey = createPublicKey(privateKey); const result = { publicKey: encoding.publicKeyEncoding ? publicKey.export(encoding.publicKeyEncoding) : publicKey, privateKey: encoding.privateKeyEncoding ? privateKey.export(encoding.privateKeyEncoding) : privateKey }; if (encoding.publicKeyEncoding) release(publicKey); if (encoding.privateKeyEncoding) release(privateKey); return result; } catch (e) { release(privateKey); if (publicKey) release(publicKey); throw e; } }
function keygenJob(type, options) {
  validate.string(type, 'type');
  if (options !== undefined) validate.object(options, 'options');
  const encoding = keygenEncoding(type, options);
  return { args: keygenArgs(type, options), encoding };
}
function generateKeyPairSync(type, options) { const job = keygenJob(type, options); return keypair(call('keyGenerate', job.args), job.encoding); }
function generateKeyPair(type, options, cb) {
  if (typeof options === 'function') { cb = options; options = undefined; }
  validate.function(cb, 'callback');
  const job = keygenJob(type, options);
  submit('keyGenerate', job.args, (e, pair) => e ? cb(e) : cb(null, pair.publicKey, pair.privateKey), id => keypair(id, job.encoding));
}
Object.defineProperty(generateKeyPair, require('internal/util').customPromisifyArgs, { value: ['publicKey', 'privateKey'], enumerable: false });
function secretKeygenLength(type, options) {
  validate.string(type, 'type'); validate.object(options, 'options');
  const { length } = options;
  if (type === 'hmac') validate.integer(length, 'options.length', 8, 2 ** 31 - 1);
  else if (type === 'aes') validate.oneOf(length, 'options.length', [128, 192, 256]);
  else throw codes.ERR_INVALID_ARG_VALUE('type', type, 'must be a supported key type');
  return Math.floor(length / 8);
}
function generateKeySync(type, options) { return createSecretKey(randomBytes(secretKeygenLength(type, options))); }
function generateKey(type, options, cb) {
  if (typeof options === 'function') { cb = options; options = undefined; }
  validate.function(cb, 'callback');
  const length = secretKeygenLength(type, options);
  randomBytes(length, (e, b) => e ? cb(e) : cb(null, createSecretKey(b)));
}
// lib/internal/crypto/sig.js, with the checks of src/crypto/crypto_sig.cc.
const kSigOptionsDefault = {};
function signatureKeyOptions(value) { return value !== null && typeof value === 'object' && !isKeyObject(value) && !isCryptoKey(value) && !ArrayBuffer.isView(value) && !isAnyArrayBuffer(value) ? value : kSigOptionsDefault; }
function getIntOption(name, options) {
  const value = options[name];
  if (value !== undefined) { if (value === value >> 0) return value; throw codes.ERR_INVALID_ARG_VALUE(`options.${name}`, value); }
  return undefined;
}
function getSaltLength(options) {
  let saltLength = getIntOption('saltLength', options);
  if (options.padding === constants.RSA_PKCS1_PSS_PADDING && saltLength === undefined) saltLength = constants.RSA_PSS_SALTLEN_MAX_SIGN;
  return saltLength;
}
function getDSASignatureEncoding(options) {
  if (typeof options === 'object') {
    const { dsaEncoding = 'der' } = options;
    if (dsaEncoding === 'der' || dsaEncoding === 'ieee-p1363') return dsaEncoding;
    throw codes.ERR_INVALID_ARG_VALUE('options.dsaEncoding', dsaEncoding);
  }
  return 'der';
}
function getContext(options) {
  if (options?.context === undefined) return undefined;
  if (!ArrayBuffer.isView(options.context)) throw codes.ERR_INVALID_ARG_TYPE('options.context', ['Buffer', 'TypedArray', 'DataView'], options.context);
  return options.context;
}
function signatureOptions(key) {
  const options = signatureKeyOptions(key);
  return { padding: getIntOption('padding', options), saltLength: getSaltLength(options), dsaEncoding: getDSASignatureEncoding(key), context: getContext(options) };
}
function signatureArgs(algorithm, data, key, options, signature) {
  if (options.context !== undefined && options.context.byteLength > 255) throw codes.ERR_OUT_OF_RANGE_MESSAGE('context string must be at most 255 bytes');
  // EVPKeyPointer::supportsContextString: only the one-shot EdDSA, ML-DSA and
  // SLH-DSA signatures take a context string.
  if (options.context?.byteLength && !/^(?:ed25519|ed448|ml-dsa-|slh-dsa-)/.test(asymmetricKeyTypeOf(key))) {
    throw codes.ERR_CRYPTO_OPERATION_FAILED('Context parameter is unsupported');
  }
  // Streams follow Node_SignFinal: RSA options apply only to RSA keys.
  const rsa = !options.stream || /^rsa/.test(asymmetricKeyTypeOf(key));
  return [handle(key), algorithm ?? '', packed(data), signature === undefined ? undefined : packed(signature), rsa ? options.padding ?? 0 : 0, rsa ? options.saltLength ?? -2147483648 : -2147483648, options.context === undefined ? undefined : packed(options.context), options.stream ? 1 : 0];
}
function dsaSize(key) {
  const type = asymmetricKeyTypeOf(key); if (type !== 'ec' && type !== 'dsa') return 0;
  return Math.ceil((type === 'dsa' ? call('keyQBits', [handle(key), 'q']) : call('keyBits', [handle(key)])) / 8);
}
function signatureToP1363(signature, key, options) {
  if (options.dsaEncoding !== 'ieee-p1363') return signature;
  const size = dsaSize(key); return size ? require('internal/crypto_keys').signature(signature, size, false) : signature;
}
function signatureFromP1363(signature, key, options) {
  if (options.dsaEncoding !== 'ieee-p1363') return signature;
  const size = dsaSize(key); if (!size) return signature;
  // A P1363 signature of the wrong length cannot verify; Node's ConvertSignatureToDER fails it the same way.
  if (signature.byteLength !== size * 2) return undefined;
  return require('internal/crypto_keys').signature(signature, size, true);
}
function signFailure(e) { if (e.library !== undefined || e.code !== 'ERR_OSSL_CRYPTO_OPERATION_FAILED' && e.code !== 'ERR_CRYPTO_OPERATION_FAILED') return e; return codes.ERR_CRYPTO_OPERATION_FAILED('EVP_SignInit_ex failed'); }
function sign(algorithm, data, key, cb) {
  if (algorithm != null) validate.string(algorithm, 'algorithm');
  if (cb !== undefined) validate.function(cb, 'callback');
  data = validate.bufferSource(data, 'data');
  if (!key) throw codes.ERR_CRYPTO_SIGN_KEY_REQUIRED();
  const options = signatureOptions(key);
  const info = preparedKeyObject(key, kConsumePrivate, 'key');
  let submitted = false;
  try {
    if (algorithm != null && digestSize(algorithm) === undefined) throw codes.ERR_CRYPTO_INVALID_DIGEST(algorithm);
    const args = signatureArgs(algorithm, data, info.key, options);
    if (cb !== undefined) {
      submit('sign', args, (e, result) => {
        let converted;
        try { if (!e) converted = signatureToP1363(Buffer.from(result), info.key, options); } catch (failure) { e = failure; }
        finally { if (info.owned) release(info.key); }
        if (e) cb(signFailure(e)); else cb(null, converted);
      });
      submitted = true; return;
    }
    let result; try { result = call('sign', args); } catch (e) { throw signFailure(e); }
    return signatureToP1363(Buffer.from(result), info.key, options);
  } finally { if (!submitted && info.owned) release(info.key); }
}
function verify(algorithm, data, key, signature, cb) {
  if (algorithm != null) validate.string(algorithm, 'algorithm');
  if (cb !== undefined) validate.function(cb, 'callback');
  data = validate.bufferSource(data, 'data');
  const options = signatureOptions(key);
  signature = validate.bufferSource(signature, 'signature');
  const info = preparedKeyObject(key, kConsumePublic, 'key');
  let submitted = false;
  try {
    if (algorithm != null && digestSize(algorithm) === undefined) throw codes.ERR_CRYPTO_INVALID_DIGEST(algorithm);
    const der = signatureFromP1363(signature, info.key, options);
    if (der === undefined) { if (cb !== undefined) { process.nextTick(cb, null, false); return; } return false; }
    const args = signatureArgs(algorithm, data, info.key, options, der);
    if (cb !== undefined) { submit('verify', args, (e, result) => { if (info.owned) release(info.key); if (e) cb(signFailure(e)); else cb(null, !!result); }); submitted = true; return; }
    try { return !!call('verify', args); } catch (e) { throw signFailure(e); }
  } finally { if (!submitted && info.owned) release(info.key); }
}
const kSignState = Symbol('kSignState');
function signUpdate(data, encoding) {
  if (typeof data === 'string') validate.encoding(data, encoding);
  else if (!ArrayBuffer.isView(data)) throw codes.ERR_INVALID_ARG_TYPE('data', ['string', 'Buffer', 'TypedArray', 'DataView'], data);
  const state = this[kSignState];
  if (state.done) throw codes.ERR_CRYPTO_INVALID_STATE_MESSAGE('Not initialised');
  state.chunks.push(typeof data === 'string' ? Buffer.from(data, encoding) : Buffer.from(data.buffer, data.byteOffset, data.byteLength).slice());
  return this;
}
function Sign(algorithm, options) {
  if (!(this instanceof Sign)) return new Sign(algorithm, options);
  validate.string(algorithm, 'algorithm');
  if (digestSize(algorithm) === undefined) throw codes.ERR_CRYPTO_INVALID_DIGEST_DEFAULT();
  this[kSignState] = { algorithm, chunks: [], done: false };
  Reflect.apply(Writable, this, [options]);
}
Object.setPrototypeOf(Sign.prototype, Writable.prototype);
Object.setPrototypeOf(Sign, Writable);
Sign.prototype._write = function _write(chunk, encoding, callback) { this.update(chunk, encoding); callback(); };
Sign.prototype.update = signUpdate;
function finishSignState(object) {
  const state = object[kSignState];
  if (state.done) throw codes.ERR_CRYPTO_INVALID_STATE_MESSAGE('Not initialised');
  state.done = true; const data = Buffer.concat(state.chunks); state.chunks = [];
  return { algorithm: state.algorithm, data };
}
function oneShotKeyType(key) { const type = asymmetricKeyTypeOf(key); return type === 'ed25519' || type === 'ed448' || type.startsWith('ml-dsa') || type.startsWith('slh-dsa'); }
Sign.prototype.sign = function sign(privateKey, encoding) {
  if (!privateKey) throw codes.ERR_CRYPTO_SIGN_KEY_REQUIRED();
  let options; const info = preparedKeyObject(privateKey, kConsumePrivate, 'privateKey', () => { options = signatureOptions(privateKey); });
  try {
    if (oneShotKeyType(info.key)) throw codes.ERR_CRYPTO_UNSUPPORTED_OPERATION_DEFAULT();
    const { algorithm, data } = finishSignState(this);
    let result; try { result = call('sign', signatureArgs(algorithm, data, info.key, { ...options, context: undefined, stream: true })); } catch (e) { throw signFailure(e); }
    result = signatureToP1363(Buffer.from(result), info.key, options);
    return encoding && encoding !== 'buffer' ? result.toString(encoding) : result;
  } finally { if (info.owned) release(info.key); }
};
function Verify(algorithm, options) {
  if (!(this instanceof Verify)) return new Verify(algorithm, options);
  validate.string(algorithm, 'algorithm');
  if (digestSize(algorithm) === undefined) throw codes.ERR_CRYPTO_INVALID_DIGEST_DEFAULT();
  this[kSignState] = { algorithm, chunks: [], done: false };
  Reflect.apply(Writable, this, [options]);
}
Object.setPrototypeOf(Verify.prototype, Writable.prototype);
Object.setPrototypeOf(Verify, Writable);
Verify.prototype._write = Sign.prototype._write;
Verify.prototype.update = Sign.prototype.update;
Verify.prototype.verify = function verify(key, signature, sigEncoding) {
  let options; const info = preparedKeyObject(key, kConsumePublic, 'key', () => { options = signatureOptions(key); signature = validate.bufferSource(signature, 'signature', sigEncoding); });
  try {
    if (oneShotKeyType(info.key)) throw codes.ERR_CRYPTO_UNSUPPORTED_OPERATION_DEFAULT();
    const { algorithm, data } = finishSignState(this);
    const der = signatureFromP1363(signature, info.key, options);
    if (der === undefined) return false;
    try { return !!call('verify', signatureArgs(algorithm, data, info.key, { ...options, context: undefined, stream: true }, der)); } catch (e) { throw signFailure(e); }
  } finally { if (info.owned) release(info.key); }
};
function createSign(algorithm, options) { return new Sign(algorithm, options); }
function createVerify(algorithm, options) { return new Verify(algorithm, options); }
const dhEnabledKeyTypes = new Set(['dh', 'ec', 'x448', 'x25519']);
function diffieHellman(options, cb) {
  validate.object(options, 'options');
  if (cb !== undefined) validate.function(cb, 'callback');
  const { privateKey, publicKey } = options;
  if (privateKey === undefined) throw codes.ERR_INVALID_ARG_VALUE('options.privateKey', privateKey);
  if (publicKey === undefined) throw codes.ERR_INVALID_ARG_VALUE('options.publicKey', publicKey);
  if (isKeyObject(privateKey) && keySlotsOf(privateKey).type === 'private' && isKeyObject(publicKey) && keySlotsOf(publicKey).type !== 'secret') {
    const privateType = asymmetricKeyTypeOf(privateKey), publicType = asymmetricKeyTypeOf(publicKey);
    if (privateType !== publicType || !dhEnabledKeyTypes.has(privateType)) throw codes.ERR_CRYPTO_INCOMPATIBLE_KEY('key types for Diffie-Hellman', `${privateType} and ${publicType}`);
  }
  const pub = preparedKeyObject(publicKey, kConsumePublic, 'options.publicKey');
  let priv;
  try { priv = preparedKeyObject(privateKey, kConsumePrivate, 'options.privateKey'); } catch (e) { if (pub.owned) release(pub.key); throw e; }
  const args = [handle(priv.key), handle(pub.key)];
  const done = () => { if (pub.owned) release(pub.key); if (priv.owned) release(priv.key); };
  if (cb !== undefined) { submit('derive', args, (e, secret) => { done(); cb(e, secret); }, Buffer.from); return; }
  try { return Buffer.from(call('derive', args)); } finally { done(); }
}
// lib/internal/crypto/cipher.js rsaFunctionFor.
function rsaFunctionFor(operation, defaultPadding, keyType) {
  return function(options, buffer) {
    let padding, oaepHash, mgf1Hash, oaepLabel;
    const info = preparedKeyObject(options, keyType === 'private' ? kConsumePrivate : kConsumePublic, 'key', () => {
      padding = options.padding || defaultPadding;
      const { encoding } = options; ({ oaepHash, mgf1Hash, oaepLabel } = options);
      if (oaepHash !== undefined) validate.string(oaepHash, 'key.oaepHash');
      if (mgf1Hash !== undefined) validate.string(mgf1Hash, 'key.mgf1Hash');
      if (oaepLabel !== undefined) oaepLabel = validate.bufferSource(oaepLabel, 'key.oaepLabel', encoding);
      buffer = validate.bufferSource(buffer, 'buffer', encoding);
    }, true);
    try {
      // PublicKeyCipher::Cipher looks the OAEP digest up after parsing the key.
      if (oaepHash !== undefined && digestSize(oaepHash) === undefined) throw error('ERR_OSSL_EVP_INVALID_DIGEST', 'Invalid digest used');
      if (oaepLabel !== undefined && oaepLabel.byteLength > 0x7fffffff) throw codes.ERR_OUT_OF_RANGE_MESSAGE('oaepLabel is too big');
      if (mgf1Hash !== undefined && digestSize(mgf1Hash) === undefined) throw error('ERR_OSSL_EVP_INVALID_DIGEST', 'Invalid digest used');
      const legacy = operation === 'privateEncrypt' || operation === 'publicDecrypt';
      return Buffer.from(call(operation, [handle(info.key), packed(buffer), padding, legacy ? '' : oaepHash ?? 'sha1', legacy || oaepLabel === undefined ? undefined : packed(oaepLabel), legacy ? '' : mgf1Hash ?? '']));
    } finally { if (info.owned) release(info.key); }
  };
}
const publicEncrypt = rsaFunctionFor('encrypt', constants.RSA_PKCS1_OAEP_PADDING, 'public');
const publicDecrypt = rsaFunctionFor('publicDecrypt', constants.RSA_PKCS1_PADDING, 'public');
const privateEncrypt = rsaFunctionFor('privateEncrypt', constants.RSA_PKCS1_PADDING, 'private');
const privateDecrypt = rsaFunctionFor('decrypt', constants.RSA_PKCS1_OAEP_PADDING, 'private');
// lib/internal/crypto/diffiehellman.js, with the checks of src/crypto/crypto_dh.cc and crypto_ec.cc.
// Node raises these OpenSSL errors itself (ERR_put_error) before it calls into OpenSSL.
const dhBadGenerator = () => normalize(new Error('error:02800065:Diffie-Hellman routines::bad generator'));
const kDhKind = Symbol('kDhKind');
function unsignedBig(buffer) { let n = 0n; for (const b of buffer) n = (n << 8n) | BigInt(b); return n; }
function bitLength(n) { return n === 0n ? 0 : n.toString(2).length; }
function encodeDh(buffer, encoding) { buffer = Buffer.from(buffer); return encoding && encoding !== 'buffer' ? buffer.toString(encoding) : buffer; }
function dhCreate(object, args) {
  try { attach(object, call('dhCreate', args)); }
  catch (e) { if (e.library !== undefined) throw e; throw codes.ERR_INVALID_ARG_VALUE_MESSAGE('Invalid DH parameters'); }
}
function dhVerifyError(object) {
  let result; try { result = call('dhCheck', [handle(object)]); } catch { throw codes.ERR_CRYPTO_OPERATION_FAILED('Checking DH parameters failed'); }
  Object.defineProperty(object, 'verifyError', { __proto__: null, enumerable: true, value: result, writable: false });
}
function DiffieHellman(sizeOrKey, keyEncoding, generator, genEncoding) {
  if (!(this instanceof DiffieHellman)) return new DiffieHellman(sizeOrKey, keyEncoding, generator, genEncoding);
  if (typeof sizeOrKey !== 'number' && typeof sizeOrKey !== 'string' && !ArrayBuffer.isView(sizeOrKey) && !isAnyArrayBuffer(sizeOrKey))
    throw codes.ERR_INVALID_ARG_TYPE('sizeOrKey', ['number', 'string', 'ArrayBuffer', 'Buffer', 'TypedArray', 'DataView'], sizeOrKey);
  if (typeof sizeOrKey === 'number') { validate.int32(sizeOrKey, 'sizeOrKey'); sizeOrKey += 0; }
  if (keyEncoding && !Buffer.isEncoding(keyEncoding) && keyEncoding !== 'buffer') { genEncoding = generator; generator = keyEncoding; keyEncoding = false; }
  if (typeof sizeOrKey !== 'number') sizeOrKey = toBuf(sizeOrKey, keyEncoding);
  if (!generator) generator = 2;
  else if (typeof generator === 'number') validate.int32(generator, 'generator');
  else if (typeof generator === 'string') generator = toBuf(generator, genEncoding);
  else if (!ArrayBuffer.isView(generator) && !isAnyArrayBuffer(generator))
    throw codes.ERR_INVALID_ARG_TYPE('generator', ['number', 'string', 'ArrayBuffer', 'Buffer', 'TypedArray', 'DataView'], generator);
  this[kDhKind] = 'dh';
  if (typeof sizeOrKey === 'number') {
    if (sizeOrKey < 2) throw normalize(new Error('error:02800067:Diffie-Hellman routines::modulus too small'));
    if (typeof generator !== 'number') throw codes.ERR_INVALID_ARG_TYPE_MESSAGE('Second argument must be an int32');
    if (generator < 2) throw dhBadGenerator();
    dhCreate(this, [sizeOrKey, generator, '']);
  } else {
    const prime = bytes(sizeOrKey);
    if (prime.byteLength > 0x7fffffff) throw codes.ERR_OUT_OF_RANGE_MESSAGE('prime is too big');
    let g;
    if (typeof generator === 'number') { if (generator < 2) throw dhBadGenerator(); g = Buffer.alloc(4); g.writeUInt32BE(generator); }
    else { g = bytes(generator); if (g.byteLength > 0x7fffffff) throw codes.ERR_OUT_OF_RANGE_MESSAGE('generator is too big'); }
    const p = unsignedBig(prime), gn = unsignedBig(g);
    if (gn < 2n) throw dhBadGenerator();
    if (bitLength(p) >= 512 && gn >= p) throw dhBadGenerator();
    dhCreate(this, [packed(prime), packed(g), '']);
  }
  dhVerifyError(this);
}
function DiffieHellmanGroup(name) {
  if (!(this instanceof DiffieHellmanGroup)) return new DiffieHellmanGroup(name);
  if (typeof name !== 'string') throw codes.ERR_INVALID_ARG_TYPE_MESSAGE('Group name must be a string');
  const legacy = { modp1: 768, modp2: 1024, modp5: 1536 }, map = { modp14: 'modp_2048', modp15: 'modp_3072', modp16: 'modp_4096', modp17: 'modp_6144', modp18: 'modp_8192' };
  if (!Object.hasOwn(map, name) && !Object.hasOwn(legacy, name)) throw codes.ERR_CRYPTO_UNKNOWN_DH_GROUP();
  this[kDhKind] = 'dh';
  attach(this, call('dhCreate', legacy[name] ? [0, packed(Buffer.from([2])), '', legacy[name]] : [0, 0, map[name]]));
  dhVerifyError(this);
}
function toBuf(value, encoding) { if (typeof value === 'string') { if (encoding === 'buffer') encoding = 'utf8'; return Buffer.from(value, encoding); } return value; }
function dhGenerateKeys(encoding) {
  try { call('dhGenerate', [handle(this)]); } catch { throw codes.ERR_CRYPTO_OPERATION_FAILED('Key generation failed'); }
  return encodeDh(call('dhPublic', [handle(this)]), encoding);
}
function dhComputeSecret(key, inEnc, outEnc) {
  key = validate.bufferSource(key, 'key', inEnc);
  if (this[kDhKind] === 'ecdh') {
    let secret;
    try { secret = call('ecSecret', [handle(this), packed(key)]); }
    catch (e) {
      throw e.code === 'ERR_CRYPTO_INVALID_KEYPAIR' ? codes.ERR_CRYPTO_INVALID_KEYPAIR() : codes.ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY();
    }
    return encodeDh(secret, outEnc);
  }
  if (key.byteLength > 0x7fffffff) throw codes.ERR_OUT_OF_RANGE_MESSAGE('secret is too big');
  const value = unsignedBig(bytes(key)), prime = unsignedBig(Buffer.from(call('dhPrime', [handle(this)])));
  if (value <= 1n) throw codes.ERR_CRYPTO_INVALID_KEYLEN('Supplied key is too small');
  if (value >= prime - 1n) throw codes.ERR_CRYPTO_INVALID_KEYLEN('Supplied key is too large');
  let secret;
  try { secret = call('dhSecret', [handle(this), packed(key)]); }
  catch (e) { if (e.library !== undefined && e.library !== 'Diffie-Hellman routines') throw codes.ERR_CRYPTO_OPERATION_FAILED('Failed to compute shared secret'); throw codes.ERR_CRYPTO_INVALID_KEYTYPE('Supplied key is invalid'); }
  return encodeDh(secret, outEnc);
}
function dhGetPrime(encoding) { return encodeDh(call('dhPrime', [handle(this)]), encoding); }
function dhGetGenerator(encoding) { return encodeDh(call('dhGenerator', [handle(this)]), encoding); }
function dhGetPublicKey(encoding) {
  let key; try { key = call('dhPublic', [handle(this)]); } catch { throw codes.ERR_CRYPTO_INVALID_STATE_MESSAGE('No public key - did you forget to generate one?'); }
  return encodeDh(key, encoding);
}
function dhGetPrivateKey(encoding) {
  let key; try { key = call('dhPrivate', [handle(this)]); } catch { throw codes.ERR_CRYPTO_INVALID_STATE_MESSAGE('No private key - did you forget to generate one?'); }
  return encodeDh(key, encoding);
}
for (const target of [DiffieHellman.prototype, DiffieHellmanGroup.prototype]) Object.assign(target, { generateKeys: dhGenerateKeys, computeSecret: dhComputeSecret, getPrime: dhGetPrime, getGenerator: dhGetGenerator, getPublicKey: dhGetPublicKey, getPrivateKey: dhGetPrivateKey });
function dhSetKey(object, op, key, encoding, message) {
  key = validate.bufferSource(key, 'key', encoding);
  if (key.byteLength > 0x7fffffff) throw codes.ERR_OUT_OF_RANGE_MESSAGE('buf is too big');
  try { call(op, [handle(object), packed(key)]); } catch { throw codes.ERR_INVALID_ARG_VALUE_MESSAGE(message); }
  return object;
}
DiffieHellman.prototype.setPublicKey = function setPublicKey(key, encoding) {
  if (this[kDhKind] === 'ecdh') {
    key = validate.bufferSource(key, 'key', encoding);
    try { call('ecSetPublic', [handle(this), packed(key)]); } catch { throw codes.ERR_CRYPTO_OPERATION_FAILED('Failed to convert Buffer to EC_POINT'); }
    return this;
  }
  return dhSetKey(this, 'dhSetPublic', key, encoding, 'Invalid public key');
};
DiffieHellman.prototype.setPrivateKey = function setPrivateKey(key, encoding) {
  if (this[kDhKind] === 'ecdh') {
    key = validate.bufferSource(key, 'key', encoding);
    try { call('ecSetPrivate', [handle(this), packed(key)]); } catch { throw codes.ERR_CRYPTO_INVALID_KEYTYPE('Private key is not valid for specified curve.'); }
    return this;
  }
  return dhSetKey(this, 'dhSetPrivate', key, encoding, 'Invalid private key');
};
function ECDH(curve) {
  if (!(this instanceof ECDH)) return new ECDH(curve);
  validate.string(curve, 'curve');
  this[kDhKind] = 'ecdh';
  try { attach(this, call('ecCreate', [curve])); } catch { throw codes.ERR_CRYPTO_INVALID_CURVE(); }
}
ECDH.prototype.computeSecret = DiffieHellman.prototype.computeSecret;
ECDH.prototype.setPrivateKey = DiffieHellman.prototype.setPrivateKey;
ECDH.prototype.setPublicKey = require('util').deprecate(DiffieHellman.prototype.setPublicKey, 'ecdh.setPublicKey() is deprecated.', 'DEP0031');
ECDH.prototype.getPrivateKey = function getPrivateKey(encoding) {
  let key; try { key = call('ecPrivate', [handle(this)]); } catch { throw codes.ERR_CRYPTO_OPERATION_FAILED('Failed to get ECDH private key'); }
  return encodeDh(key, encoding);
};
ECDH.prototype.generateKeys = function generateKeys(encoding, format) {
  try { call('ecGenerate', [handle(this)]); } catch { throw codes.ERR_CRYPTO_OPERATION_FAILED('Failed to generate key'); }
  return this.getPublicKey(encoding, format);
};
ECDH.prototype.getPublicKey = function getPublicKey(encoding, format) {
  const f = getFormat(format);
  let key; try { key = call('ecPublic', [handle(this), f]); } catch { throw codes.ERR_CRYPTO_OPERATION_FAILED('Failed to get ECDH public key'); }
  return encodeDh(key, encoding);
};
ECDH.convertKey = function convertKey(key, curve, inEnc, outEnc, format) {
  validate.string(curve, 'curve');
  key = validate.bufferSource(key, 'key', inEnc);
  const f = getFormat(format);
  let id; try { id = call('ecCreate', [curve]); } catch { throw codes.ERR_CRYPTO_INVALID_CURVE(); }
  const object = {}; attach(object, id);
  try {
    try { call('ecSetPublic', [handle(object), packed(key)]); } catch { throw codes.ERR_CRYPTO_OPERATION_FAILED('Failed to convert Buffer to EC_POINT'); }
    return encodeDh(call('ecPublic', [handle(object), f]), outEnc);
  } finally { release(object); }
};
function getFormat(format) {
  if (format) {
    if (format === 'compressed') return 2;
    if (format === 'hybrid') return 6;
    if (format !== 'uncompressed') throw codes.ERR_CRYPTO_ECDH_INVALID_FORMAT(format);
  }
  return 4;
}
function createECDH(curve) { return new ECDH(curve); }
function createDiffieHellman(sizeOrKey, keyEncoding, generator, genEncoding) { return new DiffieHellman(sizeOrKey, keyEncoding, generator, genEncoding); }
function getDiffieHellman(group) { return new DiffieHellmanGroup(group); }
module.exports = { constants, randomBytes, randomFill, randomFillSync, randomInt, randomUUID, timingSafeEqual, Hash: require('util').deprecate(Hash, 'crypto.Hash constructor is deprecated.', 'DEP0179'), Hmac: require('util').deprecate(Hmac, 'crypto.Hmac constructor is deprecated.', 'DEP0181'), createHash, createHmac, hash, Cipheriv, Decipheriv, createCipheriv, createDecipheriv, pbkdf2, pbkdf2Sync, scrypt, scryptSync, hkdf, hkdfSync, KeyObject, createSecretKey, createPrivateKey, createPublicKey, generateKey, generateKeySync, generateKeyPair, generateKeyPairSync, sign, verify, Sign, Verify, createSign, createVerify, diffieHellman, publicEncrypt, privateDecrypt, ECDH, createECDH, DiffieHellman, DiffieHellmanGroup, createDiffieHellman, getDiffieHellman, createDiffieHellmanGroup: getDiffieHellman };
Object.defineProperty(module.exports, 'webcrypto', { enumerable: true, get() { return require('internal/crypto/webcrypto').crypto; } });
Object.defineProperty(module.exports, 'subtle', { enumerable: true, get() { return module.exports.webcrypto.subtle; } });
module.exports.getRandomValues = value => module.exports.webcrypto.getRandomValues(value);
// Node's filterDuplicateStrings: one entry per lowercased name, the last spelling seen wins.
function names(operation) { const map = new Map(); for (const item of call(operation, []).split('\n')) if (item) map.set(item.toLowerCase(), item); return [...map.values()].sort(); }
module.exports.getHashes = () => names('hashes');
module.exports.getCiphers = () => names('ciphers');
module.exports.getCurves = () => names('curves');
module.exports.getFips = () => call('getFips', []);
// lib/crypto.js setFips: forced FIPS mode stays on, and workers do not own the process state.
module.exports.setFips = enabled => {
  if (require('internal/options').getOptionValue('--force-fips')) {
    if (enabled) return;
    throw new (require('internal/errors').codes.ERR_CRYPTO_FIPS_FORCED)();
  }
  if (!require('worker_threads').isMainThread) {
    throw new (require('internal/errors').codes.ERR_WORKER_UNSUPPORTED_OPERATION)('Calling crypto.setFips()');
  }
  // ncrypto::setFipsEnabled: the generation moves only when the FIPS state does.
  const before = call('getFips', []);
  call('setFips', [enabled ? 1 : 0]);
  if (call('getFips', []) !== before) binding.noteFipsChange();
};
c.keyFromHandle = (type, id) => newKeyObject(type, id);
c.keyObjectFromHandle = keyObjectFromHandle;
c.keyObjectHandle = key => keySlotsOf(key).handle;
c.importKeyObject = keyFromPrepared;
c.prepareSecretKey = prepareSecretKey;
// Internal reads that bypass the public, user-replaceable KeyObject accessors.
c.keyObjectType = key => keySlotsOf(key).type;
c.keyObjectEquals = keyObjectEquals;
c.keyObjectSecret = key => Buffer.from(keySlotsOf(key).secret);
c.keyObjectAsymmetricType = key => asymmetricKeyTypeOf(key);
c.keyObjectDetails = key => asymmetricKeyDetailsOf(key);
c.keyObjectDer = key => exportAsymmetric(key, { format: 'der', type: keySlotsOf(key).type === 'private' ? 'pkcs8' : 'spki' });
c.keygenArgs = keygenArgs;
// lib/internal/crypto/keys.js internals that tests reach with --expose-internals.
c.prepareAsymmetricKey = prepareAsymmetricKey;
c.getKeyObjectHandle = key => keySlotsOf(key).handle;
c.keyContexts = { kCreatePrivate, kCreatePublic, kConsumePrivate, kConsumePublic };
c.serializeKeyObject = key => {
  if (!isKeyObject(key)) return undefined;
  const type = keySlotsOf(key).type;
  const data = type === 'secret' ? keySlotsOf(key).secret :
    call('keyExport', [handle(key), 'DER', type === 'private' ? 'PrivateKeyInfo' : 'SubjectPublicKeyInfo', type === 'private' ? 1 : 0, '', packed(Buffer.alloc(0))]);
  return { type, data };
};
c.deserializeKeyObject = value => {
  if (value.type === 'secret') return createSecretKey(value.data);
  if (value.type !== 'private' && value.type !== 'public') throw error('ERR_INVALID_ARG_VALUE', 'Invalid cloned key type', TypeError);
  return importDer(Buffer.from(value.data), value.type);
};
Object.assign(module.exports, { randomUUIDv7, checkPrime, checkPrimeSync, generatePrime, generatePrimeSync, getCipherInfo, privateEncrypt, publicDecrypt, secureHeapUsed, setEngine });
for (const key of ['rng', 'prng', 'pseudoRandomBytes']) {
  Object.defineProperty(module.exports, key, {
    configurable: true, enumerable: false,
    get() {
      const value = require('internal/options').getOptionValue('--pending-deprecation') ?
        require('util').deprecate(randomBytes, `crypto.${key} is deprecated.`, 'DEP0115') : randomBytes;
      Object.defineProperty(this, key, { value, writable: true, configurable: true, enumerable: false });
      return value;
    },
    set(value) { Object.defineProperty(this, key, { value, writable: true, configurable: true, enumerable: true }); },
  });
}
Object.defineProperty(module.exports, 'fips', {
  get: require('util').deprecate(module.exports.getFips, 'The crypto.fips is deprecated. Please use crypto.getFips()', 'DEP0093'),
  set: require('util').deprecate(module.exports.setFips, 'The crypto.fips is deprecated. Please use crypto.setFips()', 'DEP0093'),
});
const certificates = require('internal/crypto_certificates');
Object.assign(module.exports, { Certificate: certificates.Certificate, X509Certificate: certificates.X509Certificate, parsePKCS12: certificates.parsePKCS12 }, require('internal/crypto_provider'));
