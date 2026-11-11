'use strict';
const c = require('internal/crypto_core');
const { Buffer, call, submit, packed, bytes, binary, integer, callback, error, invalid, output, attach, handle, release, name } = c;
const { Transform, Writable } = require('stream');
const constants = Object.freeze({ RSA_PKCS1_PADDING: 1, RSA_NO_PADDING: 3, RSA_PKCS1_OAEP_PADDING: 4, RSA_X931_PADDING: 5, RSA_PKCS1_PSS_PADDING: 6, RSA_PSS_SALTLEN_DIGEST: -1, RSA_PSS_SALTLEN_MAX_SIGN: -2, RSA_PSS_SALTLEN_AUTO: -2, POINT_CONVERSION_COMPRESSED: 2, POINT_CONVERSION_UNCOMPRESSED: 4, POINT_CONVERSION_HYBRID: 6, DH_CHECK_P_NOT_PRIME: 1, DH_CHECK_P_NOT_SAFE_PRIME: 2, DH_UNABLE_TO_CHECK_GENERATOR: 4, DH_NOT_SUITABLE_GENERATOR: 8, ENGINE_METHOD_RSA: 1, ENGINE_METHOD_DSA: 2, ENGINE_METHOD_DH: 4, ENGINE_METHOD_RAND: 8, ENGINE_METHOD_CIPHERS: 64, ENGINE_METHOD_DIGESTS: 128, ENGINE_METHOD_PKEY_METHS: 512, ENGINE_METHOD_PKEY_ASN1_METHS: 1024, ENGINE_METHOD_EC: 2048, ENGINE_METHOD_ALL: 65535, ENGINE_METHOD_NONE: 0, defaultCoreCipherList: require('internal/tls/options').DEFAULT_CIPHER_LIST, defaultCipherList: require('internal/tls/options').getOptionValue('--tls-cipher-list') });
function randomBytes(size, cb) { integer(size, 'size'); if (cb !== undefined) { submit('random', [size], cb, Buffer.from); return; } return Buffer.from(call('random', [size])); }
function randomFillSync(buffer, offset = 0, size) { const b = binary(buffer); const unit = buffer.BYTES_PER_ELEMENT || 1; integer(offset, 'offset', 0, Math.floor(b.length / unit)); if (size === undefined) size = Math.floor(b.length / unit) - offset; integer(size, 'size', 0, Math.floor(b.length / unit) - offset); b.set(randomBytes(size * unit), offset * unit); return buffer; }
function randomFill(buffer, offset, size, cb) { if (typeof offset === 'function') { cb = offset; offset = 0; size = undefined; } else if (typeof size === 'function') { cb = size; size = undefined; } callback(cb); const b = binary(buffer); const unit = buffer.BYTES_PER_ELEMENT || 1; if (offset === undefined) offset = 0; integer(offset, 'offset', 0, Math.floor(b.length / unit)); if (size === undefined) size = Math.floor(b.length / unit) - offset; integer(size, 'size', 0, Math.floor(b.length / unit) - offset); randomBytes(size * unit, (e, data) => { if (e) return cb(e); try { binary(buffer).set(data, offset * unit); } catch (failure) { cb(failure); return; } cb(null, buffer); }); }
function randomInt(min, max, cb) {
  if (typeof max === 'function') { cb = max; max = min; min = 0; } else if (max === undefined) { max = min; min = 0; }
  integer(min, 'min', Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER); integer(max, 'max', Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  const range = max - min; if (range <= 0 || range >= 0x1000000000000) throw error('ERR_OUT_OF_RANGE', 'max - min must be positive and less than 2**48', RangeError);
  const limit = 0x1000000000000 - 0x1000000000000 % range;
  function sample(b) { let n = 0; for (const byte of b) n = n * 256 + byte; return n < limit ? n % range + min : undefined; }
  if (cb !== undefined) { callback(cb); const next = () => randomBytes(6, (e, b) => { if (e) return cb(e); const n = sample(b); if (n === undefined) next(); else cb(null, n); }); next(); return; }
  for (;;) { const n = sample(randomBytes(6)); if (n !== undefined) return n; }
}
function randomUUID(options) { if (options !== undefined && (options === null || typeof options !== 'object')) throw invalid('options', 'an object'); if (options && options.disableEntropyCache !== undefined && typeof options.disableEntropyCache !== 'boolean') throw invalid('options.disableEntropyCache', 'a boolean'); const b = randomBytes(16); b[6] = b[6] & 15 | 64; b[8] = b[8] & 63 | 128; const h = b.toString('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; }
function randomUUIDv7(options) {
  if (options !== undefined && (options === null || typeof options !== 'object' || Array.isArray(options))) throw invalid('options', 'an object');
  if (options && options.disableEntropyCache !== undefined && typeof options.disableEntropyCache !== 'boolean') throw invalid('options.disableEntropyCache', 'a boolean');
  const b = randomBytes(16), now = Date.now(), high = now / 0x100000000;
  b[0] = high >>> 8; b[1] = high; b[2] = now >>> 24; b[3] = now >>> 16; b[4] = now >>> 8; b[5] = now;
  b[6] = b[6] & 15 | 112; b[8] = b[8] & 63 | 128;
  const h = b.toString('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function optionsObject(value) { if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid('options', 'an object'); return value; }
function unsignedBytes(value, field) {
  if (typeof value !== 'bigint') return binary(value, field);
  if (value < 0n) throw error('ERR_OUT_OF_RANGE', `${field} must be nonnegative`, RangeError);
  let hex = value.toString(16); if (hex.length % 2) hex = '0' + hex; return Buffer.from(hex, 'hex');
}
function unsignedValue(value) { const hex = Buffer.from(value).toString('hex'); return hex ? BigInt('0x' + hex) : 0n; }
function checkPrimeArgs(candidate, options = {}) { candidate = unsignedBytes(candidate, 'candidate'); optionsObject(options); return [packed(candidate), integer(options.checks === undefined ? 0 : options.checks, 'options.checks')]; }
function checkPrimeSync(candidate, options) { return !!call('checkPrime', checkPrimeArgs(candidate, options)); }
function checkPrime(candidate, options, cb) { if (typeof options === 'function') { cb = options; options = undefined; } const args = checkPrimeArgs(candidate, options); callback(cb); submit('checkPrime', args, cb, value => !!value); }
function primeArgs(size, options = {}) {
  integer(size, 'size', 1); optionsObject(options);
  const safe = options.safe === undefined ? false : options.safe, bigint = options.bigint === undefined ? false : options.bigint;
  if (typeof safe !== 'boolean') throw invalid('options.safe', 'a boolean');
  if (typeof bigint !== 'boolean') throw invalid('options.bigint', 'a boolean');
  const add = options.add === undefined ? undefined : unsignedBytes(options.add, 'options.add'), rem = options.rem === undefined ? undefined : unsignedBytes(options.rem, 'options.rem');
  if (add !== undefined) {
    const a = unsignedValue(add);
    if (a.toString(2).length > size) throw error('ERR_OUT_OF_RANGE', 'invalid options.add', RangeError);
    if (rem !== undefined && a <= unsignedValue(rem)) throw error('ERR_OUT_OF_RANGE', 'invalid options.rem', RangeError);
  }
  return { args: [size, safe ? 1 : 0, add === undefined ? undefined : packed(add), rem === undefined ? undefined : packed(rem)], bigint };
}
function generatePrimeSync(size, options) { const job = primeArgs(size, options); const value = call('generatePrime', job.args); return job.bigint ? unsignedValue(value) : value; }
function generatePrime(size, options, cb) { if (typeof options === 'function') { cb = options; options = undefined; } integer(size, 'size', 1); callback(cb); const job = primeArgs(size, options); submit('generatePrime', job.args, cb, value => job.bigint ? unsignedValue(value) : value); }
function getCipherInfo(nameOrNid, options) {
  if (typeof nameOrNid === 'number') integer(nameOrNid, 'nameOrNid', -2147483648);
  else name(nameOrNid, 'nameOrNid');
  if (options !== undefined) optionsObject(options);
  const keyLength = options && options.keyLength, ivLength = options && options.ivLength;
  if (keyLength !== undefined) integer(keyLength, 'options.keyLength', -2147483648);
  if (ivLength !== undefined) integer(ivLength, 'options.ivLength', -2147483648);
  const value = call('cipherInfo', [nameOrNid, keyLength === undefined ? 0 : keyLength, ivLength === undefined ? 0 : ivLength, typeof nameOrNid === 'number' ? 1 : 0, keyLength === undefined ? 0 : 1, ivLength === undefined ? 0 : 1]);
  if (value === undefined) return undefined;
  const b = Buffer.from(value), mode = b.readInt32LE(0);
  const result = { name: b.subarray(20).toString().toLowerCase(), keyLength: b.readInt32LE(12) };
  const modeName = ({ 0: 'stream', 1: 'ecb', 2: 'cbc', 3: 'cfb', 4: 'ofb', 5: 'ctr', 6: 'gcm', 7: 'ccm', 65537: 'xts', 65538: 'wrap', 65539: 'ocb', 65540: 'siv' })[mode];
  if (modeName !== undefined) result.mode = modeName;
  const nid = b.readInt32LE(4); if (nid !== 0) result.nid = nid;
  if (mode !== 0) result.blockSize = b.readInt32LE(8);
  const iv = b.readInt32LE(16); if (iv !== 0) result.ivLength = iv;
  return result;
}
// No secure heap is configured by this runtime. These are Node's disabled-heap
// configuration values; used is queried from OpenSSL rather than estimated.
function secureHeapUsed() { const total = 0, used = call('secureHeapUsed', []); return { total, used, utilization: used / total, min: 2 }; }
function setEngine(id, flags) { name(id, 'id'); if (flags && typeof flags !== 'number') throw invalid('flags', 'a number'); flags = flags >>> 0; if (!call('setEngine', [id, flags || 65535])) throw error('ERR_CRYPTO_ENGINE_UNKNOWN', `Engine "${id}" was not found`); }
function timingSafeEqual(a, b) { a = binary(a); b = binary(b); if (a.length !== b.length) throw error('ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH', 'Input buffers must have the same byte length', RangeError); return !!call('equal', [packed(a), packed(b)]); }
class Hash extends Transform {
  constructor(algorithm, options = {}, existing) {
    super(options); this._algorithm = name(algorithm); this._xof = /^shake(?:128|256)$/i.test(algorithm);
    this._length = options.outputLength === undefined ? -1 : integer(options.outputLength, 'outputLength');
    if (!this._xof && this._length !== -1) { if (this._length !== call('hashSize', [algorithm])) throw error('ERR_OSSL_EVP_NOT_XOF_OR_INVALID_LENGTH', 'Invalid digest output length'); this._length = -1; }
    if (this._xof && this._length === -1) this._length = /128$/.test(algorithm) ? 16 : 32;
    attach(this, existing === undefined ? call('hashCreate', [algorithm]) : existing); this._finalized = false;
  }
  update(data, encoding) { if (this._finalized) throw error('ERR_CRYPTO_HASH_FINALIZED', 'Digest already called'); call('hashUpdate', [handle(this), packed(bytes(data, encoding))]); return this; }
  digest(encoding) { if (this._finalized) throw error('ERR_CRYPTO_HASH_FINALIZED', 'Digest already called'); this._finalized = true; try { return output(call('hashFinal', [handle(this), this._length]), encoding); } finally { release(this); } }
  copy(options = {}) {
    if (this._finalized) throw error('ERR_CRYPTO_HASH_FINALIZED', 'Digest already called');
    const normalized = { ...options, outputLength: options.outputLength === undefined && this._xof ? this._length : options.outputLength };
    if (normalized.outputLength !== undefined) { integer(normalized.outputLength, 'outputLength'); if (!this._xof && normalized.outputLength !== call('hashSize', [this._algorithm])) throw error('ERR_OSSL_EVP_NOT_XOF_OR_INVALID_LENGTH', 'Invalid digest output length'); }
    const id = call('hashCopy', [handle(this)]);
    try { return new Hash(this._algorithm, normalized, id); } catch (e) { call('release', [id]); throw e; }
  }
  _transform(chunk, encoding, cb) { try { this.update(chunk, encoding); cb(); } catch (e) { cb(e); } }
  _flush(cb) { try { this.push(this.digest()); cb(); } catch (e) { cb(e); } }
  _destroy(e, cb) { release(this); cb(e); }
}
class Hmac extends Transform {
  constructor(algorithm, key, options = {}) { super(options); if (key instanceof KeyObject) { if (key.type !== 'secret') throw error('ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE', 'HMAC requires a secret key'); key = key.export(); } attach(this, call('hmacCreate', [name(algorithm), packed(bytes(key, options.encoding))])); this._finalized = false; }
  update(data, encoding) { if (this._finalized) throw error('ERR_CRYPTO_HASH_FINALIZED', 'Digest already called'); call('hmacUpdate', [handle(this), packed(bytes(data, encoding))]); return this; }
  digest(encoding) { if (this._finalized) return output(new ArrayBuffer(0), encoding); this._finalized = true; try { return output(call('hmacFinal', [handle(this)]), encoding); } finally { release(this); } }
  _transform(chunk, encoding, cb) { try { this.update(chunk, encoding); cb(); } catch (e) { cb(e); } }
  _flush(cb) { try { this.push(this.digest()); cb(); } catch (e) { cb(e); } }
  _destroy(e, cb) { release(this); cb(e); }
}
function createHash(algorithm, options) { return new Hash(algorithm, options); }
function createHmac(algorithm, key, options) { return new Hmac(algorithm, key, options); }
function hash(algorithm, data, encoding = 'hex') { return createHash(algorithm).update(data).digest(encoding); }
class Cipheriv extends Transform {
  constructor(algorithm, key, iv, options = {}, decrypt = false) {
    super(options); name(algorithm); if (key instanceof KeyObject) { if (key.type !== 'secret') throw error('ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE', 'Cipher requires a secret key'); key = key.export(); }
    this._decrypt = decrypt; this._aead = /-(gcm|ccm|ocb)$|^chacha20-poly1305$/i.test(algorithm); this._ccm = /-ccm$/i.test(algorithm); this._tagLength = options.authTagLength === undefined ? 16 : integer(options.authTagLength, 'authTagLength', 1, 16);
    if (this._ccm && options.authTagLength === undefined) throw error('ERR_CRYPTO_INVALID_AUTH_TAG', 'authTagLength is required for CCM');
    if (/-gcm$/i.test(algorithm) && ![4, 8, 12, 13, 14, 15, 16].includes(this._tagLength)) throw error('ERR_CRYPTO_INVALID_AUTH_TAG', 'Invalid GCM authentication tag length');
    if (this._ccm && ![4, 6, 8, 10, 12, 14, 16].includes(this._tagLength)) throw error('ERR_CRYPTO_INVALID_AUTH_TAG', 'Invalid CCM authentication tag length');
    this._tagSpecified = options.authTagLength !== undefined; this._finished = false; this._tag = undefined; this._decoder = undefined; this._outputEncoding = undefined;
    attach(this, call('cipherCreate', [algorithm, packed(bytes(key, options.encoding)), packed(iv === null ? Buffer.alloc(0) : bytes(iv, options.encoding)), decrypt ? 0 : 1, this._tagLength, /^(?:chacha20-poly1305)$|-(?:gcm|ccm|ocb)$/i.test(algorithm) ? 1 : 0]));
  }
  _encode(data, encoding, final) { if (!encoding || encoding === 'buffer') { if (this._decoder) throw error('ERR_INVALID_ARG_VALUE', 'Cannot change cipher output encoding'); return Buffer.from(data); } if (this._outputEncoding && this._outputEncoding !== encoding) throw error('ERR_INVALID_ARG_VALUE', 'Cannot change cipher output encoding'); this._outputEncoding = encoding; if (!this._decoder) { const { StringDecoder } = require('string_decoder'); this._decoder = new StringDecoder(encoding); } return final ? this._decoder.end(Buffer.from(data)) : this._decoder.write(Buffer.from(data)); }
  update(data, inputEncoding, outputEncoding) { if (this._finished) throw error('ERR_CRYPTO_INVALID_STATE', 'Cipher is finalized'); return this._encode(call('cipherUpdate', [handle(this), packed(bytes(data, inputEncoding))]), outputEncoding, false); }
  final(encoding) { if (this._finished) throw error('ERR_CRYPTO_INVALID_STATE', 'Cipher is finalized'); this._finished = true; try { const result = call('cipherFinal', [handle(this)]); if (this._aead && !this._decrypt) this._tag = Buffer.from(call('cipherGetTag', [handle(this), this._tagLength])); return this._encode(result, encoding, true); } finally { release(this); } }
  setAutoPadding(value = true) { if (typeof value !== 'boolean') throw invalid('autoPadding', 'a boolean'); call('cipherPadding', [handle(this), value ? 1 : 0]); return this; }
  setAAD(data, options = {}) { if (!this._aead || this._finished) throw error('ERR_CRYPTO_INVALID_STATE', 'Invalid state for setAAD'); let length = -1; if (this._ccm) length = integer(options.plaintextLength, 'plaintextLength'); call('cipherAAD', [handle(this), packed(binary(data)), length]); return this; }
  setAuthTag(tag, encoding) { if (!this._decrypt || !this._aead || this._finished || this._tag) throw error('ERR_CRYPTO_INVALID_STATE', 'Invalid state for setAuthTag'); tag = bytes(tag, encoding); if (this._tagSpecified && tag.length !== this._tagLength) throw error('ERR_CRYPTO_INVALID_AUTH_TAG', 'Invalid authentication tag length'); if (!this._tagSpecified && ![4, 8, 12, 13, 14, 15, 16].includes(tag.length)) throw error('ERR_CRYPTO_INVALID_AUTH_TAG', 'Invalid authentication tag length'); call('cipherTag', [handle(this), packed(tag)]); this._tag = Buffer.from(tag); return this; }
  getAuthTag() { if (this._decrypt || !this._tag || !this._finished) throw error('ERR_CRYPTO_INVALID_STATE', 'Invalid state for getAuthTag'); return Buffer.from(this._tag); }
  _transform(chunk, encoding, cb) { try { this.push(this.update(chunk, encoding)); cb(); } catch (e) { cb(e); } }
  _flush(cb) { try { this.push(this.final()); cb(); } catch (e) { cb(e); } }
  _destroy(e, cb) { release(this); cb(e); }
}
class Decipheriv extends Cipheriv { constructor(algorithm, key, iv, options) { super(algorithm, key, iv, options, true); } }
function createCipheriv(algorithm, key, iv, options) { return new Cipheriv(algorithm, key, iv, options); }
function createDecipheriv(algorithm, key, iv, options) { return new Decipheriv(algorithm, key, iv, options); }
function pbkdf2Args(password, salt, iterations, keylen, digest) { return [packed(password), packed(salt), integer(iterations, 'iterations', 1), integer(keylen, 'keylen'), name(digest, 'digest')]; }
function pbkdf2Sync(password, salt, iterations, keylen, digest) { return Buffer.from(call('pbkdf2', pbkdf2Args(password, salt, iterations, keylen, digest))); }
function pbkdf2(password, salt, iterations, keylen, digest, cb) { callback(cb); submit('pbkdf2', pbkdf2Args(password, salt, iterations, keylen, digest), cb, Buffer.from); }
function scryptArgs(password, salt, keylen, options = {}) { if (options === null || typeof options !== 'object') throw invalid('options', 'an object'); for (const [a, b] of [['N', 'cost'], ['r', 'blockSize'], ['p', 'parallelization']]) if (options[a] !== undefined && options[b] !== undefined) throw error('ERR_CRYPTO_SCRYPT_INVALID_PARAMETER', `Cannot specify both ${a} and ${b}`); const N = options.N ?? options.cost ?? 16384, r = options.r ?? options.blockSize ?? 8, p = options.p ?? options.parallelization ?? 1, maxmem = options.maxmem ?? 32 * 1024 * 1024; integer(N, 'N', 2, Number.MAX_SAFE_INTEGER); if (!Number.isInteger(Math.log2(N))) throw error('ERR_CRYPTO_INVALID_SCRYPT_PARAMS', 'N must be a power of two'); return [packed(password), packed(salt), integer(keylen, 'keylen'), N, integer(r, 'r', 1), integer(p, 'p', 1), integer(maxmem, 'maxmem', 1, Number.MAX_SAFE_INTEGER)]; }
function scryptSync(password, salt, keylen, options) { return Buffer.from(call('scrypt', scryptArgs(password, salt, keylen, options))); }
function scrypt(password, salt, keylen, options, cb) { if (typeof options === 'function') { cb = options; options = undefined; } callback(cb); submit('scrypt', scryptArgs(password, salt, keylen, options), cb, Buffer.from); }
function hkdfArgs(digest, ikm, salt, info, keylen) { if (ikm instanceof KeyObject) ikm = ikm.export(); const args = [name(digest, 'digest'), packed(ikm), packed(salt), packed(info), integer(keylen, 'keylen')]; if (args[3].byteLength > 1024) throw error('ERR_OUT_OF_RANGE', 'info must not exceed 1024 bytes', RangeError); return args; }
function hkdfSync(digest, ikm, salt, info, keylen) { return call('hkdf', hkdfArgs(digest, ikm, salt, info, keylen)); }
function hkdf(digest, ikm, salt, info, keylen, cb) { callback(cb); submit('hkdf', hkdfArgs(digest, ikm, salt, info, keylen), cb); }
const keyToken = Symbol('KeyObject'); const secrets = new WeakMap(), keyObjects = new WeakSet();
require('internal/host').types.isKeyObject = value => keyObjects.has(value);
class KeyObject {
  constructor(token, type, value) { if (token !== keyToken) throw error('ERR_ILLEGAL_CONSTRUCTOR', 'Illegal constructor', TypeError); Object.defineProperty(this, 'type', { value: type, enumerable: true }); if (type === 'secret') secrets.set(this, Buffer.from(value)); else attach(this, value); keyObjects.add(this); }
  get symmetricKeySize() { return this.type === 'secret' ? secrets.get(this).length : undefined; }
  get asymmetricKeyType() { if (this.type === 'secret') return undefined; const type = call('keyType', [handle(this)]).toLowerCase(); return ({ 'rsa-pss': 'rsa-pss', 'dhx': 'dh' })[type] || type; }
  get asymmetricKeyDetails() { if (this.type === 'secret') return undefined; const type = this.asymmetricKeyType; if (type === 'rsa' || type === 'rsa-pss') return { modulusLength: call('keyBits', [handle(this)]) }; if (type === 'ec') { const jwk = this.export({ format: 'jwk' }); return { namedCurve: ({ 'P-256': 'prime256v1', 'P-384': 'secp384r1', 'P-521': 'secp521r1' })[jwk.crv] || jwk.crv }; } return {}; }
  export(options = {}) {
    if (this.type === 'secret') { if (options.format === 'jwk') return { kty: 'oct', k: secrets.get(this).toString('base64url') }; if (options.format !== undefined && options.format !== 'buffer') throw error('ERR_INVALID_ARG_VALUE', 'Invalid secret key export format'); return Buffer.from(secrets.get(this)); }
    if (['raw-public', 'raw-private', 'raw-seed'].includes(options.format)) return c.providerRawExport(this, options);
    if (options.format === 'jwk') return require('internal/crypto_keys').exportJwk(this);
    const format = options.format || 'pem'; if (!['pem', 'der'].includes(format)) throw error('ERR_INVALID_ARG_VALUE', 'Invalid key format');
    const type = options.type || (this.type === 'private' ? 'pkcs8' : 'spki'); const structure = ({ pkcs8: 'PrivateKeyInfo', spki: 'SubjectPublicKeyInfo', pkcs1: 'type-specific', sec1: 'type-specific' })[type];
    if (!structure || this.type === 'public' && !['spki', 'pkcs1'].includes(type)) throw error('ERR_INVALID_ARG_VALUE', 'Invalid key encoding type');
    if (options.cipher !== undefined && (this.type !== 'private' || options.passphrase === undefined)) throw error('ERR_INVALID_ARG_VALUE', 'Encrypted export requires a private key and passphrase');
    const result = call('keyExport', [handle(this), format.toUpperCase(), structure, this.type === 'private' ? 1 : 0, options.cipher === undefined ? '' : name(options.cipher, 'cipher'), packed(options.passphrase === undefined ? Buffer.alloc(0) : options.passphrase)]); return format === 'pem' ? Buffer.from(result).toString() : Buffer.from(result);
  }
  equals(other) { if (!(other instanceof KeyObject)) throw invalid('otherKeyObject', 'a KeyObject'); if (this.type !== other.type) return false; const opts = this.type === 'secret' ? {} : { format: 'der', type: this.type === 'private' ? 'pkcs8' : 'spki' }; const a = this.export(opts), b = other.export(opts); return a.length === b.length && timingSafeEqual(a, b); }
  toCryptoKey(algorithm, extractable, keyUsages) { if (!keyObjects.has(this)) throw error('ERR_INVALID_THIS', 'Value of "this" must be of type KeyObject', TypeError); return require('internal/crypto_webcrypto').toCryptoKey(this, algorithm, extractable, keyUsages); }
  static from(key) { const obj = require('internal/crypto_webcrypto').unwrap(key); if (!obj) throw invalid('key', 'a CryptoKey'); return obj; }
}
function createSecretKey(key, encoding) { return new KeyObject(keyToken, 'secret', bytes(key, encoding)); }
function importKey(key, type) {
  if (key instanceof KeyObject) { if (type === 'public' && key.type === 'private') return importKey({ key: key.export({ format: 'der', type: 'pkcs8' }), format: 'der' }, 'public'); if (key.type !== type) throw error('ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE', `Expected ${type} key`); return key; }
  const options = typeof key === 'object' && key !== null && !ArrayBuffer.isView(key) && !(key instanceof ArrayBuffer) ? key : { key };
  if (options.key instanceof KeyObject) return importKey(options.key, type);
  if (['raw-public', 'raw-private', 'raw-seed'].includes(options.format)) return c.providerRawImport(options, type);
  if (options.format === 'jwk') return require('internal/crypto_keys').importJwk(options.key, type);
  const format = options.format || 'pem'; if (!['pem', 'der'].includes(format)) throw error('ERR_INVALID_ARG_VALUE', 'Invalid key format');
  return new KeyObject(keyToken, type, call('keyImport', [packed(bytes(options.key, options.encoding)), format.toUpperCase(), type === 'private' ? 1 : 0, packed(options.passphrase === undefined ? Buffer.alloc(0) : options.passphrase)]));
}
function createPrivateKey(key) { return importKey(key, 'private'); }
function createPublicKey(key) { if (key instanceof KeyObject && key.type === 'private') return importKey({ key: key.export({ format: 'der', type: 'pkcs8' }), format: 'der' }, 'public'); return importKey(key, 'public'); }
function keygenArgs(type, options = {}) {
  name(type, 'type');
  const native = ({ rsa: 'RSA', 'rsa-pss': 'RSA-PSS', dsa: 'DSA', ec: 'EC', ed25519: 'ED25519', ed448: 'ED448', x25519: 'X25519', x448: 'X448', dh: 'DH', 'ml-kem-512': 'ML-KEM-512', 'ml-kem-768': 'ML-KEM-768', 'ml-kem-1024': 'ML-KEM-1024', 'ml-dsa-44': 'ML-DSA-44', 'ml-dsa-65': 'ML-DSA-65', 'ml-dsa-87': 'ML-DSA-87' })[type];
  if (!native) throw error('ERR_INVALID_ARG_VALUE', `Unsupported key type ${type}`);
  const bits = /^rsa/.test(type) ? integer(options.modulusLength, 'modulusLength', 512) : 0;
  let group = '';
  if (type === 'ec') group = name(options.namedCurve, 'namedCurve');
  if (type === 'dsa') return [native, integer(options.modulusLength, 'modulusLength', 512), '', packed(Buffer.alloc(0)), '', '', integer(options.divisorLength ?? 160, 'divisorLength', 160, 256), 1];
  if (type === 'dh') {
    if (options.group !== undefined) { if (options.prime !== undefined || options.primeLength !== undefined || options.generator !== undefined) throw error('ERR_INCOMPATIBLE_OPTION_PAIR', 'group cannot be combined with prime, primeLength, or generator'); group = name(options.group, 'group'); }
    else { if (options.prime !== undefined && options.primeLength !== undefined) throw error('ERR_INCOMPATIBLE_OPTION_PAIR', 'prime and primeLength are mutually exclusive'); const generator = integer(options.generator ?? 2, 'generator', 2, 0x7fffffff), g = Buffer.alloc(4); g.writeUInt32BE(generator); return [native, options.prime === undefined ? integer(options.primeLength, 'primeLength', 2) : 0, '', packed(g), options.prime === undefined ? undefined : packed(options.prime), '', generator, 2]; }
  }
  let exponent = Buffer.alloc(0);
  if (/^rsa/.test(type)) { const e = integer(options.publicExponent ?? 65537, 'publicExponent', 3, 0xffffffff); if (!(e & 1)) throw error('ERR_OUT_OF_RANGE', 'publicExponent must be odd'); exponent = Buffer.alloc(4); exponent.writeUInt32BE(e); }
  return [native, bits, group, packed(exponent), options.hashAlgorithm === undefined ? '' : name(options.hashAlgorithm), options.mgf1HashAlgorithm === undefined ? '' : name(options.mgf1HashAlgorithm), options.saltLength === undefined ? -1 : integer(options.saltLength, 'saltLength')];
}
function keypair(id, options) { const privateKey = new KeyObject(keyToken, 'private', id); let publicKey; try { publicKey = createPublicKey(privateKey); const result = { publicKey: options.publicKeyEncoding ? publicKey.export(options.publicKeyEncoding) : publicKey, privateKey: options.privateKeyEncoding ? privateKey.export(options.privateKeyEncoding) : privateKey }; if (options.publicKeyEncoding) release(publicKey); if (options.privateKeyEncoding) release(privateKey); return result; } catch (e) { release(privateKey); if (publicKey) release(publicKey); throw e; } }
function generateKeyPairSync(type, options = {}) { return keypair(call('keyGenerate', keygenArgs(type, options)), options); }
function generateKeyPair(type, options, cb) { if (typeof options === 'function') { cb = options; options = {}; } options = options || {}; callback(cb); submit('keyGenerate', keygenArgs(type, options), (e, pair) => e ? cb(e) : cb(null, pair.publicKey, pair.privateKey), id => keypair(id, options)); }
function generateKeySync(type, options) { if (type !== 'hmac' && type !== 'aes') throw error('ERR_INVALID_ARG_VALUE', 'type must be hmac or aes'); const length = integer(options && options.length, 'length', 8); if (type === 'aes' && ![128, 192, 256].includes(length)) throw error('ERR_INVALID_ARG_VALUE', 'AES length must be 128, 192, or 256'); return createSecretKey(randomBytes(Math.floor(length / 8))); }
function generateKey(type, options, cb) { callback(cb); if (type !== 'hmac' && type !== 'aes') throw error('ERR_INVALID_ARG_VALUE', 'type must be hmac or aes'); const length = integer(options && options.length, 'length', 8); if (type === 'aes' && ![128, 192, 256].includes(length)) throw error('ERR_INVALID_ARG_VALUE', 'AES length must be 128, 192, or 256'); randomBytes(Math.floor(length / 8), (e, b) => e ? cb(e) : cb(null, createSecretKey(b))); }
function signingKey(value, privateOnly) { const options = value && typeof value === 'object' && !(value instanceof KeyObject) && !ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer) && 'key' in value ? value : { key: value }; const owned = !(options.key instanceof KeyObject); let key = options.key; if (owned) { if (privateOnly) key = createPrivateKey(options); else { try { key = createPublicKey(options); } catch (_) { key = createPrivateKey(options); } } } if (!(key instanceof KeyObject) || key.type === 'secret' || privateOnly && key.type !== 'private') throw error('ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE', 'Invalid signing key'); return { key, options, owned }; }
function signatureArgs(algorithm, data, info, signature) { if (algorithm !== null && algorithm !== undefined) name(algorithm); const o = info.options; return [handle(info.key), algorithm || '', packed(data), signature === undefined ? undefined : packed(signature), o.padding === undefined ? 0 : integer(o.padding, 'padding', 1, 6), o.saltLength === undefined ? -2147483648 : integer(o.saltLength, 'saltLength', -2)]; }
function signatureConvert(signature, key, options, toDer) {
  if (options.dsaEncoding === undefined || options.dsaEncoding === 'der') return signature;
  if (options.dsaEncoding !== 'ieee-p1363') throw error('ERR_INVALID_ARG_VALUE', 'Invalid dsaEncoding');
  const type = key.asymmetricKeyType; if (type !== 'ec' && type !== 'dsa') return signature;
  const bits = type === 'dsa' ? call('keyQBits', [handle(key), 'q']) : call('keyBits', [handle(key)]);
  return require('internal/crypto_keys').signature(signature, Math.ceil(bits / 8), toDer);
}
function sign(algorithm, data, key, cb) {
  if (cb !== undefined) callback(cb);
  const info = signingKey(key, true); let submitted = false;
  try {
    const args = signatureArgs(algorithm, data, info);
    if (cb !== undefined) {
      submit('sign', args, (e, result) => {
        let converted;
        try { if (!e) converted = signatureConvert(Buffer.from(result), info.key, info.options, false); } catch (failure) { e = failure; }
        finally { if (info.owned) release(info.key); }
        cb(e, converted);
      });
      submitted = true; return;
    }
    return signatureConvert(Buffer.from(call('sign', args)), info.key, info.options, false);
  } finally { if (!submitted && info.owned) release(info.key); }
}
function verify(algorithm, data, key, signature, cb) {
  if (cb !== undefined) callback(cb);
  const info = signingKey(key, false); let submitted = false;
  try {
    const sig = signatureConvert(bytes(signature), info.key, info.options, true), args = signatureArgs(algorithm, data, info, sig);
    if (cb !== undefined) { submit('verify', args, (e, result) => { if (info.owned) release(info.key); cb(e, e ? undefined : !!result); }); submitted = true; return; }
    return !!call('verify', args);
  } finally { if (!submitted && info.owned) release(info.key); }
}
class Sign extends Writable { constructor(algorithm, options) { super(options); this._algorithm = name(algorithm); this._chunks = []; this._done = false; } update(data, encoding) { if (this._done) throw error('ERR_CRYPTO_INVALID_STATE', 'Signing context already finalized'); this._chunks.push(Buffer.from(bytes(data, encoding))); return this; } _write(chunk, encoding, cb) { try { this.update(chunk, encoding); cb(); } catch (e) { cb(e); } } sign(key, encoding) { if (this._done) throw error('ERR_CRYPTO_INVALID_STATE', 'Signing context already finalized'); this._done = true; const data = Buffer.concat(this._chunks); this._chunks = []; return output(sign(this._algorithm, data, key), encoding); } }
class Verify extends Sign { verify(key, signature, encoding) { if (this._done) throw error('ERR_CRYPTO_INVALID_STATE', 'Verification context already finalized'); this._done = true; const data = Buffer.concat(this._chunks); this._chunks = []; return verify(this._algorithm, data, key, bytes(signature, encoding)); } }
function createSign(algorithm, options) { return new Sign(algorithm, options); }
function createVerify(algorithm, options) { return new Verify(algorithm, options); }
function diffieHellman(options, cb) { if (!options || !(options.privateKey instanceof KeyObject) || options.privateKey.type !== 'private' || !(options.publicKey instanceof KeyObject) || options.publicKey.type !== 'public') throw error('ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE', 'Expected privateKey and publicKey KeyObjects'); const args = [handle(options.privateKey), handle(options.publicKey)]; if (cb !== undefined) { submit('derive', args, cb, Buffer.from); return; } return Buffer.from(call('derive', args)); }
function rsa(operation, key, buffer) { const legacy = operation === 'privateEncrypt' || operation === 'publicDecrypt'; const info = signingKey(key, operation === 'decrypt' || operation === 'privateEncrypt'); try { const o = info.options; return Buffer.from(call(operation, [handle(info.key), packed(buffer), o.padding ?? (legacy ? constants.RSA_PKCS1_PADDING : constants.RSA_PKCS1_OAEP_PADDING), legacy ? '' : o.oaepHash === undefined ? 'sha1' : name(o.oaepHash, 'oaepHash'), legacy || o.oaepLabel === undefined ? undefined : packed(o.oaepLabel)])); } finally { if (info.owned) release(info.key); } }
function publicEncrypt(key, buffer) { return rsa('encrypt', key, buffer); }
function privateDecrypt(key, buffer) { return rsa('decrypt', key, buffer); }
function privateEncrypt(key, buffer) { return rsa('privateEncrypt', key, buffer); }
function publicDecrypt(key, buffer) { return rsa('publicDecrypt', key, buffer); }
function pointForm(format) { if (format === undefined || format === 'uncompressed') return 4; if (format === 'compressed') return 2; if (format === 'hybrid') return 6; throw error('ERR_CRYPTO_ECDH_INVALID_FORMAT', 'Invalid ECDH point format'); }
class ECDH { constructor(curve) { attach(this, call('ecCreate', [name(curve, 'curve')])); this._curve = curve; } generateKeys(encoding, format) { call('ecGenerate', [handle(this)]); return this.getPublicKey(encoding, format); } getPublicKey(encoding, format) { return output(call('ecPublic', [handle(this), pointForm(format)]), encoding); } getPrivateKey(encoding) { return output(call('ecPrivate', [handle(this)]), encoding); } setPrivateKey(key, encoding) { call('ecSetPrivate', [handle(this), packed(bytes(key, encoding))]); return this; } setPublicKey(key, encoding) { call('ecSetPublic', [handle(this), packed(bytes(key, encoding))]); return this; } computeSecret(key, inputEncoding, outputEncoding) { return output(call('ecSecret', [handle(this), packed(bytes(key, inputEncoding))]), outputEncoding); } static convertKey(key, curve, inputEncoding, outputEncoding, format) { const ecdh = new ECDH(curve); try { ecdh.setPublicKey(key, inputEncoding); return ecdh.getPublicKey(outputEncoding, format); } finally { release(ecdh); } } }
function createECDH(curve) { return new ECDH(curve); }
class DiffieHellman { constructor(sizeOrPrime, primeEncoding, generator, generatorEncoding) { let args; if (typeof sizeOrPrime === 'number') { if (typeof primeEncoding === 'number') generator = primeEncoding; args = [integer(sizeOrPrime, 'size', 2), integer(generator === undefined ? 2 : generator, 'generator', 2), '']; } else { if (typeof primeEncoding !== 'string') { generatorEncoding = generator; generator = primeEncoding; primeEncoding = undefined; } if (generator === undefined) generator = 2; if (typeof generator === 'number') { const n = integer(generator, 'generator', 2, 0xffffffff); generator = Buffer.alloc(4); generator.writeUInt32BE(n); } args = [packed(bytes(sizeOrPrime, primeEncoding)), packed(bytes(generator, generatorEncoding)), '']; } attach(this, call('dhCreate', args)); } generateKeys(encoding) { call('dhGenerate', [handle(this)]); return this.getPublicKey(encoding); } getPrime(encoding) { return output(call('dhPrime', [handle(this)]), encoding); } getGenerator(encoding) { return output(call('dhGenerator', [handle(this)]), encoding); } getPublicKey(encoding) { return output(call('dhPublic', [handle(this)]), encoding); } getPrivateKey(encoding) { return output(call('dhPrivate', [handle(this)]), encoding); } setPublicKey(key, encoding) { call('dhSetPublic', [handle(this), packed(bytes(key, encoding))]); return this; } setPrivateKey(key, encoding) { call('dhSetPrivate', [handle(this), packed(bytes(key, encoding))]); return this; } computeSecret(key, inputEncoding, outputEncoding) { return output(call('dhSecret', [handle(this), packed(bytes(key, inputEncoding))]), outputEncoding); } get verifyError() { return call('dhCheck', [handle(this)]); } }
class DiffieHellmanGroup extends DiffieHellman {
  constructor(group) {
    const object = Object.create(new.target.prototype), legacy = { modp1: 768, modp2: 1024, modp5: 1536 };
    const map = { modp14: 'modp_2048', modp15: 'modp_3072', modp16: 'modp_4096', modp17: 'modp_6144', modp18: 'modp_8192' };
    name(group, 'name'); if (!map[group] && !legacy[group]) throw error('ERR_CRYPTO_UNKNOWN_DH_GROUP', 'Unknown DH group');
    attach(object, call('dhCreate', legacy[group] ? [0, packed(Buffer.from([2])), '', legacy[group]] : [0, 0, map[group]])); return object;
  }
}
function createDiffieHellman(...args) { return new DiffieHellman(...args); }
function getDiffieHellman(group) { return new DiffieHellmanGroup(group); }
module.exports = { constants, randomBytes, randomFill, randomFillSync, randomInt, randomUUID, timingSafeEqual, Hash, Hmac, createHash, createHmac, hash, Cipheriv, Decipheriv, createCipheriv, createDecipheriv, pbkdf2, pbkdf2Sync, scrypt, scryptSync, hkdf, hkdfSync, KeyObject, createSecretKey, createPrivateKey, createPublicKey, generateKey, generateKeySync, generateKeyPair, generateKeyPairSync, sign, verify, Sign, Verify, createSign, createVerify, diffieHellman, publicEncrypt, privateDecrypt, ECDH, createECDH, DiffieHellman, DiffieHellmanGroup, createDiffieHellman, getDiffieHellman, createDiffieHellmanGroup: getDiffieHellman };
Object.defineProperty(module.exports, 'webcrypto', { enumerable: true, get() { return require('internal/crypto_webcrypto').webcrypto; } });
Object.defineProperty(module.exports, 'subtle', { enumerable: true, get() { return module.exports.webcrypto.subtle; } });
module.exports.getRandomValues = value => module.exports.webcrypto.getRandomValues(value);
function names(operation) { return [...new Set(call(operation, []).split('\n').filter(Boolean))].sort(); }
module.exports.getHashes = () => names('hashes');
module.exports.getCiphers = () => names('ciphers');
module.exports.getCurves = () => names('curves');
module.exports.getFips = () => call('getFips', []);
module.exports.setFips = enabled => call('setFips', [enabled ? 1 : 0]);
c.keyFromHandle = (type, id) => new KeyObject(keyToken, type, id);
c.keygenArgs = keygenArgs;
c.serializeKeyObject = key => {
  if (!keyObjects.has(key)) return undefined;
  const type = key.type;
  const data = type === 'secret' ? secrets.get(key) :
    call('keyExport', [handle(key), 'DER', type === 'private' ? 'PrivateKeyInfo' : 'SubjectPublicKeyInfo', type === 'private' ? 1 : 0, '', packed(Buffer.alloc(0))]);
  return { type, data };
};
c.deserializeKeyObject = value => {
  if (value.type === 'secret') return createSecretKey(value.data);
  if (value.type !== 'private' && value.type !== 'public') throw error('ERR_INVALID_ARG_VALUE', 'Invalid cloned key type', TypeError);
  return importKey({ key: value.data, format: 'der', type: value.type === 'private' ? 'pkcs8' : 'spki' }, value.type);
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
