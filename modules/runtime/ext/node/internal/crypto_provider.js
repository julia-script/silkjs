'use strict';
const c = require('internal/crypto_core');
const { Buffer, bytes, binary, packed, integer, error, invalid, call, submit, attach, handle, release } = c;
const { Transform } = require('stream');

function object(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid(field, 'an object');
}
function providerName(value, field) {
  c.name(value, field);
  if (!value.length) throw error('ERR_INVALID_ARG_VALUE', `${field} must be non-empty and contain no NUL bytes`, TypeError);
  return value;
}
function argon2Args(algorithm, parameters) {
  if (typeof algorithm !== 'string') throw invalid('algorithm', 'a string');
  if (!['argon2d', 'argon2i', 'argon2id'].includes(algorithm)) throw error('ERR_INVALID_ARG_VALUE', 'algorithm must be argon2d, argon2i, or argon2id', TypeError);
  object(parameters, 'parameters');
  const { parallelism, tagLength, memory, passes } = parameters;
  const message = bytes(parameters.message, undefined, 'parameters.message');
  integer(message.byteLength, 'parameters.message.byteLength', 0, 0xffffffff);
  const nonce = bytes(parameters.nonce, undefined, 'parameters.nonce');
  integer(nonce.byteLength, 'parameters.nonce.byteLength', 8, 0xffffffff);
  integer(parallelism, 'parameters.parallelism', 1, 0xffffff);
  integer(tagLength, 'parameters.tagLength', 4, 0xffffffff);
  integer(memory, 'parameters.memory', 8 * parallelism, 0xffffffff);
  integer(passes, 'parameters.passes', 1, 0xffffffff);
  const secret = parameters.secret === undefined ? Buffer.alloc(0) : bytes(parameters.secret, undefined, 'parameters.secret');
  integer(secret.byteLength, 'parameters.secret.byteLength', 0, 0xffffffff);
  const associatedData = parameters.associatedData === undefined ? Buffer.alloc(0) : bytes(parameters.associatedData, undefined, 'parameters.associatedData');
  integer(associatedData.byteLength, 'parameters.associatedData.byteLength', 0, 0xffffffff);
  const costs = Buffer.alloc(8);
  costs.writeUInt32LE(memory, 0); costs.writeUInt32LE(passes, 4);
  return [algorithm, packed(message), packed(nonce), packed(secret), packed(associatedData), parallelism, tagLength, packed(costs)];
}
function argon2(algorithm, parameters, callback) {
  const args = argon2Args(algorithm, parameters);
  c.callback(callback);
  submit('argon2', args, callback, Buffer.from);
}
function argon2Sync(algorithm, parameters) { return Buffer.from(call('argon2', argon2Args(algorithm, parameters))); }

