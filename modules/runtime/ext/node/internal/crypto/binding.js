'use strict';

// The parts of Node's internalBinding('crypto') (src/crypto/*.cc, Node.js
// main ce7aaf1c) that the ported lib/internal/crypto modules call, written
// over the runtime's native crypto operations (host.crypto). Constants keep
// Node's values. Jobs follow CryptoJob: kCryptoJobSync returns [err, result],
// kCryptoJobAsync calls ondone, and kCryptoJobWebCrypto returns a promise that
// rejects with an OperationError DOMException whose cause is the failure.

const {
  ArrayBufferPrototypeSlice,
  ArrayIsArray,
  MathCeil,
  MathFloor,
  ObjectDefineProperty,
  ObjectPrototypeHasOwnProperty,
  Promise,
  SafeSet,
  SafeWeakMap,
  StringPrototypeToLowerCase,
  StringPrototypeSplit,
  Symbol,
  TypeError,
} = require('internal/per_context/primordials');

const c = require('internal/crypto_core');
const { Buffer, call, packed } = c;
const host = require('internal/host');

const kCryptoJobAsync = 0;
const kCryptoJobSync = 1;
const kCryptoJobWebCrypto = 2;

const kKeyTypeSecret = 0;
const kKeyTypePublic = 1;
const kKeyTypePrivate = 2;

const kKeyFormatDER = 0;
const kKeyFormatPEM = 1;
const kKeyFormatJWK = 2;
const kKeyFormatRawPublic = 3;
const kKeyFormatRawPrivate = 4;
const kKeyFormatRawSeed = 5;
const kKeyFormatStore = 6;

const kKeyEncodingPKCS1 = 0;
const kKeyEncodingPKCS8 = 1;
const kKeyEncodingSPKI = 2;
const kKeyEncodingSEC1 = 3;

const kWebCryptoKeyFormatRaw = 0;
const kWebCryptoKeyFormatPKCS8 = 1;
const kWebCryptoKeyFormatSPKI = 2;
const kWebCryptoKeyFormatJWK = 3;

const kWebCryptoCipherEncrypt = 0;
const kWebCryptoCipherDecrypt = 1;

const kSignJobModeSign = 0;
const kSignJobModeVerify = 1;

const kSigEncDER = 0;
const kSigEncP1363 = 1;

const kKeyVariantRSA_SSA_PKCS1_v1_5 = 0;
const kKeyVariantRSA_PSS = 1;
const kKeyVariantRSA_OAEP = 2;

const kTypeArgon2d = 0;
const kTypeArgon2i = 1;
const kTypeArgon2id = 2;

const RSA_PKCS1_PSS_PADDING = 6;
const POINT_CONVERSION_COMPRESSED = 2;
const POINT_CONVERSION_UNCOMPRESSED = 4;

// AESKeyVariant: CTR, CBC, GCM, KW, OCB, each for 128, 192 and 256 bit keys.
const kAesModes = ['ctr', 'cbc', 'gcm', 'wrap', 'ocb'];
const aesVariants = {};
for (let mode = 0; mode < kAesModes.length; mode++) {
  const name = ['CTR', 'CBC', 'GCM', 'KW', 'OCB'][mode];
  for (let size = 0; size < 3; size++)
    aesVariants[`kKeyVariantAES_${name}_${128 + size * 64}`] = mode * 3 + size;
}

function crypto() { return require('crypto'); }

// --- KeyObjectHandle -------------------------------------------------------

// A handle holds a secret's bytes or a native key. Handles made from another
// handle's key share it with c.share, which keeps the owner alive.
const handleState = new SafeWeakMap();

function stateOf(handle) {
  const state = handleState.get(handle);
  if (state === undefined) throw new TypeError('Illegal invocation');
  return state;
}

function adopt(target, type, source) {
  const state = stateOf(target);
  state.type = type;
  if (type === kKeyTypeSecret) state.secret = stateOf(source).secret;
  else c.share(target, source);
}

function adoptKeyObject(target, keyObject) {
  adopt(target, typeEnum(c.keyObjectType(keyObject)), c.keyObjectHandle(keyObject));
}

function typeEnum(name) {
  return name === 'secret' ? kKeyTypeSecret : name === 'public' ? kKeyTypePublic : kKeyTypePrivate;
}
function typeName(type) {
  return type === kKeyTypeSecret ? 'secret' : type === kKeyTypePublic ? 'public' : 'private';
}

function secretBytes(value) {
  if (value instanceof KeyObjectHandle) return own(stateOf(value).secret);
  return Buffer.from(c.bytes(value, undefined, 'key'));
}

const kEncodingNames = ['pkcs1', 'pkcs8', 'spki', 'sec1'];
const kRawFormats = { [kKeyFormatRawPublic]: 'raw-public', [kKeyFormatRawPrivate]: 'raw-private', [kKeyFormatRawSeed]: 'raw-seed' };

class KeyObjectHandle {
  constructor() {
    handleState.set(this, { type: undefined, secret: undefined });
  }

