'use strict';
// node:tls errors: OpenSSL failures decorated as Node's crypto layer does, plus the
// shared codes and validators.
const { codes } = require('internal/errors');
const {
  validateString, validateFunction, validateBoolean, validateObject, validateArray,
  validateNumber, validateInteger, validateInt32, validateUint32,
} = require('internal/validators');

// Errors that Node raises from C++ carry a code but keep the plain "Name: message" header.
function coded(Base, code, message) {
  const error = new Base(message);
  Object.defineProperty(error, 'code', { value: code, enumerable: true, writable: true, configurable: true });
  return error;
}
function invalidArgType(name, expected, actual) { return new codes.ERR_INVALID_ARG_TYPE(name, expected, actual); }
function invalidArgValue(name, value, reason) { return new codes.ERR_INVALID_ARG_VALUE(name, value, reason); }
function outOfRange(name, range, input, replaceDefaultBoolean) { return new codes.ERR_OUT_OF_RANGE(name, range, input, replaceDefaultBoolean); }
function validateBuffer(value, name = 'buffer') {
  if (!ArrayBuffer.isView(value)) throw new codes.ERR_INVALID_ARG_TYPE(name, ['Buffer', 'TypedArray', 'DataView'], value);
}

// OpenSSL packs the library number into bits 23..30 of an error code. Node turns
// a reason into a code: ERR_SSL_<REASON> for libssl, ERR_OSSL_<LIB>_<REASON> else.
const libraries = {
  2: 'SYS', 3: 'BN', 4: 'RSA', 5: 'DH', 6: 'EVP', 7: 'BUF', 8: 'OBJ', 9: 'PEM', 10: 'DSA', 11: 'X509', 13: 'ASN1',
  14: 'CONF', 15: 'CRYPTO', 16: 'EC', 20: 'SSL', 32: 'BIO', 33: 'PKCS7', 34: 'X509V3', 35: 'PKCS12', 36: 'RAND', 37: 'DSO',
  38: 'ENGINE', 39: 'OCSP', 40: 'UI', 41: 'COMP', 42: 'ECDSA', 43: 'ECDH', 44: 'OSSL_STORE', 45: 'FIPS', 46: 'CMS', 47: 'TS',
  48: 'HMAC', 50: 'CT', 51: 'ASYNC', 52: 'KDF', 53: 'SM2', 128: 'USER',
};
function opensslCode(packed, reason) {
  const upper = reason.replace(/ /g, '_').toUpperCase();
  const library = libraries[(packed >>> 23) & 0xff];
  if (library === 'SSL') return 'ERR_SSL_' + upper;
  return 'ERR_OSSL_' + (library ? library + '_' : '') + upper;
}
// Native failures carry OpenSSL's "error:XXXXXXXX:library:function:reason" text.
function decorate(error) {
  const match = /(?:^|: )(error:([0-9A-F]{8}):([^:]*):([^:]*):(.*))$/.exec(error.message);
  if (!match) {
    if (!error.code) error.code = /^([A-Z][A-Z0-9_]+):/.exec(error.message)?.[1] || 'ERR_SSL_TLS_OPERATION_FAILED';
    return error;
  }
  const [, text, hex, library, func, reason] = match;
  error.message = text;
  if (error.stack) error.stack = error.stack.replace(/^[^\n]*/, `${error.name}: ${text}`);
  if (library) error.library = library;
  if (func) error.function = func;
  if (reason) { error.reason = reason; error.code = opensslCode(parseInt(hex, 16), reason); }
  else error.code = 'ERR_SSL_TLS_OPERATION_FAILED';
  return error;
}

module.exports = {
  codes, coded, invalidArgType, invalidArgValue, outOfRange, decorate,
  validateString, validateFunction, validateBoolean, validateObject, validateArray, validateBuffer,
  validateNumber, validateInteger, validateInt32, validateUint32,
};