function macArgs(algorithm, key, options) {
  providerName(algorithm, 'algorithm');
  let digest, cipher, iv, customization, salt, outputLength = -1;
  if (options !== undefined) {
    object(options, 'options');
    const digestOption = options.digest;
    if (digestOption !== undefined) digest = providerName(digestOption, 'options.digest');
    const cipherOption = options.cipher;
    if (cipherOption !== undefined) cipher = providerName(cipherOption, 'options.cipher');
    const ivOption = options.iv;
    if (ivOption !== undefined) iv = packed(binary(ivOption, 'options.iv'));
    const customOption = options.customization;
    if (customOption !== undefined) customization = packed(binary(customOption, 'options.customization'));
    const saltOption = options.salt;
    if (saltOption !== undefined) salt = packed(binary(saltOption, 'options.salt'));
    const lengthOption = options.outputLength;
    if (lengthOption !== undefined) outputLength = integer(lengthOption, 'options.outputLength', 0, 0xffffffff) + 0;
  }
  const { KeyObject } = require('crypto');
  if (key instanceof KeyObject) {
    if (key.type !== 'secret') throw invalid('key', 'an ArrayBuffer, ArrayBufferView, or secret KeyObject');
    key = key.export();
  }
  return [algorithm, packed(binary(key, 'key')), digest, cipher, iv, customization, salt, outputLength];
}
function encoding(value, field, output) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalid(field, 'a string');
  if (value === '') return 'utf8';
  if (output && value.toLowerCase() === 'buffer') return 'buffer';
  if (!Buffer.isEncoding(value)) throw error('ERR_INVALID_ARG_VALUE', `Invalid ${field}: ${value}`, TypeError);
  return value;
}
function finalized() { return error('ERR_CRYPTO_MAC_FINALIZED', 'MAC already finalized'); }
class Mac extends Transform {
  constructor(algorithm, key, options) {
    const args = macArgs(algorithm, key, options);
    let id;
    try { id = call('macCreate', args); }
    catch (e) {
      if (e.code === 'ERR_INVALID_ARG_VALUE' || e.code === 'ERR_CRYPTO_INVALID_MAC') throw Object.assign(new TypeError(e.message), { code: e.code });
      throw e;
    }
    try { super(options); } catch (e) { call('release', [id]); throw e; }
    attach(this, id); this._finalized = false;
  }
  update(data, inputEncoding) {
    if (this._finalized) throw finalized();
    if (typeof data === 'string') {
      inputEncoding = encoding(inputEncoding, 'inputEncoding', false);
      if (inputEncoding && inputEncoding.toLowerCase() === 'hex' && data.length % 2) throw error('ERR_INVALID_ARG_VALUE', 'The argument encoding is invalid for data of odd length', TypeError);
    } else if (!ArrayBuffer.isView(data)) throw invalid('data', 'a string, Buffer, TypedArray, or DataView');
    try { call('macUpdate', [handle(this), packed(bytes(data, inputEncoding))]); }
    catch (e) { this._finalized = true; release(this); throw e; }
    return this;
  }
  final(outputEncoding) {
    if (this._finalized) throw finalized();
    outputEncoding = encoding(outputEncoding, 'outputEncoding', true);
    this._finalized = true;
    try { return c.output(call('macFinal', [handle(this)]), outputEncoding); }
    finally { release(this); }
  }
  _transform(chunk, inputEncoding, callback) { try { this.update(chunk, inputEncoding); callback(); } catch (e) { callback(e); } }
  _flush(callback) { try { const result = this.final(); if (result.length) this.push(result); callback(); } catch (e) { callback(e); } }
  _destroy(e, callback) { release(this); callback(e); }
}
function createMac(algorithm, key, options) { return new Mac(algorithm, key, options); }
function getMacs() {
  return Array.from(new Set(call('macs', []).split('\n').filter(name => name && !/^[0-9.]+$/.test(name)).map(name => name.toLowerCase()))).sort();
}