  // init(type, data[, format, encodingOrName, passphrase, namedCurve]):
  // KeyObjectHandle::Init.
  init(type, data, format, encoding, passphrase, namedCurve) {
    const state = stateOf(this);
    if (type === kKeyTypeSecret) {
      if (format === kKeyFormatJWK) {
        if (data === null || typeof data !== 'object' || data.kty !== 'oct' || typeof data.k !== 'string')
          throw c.error('ERR_CRYPTO_INVALID_JWK', 'Invalid JWK secret key format', TypeError);
        state.secret = own(Buffer.from(data.k, 'base64url'));
      } else {
        state.secret = secretBytes(data);
      }
      state.type = kKeyTypeSecret;
      return;
    }
    if (data instanceof KeyObjectHandle) {
      // The public half of a private key (or the key itself).
      const source = stateOf(data);
      if (type === kKeyTypePublic && source.type === kKeyTypePrivate) {
        adoptKeyObject(this, c.keyFromHandle('public', call('keyPublic', [c.handle(data)])));
      } else {
        adopt(this, source.type, data);
      }
      return;
    }
    const name = typeName(type);
    let prepared;
    switch (format) {
      case kKeyFormatDER:
      case kKeyFormatPEM:
        prepared = {
          format: format === kKeyFormatDER ? 'der' : 'pem',
          type: encoding == null ? undefined : kEncodingNames[encoding],
          data: c.bytes(data, undefined, 'key'),
          passphrase: passphrase == null ? undefined : c.bytes(passphrase, undefined, 'passphrase'),
        };
        break;
      case kKeyFormatJWK:
        prepared = { format: 'jwk', data };
        break;
      case kKeyFormatRawPublic:
      case kKeyFormatRawPrivate:
      case kKeyFormatRawSeed:
        prepared = { raw: { key: data, format: kRawFormats[format], asymmetricKeyType: encoding, namedCurve: namedCurve ?? undefined } };
        break;
      default:
        throw c.error('ERR_INVALID_ARG_VALUE', 'Invalid key format', TypeError);
    }
    adoptKeyObject(this, c.importKeyObject(prepared, name));
  }

  getKeyType() { return stateOf(this).type; }

  getSymmetricKeySize() { return stateOf(this).secret.length; }

  getAsymmetricKeyType() { return c.keyObjectAsymmetricType(view(this)); }

  // KeyObjectHandle::GetKeyDetail: fills `target` with the key's details.
  keyDetail(target) {
    const details = c.keyObjectDetails(view(this));
    for (const key of ['modulusLength', 'publicExponent', 'hashAlgorithm', 'mgf1HashAlgorithm', 'saltLength', 'divisorLength', 'namedCurve']) {
      if (details[key] === undefined) continue;
      // The public exponent is its big-endian bytes, as GetRsaKeyDetail returns it.
      target[key] = key === 'publicExponent' ? bigEndian(details[key]) : details[key];
    }
    return target;
  }

  equals(other) {
    const a = stateOf(this), b = stateOf(other);
    if (a.type !== b.type) return false;
    if (a.type === kKeyTypeSecret) return a.secret.length === b.secret.length && crypto().timingSafeEqual(a.secret, b.secret);
    return c.keyObjectEquals(view(this), view(other));
  }

  // export(): the secret; export(format, encoding, cipher, passphrase): DER or PEM.
  export(format, encoding, cipher, passphrase) {
    const state = stateOf(this);
    if (state.type === kKeyTypeSecret) return own(state.secret);
    const options = { format: format === kKeyFormatPEM ? 'pem' : 'der', type: kEncodingNames[encoding] };
    if (cipher != null) options.cipher = cipher;
    if (passphrase != null) options.passphrase = passphrase;
    const result = view(this).export(options);
    return typeof result === 'string' ? result : copy(result);
  }

  // ExportJWK: adds the key's members to `target`. RSA-PSS keys export as RSA.
  exportJwk(target, handleRsaPss) {
    const state = stateOf(this);
    let jwk;
    if (state.type === kKeyTypeSecret) {
      jwk = { kty: 'oct', k: state.secret.toString('base64url') };
    } else {
      const object = view(this);
      const type = c.keyObjectAsymmetricType(object);
      if (type === 'rsa-pss' && !handleRsaPss)
        throw c.error('ERR_CRYPTO_JWK_UNSUPPORTED_KEY_TYPE', 'Unsupported JWK Key Type.');
      jwk = object.export({ format: 'jwk' });
    }
    for (const key of Object.keys(jwk)) target[key] = jwk[key];
    return target;
  }

  // RawPublicKey, RawPrivateKey and RawSeed; a private key also has its public half.
  rawPublicKey() {
    const object = stateOf(this).type === kKeyTypePrivate ? publicView(this) : view(this);
    return rawExport(object, 'raw-public', 'Failed to get raw public key');
  }
  rawPrivateKey() { return rawExport(view(this), 'raw-private', 'Failed to get raw private key'); }
  rawSeed() { return rawExport(view(this), 'raw-seed', 'Failed to get raw seed'); }

