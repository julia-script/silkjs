'use strict';
const c = require('internal/crypto_core');
const { Buffer, packed, submit, handle, release } = c;
const crypto = require('crypto');
const codecs = require('internal/crypto_keys');
const records = new WeakMap(), token = Symbol('CryptoKey');
require('internal/host').types.isCryptoKey = value => records.has(value);
// Node treats detached ArrayBuffers and typed arrays as empty, but rejects a
// detached DataView: V8 still throws from its byteLength getter, which now
// reports 0 under the current spec.
function binary(value, name) { if (value instanceof DataView && value.buffer.detached) throw new TypeError('Cannot perform get DataView.prototype.byteLength on a detached ArrayBuffer'); if ((ArrayBuffer.isView(value) || value instanceof ArrayBuffer) && value.byteLength === 0) return Buffer.alloc(0); return c.binary(value, name); }
function exception(name, message) { if (typeof DOMException === 'function') return new DOMException(message, name); const e = new Error(message); e.name = name; return e; }
function fail(name, message) { throw exception(name, message); }
function brand(receiver, expected, name) {
  if (receiver !== expected) throw c.error('ERR_INVALID_THIS', `Value of "this" must be of type ${name}`, TypeError);
}
function clone(value) { if (ArrayBuffer.isView(value)) return new Uint8Array(value); if (Array.isArray(value)) return value.map(clone); if (value && typeof value === 'object') { const result = {}; for (const k of Object.keys(value)) result[k] = clone(value[k]); return result; } return value; }
class CryptoKey {
  constructor(secret = undefined, key, algorithm, extractable, usages) { if (secret !== token) throw c.error('ERR_ILLEGAL_CONSTRUCTOR', 'Illegal constructor', TypeError); records.set(this, { key, algorithm: clone(algorithm), extractable: !!extractable, usages: [...usages] }); }
  get type() { return record(this, true).key.type; }
  get extractable() { return record(this, true).extractable; }
  get algorithm() { return clone(record(this, true).algorithm); }
  get usages() { return [...record(this, true).usages]; }
}
function record(key, receiver = false) { const r = records.get(key); if (!r) throw receiver ? c.error('ERR_INVALID_THIS', 'Value of "this" must be of type CryptoKey', TypeError) : new TypeError('Expected a CryptoKey'); return r; }
function unwrap(key) { return records.get(key)?.key; }
const canonical = ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512', 'SHA3-256', 'SHA3-384', 'SHA3-512', 'cSHAKE128', 'cSHAKE256', 'HMAC', 'KMAC128', 'KMAC256', 'AES-CBC', 'AES-CTR', 'AES-GCM', 'AES-KW', 'AES-OCB', 'ChaCha20-Poly1305', 'RSA-OAEP', 'RSA-PSS', 'RSASSA-PKCS1-v1_5', 'ECDSA', 'ECDH', 'Ed25519', 'Ed448', 'X25519', 'X448', 'PBKDF2', 'HKDF', 'Argon2d', 'Argon2i', 'Argon2id', 'ML-DSA-44', 'ML-DSA-65', 'ML-DSA-87', 'ML-KEM-512', 'ML-KEM-768', 'ML-KEM-1024'];
function algorithm(value) { if (typeof value === 'string') value = { name: value }; if (!value || typeof value.name !== 'string') throw new TypeError('Algorithm must have a name'); const name = canonical.find(n => n.toLowerCase() === value.name.toLowerCase()); if (!name) fail('NotSupportedError', `Unrecognized algorithm: ${value.name}`); return { ...value, name }; }
function digestName(value) { const a = algorithm(value); if (!a.name.startsWith('SHA')) fail('NotSupportedError', 'Unsupported digest'); return a.name.startsWith('SHA3-') ? a.name.toLowerCase() : a.name.toLowerCase().replace('-', ''); }
function isDerivation(name) { return name === 'PBKDF2' || name === 'HKDF' || name.startsWith('Argon2'); }
function isSecret(name) { return name.startsWith('AES-') || name === 'ChaCha20-Poly1305' || name === 'HMAC' || name.startsWith('KMAC') || isDerivation(name); }
function isModern(name) { return name.startsWith('ML-') || name.startsWith('KMAC') || name.startsWith('Argon2') || name === 'ChaCha20-Poly1305'; }
function blockSize(hash) { if (hash.startsWith('SHA3-')) fail('NotSupportedError', 'Explicit algorithm length member is required'); return ['SHA-384', 'SHA-512'].includes(hash) ? 1024 : 512; }
function optionalBytes(value) { return value === undefined ? Buffer.alloc(0) : Buffer.from(binary(value)); }
function bitLength(value, field = 'outputLength') { return count(value, field, 0, 0xfffffff8); }
function truncateBits(data, bits) { const result = Buffer.from(data); if (bits % 8 && result.length) result[result.length - 1] &= 255 << (8 - bits % 8); return packed(result); }
function secretDescriptor(a, data) {
  const descriptor = { name: a.name };
  if (a.name.startsWith('AES-')) { if (![16, 24, 32].includes(data.length)) fail('DataError', 'Invalid AES key length'); descriptor.length = data.length * 8; }
  else if (a.name === 'ChaCha20-Poly1305') { if (data.length !== 32) fail('DataError', 'Invalid ChaCha20 key length'); }
  else if (a.name === 'HMAC' || a.name.startsWith('KMAC')) {
    const length = a.length === undefined ? data.length * 8 : bitLength(a.length, 'length');
    if (Math.ceil(length / 8) !== data.length || a.name === 'HMAC' && !length) fail('DataError', 'Invalid MAC key length');
    descriptor.length = length;
    if (a.name === 'HMAC') { const hash = algorithm(a.hash); digestName(hash); descriptor.hash = { name: hash.name }; }
  }
  return descriptor;
}
function count(value, name, min = 0, max = 0x7fffffff) { if (!Number.isInteger(value) || value < min || value > max) fail('OperationError', `${name} is out of range`); return value; }
function work(op, args) { return new Promise((resolve, reject) => { submit(op, args, (e, result) => e ? reject(exception('OperationError', e.message)) : resolve(result)); }); }
function allowed(a, type) { if (a === 'HMAC' || a.startsWith('KMAC')) return ['sign', 'verify']; if (a === 'AES-KW') return ['wrapKey', 'unwrapKey']; if (a.startsWith('AES-') || a === 'ChaCha20-Poly1305') return ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']; if (isDerivation(a)) return ['deriveKey', 'deriveBits']; if (a.startsWith('ML-KEM-')) return type === 'private' ? ['decapsulateBits', 'decapsulateKey'] : ['encapsulateBits', 'encapsulateKey']; if (a === 'ECDH' || a === 'X25519' || a === 'X448') return type === 'private' ? ['deriveKey', 'deriveBits'] : []; if (a === 'RSA-OAEP') return type === 'private' ? ['decrypt', 'unwrapKey'] : ['encrypt', 'wrapKey']; return type === 'private' ? ['sign'] : ['verify']; }
function checkUsages(name, type, usages, requireNonempty = true) { if (!Array.isArray(usages)) throw new TypeError('keyUsages must be an array'); const permit = allowed(name, type); for (const u of usages) if (!permit.includes(u)) fail('SyntaxError', `Unsupported key usage: ${u}`); if (requireNonempty && type !== 'public' && !usages.length) fail('SyntaxError', 'Key usages must not be empty'); return [...new Set(usages)]; }
function use(key, a, usage, type) { const r = record(key); if (r.algorithm.name !== a.name || !r.usages.includes(usage) || type && r.key.type !== type) fail('InvalidAccessError', 'Key does not support this operation'); return r; }
const curves = { 'P-256': { name: 'prime256v1', size: 32 }, 'P-384': { name: 'secp384r1', size: 48 }, 'P-521': { name: 'secp521r1', size: 66 } };
async function exportNative(key, privateKey) { return Buffer.from(await work('keyExport', [handle(key), 'DER', privateKey ? 'PrivateKeyInfo' : 'SubjectPublicKeyInfo', privateKey ? 1 : 0, '', packed(Buffer.alloc(0))])); }
async function jwkOf(key) { const privateKey = key.type === 'private'; const encoded = await exportNative(key, privateKey); const publicEncoded = privateKey ? await exportNative(key, false) : undefined; return codecs.exportJwk(key, encoded, publicEncoded); }
function jwkAlgorithm(a) { if (a.hash && a.hash.name.startsWith('SHA3-')) return undefined; const hash = a.hash && a.hash.name.replace('SHA-', ''); if (a.name === 'HMAC') return `HS${hash}`; if (a.name.startsWith('AES-')) return `A${a.length}${a.name.slice(4)}`; if (a.name === 'RSA-PSS') return `PS${hash}`; if (a.name === 'RSASSA-PKCS1-v1_5') return `RS${hash}`; if (a.name === 'RSA-OAEP') return hash === '1' ? 'RSA-OAEP' : `RSA-OAEP-${hash}`; return undefined; }
async function derive(alg, baseKey, length, usage) {
  const a = algorithm(alg), r = use(baseKey, a, usage);
  if (length !== null) count(length, 'length', 0);
  if (length !== null && length % 8) fail('OperationError', 'length must be a multiple of eight');
  if (a.name.startsWith('Argon2')) {
    if (length === null || length < 32) fail('OperationError', 'Argon2 length must be at least 32 bits');
    const nonce = optionalBytes(a.nonce), parallelism = count(a.parallelism, 'parallelism', 1, 0xffffff);
    if (nonce.length < 8 || a.version !== undefined && a.version !== 19) fail('OperationError', 'Invalid Argon2 parameters');
    const costs = Buffer.alloc(8); costs.writeUInt32LE(count(a.memory, 'memory', 8 * parallelism, 0xffffffff), 0); costs.writeUInt32LE(count(a.passes, 'passes', 1, 0xffffffff), 4);
    return work('argon2', [a.name.toLowerCase(), packed(r.key.export()), packed(nonce), packed(optionalBytes(a.secretValue)), packed(optionalBytes(a.associatedData)), parallelism, length / 8, packed(costs)]);
  }
  if (a.name === 'PBKDF2') { if (length === null || length === 0) fail('OperationError', 'PBKDF2 length must be positive'); return work('pbkdf2', [packed(r.key.export()), packed(binary(a.salt)), count(a.iterations, 'iterations', 1), length / 8, digestName(a.hash)]); }
  if (a.name === 'HKDF') { if (length === null) fail('OperationError', 'HKDF requires a length'); return work('hkdf', [digestName(a.hash), packed(r.key.export()), packed(binary(a.salt)), packed(binary(a.info)), length / 8]); }
  if (!['ECDH', 'X25519', 'X448'].includes(a.name) || r.key.type !== 'private') fail('NotSupportedError', 'Unsupported derivation algorithm');
  const peer = record(a.public); if (peer.key.type !== 'public' || peer.algorithm.name !== a.name || a.name === 'ECDH' && peer.algorithm.namedCurve !== r.algorithm.namedCurve) fail('InvalidAccessError', 'Invalid peer key');
  const secret = await work('derive', [handle(r.key), handle(peer.key)]); if (length === null) return secret; if (length > secret.byteLength * 8) fail('OperationError', 'Requested derivation length is too large'); return secret.slice(0, length / 8);
}
async function crypt(alg, key, data, encrypt, usage) {
  const a = algorithm(alg);
  if (a.name === 'AES-KW' && (usage === 'encrypt' || usage === 'decrypt')) fail('NotSupportedError', 'AES-KW only wraps keys');
  const r = use(key, a, usage), input = Buffer.from(binary(data));
  if (a.name === 'RSA-OAEP') { if (r.key.type !== (encrypt ? 'public' : 'private')) fail('InvalidAccessError', 'Invalid RSA key type'); return work(encrypt ? 'encrypt' : 'decrypt', [handle(r.key), packed(input), 4, digestName(r.algorithm.hash), a.label === undefined ? undefined : packed(binary(a.label))]); }
  if ((!a.name.startsWith('AES-') && a.name !== 'ChaCha20-Poly1305') || r.key.type !== 'secret') fail('NotSupportedError', 'Unsupported encryption algorithm');
  const keyBytes = packed(r.key.export()), cipher = a.name === 'ChaCha20-Poly1305' ? 'chacha20-poly1305' : `aes-${r.algorithm.length}-${a.name === 'AES-KW' ? 'wrap' : a.name.slice(4).toLowerCase()}`;
  if (a.name === 'AES-KW') { if (input.length % 8 || input.length < (encrypt ? 16 : 24)) fail('OperationError', 'Invalid AES-KW input length'); return work('cipherOnce', [cipher, keyBytes, packed(Buffer.alloc(8, 0xa6)), packed(input), encrypt ? 1 : 0]); }
  if (a.name === 'AES-CTR') {
    const counter = Buffer.from(binary(a.counter)); if (counter.length !== 16) fail('OperationError', 'AES-CTR counter must be 16 bytes'); const bits = count(a.length, 'length', 1, 128); const blocks = BigInt(Math.ceil(input.length / 16)), modulus = 1n << BigInt(bits); if (blocks > modulus) fail('OperationError', 'AES-CTR counter would repeat');
    let counterValue = 0n; for (const byte of counter) counterValue = counterValue << 8n | BigInt(byte); const remaining = modulus - (counterValue & modulus - 1n);
    const firstLength = remaining >= blocks ? input.length : Number(remaining) * 16;
    const first = await work('cipherOnce', [cipher, keyBytes, packed(counter), packed(input.subarray(0, firstLength)), encrypt ? 1 : 0]);
    if (firstLength === input.length) return first;
    counterValue &= ~(modulus - 1n); for (let i = 15; i >= 0; i--) { counter[i] = Number(counterValue & 255n); counterValue >>= 8n; }
    const second = await work('cipherOnce', [cipher, keyBytes, packed(counter), packed(input.subarray(firstLength)), encrypt ? 1 : 0]); return packed(Buffer.concat([Buffer.from(first), Buffer.from(second)]));
  }
  const iv = binary(a.iv); if (a.name === 'AES-CBC' && iv.length !== 16) fail('OperationError', 'AES-CBC IV must be 16 bytes'); if (a.name === 'AES-GCM' && !iv.length) fail('OperationError', 'AES-GCM IV must not be empty');
  if (a.name === 'AES-OCB' && (!iv.length || iv.length > 15) || a.name === 'ChaCha20-Poly1305' && iv.length !== 12) fail('OperationError', 'Invalid AEAD IV length');
  let tagLength = 16, ciphertext = input, tag;
  if (['AES-GCM', 'AES-OCB', 'ChaCha20-Poly1305'].includes(a.name)) { const bits = a.tagLength === undefined ? 128 : a.tagLength; const sizes = a.name === 'AES-GCM' ? [32, 64, 96, 104, 112, 120, 128] : a.name === 'AES-OCB' ? [64, 96, 128] : [128]; if (!sizes.includes(bits)) fail('OperationError', 'Invalid authentication tag length'); tagLength = bits / 8; if (!encrypt) { if (input.length < tagLength) fail('OperationError', 'Ciphertext is shorter than its tag'); ciphertext = input.subarray(0, input.length - tagLength); tag = input.subarray(input.length - tagLength); } }
  return work('cipherOnce', [cipher, keyBytes, packed(iv), packed(ciphertext), encrypt ? 1 : 0, a.additionalData === undefined ? undefined : packed(binary(a.additionalData)), tag === undefined ? undefined : packed(tag), tagLength]);
}
async function signature(alg, key, data, signatureValue) {
  const a = algorithm(alg), verify = signatureValue !== undefined, r = use(key, a, verify ? 'verify' : 'sign'); const input = packed(binary(data)), expected = verify ? Buffer.from(binary(signatureValue)) : undefined;
  if (a.name === 'HMAC' || a.name.startsWith('KMAC')) {
    const bits = a.name === 'HMAC' ? undefined : bitLength(a.outputLength);
    const result = a.name === 'HMAC' ? await work('hmac', [digestName(r.algorithm.hash), packed(r.key.export()), input]) : truncateBits(await work('digest', kmacArgs(a, r.key.export(), input)), bits);
    if (!verify) return result; return expected.length === result.byteLength && crypto.timingSafeEqual(expected, result);
  }
  if (!['RSA-PSS', 'RSASSA-PKCS1-v1_5', 'ECDSA', 'Ed25519', 'Ed448'].includes(a.name) && !a.name.startsWith('ML-DSA-')) fail('NotSupportedError', 'Unsupported signature algorithm');
  if (r.key.type !== (verify ? 'public' : 'private')) fail('InvalidAccessError', 'Invalid signature key type');
  const context = optionalBytes(a.context); if (context.length > 255) fail('OperationError', 'Signature context exceeds 255 bytes');
  const digest = a.name === 'ECDSA' ? digestName(a.hash) : a.name.startsWith('Ed') || a.name.startsWith('ML-DSA-') ? '' : digestName(r.algorithm.hash);
  const padding = a.name === 'RSA-PSS' ? 6 : a.name === 'RSASSA-PKCS1-v1_5' ? 1 : 0, salt = a.name === 'RSA-PSS' ? count(a.saltLength, 'saltLength') : -2147483648;
  let sig = expected;
  if (verify && a.name === 'ECDSA') { const size = curves[r.algorithm.namedCurve].size; if (sig.length !== size * 2) return false; sig = codecs.signature(sig, size, true); }
  const result = await work(verify ? 'verify' : 'sign', [handle(r.key), digest, input, sig === undefined ? undefined : packed(sig), padding, salt, packed(context)]);
  if (verify) return !!result;
  return a.name === 'ECDSA' ? packed(codecs.signature(Buffer.from(result), curves[r.algorithm.namedCurve].size, false)) : result;
}
function leftEncode(value) { const bytes = []; do { bytes.unshift(value % 256); value = Math.floor(value / 256); } while (value); return Buffer.from([bytes.length, ...bytes]); }
function shakeArgs(a, data, validateCustomization = true) {
  const bits = bitLength(a.outputLength), functionName = optionalBytes(a.functionName), customization = optionalBytes(a.customization);
  if (functionName.length && !['KMAC', 'TupleHash', 'ParallelHash'].includes(functionName.toString())) fail('NotSupportedError', 'Unsupported cSHAKE functionName');
  if (validateCustomization && customization.length > 512) fail('OperationError', 'cSHAKE customization exceeds 512 bytes');
  const strength = a.name === 'cSHAKE128' ? 128 : 256;
  if (!functionName.length && !customization.length) return [`shake${strength}`, packed(data), Math.ceil(bits / 8), 1];
  const rate = strength === 128 ? 168 : 136;
  const prefix = Buffer.concat([leftEncode(rate), leftEncode(functionName.length * 8), functionName, leftEncode(customization.length * 8), customization]);
  return [`KECCAK-KMAC-${strength}`, packed(Buffer.concat([prefix, Buffer.alloc((rate - prefix.length % rate) % rate), Buffer.from(data)])), Math.ceil(bits / 8), 1];
}
function kmacArgs(a, key, data) {
  const bits = bitLength(a.outputLength), rate = a.name === 'KMAC128' ? 168 : 136;
  const encodedKey = Buffer.concat([leftEncode(rate), leftEncode(key.length * 8), key]);
  const encodedLength = leftEncode(bits), suffix = Buffer.concat([encodedLength.subarray(1), encodedLength.subarray(0, 1)]);
  return shakeArgs({ name: a.name === 'KMAC128' ? 'cSHAKE128' : 'cSHAKE256', outputLength: bits, functionName: Buffer.from('KMAC'), customization: a.customization }, Buffer.concat([encodedKey, Buffer.alloc((rate - encodedKey.length % rate) % rate), Buffer.from(data), suffix]), false);
}
function derivedLength(a) {
  if (a.name === 'ChaCha20-Poly1305') return 256;
  if (a.name === 'HMAC') { digestName(a.hash); return a.length === undefined ? blockSize(algorithm(a.hash).name) : bitLength(a.length, 'length'); }
  if (a.name.startsWith('KMAC')) return a.length === undefined ? (a.name === 'KMAC128' ? 128 : 256) : bitLength(a.length, 'length');
  if (a.name.startsWith('AES-') && [128, 192, 256].includes(a.length)) return a.length;
  if (isDerivation(a.name)) return null;
  fail('NotSupportedError', 'Unsupported derived key type');
}
async function kem(alg, key, usage, ciphertext) {
  const a = algorithm(alg);
  if (!a.name.startsWith('ML-KEM-')) fail('NotSupportedError', 'Unsupported encapsulation algorithm');
  const encapsulate = ciphertext === undefined, r = use(key, a, usage, encapsulate ? 'public' : 'private');
  const value = await work(encapsulate ? 'encapsulate' : 'decapsulate', encapsulate ? [handle(r.key)] : [handle(r.key), packed(binary(ciphertext))]);
  if (!encapsulate) return value;
  const bytes = Buffer.from(value), length = bytes.readUInt32LE(0);
  return { sharedKey: packed(bytes.subarray(4, 4 + length)), ciphertext: packed(bytes.subarray(4 + length)) };
}
function snapshotAlgorithm(value) { const a = algorithm(value); for (const name of ['iv', 'counter', 'additionalData', 'label', 'salt', 'info', 'context', 'nonce', 'secretValue', 'associatedData', 'customization', 'functionName', 'publicExponent']) if (a[name] !== undefined) a[name] = optionalBytes(a[name]); if (a.hash !== undefined) a.hash = algorithm(a.hash); return a; }
function toCryptoKey(key, alg, extractable, keyUsages) {
  const a = algorithm(alg), usages = checkUsages(a.name, key.type, keyUsages);
  let descriptor = { name: a.name };
  if (key.type === 'secret') {
    if (!isSecret(a.name)) fail('DataError', 'Expected an asymmetric key');
    if (isDerivation(a.name) && extractable) fail('SyntaxError', 'Derivation keys must not be extractable');
    const data = key.export(); descriptor = secretDescriptor(a, data);
    if (descriptor.length % 8) key = crypto.createSecretKey(truncateBits(data, descriptor.length));
  } else {
    if (isSecret(a.name)) fail('DataError', 'Expected a secret key');
    const type = key.asymmetricKeyType;
    if (a.name.startsWith('RSA') || a.name === 'RSASSA-PKCS1-v1_5') {
      if (type !== 'rsa') fail('DataError', 'Expected an RSA key');
      const jwk = codecs.exportJwk(key), n = Buffer.from(jwk.n, 'base64url'); let top = n[0], bits = (n.length - 1) * 8; while (top) { bits++; top >>= 1; }
      const hash = algorithm(a.hash); digestName(hash); descriptor = { name: a.name, modulusLength: bits, publicExponent: new Uint8Array(Buffer.from(jwk.e, 'base64url')), hash: { name: hash.name } };
    } else if (a.name === 'ECDSA' || a.name === 'ECDH') {
      if (type !== 'ec' || !curves[a.namedCurve] || codecs.exportJwk(key).crv !== a.namedCurve) fail('DataError', 'EC named curve mismatch');
      descriptor.namedCurve = a.namedCurve;
    } else if (type !== a.name.toLowerCase() || !['Ed25519', 'Ed448', 'X25519', 'X448'].includes(a.name) && !a.name.startsWith('ML-')) fail('DataError', 'Asymmetric key algorithm mismatch');
  }
  return new CryptoKey(token, key, descriptor, extractable, usages);
}
function providerAvailable(a) {
  const n = a.name;
  if (n.startsWith('SHA')) return !!c.call('providerAvailable', ['digest', digestName(a)]);
  if (n.startsWith('cSHAKE')) return !!c.call('providerAvailable', ['digest', optionalBytes(a.functionName).length || optionalBytes(a.customization).length ? `KECCAK-KMAC-${n.slice(6)}` : n.slice(1).toLowerCase()]);
  if (n.startsWith('AES-')) return !!c.call('providerAvailable', ['cipher', `aes-256-${n === 'AES-KW' ? 'wrap' : n.slice(4).toLowerCase()}`]);
  if (n === 'ChaCha20-Poly1305') return !!c.call('providerAvailable', ['cipher', 'chacha20-poly1305']);
  if (n.startsWith('KMAC')) return !!c.call('providerAvailable', ['mac', n === 'KMAC128' ? 'KMAC-128' : 'KMAC-256']) && !!c.call('providerAvailable', ['digest', n === 'KMAC128' ? 'KECCAK-KMAC-128' : 'KECCAK-KMAC-256']);
  if (isDerivation(n)) return !!c.call('providerAvailable', ['kdf', n.toUpperCase()]);
  if (n === 'HMAC') return !!c.call('providerAvailable', ['mac', 'HMAC']) && providerAvailable(algorithm(a.hash));
  return !!c.call('providerAvailable', ['key', n.startsWith('RSA') ? 'RSA' : n === 'ECDSA' || n === 'ECDH' ? 'EC' : n.toUpperCase()]);
}
function supports(operation, alg, additional) {
  try {
    const a = algorithm(alg), n = a.name, secret = isSecret(n), digest = n.startsWith('SHA') || n.startsWith('cSHAKE');
    if (operation === 'deriveKey') { const target = algorithm(additional); if (!supports('importKey', target, null)) return false; return supports('deriveBits', a, derivedLength(target)); }
    if (operation === 'wrapKey' || operation === 'unwrapKey') { if (!supports(operation === 'wrapKey' ? 'exportKey' : 'importKey', additional, null)) return false; if (n === 'AES-KW') return providerAvailable(a); operation = operation === 'wrapKey' ? 'encrypt' : 'decrypt'; }
    if (operation === 'encapsulateKey' || operation === 'decapsulateKey') { const target = algorithm(additional); if (!isSecret(target.name) || !supports('importKey', target, null)) return false; if ((target.name === 'HMAC' || target.name.startsWith('KMAC')) && target.length !== undefined && Math.ceil(target.length / 8) !== 32) return false; operation = operation === 'encapsulateKey' ? 'encapsulateBits' : 'decapsulateBits'; }
    if (operation === 'digest') { if (!digest) return false; if (n.startsWith('cSHAKE')) shakeArgs(a, Buffer.alloc(0)); }
    else if (operation === 'importKey' || operation === 'exportKey') { if (digest || operation === 'exportKey' && isDerivation(n)) return false; if (operation === 'importKey' && (n === 'HMAC' || n.startsWith('RSA'))) digestName(a.hash); if ((n === 'ECDSA' || n === 'ECDH') && operation === 'importKey' && !curves[a.namedCurve]) return false; }
    else if (operation === 'generateKey') { if (digest || isDerivation(n)) return false; if (secret) derivedLength(a); else if (n.startsWith('RSA')) { digestName(a.hash); count(a.modulusLength, 'modulusLength', 512); binary(a.publicExponent); } else if ((n === 'ECDSA' || n === 'ECDH') && !curves[a.namedCurve]) return false; }
    else if (operation === 'getPublicKey') { if (secret || digest) return false; }
    else if (operation === 'encapsulateBits' || operation === 'decapsulateBits') { if (!n.startsWith('ML-KEM-')) return false; }
    else if (operation === 'encrypt' || operation === 'decrypt') {
      if (!['AES-CBC', 'AES-CTR', 'AES-GCM', 'AES-OCB', 'ChaCha20-Poly1305', 'RSA-OAEP'].includes(n)) return false;
      if (n === 'AES-CTR') { if (binary(a.counter).length !== 16) return false; count(a.length, 'length', 1, 128); }
      else if (n !== 'RSA-OAEP') { const iv = binary(a.iv); if (n === 'AES-CBC' && iv.length !== 16 || n === 'AES-OCB' && (!iv.length || iv.length > 15) || n === 'ChaCha20-Poly1305' && iv.length !== 12) return false; if (a.tagLength !== undefined && !(n === 'AES-GCM' ? [32, 64, 96, 104, 112, 120, 128] : n === 'AES-OCB' ? [64, 96, 128] : [128]).includes(a.tagLength)) return false; optionalBytes(a.additionalData); }
      else optionalBytes(a.label);
    } else if (operation === 'sign' || operation === 'verify') {
      if (!['HMAC', 'KMAC128', 'KMAC256', 'RSA-PSS', 'RSASSA-PKCS1-v1_5', 'ECDSA', 'Ed25519', 'Ed448'].includes(n) && !n.startsWith('ML-DSA-')) return false;
      if (n === 'ECDSA') digestName(a.hash); if (n === 'RSA-PSS') count(a.saltLength, 'saltLength'); if (n.startsWith('KMAC')) { bitLength(a.outputLength); optionalBytes(a.customization); } if (optionalBytes(a.context).length > 255) return false;
    } else if (operation === 'deriveBits') {
      if (!isDerivation(n) && !['ECDH', 'X25519', 'X448'].includes(n)) return false;
      if (additional !== null) { count(additional, 'length'); if (additional % 8) return false; }
      if (n === 'PBKDF2') { if (!additional) return false; digestName(a.hash); binary(a.salt); count(a.iterations, 'iterations', 1); }
      if (n === 'HKDF') { if (additional === null) return false; digestName(a.hash); binary(a.salt); binary(a.info); }
      if (n.startsWith('Argon2')) { if (additional === null || additional < 32 || binary(a.nonce).length < 8 || a.version !== undefined && a.version !== 19) return false; count(a.parallelism, 'parallelism', 1, 0xffffff); count(a.memory, 'memory', 8 * a.parallelism, 0xffffffff); count(a.passes, 'passes', 1, 0xffffffff); optionalBytes(a.secretValue); optionalBytes(a.associatedData); }
      if (n === 'ECDH') record(a.public);
    } else return false;
    if (a.hash !== undefined && !providerAvailable(algorithm(a.hash))) return false;
    // Hash parameters belong to key import/generation, not signature or export dictionaries.
    if ((n === 'HMAC' || n.startsWith('RSA')) && a.hash === undefined) return !!c.call('providerAvailable', [n === 'HMAC' ? 'mac' : 'key', n === 'HMAC' ? 'HMAC' : 'RSA']);
    return providerAvailable(a);
  } catch (_) { return false; }
}
class SubtleCrypto {
  constructor(secret = undefined) { if (secret !== token) throw c.error('ERR_ILLEGAL_CONSTRUCTOR', 'Illegal constructor', TypeError); }
  static supports(operation, alg, additional = null) { brand(this, SubtleCrypto, 'SubtleCrypto constructor'); if (arguments.length < 2) throw new TypeError('supports requires two arguments'); return supports(operation, alg, additional); }
  async digest(alg, data) { brand(this, subtle, 'SubtleCrypto'); const a = algorithm(alg), input = binary(data); if (a.name.startsWith('cSHAKE')) return truncateBits(await work('digest', shakeArgs(a, input)), a.outputLength); return work('digest', [digestName(a), packed(input)]); }
  async generateKey(alg, extractable, keyUsages) {
    brand(this, subtle, 'SubtleCrypto');
    const a = snapshotAlgorithm(alg);
    if (isSecret(a.name) && !isDerivation(a.name)) {
      if (a.name.startsWith('AES-') && ![128, 192, 256].includes(a.length)) fail('OperationError', 'Invalid AES key length');
      const usages = checkUsages(a.name, 'secret', keyUsages), length = derivedLength(a);
      if (a.name === 'HMAC' && !length) fail('OperationError', 'HMAC key length must be positive');
      const data = Buffer.from(truncateBits(await work('random', [Math.ceil(length / 8)]), length));
      return new CryptoKey(token, crypto.createSecretKey(data), secretDescriptor({ ...a, length }, data), extractable, usages);
    }
    if (isDerivation(a.name)) fail('NotSupportedError', 'This algorithm does not generate keys');
    const privateUsages = keyUsages.filter(u => allowed(a.name, 'private').includes(u)), publicUsages = keyUsages.filter(u => allowed(a.name, 'public').includes(u));
    for (const u of keyUsages) if (!privateUsages.includes(u) && !publicUsages.includes(u)) fail('SyntaxError', 'Unsupported key usage'); checkUsages(a.name, 'private', privateUsages);
    let type, options = {}, descriptor = { name: a.name };
    if (['RSA-PSS', 'RSA-OAEP', 'RSASSA-PKCS1-v1_5'].includes(a.name)) { type = 'rsa'; const hash = algorithm(a.hash); digestName(hash); const exp = binary(a.publicExponent); let n = 0; for (const b of exp) n = n * 256 + b; options = { modulusLength: count(a.modulusLength, 'modulusLength', 512), publicExponent: n }; descriptor = { name: a.name, modulusLength: a.modulusLength, publicExponent: new Uint8Array(exp), hash: { name: hash.name } }; }
    else if (a.name === 'ECDSA' || a.name === 'ECDH') { const curve = curves[a.namedCurve]; if (!curve) fail('NotSupportedError', 'Unsupported named curve'); type = 'ec'; options.namedCurve = curve.name; descriptor.namedCurve = a.namedCurve; }
    else if (['Ed25519', 'Ed448', 'X25519', 'X448'].includes(a.name) || a.name.startsWith('ML-')) type = a.name.toLowerCase(); else fail('NotSupportedError', 'Unsupported key generation algorithm');
    const id = await work('keyGenerate', c.keygenArgs(type, options)); const privateKey = c.keyFromHandle('private', id); let publicKey;
    try { const encoded = await exportNative(privateKey, false); publicKey = c.keyFromHandle('public', await work('keyImport', [packed(encoded), 'DER', 0, packed(Buffer.alloc(0))])); return { privateKey: new CryptoKey(token, privateKey, descriptor, extractable, privateUsages), publicKey: new CryptoKey(token, publicKey, descriptor, true, publicUsages) }; } catch (e) { release(privateKey); if (publicKey) release(publicKey); throw e; }
  }
  async importKey(format, keyData, alg, extractable, keyUsages) {
    brand(this, subtle, 'SubtleCrypto');
    const a = snapshotAlgorithm(alg); let type, data, jwk;
    if (isModern(a.name) && (format === 'raw' || format === 'jwk')) fail('NotSupportedError', 'Unsupported key format for this algorithm');
    if (format === 'jwk') { jwk = clone(keyData); if (!jwk || typeof jwk !== 'object') fail('DataError', 'Invalid JWK'); if (jwk.ext === false && extractable) fail('DataError', 'JWK is not extractable'); if (jwk.key_ops !== undefined && (!Array.isArray(jwk.key_ops) || new Set(jwk.key_ops).size !== jwk.key_ops.length || keyUsages.some(u => !jwk.key_ops.includes(u)))) fail('DataError', 'JWK key_ops mismatch'); type = jwk.kty === 'oct' ? 'secret' : jwk.d === undefined ? 'public' : 'private'; try { data = codecs.encodeJwk(jwk, type); } catch (e) { fail('DataError', e.message); } }
    else if (['raw', 'raw-secret', 'raw-public', 'raw-private', 'raw-seed'].includes(format)) { data = Buffer.from(binary(keyData)); type = format === 'raw-secret' || format === 'raw' && isSecret(a.name) ? 'secret' : format === 'raw-private' || format === 'raw-seed' ? 'private' : 'public'; }
    else if (format === 'spki' || format === 'pkcs8') { type = format === 'spki' ? 'public' : 'private'; data = Buffer.from(binary(keyData)); }
    else fail('NotSupportedError', 'Unsupported key format');
    const usages = checkUsages(a.name, type, keyUsages); let descriptor = { name: a.name };
    if (type === 'secret') {
      if (!isSecret(a.name)) fail('DataError', 'Expected an asymmetric key');
      descriptor = secretDescriptor(a, data);
      if (isDerivation(a.name) && (extractable || !['raw', 'raw-secret'].includes(format))) fail('SyntaxError', 'Derivation keys must be non-extractable raw keys');
      if (descriptor.length % 8) data = Buffer.from(truncateBits(data, descriptor.length));
      if (jwk && jwk.alg !== undefined && jwk.alg !== jwkAlgorithm(descriptor)) fail('DataError', 'JWK algorithm mismatch');
      return new CryptoKey(token, crypto.createSecretKey(data), descriptor, extractable, usages);
    }
    if (isSecret(a.name)) fail('DataError', 'Expected a secret key');
    if (['raw-public', 'raw-private', 'raw-seed'].includes(format) || a.name.startsWith('ML-')) {
      let key;
      try {
        if (format === 'raw-public' || format === 'raw-private' || format === 'raw-seed') {
          const typeName = a.name === 'ECDSA' || a.name === 'ECDH' ? 'ec' : a.name.toLowerCase();
          key = c.providerRawImport({ key: data, format, asymmetricKeyType: typeName, namedCurve: a.namedCurve }, type);
        } else key = c.keyFromHandle(type, await work('keyImport', [packed(data), 'DER', type === 'private' ? 1 : 0, packed(Buffer.alloc(0))]));
        const result = toCryptoKey(key, a, extractable, usages); return result;
      } catch (e) { if (key) release(key); fail(e.name === 'NotSupportedError' || e.name === 'SyntaxError' ? e.name : 'DataError', e.message); }
    }
    if (format === 'raw') {
      if (a.name === 'ECDSA' || a.name === 'ECDH') { const curve = curves[a.namedCurve]; if (!curve || data.length !== 1 + curve.size * 2 || data[0] !== 4) fail('DataError', 'Invalid EC point'); data = codecs.encodeJwk({ kty: 'EC', crv: a.namedCurve, x: data.subarray(1, curve.size + 1).toString('base64url'), y: data.subarray(curve.size + 1).toString('base64url') }, 'public'); }
      else if (['Ed25519', 'Ed448', 'X25519', 'X448'].includes(a.name)) data = codecs.encodeJwk({ kty: 'OKP', crv: a.name, x: data.toString('base64url') }, 'public'); else fail('NotSupportedError', 'Raw import is unsupported for this algorithm');
    }
    let key;
    try {
      key = c.keyFromHandle(type, await work('keyImport', [packed(data), 'DER', type === 'private' ? 1 : 0, packed(Buffer.alloc(0))])); const metadata = await jwkOf(key);
      if (['RSA-PSS', 'RSA-OAEP', 'RSASSA-PKCS1-v1_5'].includes(a.name)) { if (metadata.kty !== 'RSA') fail('DataError', 'Expected an RSA key'); const hash = algorithm(a.hash); digestName(hash); const n = Buffer.from(metadata.n, 'base64url'); let top = n[0], bits = (n.length - 1) * 8; while (top) { bits++; top >>= 1; } descriptor = { name: a.name, modulusLength: bits, publicExponent: new Uint8Array(Buffer.from(metadata.e, 'base64url')), hash: { name: hash.name } }; }
      else if (a.name === 'ECDSA' || a.name === 'ECDH') { if (metadata.kty !== 'EC' || metadata.crv !== a.namedCurve || !curves[a.namedCurve]) fail('DataError', 'EC named curve mismatch'); descriptor.namedCurve = a.namedCurve; }
      else if (!['Ed25519', 'Ed448', 'X25519', 'X448'].includes(a.name) || metadata.kty !== 'OKP' || metadata.crv !== a.name) fail('DataError', 'Asymmetric key algorithm mismatch');
      if (jwk && jwk.alg !== undefined && jwkAlgorithm(descriptor) !== undefined && jwk.alg !== jwkAlgorithm(descriptor)) fail('DataError', 'JWK algorithm mismatch');
      return new CryptoKey(token, key, descriptor, extractable, usages);
    } catch (e) { if (key) release(key); throw e; }
  }
  async exportKey(format, key) {
    brand(this, subtle, 'SubtleCrypto');
    const r = record(key); if (!r.extractable) fail('InvalidAccessError', 'Key is not extractable');
    if (isModern(r.algorithm.name) && (format === 'raw' || format === 'jwk')) fail('NotSupportedError', 'Unsupported key format for this algorithm');
    if (['raw-public', 'raw-private', 'raw-seed'].includes(format)) { try { return packed(c.providerRawExport(r.key, { format })); } catch (e) { fail('InvalidAccessError', e.message); } }
    if (r.key.type === 'secret') { if (format === 'raw' || format === 'raw-secret') return packed(r.key.export()); if (format !== 'jwk') fail('InvalidAccessError', 'Invalid secret key export format'); const jwk = { kty: 'oct', k: r.key.export().toString('base64url'), key_ops: [...r.usages], ext: true }, alg = jwkAlgorithm(r.algorithm); if (alg !== undefined) jwk.alg = alg; return jwk; }
    if (format === 'spki' && r.key.type === 'public') return packed(await exportNative(r.key, false));
    if (format === 'pkcs8' && r.key.type === 'private') return packed(await exportNative(r.key, true));
    if (format === 'jwk' || format === 'raw') { const jwk = await jwkOf(r.key); if (format === 'raw') { if (r.key.type !== 'public') fail('InvalidAccessError', 'Only public asymmetric keys have raw encodings'); if (jwk.kty === 'OKP') return packed(Buffer.from(jwk.x, 'base64url')); if (jwk.kty === 'EC') return packed(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])); fail('InvalidAccessError', 'Key has no raw encoding'); } const alg = jwkAlgorithm(r.algorithm); if (alg !== undefined) jwk.alg = alg; jwk.key_ops = [...r.usages]; jwk.ext = true; return jwk; }
    fail('InvalidAccessError', 'Invalid key export format');
  }
  async encrypt(algorithm, key, data) { brand(this, subtle, 'SubtleCrypto'); return crypt(algorithm, key, data, true, 'encrypt'); }
  async decrypt(algorithm, key, data) { brand(this, subtle, 'SubtleCrypto'); return crypt(algorithm, key, data, false, 'decrypt'); }
  async sign(algorithm, key, data) { brand(this, subtle, 'SubtleCrypto'); return signature(algorithm, key, data); }
  async verify(algorithm, key, signatureValue, data) { brand(this, subtle, 'SubtleCrypto'); return signature(algorithm, key, data, signatureValue); }
  async deriveBits(algorithm, baseKey, length = null) { brand(this, subtle, 'SubtleCrypto'); return derive(algorithm, baseKey, length, 'deriveBits'); }
  async deriveKey(alg, baseKey, derivedKeyType, extractable, usages) { brand(this, subtle, 'SubtleCrypto'); const a = snapshotAlgorithm(derivedKeyType), keyUsages = [...usages], length = derivedLength(a); const data = await derive(alg, baseKey, length, 'deriveKey'); return this.importKey('raw-secret', data, a, extractable, keyUsages); }
  async wrapKey(format, key, wrappingKey, wrapAlgorithm) { brand(this, subtle, 'SubtleCrypto'); const a = snapshotAlgorithm(wrapAlgorithm); use(wrappingKey, a, 'wrapKey'); const encoded = await this.exportKey(format, key); let data = format === 'jwk' ? Buffer.from(JSON.stringify(encoded)) : encoded; if (format === 'jwk' && a.name === 'AES-KW') { data = Buffer.concat([data, Buffer.alloc((8 - data.length % 8) % 8, 32)]); } return crypt(a, wrappingKey, data, true, 'wrapKey'); }
  async unwrapKey(format, wrappedKey, unwrappingKey, unwrapAlgorithm, unwrappedKeyAlgorithm, extractable, usages) { brand(this, subtle, 'SubtleCrypto'); const a = snapshotAlgorithm(unwrappedKeyAlgorithm), keyUsages = [...usages]; const data = await crypt(unwrapAlgorithm, unwrappingKey, wrappedKey, false, 'unwrapKey'); let encoded = data; if (format === 'jwk') { try { encoded = JSON.parse(Buffer.from(data).toString('utf8')); } catch (_) { fail('DataError', 'Wrapped key is not valid JSON'); } } return this.importKey(format, encoded, a, extractable, keyUsages); }
  async getPublicKey(key, usages) { brand(this, subtle, 'SubtleCrypto'); const r = record(key); if (r.key.type !== 'private') fail(r.key.type === 'secret' ? 'NotSupportedError' : 'InvalidAccessError', 'Expected a private key'); const selected = checkUsages(r.algorithm.name, 'public', usages); const data = await exportNative(r.key, false); const publicKey = c.keyFromHandle('public', await work('keyImport', [packed(data), 'DER', 0, packed(Buffer.alloc(0))])); return new CryptoKey(token, publicKey, r.algorithm, true, selected); }
  async encapsulateBits(alg, key) { brand(this, subtle, 'SubtleCrypto'); return kem(alg, key, 'encapsulateBits'); }
  async decapsulateBits(alg, key, ciphertext) { brand(this, subtle, 'SubtleCrypto'); return kem(alg, key, 'decapsulateBits', ciphertext); }
  async encapsulateKey(alg, key, sharedKeyAlgorithm, extractable, usages) { brand(this, subtle, 'SubtleCrypto'); const a = snapshotAlgorithm(sharedKeyAlgorithm), selected = [...usages], result = await kem(alg, key, 'encapsulateKey'); return { ciphertext: result.ciphertext, sharedKey: await this.importKey('raw-secret', result.sharedKey, a, extractable, selected) }; }
  async decapsulateKey(alg, key, ciphertext, sharedKeyAlgorithm, extractable, usages) { brand(this, subtle, 'SubtleCrypto'); const a = snapshotAlgorithm(sharedKeyAlgorithm), selected = [...usages], result = await kem(alg, key, 'decapsulateKey', ciphertext); return this.importKey('raw-secret', result, a, extractable, selected); }
}
const subtle = new SubtleCrypto(token);
class Crypto {
  constructor(secret = undefined) { if (secret !== token) throw c.error('ERR_ILLEGAL_CONSTRUCTOR', 'Illegal constructor', TypeError); }
  get subtle() { brand(this, webcrypto, 'Crypto'); return subtle; }
  getRandomValues(array) { brand(this, webcrypto, 'Crypto'); const tag = Object.prototype.toString.call(array); if (!ArrayBuffer.isView(array) || !['[object Int8Array]', '[object Uint8Array]', '[object Uint8ClampedArray]', '[object Int16Array]', '[object Uint16Array]', '[object Int32Array]', '[object Uint32Array]', '[object BigInt64Array]', '[object BigUint64Array]'].includes(tag)) fail('TypeMismatchError', 'Expected an integer TypedArray'); if (array.byteLength > 65536) fail('QuotaExceededError', 'Requested length exceeds 65,536 bytes'); crypto.randomFillSync(array); return array; }
  randomUUID() { brand(this, webcrypto, 'Crypto'); return crypto.randomUUID(); }
}
const webcrypto = new Crypto(token);
for (const Constructor of [Crypto, SubtleCrypto, CryptoKey]) {
  for (const key of Object.getOwnPropertyNames(Constructor.prototype)) {
    if (key !== 'constructor') Object.defineProperty(Constructor.prototype, key, { enumerable: true });
  }
  Object.defineProperty(Constructor.prototype, Symbol.toStringTag, { value: Constructor.name, configurable: true });
}
function serializeKey(key) { const r = records.get(key); if (!r) return undefined; const result = c.serializeKeyObject(r.key); result.algorithm = clone(r.algorithm); result.extractable = r.extractable; result.usages = [...r.usages]; return result; }
function deserializeKey(value) { const key = c.deserializeKeyObject(value); try { return toCryptoKey(key, value.algorithm, value.extractable, value.usages); } catch (e) { if (key.type !== 'secret') release(key); throw e; } }
module.exports = { webcrypto, CryptoKey, SubtleCrypto, Crypto, unwrap, toCryptoKey, serializeKey, deserializeKey };