function kemKey(value, privateOnly) {
  const crypto = require('crypto');
  const { unwrap } = require('internal/crypto_webcrypto');
  let key = unwrap(value) || value, owned = false;
  if (!(key instanceof crypto.KeyObject)) {
    if (key && key.key instanceof crypto.KeyObject) key = key.key;
    else if (key && unwrap(key.key)) key = unwrap(key.key);
    else { key = privateOnly ? crypto.createPrivateKey(value) : crypto.createPublicKey(value); owned = true; }
  }
  if (privateOnly ? key.type !== 'private' : key.type !== 'private' && key.type !== 'public') {
    if (owned) release(key);
    throw error('ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE', `Expected ${privateOnly ? 'private' : 'public or private'} key`, TypeError);
  }
  return { key, owned };
}
function encapsulated(value) {
  const result = Buffer.from(value);
  const length = result.readUInt32LE(0);
  return { sharedKey: result.subarray(4, 4 + length), ciphertext: result.subarray(4 + length) };
}
function encapsulate(key, callback) {
  if (callback !== undefined) c.callback(callback);
  const prepared = kemKey(key, false);
  try {
    const args = [handle(prepared.key)];
    if (callback !== undefined) { submit('encapsulate', args, callback, encapsulated); return; }
    return encapsulated(call('encapsulate', args));
  } finally { if (prepared.owned) release(prepared.key); }
}
function decapsulate(key, ciphertext, callback) {
  if (callback !== undefined) c.callback(callback);
  const prepared = kemKey(key, true);
  try {
    const args = [handle(prepared.key), packed(bytes(ciphertext, undefined, 'ciphertext'))];
    if (callback !== undefined) { submit('decapsulate', args, callback, Buffer.from); return; }
    return Buffer.from(call('decapsulate', args));
  } finally { if (prepared.owned) release(prepared.key); }
}
const rawAlgorithms = {
  ec: 'EC', ed25519: 'ED25519', ed448: 'ED448', x25519: 'X25519', x448: 'X448',
  'ml-kem-512': 'ML-KEM-512', 'ml-kem-768': 'ML-KEM-768', 'ml-kem-1024': 'ML-KEM-1024',
  'ml-dsa-44': 'ML-DSA-44', 'ml-dsa-65': 'ML-DSA-65', 'ml-dsa-87': 'ML-DSA-87',
};
function rawFormat(format) { return format === 'raw-public' ? 0 : format === 'raw-private' ? 1 : 2; }
function rawCompatibility(algorithm, format) {
  if (!Object.prototype.hasOwnProperty.call(rawAlgorithms, algorithm)) {
    if (['rsa', 'rsa-pss', 'dsa', 'dh'].includes(algorithm)) throw error('ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS', 'This key type does not support raw encoding');
    throw error('ERR_INVALID_ARG_VALUE', `Invalid asymmetricKeyType: ${algorithm}`, TypeError);
  }
  if (format !== 0 && (algorithm.startsWith('ml-') ? format !== 2 : format !== 1)) {
    throw error('ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS', 'Raw format is not compatible with this key type');
  }
}
c.providerRawImport = function providerRawImport(options, type) {
  object(options, 'options');
  const format = rawFormat(options.format);
  if (type === 'private' && format === 0) throw error('ERR_INVALID_ARG_VALUE', 'A private key cannot use raw-public format', TypeError);
  const data = binary(options.key, 'key.key');
  const algorithm = c.name(options.asymmetricKeyType, 'key.asymmetricKeyType');
  let curve = '';
  if (algorithm === 'ec') curve = c.name(options.namedCurve, 'key.namedCurve');
  rawCompatibility(algorithm, format);
  let id;
  try { id = call('providerRawImport', [rawAlgorithms[algorithm], packed(data), format, curve, type === 'public' ? 1 : 0]); }
  catch (e) {
    if (e.code === 'ERR_INVALID_ARG_VALUE' || e.code === 'ERR_CRYPTO_INVALID_CURVE') throw Object.assign(new TypeError(e.message), { code: e.code });
    throw e;
  }
  return c.keyFromHandle(type, id);
};
c.providerRawExport = function providerRawExport(key, options) {
  const format = rawFormat(options.format);
  const keyType = c.keyObjectType(key);
  if (keyType === 'private' && options.passphrase !== undefined) throw error('ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS', 'Raw format does not support encryption');
  if (keyType === 'private' ? format === 0 : keyType !== 'public' || format !== 0) {
    throw error('ERR_INVALID_ARG_VALUE', 'Raw format is incompatible with the key object type', TypeError);
  }
  const algorithm = c.keyObjectAsymmetricType(key);
  let form = 4;
  if (algorithm === 'ec' && format === 0) {
    const type = options.type === undefined ? 'uncompressed' : options.type;
    if (type !== 'compressed' && type !== 'uncompressed') throw error('ERR_INVALID_ARG_VALUE', 'options.type must be compressed or uncompressed', TypeError);
    form = type === 'compressed' ? 2 : 4;
  }
  rawCompatibility(algorithm, format);
  return Buffer.from(call('providerRawExport', [handle(key), format, form]));
};

module.exports = { argon2, argon2Sync, createMac, getMacs, encapsulate, decapsulate };
