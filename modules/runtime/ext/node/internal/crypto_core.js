'use strict';
const host = require('internal/host');
const { Buffer } = require('buffer');
// Captured at load: crypto inputs never reach a user-replaced Buffer.from.
const bufferFrom = Buffer.from.bind(Buffer);
// Brand checks, so ArrayBuffers from another realm (vm contexts) are accepted too.
const types = require('util/types');
const isAnyArrayBuffer = value => value instanceof ArrayBuffer || typeof value === 'object' && value !== null && types.isAnyArrayBuffer(value);
const isShared = buffer => !(buffer instanceof ArrayBuffer) && typeof SharedArrayBuffer !== 'undefined' && types.isSharedArrayBuffer(buffer);
const ids = new WeakMap();
const finalizers = new FinalizationRegistry(id => host.crypto('release', [id]));
function error(code, message, Type = Error) { const e = new Type(message); e.code = code; return e; }
function invalid(name, type) { return error('ERR_INVALID_ARG_TYPE', `The "${name}" argument must be ${type}`, TypeError); }
function integer(n, name, min = 0, max = 0x7fffffff) { require('internal/validators').validateInteger(n, name, min, max); return n; }
function callback(cb) { if (typeof cb !== 'function') throw invalid('callback', 'a function'); return cb; }
function bytes(value, encoding, name = 'data') {
  if (typeof value === 'string') return bufferFrom(value, encoding);
  if (ArrayBuffer.isView(value)) return bufferFrom(value.buffer, value.byteOffset, value.byteLength);
  if (isAnyArrayBuffer(value)) return bufferFrom(value);
  throw invalid(name, 'a string, ArrayBuffer, Buffer, TypedArray, or DataView');
}
function binary(value, name = 'buffer') { if (typeof value === 'string') throw invalid(name, 'an ArrayBuffer or ArrayBufferView'); return bytes(value, undefined, name); }
function packed(value) { const b = bytes(value); return b.byteOffset === 0 && b.byteLength === b.buffer.byteLength && !isShared(b.buffer) ? b.buffer : b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
const opensslLibraries = { 2: 'SYS', 3: 'BN', 4: 'RSA', 5: 'DH', 6: 'EVP', 7: 'BUF', 8: 'OBJ', 9: 'PEM', 10: 'DSA', 11: 'X509', 13: 'ASN1', 14: 'CONF', 15: 'CRYPTO', 16: 'EC', 20: 'SSL', 32: 'BIO', 33: 'PKCS7', 34: 'X509V3', 35: 'PKCS12', 36: 'RAND', 37: 'DSO', 38: 'ENGINE', 39: 'OCSP', 40: 'UI', 41: 'COMP', 42: 'ECDSA', 43: 'ECDH', 44: 'OSSL_STORE', 45: 'FIPS', 46: 'CMS', 47: 'TS', 48: 'HMAC', 50: 'CT', 51: 'ASYNC', 52: 'KDF', 53: 'SM2', 128: 'USER' };
function normalize(e) {
  if (!(e instanceof Error)) e = new Error(String(e));
  if (Object.prototype.propertyIsEnumerable.call(e, 'message')) Object.defineProperty(e, 'message', { enumerable: false });
  const match = /^(ERR_[A-Z0-9_]+):\s*/.exec(e.message);
  if (match) { e.code = match[1]; e.message = e.message.slice(match[0].length); }
  else if (!e.code) e.code = 'ERR_OSSL_CRYPTO_OPERATION_FAILED';
  const openssl = /^error:([0-9a-f]+):([^:]*):[^:]*:(.*)$/i.exec(e.message);
  if (openssl) {
    // Node's code: ERR_OSSL_<LIB>_<REASON>, LIB from ERR_GET_LIB for the libraries Node names, ERR_SSL_ for SSL.
    const lib = opensslLibraries[(parseInt(openssl[1], 16) >>> 0) >= 0x80000000 ? 2 : (parseInt(openssl[1], 16) >>> 23) & 0xff];
    delete e.code; e.library = openssl[2]; e.reason = openssl[3];
    e.code = lib === 'SSL' ? `ERR_SSL_${openssl[3].replace(/ /g, '_').toUpperCase()}` : `ERR_OSSL_${lib ? lib + '_' : ''}${openssl[3].replace(/ /g, '_').toUpperCase()}`;
  }
  return e;
}
function call(op, args) { try { return host.crypto(op, args); } catch (e) { throw normalize(e); } }
// The async_wrap provider of Node's CryptoJob for each operation (src/crypto/*.h).
const jobProviders = {
  __proto__: null, random: 'RANDOMBYTESREQUEST', hkdf: 'DERIVEBITSREQUEST', scrypt: 'SCRYPTREQUEST',
  pbkdf2: 'PBKDF2REQUEST', argon2: 'ARGON2REQUEST', generatePrime: 'RANDOMPRIMEREQUEST',
  checkPrime: 'CHECKPRIMEREQUEST', encapsulate: 'DERIVEBITSREQUEST', decapsulate: 'DERIVEBITSREQUEST',
  derive: 'DERIVEBITSREQUEST', sign: 'SIGNREQUEST', verify: 'SIGNREQUEST', keyGenerate: 'KEYPAIRGENREQUEST',
};
function submit(op, args, cb, convert = x => x) {
  callback(cb);
  const { AsyncResource } = require('async_hooks');
  const resource = new AsyncResource(jobProviders[op] ?? `${op.toUpperCase()}REQUEST`, { requireManualDestroy: true });
  try {
    host.cryptoAsync(op, args, (err, value) => {
      host.invokeResource(resource, () => {
        if (err != null) { cb(normalize(err)); return; }
        let result; try { result = convert(value); } catch (e) { cb(e); return; }
        cb(null, result);
      }, undefined, []);
      host.checkpoint();
    });
  } catch (e) { resource.emitDestroy(); throw normalize(e); }
}
function output(value, encoding) { const b = bufferFrom(value); return encoding && encoding !== 'buffer' ? b.toString(encoding) : b; }
function attach(object, id) { try { ids.set(object, id); finalizers.register(object, id, object); } catch (e) { call('release', [id]); throw e; } return object; }
function handle(object) { const id = ids.get(object); if (id === undefined) throw error('ERR_CRYPTO_INVALID_STATE', 'Crypto object has been finalized'); return id; }
// `object` uses the native object of `owner`, which stays alive while it does.
const owners = new WeakMap();
function share(object, owner) { const id = handle(owner); ids.set(object, id); owners.set(object, owner); return object; }
function release(object) {
  const id = ids.get(object);
  if (id === undefined) return;
  ids.delete(object);
  if (owners.has(object)) { owners.delete(object); return; }
  finalizers.unregister(object); call('release', [id]);
}
function name(value, field = 'algorithm') { if (typeof value !== 'string') throw invalid(field, 'a string'); if (value.includes('\0')) throw error('ERR_INVALID_ARG_VALUE', `${field} must not contain null bytes`, TypeError); return value; }
// Node's argument errors and validators (lib/internal/errors.js, lib/internal/validators.js),
// with the same codes, classes and messages, since callers and tests match on them.
const { codes: { ERR_INVALID_ARG_TYPE: InvalidArgType } } = require('internal/path_events/support');
const inspect = value => require('util').inspect(value);
function separated(text) { let result = '', i = text.length; const start = text[0] === '-' ? 1 : 0; for (; i >= start + 4; i -= 3) result = `_${text.slice(i - 3, i)}${result}`; return `${text.slice(0, i)}${result}`; }
const codes = {
  ERR_INVALID_ARG_TYPE: (name, expected, value) => new InvalidArgType(name, expected, value),
  ERR_INVALID_ARG_VALUE(name, value, reason = 'is invalid') { let received = inspect(value); if (received.length > 128) received = `${received.slice(0, 128)}...`; return error('ERR_INVALID_ARG_VALUE', `The ${name.includes('.') ? 'property' : 'argument'} '${name}' ${reason}. Received ${received}`, TypeError); },
  ERR_OUT_OF_RANGE(name, range, value, replace = false) {
    let received;
    if (Number.isInteger(value) && Math.abs(value) > 2 ** 32) received = separated(String(value));
    else if (typeof value === 'bigint') { received = String(value); if (value > 2n ** 32n || value < -(2n ** 32n)) received = separated(received); received += 'n'; }
    else received = inspect(value);
    return error('ERR_OUT_OF_RANGE', `${replace ? name : `The value of "${name}" is out of range.`} It must be ${range}. Received ${received}`, RangeError);
  },
  ERR_MISSING_PASSPHRASE: (message = 'Passphrase required for encrypted key') => error('ERR_MISSING_PASSPHRASE', message, TypeError),
  ERR_MISSING_OPTION: option => error('ERR_MISSING_OPTION', `${option} is required`, TypeError),
  ERR_INCOMPATIBLE_OPTION_PAIR: (a, b) => error('ERR_INCOMPATIBLE_OPTION_PAIR', `Option "${a}" cannot be used in combination with option "${b}"`, TypeError),
  ERR_INVALID_THIS: type => error('ERR_INVALID_THIS', `Value of "this" must be of type ${type}`, TypeError),
  ERR_ILLEGAL_CONSTRUCTOR: () => error('ERR_ILLEGAL_CONSTRUCTOR', 'Illegal constructor', TypeError),
  ERR_UNKNOWN_ENCODING: encoding => error('ERR_UNKNOWN_ENCODING', `Unknown encoding: ${encoding}`, TypeError),
  ERR_CRYPTO_HASH_FINALIZED: () => error('ERR_CRYPTO_HASH_FINALIZED', 'Digest already called'),
  ERR_CRYPTO_HASH_UPDATE_FAILED: () => error('ERR_CRYPTO_HASH_UPDATE_FAILED', 'Hash update failed'),
  ERR_CRYPTO_INVALID_DIGEST: digest => error('ERR_CRYPTO_INVALID_DIGEST', `Invalid digest: ${digest}`, TypeError),
  ERR_CRYPTO_INVALID_STATE: operation => error('ERR_CRYPTO_INVALID_STATE', `Invalid state for operation ${operation}`),
  ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE: (type, expected) => error('ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE', `Invalid key object type ${type}, expected ${expected}.`, TypeError),
  ERR_CRYPTO_INCOMPATIBLE_KEY: (name, reason) => error('ERR_CRYPTO_INCOMPATIBLE_KEY', `Incompatible ${name}: ${reason}`),
  ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS: (encoding, reason) => error('ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS', `The selected key encoding ${encoding} ${reason}.`),
  ERR_CRYPTO_ECDH_INVALID_FORMAT: format => error('ERR_CRYPTO_ECDH_INVALID_FORMAT', `Invalid ECDH format: ${format}`, TypeError),
  ERR_CRYPTO_ENGINE_UNKNOWN: id => error('ERR_CRYPTO_ENGINE_UNKNOWN', `Engine "${id}" was not found`),
  ERR_CRYPTO_SIGN_KEY_REQUIRED: () => error('ERR_CRYPTO_SIGN_KEY_REQUIRED', 'No key provided to sign'),
  ERR_CRYPTO_SCRYPT_NOT_SUPPORTED: () => error('ERR_CRYPTO_SCRYPT_NOT_SUPPORTED', 'Scrypt algorithm not supported'),
  ERR_CRYPTO_INVALID_JWK: (message = 'Invalid JWK data') => error('ERR_CRYPTO_INVALID_JWK', message, TypeError),
  // Errors that Node raises from C++ (src/node_errors.h), with their default messages.
  ERR_CRYPTO_INVALID_IV: (message = 'Invalid initialization vector') => error('ERR_CRYPTO_INVALID_IV', message, TypeError),
  ERR_CRYPTO_INVALID_KEYLEN: (message = 'Invalid key length') => error('ERR_CRYPTO_INVALID_KEYLEN', message, RangeError),
  ERR_CRYPTO_INVALID_AUTH_TAG: (message = 'Invalid authentication tag') => error('ERR_CRYPTO_INVALID_AUTH_TAG', message, TypeError),
  ERR_CRYPTO_INVALID_SCRYPT_PARAMS: (message = 'Invalid scrypt params') => error('ERR_CRYPTO_INVALID_SCRYPT_PARAMS', message, RangeError),
  ERR_CRYPTO_UNKNOWN_CIPHER: (message = 'Unknown cipher') => error('ERR_CRYPTO_UNKNOWN_CIPHER', message),
  ERR_CRYPTO_UNKNOWN_DH_GROUP: (message = 'Unknown DH group') => error('ERR_CRYPTO_UNKNOWN_DH_GROUP', message),
  ERR_CRYPTO_INVALID_CURVE: (message = 'Invalid EC curve name') => error('ERR_CRYPTO_INVALID_CURVE', message, TypeError),
  ERR_CRYPTO_OPERATION_FAILED: (message = 'Operation failed') => error('ERR_CRYPTO_OPERATION_FAILED', message),
  ERR_CRYPTO_INVALID_DIGEST_DEFAULT: () => error('ERR_CRYPTO_INVALID_DIGEST', 'Invalid digest', TypeError),
  ERR_CRYPTO_UNSUPPORTED_OPERATION_DEFAULT: () => error('ERR_CRYPTO_UNSUPPORTED_OPERATION', 'Unsupported crypto operation'),
  ERR_CRYPTO_INVALID_KEYPAIR: (message = 'Invalid key pair') => error('ERR_CRYPTO_INVALID_KEYPAIR', message, RangeError),
  ERR_CRYPTO_INVALID_KEYTYPE: (message = 'Invalid key type') => error('ERR_CRYPTO_INVALID_KEYTYPE', message, RangeError),
  ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY: () => error('ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY', 'Public key is not valid for specified curve'),
  ERR_CRYPTO_INVALID_STATE_MESSAGE: message => error('ERR_CRYPTO_INVALID_STATE', message),
  // C++ THROW_ERR_* with an explicit message.
  ERR_INVALID_ARG_TYPE_MESSAGE: message => error('ERR_INVALID_ARG_TYPE', message, TypeError),
  ERR_INVALID_ARG_VALUE_MESSAGE: message => error('ERR_INVALID_ARG_VALUE', message, TypeError),
  ERR_OUT_OF_RANGE_MESSAGE: message => error('ERR_OUT_OF_RANGE', message, RangeError),
};
const isView = ArrayBuffer.isView;
// Byte lengths from the intrinsic getters, which own properties cannot shadow.
const getter = (object, key) => Function.prototype.call.bind(Object.getOwnPropertyDescriptor(object, key).get);
const typedArrayByteLength = getter(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength'), dataViewByteLength = getter(DataView.prototype, 'byteLength');
const arrayBufferByteLength = getter(ArrayBuffer.prototype, 'byteLength');
const sharedArrayBufferByteLength = typeof SharedArrayBuffer === 'undefined' ? undefined : getter(SharedArrayBuffer.prototype, 'byteLength');
function byteLength(value) { if (value instanceof DataView) return dataViewByteLength(value); if (isView(value)) return typedArrayByteLength(value); if (value instanceof ArrayBuffer) return arrayBufferByteLength(value); return sharedArrayBufferByteLength(value); }
const validate = {
  string(value, name) { if (typeof value !== 'string') throw codes.ERR_INVALID_ARG_TYPE(name, 'string', value); },
  number(value, name, min, max) {
    if (typeof value !== 'number') throw codes.ERR_INVALID_ARG_TYPE(name, 'number', value);
    if ((min != null && value < min) || (max != null && value > max) || ((min != null || max != null) && Number.isNaN(value)))
      throw codes.ERR_OUT_OF_RANGE(name, `${min != null ? `>= ${min}` : ''}${min != null && max != null ? ' && ' : ''}${max != null ? `<= ${max}` : ''}`, value);
  },
  integer(value, name, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
    if (typeof value !== 'number') throw codes.ERR_INVALID_ARG_TYPE(name, 'number', value);
    if (!Number.isInteger(value)) throw codes.ERR_OUT_OF_RANGE(name, 'an integer', value);
    if (value < min || value > max) throw codes.ERR_OUT_OF_RANGE(name, `>= ${min} && <= ${max}`, value);
  },
  int32(value, name, min = -2147483648, max = 2147483647) { validate.integer(value, name, min, max); },
  uint32(value, name, positive = false) { validate.integer(value, name, positive ? 1 : 0, 4294967295); },
  boolean(value, name) { if (typeof value !== 'boolean') throw codes.ERR_INVALID_ARG_TYPE(name, 'boolean', value); },
  function(value, name) { if (typeof value !== 'function') throw codes.ERR_INVALID_ARG_TYPE(name, 'Function', value); },
  // options: { nullable, array, function }
  object(value, name, options) {
    if (value === null ? !(options && options.nullable) : Array.isArray(value) ? !(options && options.array) :
      typeof value !== 'object' && !(typeof value === 'function' && options && options.function)) throw codes.ERR_INVALID_ARG_TYPE(name, 'Object', value);
  },
  oneOf(value, name, oneOf) { if (!oneOf.includes(value)) throw codes.ERR_INVALID_ARG_VALUE(name, value, 'must be one of: ' + oneOf.map(v => typeof v === 'string' ? `'${v}'` : String(v)).join(', ')); },
  buffer(value, name = 'buffer') { if (!isView(value)) throw codes.ERR_INVALID_ARG_TYPE(name, ['Buffer', 'TypedArray', 'DataView'], value); },
  encoding(data, encoding) { if (typeof encoding === 'string' && /^hex$/i.test(encoding) && data.length % 2 !== 0) throw codes.ERR_INVALID_ARG_VALUE('encoding', encoding, `is invalid for data of length ${data.length}`); },
  // lib/internal/crypto/util.js getArrayBufferOrView
  bufferSource(value, name, encoding) {
    if (isAnyArrayBuffer(value)) return value;
    if (typeof value === 'string') { if (encoding === 'buffer') encoding = 'utf8'; return bufferFrom(value, encoding); }
    if (!isView(value)) throw codes.ERR_INVALID_ARG_TYPE(name, ['string', 'ArrayBuffer', 'Buffer', 'TypedArray', 'DataView'], value);
    return value;
  },
};
// internal/crypto/util's kHandle: the native handle slot of Hash and friends.
const kHandle = Symbol('kHandle');
module.exports = { kHandle, Buffer, error, invalid, integer, callback, bytes, binary, packed, normalize, call, submit, output, attach, share, handle, release, name, codes, validate, isAnyArrayBuffer, byteLength };