  exportECPublicRaw(form) {
    const object = stateOf(this).type === kKeyTypePrivate ? publicView(this) : view(this);
    return copy(c.providerRawExport(object, { format: 'raw-public', type: form === POINT_CONVERSION_COMPRESSED ? 'compressed' : 'uncompressed' }));
  }

  exportECPrivateRaw() { return this.rawPrivateKey(); }

  // EVP_PKEY_check for private keys and EVP_PKEY_public_check for public ones.
  checkEcKeyData() {
    return !!call('keyCheck', [c.handle(this), stateOf(this).type === kKeyTypePrivate ? 1 : 0]);
  }
}

function rawExport(object, format, message) {
  try {
    return copy(c.providerRawExport(object, { format }));
  } catch {
    throw c.error('ERR_CRYPTO_OPERATION_FAILED', message);
  }
}

function bigEndian(value) {
  const hex = value.toString(16);
  return copy(Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex')).buffer;
}

function copy(value) {
  const bytes = new Uint8Array(value.byteLength);
  bytes.set(ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : new Uint8Array(value));
  return bytes;
}
// A Buffer that owns its whole ArrayBuffer (never a pool slab), since
// Node's callers hand TypedArrayPrototypeGetBuffer(result) to the page.
function own(value) {
  return Buffer.from(copy(value).buffer);
}

// A KeyObject over a handle, for the runtime's KeyObject helpers.
function view(handle) {
  const { type } = stateOf(handle);
  return c.keyObjectFromHandle(typeName(type), handle);
}
function publicView(handle) {
  return c.keyFromHandle('public', call('keyPublic', [c.handle(handle)]));
}

// A handle that owns `value`: a secret's bytes or a native key id.
function createHandle(type, value) {
  const handle = new KeyObjectHandle();
  const state = stateOf(handle);
  state.type = typeEnum(type);
  if (type === 'secret') state.secret = own(value);
  else c.attach(handle, value);
  return handle;
}
function handleSecret(handle) { return stateOf(handle).secret; }
function isKeyObjectHandle(value) { return handleState.has(value); }

// --- CryptoKey storage ------------------------------------------------------

const cryptoKeySlots = new SafeWeakMap();

function createCryptoKeyClass(callback) {
  class NativeCryptoKey {
    constructor(handle, algorithm, usagesMask, extractable, secondaryHandle, seedData) {
      cryptoKeySlots.set(this, [handle.getKeyType(), extractable, algorithm, usagesMask, handle, secondaryHandle, seedData]);
    }
  }
  return callback(NativeCryptoKey);
}

function getCryptoKeySlots(key) {
  const slots = cryptoKeySlots.get(key);
  return [slots[0], slots[1], slots[2], slots[3], slots[4], slots[5], slots[6]];
}

function isCryptoKey(value) { return cryptoKeySlots.has(value); }
host.types.isCryptoKey = isCryptoKey;

// --- Jobs -------------------------------------------------------------------

function operationError(cause) {
  const { lazyDOMException } = require('internal/crypto/node_util');
  return lazyDOMException('The operation failed for an operation-specific reason', { name: 'OperationError', cause });
}

// ToWebCryptoJobResult: Buffers resolve as their ArrayBuffer.
function webCryptoResult(value) {
  if (ArrayBuffer.isView(value)) {
    if (value.byteOffset === 0 && value.byteLength === value.buffer.byteLength) return value.buffer;
    return ArrayBufferPrototypeSlice(value.buffer, value.byteOffset, value.byteOffset + value.byteLength);
  }
  return value;
}

// ResolveWebCrypto: an own, non-enumerable `then` hides inherited thenables
// while the promise resolves.
function resolveWebCrypto(resolve, value) {
  let shadow = false;
  if (value !== null && typeof value === 'object' && !ObjectPrototypeHasOwnProperty(value, 'then')) {
    ObjectDefineProperty(value, 'then', { __proto__: null, value: undefined, configurable: true, writable: true, enumerable: false });
    shadow = true;
  }
  try { resolve(value); } finally { if (shadow) delete value.then; }
}

// The operations the native side runs on the thread pool; the rest are cheap
// and run in place.
const kWorkerOperations = new SafeSet(['random', 'pbkdf2', 'scrypt', 'hkdf', 'digest', 'cipherOnce', 'hmac',
  'keyImport', 'keyExport', 'keyGenerate', 'sign', 'verify', 'derive', 'keyType', 'keyBits', 'encrypt', 'decrypt',
  'argon2', 'encapsulate', 'decapsulate', 'kmac', 'turboshake']);

function exec(op, args) {
  if (!kWorkerOperations.has(op)) return call(op, args);
  return new Promise((resolve, reject) => {
    c.submit(op, args, (err, value) => { if (err) reject(err); else resolve(value); });
  });
}

const kWork = Symbol('kWork');

// Every job is { mode, work }: work(run) computes the result, calling
// run(op, args) for each native operation. Sync jobs run each operation in
// place; the others submit them to the thread pool.
class CryptoJob {
  constructor(mode, work) {
    this.mode = mode;
    this[kWork] = work;
    this.ondone = undefined;
  }

  run() {
    const work = this[kWork];
    if (this.mode === kCryptoJobSync) {
      let result;
      try {
        result = work((op, args) => call(op, args), true);
      } catch (err) {
        return [err, undefined];
      }
      return [undefined, result];
    }
    const promise = (async () => work(exec, false))();
    if (this.mode === kCryptoJobAsync) {
      promise.then((result) => this.ondone(undefined, result), (err) => this.ondone(c.normalize(err)));
      return;
    }
    return new Promise((resolve, reject) => {
      promise.then((result) => {
        let value;
        try { value = webCryptoResult(result); } catch (err) { reject(operationError(err)); return; }
        resolveWebCrypto(resolve, value);
      }, (err) => reject(operationError(c.normalize(err))));
    });
  }
}

function defineJob(name, prepare) {
  const Job = {
    [name]: class extends CryptoJob {
      constructor(mode, ...args) {
        super(mode, prepare(mode, ...args));
      }
    },
  }[name];
  return Job;
}

function bytesOf(value) {
  if (value === undefined || value === null) return Buffer.alloc(0);
  if (value instanceof KeyObjectHandle) return own(stateOf(value).secret);
  return Buffer.from(c.bytes(value, undefined, 'data'));
}
function keyId(handle) { return c.handle(handle); }
function truncateBits(data, bits) {
  const result = own(data);
  if (bits % 8 && result.length) result[result.length - 1] &= 0xff << (8 - bits % 8);
  return result;
}
function timingSafe(a, b) {
  a = Buffer.from(a); b = Buffer.from(b);
  return a.length === b.length && !!call('equal', [packed(a), packed(b)]);
}

// AESCipherTraits: CTR splits the input where the counter wraps, KW uses the
// RFC 3394 default IV, and AEAD modes carry the tag after the ciphertext.
const AESCipherJob = defineJob('AESCipherJob', (mode, cipherMode, key, data, variant, ivOrCounter, lengthOrTag, additionalData) => {
  const kind = kAesModes[MathFloor(variant / 3)];
  const cipher = `aes-${128 + (variant % 3) * 64}-${kind}`;
  const encrypt = cipherMode === kWebCryptoCipherEncrypt ? 1 : 0;
  const keyBytes = packed(bytesOf(key));
  const input = bytesOf(data);
  const iv = kind === 'wrap' ? Buffer.alloc(8, 0xa6) : bytesOf(ivOrCounter);
  // OCB takes 1 to 15 IV bytes, GCM any non-empty IV, CBC and CTR a block.
  const invalidIv = kind === 'ocb' ? iv.length === 0 || iv.length > 15 :
    kind === 'gcm' ? iv.length === 0 : kind !== 'wrap' && iv.length < 16;
  if (invalidIv) throw c.error('ERR_CRYPTO_INVALID_IV', 'Invalid initialization vector', TypeError);
  if (kind === 'ctr') {
    return async (run) => {
      const counter = Buffer.from(iv.subarray(0, 16));
      const bits = lengthOrTag;
      const blocks = BigInt(MathCeil(input.length / 16));
      const modulus = 1n << BigInt(bits);
      if (blocks > modulus) throw c.error('ERR_CRYPTO_OPERATION_FAILED', 'Counter would wrap');
      let value = 0n;
      for (const byte of counter) value = value << 8n | BigInt(byte);
      const remaining = modulus - (value & (modulus - 1n));
      const firstLength = remaining >= blocks ? input.length : Number(remaining) * 16;
      const first = await run('cipherOnce', [cipher, keyBytes, packed(counter), packed(input.subarray(0, firstLength)), encrypt]);
      if (firstLength === input.length) return first;
      value &= ~(modulus - 1n);
      for (let i = 15; i >= 0; i--) { counter[i] = Number(value & 255n); value >>= 8n; }
      const second = await run('cipherOnce', [cipher, keyBytes, packed(counter), packed(input.subarray(firstLength)), encrypt]);
      return Buffer.concat([Buffer.from(first), Buffer.from(second)]);
    };
  }
  if (kind === 'gcm' || kind === 'ocb') {
    const tagLength = lengthOrTag;
    const aad = additionalData === undefined ? undefined : packed(bytesOf(additionalData));
    return (run) => {
      let ciphertext = input, tag;
      if (!encrypt) {
        if (input.length < tagLength) throw c.error('ERR_CRYPTO_OPERATION_FAILED', 'Ciphertext is shorter than its tag');
        ciphertext = input.subarray(0, input.length - tagLength);
        tag = packed(input.subarray(input.length - tagLength));
      }
      return run('cipherOnce', [cipher, keyBytes, packed(iv), packed(ciphertext), encrypt, aad, tag, tagLength]);
    };
  }
  return (run) => run('cipherOnce', [cipher, keyBytes, packed(kind === 'wrap' ? iv : iv.subarray(0, 16)), packed(input), encrypt]);
});

const ChaCha20Poly1305CipherJob = defineJob('ChaCha20Poly1305CipherJob', (mode, cipherMode, key, data, iv, additionalData) => {
  const encrypt = cipherMode === kWebCryptoCipherEncrypt ? 1 : 0;
  const keyBytes = packed(bytesOf(key)), input = bytesOf(data), nonce = bytesOf(iv);
  const aad = additionalData === undefined ? undefined : packed(bytesOf(additionalData));
  if (nonce.length !== 12) throw c.error('ERR_CRYPTO_INVALID_IV', 'Invalid initialization vector', TypeError);
  return (run) => {
    let ciphertext = input, tag;
    if (!encrypt) {
      if (input.length < 16) throw c.error('ERR_CRYPTO_OPERATION_FAILED', 'Ciphertext is shorter than its tag');
      ciphertext = input.subarray(0, input.length - 16);
      tag = packed(input.subarray(input.length - 16));
    }
    return run('cipherOnce', ['chacha20-poly1305', keyBytes, packed(nonce), packed(ciphertext), encrypt, aad, tag, 16]);
  };
});

const RSACipherJob = defineJob('RSACipherJob', (mode, cipherMode, key, data, variant, hash, label) => {
  const input = packed(bytesOf(data));
  const labelBytes = label === undefined ? undefined : packed(bytesOf(label));
  return (run) => run(cipherMode === kWebCryptoCipherEncrypt ? 'encrypt' : 'decrypt', [keyId(key), input, 4, hash ?? 'sha1', labelBytes]);
});

function signatureSize(key) {
  const object = view(key);
  const type = c.keyObjectAsymmetricType(object);
  if (type !== 'ec' && type !== 'dsa') return 0;
  return MathCeil((type === 'dsa' ? call('keyQBits', [keyId(key), 'q']) : call('keyBits', [keyId(key)])) / 8);
}

// SignJob: the signature arguments follow SignConfiguration.
const SignJob = defineJob('SignJob', (mode, signMode, key, keyData, keyFormat, keyType, passphrase, data, digest, saltLength, padding, dsaEncoding, context, signature) => {
  const input = packed(bytesOf(data));
  const contextBytes = context === undefined ? undefined : packed(bytesOf(context));
  if (contextBytes !== undefined && contextBytes.byteLength > 255) throw c.error('ERR_OUT_OF_RANGE', 'context string must be at most 255 bytes', RangeError);
  const p1363 = dsaEncoding === kSigEncP1363;
  const size = p1363 ? signatureSize(key) : 0;
  const args = (sig) => [keyId(key), digest ?? '', input, sig, padding ?? 0, saltLength ?? -2147483648, contextBytes, 0];
  if (signMode === kSignJobModeSign) {
    return async (run) => {
      const result = Buffer.from(await run('sign', args(undefined)));
      return size ? require('internal/crypto_keys').signature(result, size, false) : result;
    };
  }
  let sig = bytesOf(signature);
  return async (run) => {
    if (size) {
      if (sig.length !== size * 2) return false;
      sig = require('internal/crypto_keys').signature(sig, size, true);
    }
    return !!(await run('verify', args(packed(sig)))) && !hasSmallOrderEdDsaPoint(key, sig);
  };
});

// ncrypto's EVPKeyPointer::hasSmallOrderEdDsaPoint: WebCrypto verification
// fails when the signature's R or the public key is a small-order point
// (the canonical subgroup plus non-canonical encodings of it).
const kEd25519SmallOrderPoints = [
  '0100000000000000000000000000000000000000000000000000000000000000',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  '0000000000000000000000000000000000000000000000000000000000000080',
  '0000000000000000000000000000000000000000000000000000000000000000',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85',
  '0100000000000000000000000000000000000000000000000000000000000080',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
];
const kEd448SmallOrderPoints = [
  `01${'00'.repeat(56)}`,
  `fe${'ff'.repeat(27)}fe${'ff'.repeat(27)}00`,
  '00'.repeat(57),
  `${'00'.repeat(56)}80`,
];
function hasSmallOrderEdDsaPoint(handle, signature) {
  const type = handle.getAsymmetricKeyType?.();
  const points = type === 'ed25519' ? kEd25519SmallOrderPoints : type === 'ed448' ? kEd448SmallOrderPoints : undefined;
  if (points === undefined) return false;
  const size = type === 'ed25519' ? 32 : 57;
  if (signature.length !== size * 2) return false;
  const hex = (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, size).toString('hex');
  if (points.includes(hex(signature))) return true;
  const publicKey = Buffer.from(handle.rawPublicKey());
  return publicKey.length === size && points.includes(hex(publicKey));
}

const HmacJob = defineJob('HmacJob', (mode, signMode, hash, key, data, signature) => {
  const args = [hash, packed(bytesOf(key)), packed(bytesOf(data))];
  if (signMode === kSignJobModeSign) return (run) => run('hmac', args);
  const expected = bytesOf(signature);
  return async (run) => timingSafe(await run('hmac', args), expected);
});

// KmacTraits::DeriveBits: OpenSSL's KMAC when its limits allow, otherwise
// (bit lengths, keys under 4 bytes) KMAC as cSHAKE("KMAC", S) over
// bytepad(encode_string(K)) || X || right_encode(L).
const KmacJob = defineJob('KmacJob', (mode, signMode, key, algorithm, customization, keyLength, outputLength, data, signature) => {
  const strength = algorithm === 'KMAC128' ? 128 : 256;
  const keyBytes = bytesOf(key), custom = bytesOf(customization), input = bytesOf(data);
  if (keyBytes.length > 512 || MathCeil(keyLength / 8) > 512 || custom.length > 512 || MathCeil(outputLength / 8) > 0xffffff / 8) {
    return () => { throw c.error('ERR_CRYPTO_OPERATION_FAILED', 'Deriving bits failed'); };
  }
  let mac;
  if (outputLength === 0) {
    mac = () => Buffer.alloc(0);
  } else if (outputLength % 8 || keyLength % 8 || keyBytes.length < 4) {
    if (keyBytes.length < MathCeil(keyLength / 8)) return () => { throw c.error('ERR_CRYPTO_OPERATION_FAILED', 'Deriving bits failed'); };
    const keyString = { bytes: keyBytes.subarray(0, MathCeil(keyLength / 8)), bits: keyLength };
    mac = cShake(strength, Buffer.from('KMAC'), custom, keyString, input, outputLength, true);
  } else {
    const args = [`KMAC-${strength}`, packed(keyBytes), packed(input), packed(custom), outputLength / 8];
    mac = (run) => run('kmac', args);
  }
  if (signMode === kSignJobModeSign) return mac;
  const expected = bytesOf(signature);
  return async (run) => timingSafe(await mac(run), expected);
});

const HKDFJob = defineJob('HKDFJob', (mode, hash, key, salt, info, length) => {
  const args = [hash, packed(bytesOf(key)), packed(bytesOf(salt)), packed(bytesOf(info)), length];
  return (run) => run('hkdf', args);
});

const PBKDF2Job = defineJob('PBKDF2Job', (mode, password, salt, iterations, length, hash) => {
  const args = [packed(bytesOf(password)), packed(bytesOf(salt)), iterations, length, hash];
  return (run) => run('pbkdf2', args);
});

const kArgon2Types = ['argon2d', 'argon2i', 'argon2id'];
const Argon2Job = defineJob('Argon2Job', (mode, message, nonce, parallelism, tagLength, memory, passes, secret, associatedData, type) => {
  const costs = Buffer.alloc(8);
  costs.writeUInt32LE(memory >>> 0, 0);
  costs.writeUInt32LE(passes >>> 0, 4);
  const args = [kArgon2Types[type], packed(bytesOf(message)), packed(bytesOf(nonce)), packed(bytesOf(secret)), packed(bytesOf(associatedData)), parallelism, tagLength, packed(costs)];
  return (run) => run('argon2', args);
});

const DHBitsJob = defineJob('DHBitsJob', (mode, publicKey, publicData, publicFormat, publicType, publicPassphrase, privateKey) => {
  return (run) => run('derive', [keyId(privateKey), keyId(publicKey)]);
});

function encapsulated(value) {
  const bytes = Buffer.from(value), length = bytes.readUInt32LE(0);
  return { sharedKey: copy(bytes.subarray(4, 4 + length)).buffer, ciphertext: copy(bytes.subarray(4 + length)).buffer };
}

const KEMEncapsulateJob = defineJob('KEMEncapsulateJob', (mode, key) => {
  return async (run) => encapsulated(await run('encapsulate', [keyId(key)]));
});

const KEMDecapsulateJob = defineJob('KEMDecapsulateJob', (mode, key, keyData, keyFormat, keyType, passphrase, ciphertext) => {
  const ct = packed(bytesOf(ciphertext));
  return (run) => run('decapsulate', [keyId(key), ct]);
});

const HashJob = defineJob('HashJob', (mode, algorithm, data, outputLength) => {
  const input = packed(bytesOf(data));
  const args = outputLength === undefined ? [algorithm, input] : [algorithm, input, MathCeil(outputLength / 8), 1];
  return (run) => run('digest', args);
});

// cSHAKE (NIST SP 800-185) over the provider's KECCAK-KMAC digests, which
// apply the cSHAKE padding, so the bytepad prefixes are absorbed as part of
// the message (Node's DeriveCShakeBits). An encoded string is
// left_encode(bitLength) || bytes, with bitLength free to be shorter than
// the bytes (KMAC keys of any bit length).
function encodeLength(value, left) {
  const bytes = [];
  do { bytes.unshift(value % 256); value = Math.floor(value / 256); } while (value);
  return Buffer.from(left ? [bytes.length, ...bytes] : [...bytes, bytes.length]);
}
function bytepad(rate, ...strings) {
  const parts = [encodeLength(rate, true)];
  for (const { bytes, bits } of strings) parts.push(encodeLength(bits, true), bytes);
  const prefix = Buffer.concat(parts);
  return Buffer.concat([prefix, Buffer.alloc((rate - prefix.length % rate) % rate)]);
}
function encodedString(bytes) { return { bytes, bits: bytes.length * 8 }; }
function cShake(strength, name, custom, key, data, length, appendLength) {
  if (length === 0) return Buffer.alloc(0);
  const rate = strength === 128 ? 168 : 136;
  const parts = [bytepad(rate, encodedString(name), encodedString(custom))];
  if (key !== undefined) parts.push(bytepad(rate, key));
  parts.push(data);
  if (appendLength) parts.push(encodeLength(length, false));
  const args = [`KECCAK-KMAC-${strength}`, packed(Buffer.concat(parts)), MathCeil(length / 8), 1];
  return async (run) => truncateBits(await run('digest', args), length);
}
const CShakeJob = defineJob('CShakeJob', (mode, algorithm, data, functionName, customization, outputLength) => {
  const work = cShake(algorithm === 'cSHAKE128' ? 128 : 256, bytesOf(functionName), bytesOf(customization), undefined, bytesOf(data), outputLength, false);
  return ArrayBuffer.isView(work) ? () => work : work;
});

// TurboShakeTraits / KangarooTwelveTraits (crypto_turboshake.cc): the
// TurboSHAKE sponge is native; the KangarooTwelve tree (RFC 9861 3.2) is
// built here over it.
function turboShakeArgs(strength, data, domain, length) { return [packed(data), strength, domain, length]; }
function unsupportedInFips() {
  if (call('getFips', [])) throw c.error('ERR_CRYPTO_UNSUPPORTED_OPERATION', 'Unsupported crypto operation');
}
const TurboShakeJob = defineJob('TurboShakeJob', (mode, algorithm, domainSeparation, outputLength, data) => {
  unsupportedInFips();
  const args = turboShakeArgs(algorithm === 'TurboSHAKE128' ? 128 : 256, bytesOf(data), domainSeparation, outputLength);
  return (run) => run('turboshake', args);
});
function lengthEncode(value) {
  const bytes = [];
  while (value > 0) { bytes.unshift(value % 256); value = Math.floor(value / 256); }
  return Buffer.from([...bytes, bytes.length]);
}
const kKangarooChunk = 8192;
const KangarooTwelveJob = defineJob('KangarooTwelveJob', (mode, algorithm, customization, outputLength, data) => {
  unsupportedInFips();
  const strength = algorithm === 'KT128' ? 128 : 256, cvLength = strength === 128 ? 32 : 64;
  const custom = bytesOf(customization);
  const s = Buffer.concat([bytesOf(data), custom, lengthEncode(custom.length)]);
  if (s.length <= kKangarooChunk) {
    const args = turboShakeArgs(strength, s, 0x07, outputLength);
    return (run) => run('turboshake', args);
  }
  const parts = [s.subarray(0, kKangarooChunk), Buffer.from([0x03, 0, 0, 0, 0, 0, 0, 0])];
  let blocks = 0;
  for (let offset = kKangarooChunk; offset < s.length; offset += kKangarooChunk, blocks++) {
    parts.push(Buffer.from(call('turboshake', turboShakeArgs(strength, s.subarray(offset, offset + kKangarooChunk), 0x0B, cvLength))));
  }
  parts.push(lengthEncode(blocks), Buffer.from([0xff, 0xff]));
  const args = turboShakeArgs(strength, Buffer.concat(parts), 0x06, outputLength);
  return (run) => run('turboshake', args);
});

// Key generation. In WebCrypto mode the result is the new CryptoKey or pair.
function cryptoKey(handle, algorithm, usagesMask, extractable) {
  const { InternalCryptoKey } = require('internal/crypto/keys');
  return new InternalCryptoKey(handle, algorithm, usagesMask, extractable);
}

const SecretKeyGenJob = defineJob('SecretKeyGenJob', (mode, bits, algorithm, usagesMask, extractable) => {
  const length = mode === kCryptoJobWebCrypto ? MathCeil(bits / 8) : bits >>> 3;
  return async (run) => {
    const data = truncateBits(await run('random', [length]), bits);
    const handle = createHandle('secret', data);
    if (mode !== kCryptoJobWebCrypto) return handle;
    return cryptoKey(handle, algorithm, usagesMask, extractable);
  };
});

function keyPairJob(name, args) {
  return defineJob(name, (mode, ...rest) => {
    const { type, options, algorithm, publicMask, privateMask, extractable } = args(...rest);
    const keygen = c.keygenArgs(type, options);
    return async (run) => {
      const id = await run('keyGenerate', keygen);
      const privateHandle = createHandle('private', id);
      const publicHandle = createHandle('public', await run('keyPublic', [keyId(privateHandle)]));
      return {
        publicKey: cryptoKey(publicHandle, algorithm, publicMask, true),
        privateKey: cryptoKey(privateHandle, algorithm, privateMask, extractable),
      };
    };
  });
}

const RsaKeyPairGenJob = keyPairJob('RsaKeyPairGenJob', (variant, modulusLength, publicExponent, algorithm, publicMask, privateMask, extractable) =>
  ({ type: 'rsa', options: { modulusLength, publicExponent }, algorithm, publicMask, privateMask, extractable }));
const EcKeyPairGenJob = keyPairJob('EcKeyPairGenJob', (namedCurve, paramEncoding, algorithm, publicMask, privateMask, extractable) =>
  ({ type: 'ec', options: { namedCurve }, algorithm, publicMask, privateMask, extractable }));
const NamedKeyPairGenJob = keyPairJob('NamedKeyPairGenJob', (name, algorithm, publicMask, privateMask, extractable) =>
  ({ type: StringPrototypeToLowerCase(name), options: {}, algorithm, publicMask, privateMask, extractable }));

// --- Process-wide state ----------------------------------------------------

function names(op) { return StringPrototypeSplit(call(op, []), '\n').filter((name) => name); }

let fipsGeneration = 0;
function noteFipsChange() { fipsGeneration++; }

function aliases(list) {
  const result = { __proto__: null };
  for (let i = 0; i < list.length; i++) result[list[i]] = i;
  return result;
}

function getPqcKeyTypes() {
  const result = [];
  for (const name of ['ML-DSA-44', 'ML-DSA-65', 'ML-DSA-87', 'ML-KEM-512', 'ML-KEM-768', 'ML-KEM-1024']) {
    if (call('providerAvailable', ['key', name])) result.push(name);
  }
  return result;
}

module.exports = {
  // Constants.
  kCryptoJobAsync,
  kCryptoJobSync,
  kCryptoJobWebCrypto,
  kKeyTypeSecret,
  kKeyTypePublic,
  kKeyTypePrivate,
  kKeyFormatDER,
  kKeyFormatPEM,
  kKeyFormatJWK,
  kKeyFormatRawPublic,
  kKeyFormatRawPrivate,
  kKeyFormatRawSeed,
  kKeyFormatStore,
  kKeyEncodingPKCS1,
  kKeyEncodingPKCS8,
  kKeyEncodingSPKI,
  kKeyEncodingSEC1,
  kWebCryptoKeyFormatRaw,
  kWebCryptoKeyFormatPKCS8,
  kWebCryptoKeyFormatSPKI,
  kWebCryptoKeyFormatJWK,
  kWebCryptoCipherEncrypt,
  kWebCryptoCipherDecrypt,
  kSignJobModeSign,
  kSignJobModeVerify,
  kSigEncDER,
  kSigEncP1363,
  kKeyVariantRSA_SSA_PKCS1_v1_5,
  kKeyVariantRSA_PSS,
  kKeyVariantRSA_OAEP,
  kTypeArgon2d,
  kTypeArgon2i,
  kTypeArgon2id,
  RSA_PKCS1_PSS_PADDING,
  POINT_CONVERSION_COMPRESSED,
  POINT_CONVERSION_UNCOMPRESSED,
  ...aesVariants,

  // Keys.
  KeyObjectHandle,
  createCryptoKeyClass,
  getCryptoKeySlots,
  isCryptoKey,

  // Jobs.
  AESCipherJob,
  Argon2Job,
  ChaCha20Poly1305CipherJob,
  CShakeJob,
  DHBitsJob,
  EcKeyPairGenJob,
  HashJob,
  HKDFJob,
  HmacJob,
  KEMDecapsulateJob,
  KEMEncapsulateJob,
  KangarooTwelveJob,
  KmacJob,
  NamedKeyPairGenJob,
  PBKDF2Job,
  RSACipherJob,
  RsaKeyPairGenJob,
  SecretKeyGenJob,
  TurboShakeJob,
  SignJob,

  // Process-wide state.
  getCiphers: () => names('ciphers'),
  getHashes: () => names('hashes'),
  getCurves: () => names('curves'),
  getMacs: () => names('macs'),
  getCachedAliases: () => aliases(names('hashes')),
  getCachedMacAliases: () => aliases(names('macs')),
  getFipsCrypto: () => call('getFips', []),
  getFipsCryptoGeneration: () => fipsGeneration,
  getOpenSSLSecLevelCrypto: () => crypto().getOpenSSLSecLevel?.(),
  getPqcKeyTypes,
  secureHeapUsed: () => call('secureHeapUsed', []),
  setEngine: (id, flags) => call('setEngine', [id, flags]),
  timingSafeEqual: (a, b) => timingSafe(a, b),

  // Runtime internals for internal/crypto/keys and crypto.js.
  createHandle,
  handleSecret,
  isKeyObjectHandle,
  noteFipsChange,
};
