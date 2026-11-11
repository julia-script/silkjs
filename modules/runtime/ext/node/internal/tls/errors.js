'use strict';
// Node's error messages and validators for node:tls, after Node.js v24
// lib/internal/errors.js and lib/internal/validators.js.
const { inspect } = require('internal/util_inspect');

function coded(Base, code, message) {
  const error = new Base(message);
  Object.defineProperty(error, 'code', { value: code, enumerable: true, writable: true, configurable: true });
  return error;
}
function formatList(array, type = 'and') {
  if (array.length < 3) return array.join(` ${type} `);
  return `${array.slice(0, -1).join(', ')}, ${type} ${array[array.length - 1]}`;
}
function specificType(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  switch (typeof value) {
    case 'bigint': return `type bigint (${value}n)`;
    case 'number':
      if (value === 0) return 1 / value === -Infinity ? 'type number (-0)' : 'type number (0)';
      return `type number (${value})`;
    case 'boolean': return `type boolean (${value})`;
    case 'symbol': return `type symbol (${String(value)})`;
    case 'function': return `function ${value.name}`;
    case 'object': {
      const name = value.constructor?.name;
      if (typeof name === 'string' && name !== '') return `an instance of ${name}`;
      return inspect(value, { depth: -1 });
    }
    case 'string': {
      if (value.length > 28) value = `${value.slice(0, 25)}...`;
      if (value.indexOf("'") === -1) return `type string ('${value}')`;
      return `type string (${JSON.stringify(value)})`;
    }
  }
  let inspected = inspect(value, { colors: false });
  if (inspected.length > 28) inspected = `${inspected.slice(0, 25)}...`;
  return `type ${typeof value} (${inspected})`;
}
const kTypes = ['string', 'function', 'number', 'object', 'Function', 'Object', 'boolean', 'bigint', 'symbol'];
const classRegExp = /^[A-Z][a-zA-Z0-9]*$/;
function invalidArgType(name, expected, actual) {
  if (!Array.isArray(expected)) expected = [expected];
  let message = 'The ';
  if (name.endsWith(' argument')) message += `${name} `;
  else message += `"${name}" ${name.includes('.') ? 'property' : 'argument'} `;
  message += 'must be ';
  const types = [], instances = [], other = [];
  for (const value of expected) {
    if (kTypes.includes(value)) types.push(value.toLowerCase());
    else if (classRegExp.test(value)) instances.push(value);
    else other.push(value);
  }
  if (instances.length > 0) {
    const position = types.indexOf('object');
    if (position !== -1) { types.splice(position, 1); instances.push('Object'); }
  }
  if (types.length > 0) {
    message += `${types.length > 1 ? 'one of type' : 'of type'} ${formatList(types, 'or')}`;
    if (instances.length > 0 || other.length > 0) message += ' or ';
  }
  if (instances.length > 0) {
    message += `an instance of ${formatList(instances, 'or')}`;
    if (other.length > 0) message += ' or ';
  }
  if (other.length > 0) {
    if (other.length > 1) message += `one of ${formatList(other, 'or')}`;
    else {
      if (other[0].toLowerCase() !== other[0]) message += 'an ';
      message += other[0];
    }
  }
  return coded(TypeError, 'ERR_INVALID_ARG_TYPE', `${message}. Received ${specificType(actual)}`);
}
function invalidArgValue(name, value, reason = 'is invalid', Base = TypeError) {
  let inspected = inspect(value);
  if (inspected.length > 128) inspected = `${inspected.slice(0, 128)}...`;
  return coded(Base, 'ERR_INVALID_ARG_VALUE', `The ${name.includes('.') ? 'property' : 'argument'} '${name}' ${reason}. Received ${inspected}`);
}
function separated(text) {
  let result = '', i = text.length;
  const start = text[0] === '-' ? 1 : 0;
  for (; i >= start + 4; i -= 3) result = `_${text.slice(i - 3, i)}${result}`;
  return `${text.slice(0, i)}${result}`;
}
function outOfRange(name, range, input, replaceDefaultBoolean = false) {
  let message = replaceDefaultBoolean ? name : `The value of "${name}" is out of range.`;
  let received;
  if (Number.isInteger(input) && Math.abs(input) > 2 ** 32) received = separated(String(input));
  else if (typeof input === 'bigint') {
    received = String(input);
    if (input > 2n ** 32n || input < -(2n ** 32n)) received = separated(received);
    received += 'n';
  } else received = inspect(input);
  return coded(RangeError, 'ERR_OUT_OF_RANGE', `${message} It must be ${range}. Received ${received}`);
}
function validateString(value, name) { if (typeof value !== 'string') throw invalidArgType(name, 'string', value); }
function validateFunction(value, name) { if (typeof value !== 'function') throw invalidArgType(name, 'Function', value); }
function validateBoolean(value, name) { if (typeof value !== 'boolean') throw invalidArgType(name, 'boolean', value); }
function validateObject(value, name, nullable = false) {
  if ((!nullable && value === null) || Array.isArray(value) || (typeof value !== 'object' && typeof value !== 'function') || typeof value === 'function')
    throw invalidArgType(name, 'Object', value);
}
function validateArray(value, name) { if (!Array.isArray(value)) throw invalidArgType(name, 'Array', value); }
function validateBuffer(value, name = 'buffer') {
  if (!ArrayBuffer.isView(value)) throw invalidArgType(name, ['Buffer', 'TypedArray', 'DataView'], value);
}
function validateNumber(value, name, min = undefined, max) {
  if (typeof value !== 'number') throw invalidArgType(name, 'number', value);
  if ((min != null && value < min) || (max != null && value > max) || ((min != null || max != null) && Number.isNaN(value)))
    throw outOfRange(name, `${min != null ? `>= ${min}` : ''}${min != null && max != null ? ' && ' : ''}${max != null ? `<= ${max}` : ''}`, value);
}
function validateInteger(value, name, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'number') throw invalidArgType(name, 'number', value);
  if (!Number.isInteger(value)) throw outOfRange(name, 'an integer', value);
  if (value < min || value > max) throw outOfRange(name, `>= ${min} && <= ${max}`, value);
}
function validateInt32(value, name, min = -2147483648, max = 2147483647) {
  if (typeof value !== 'number') throw invalidArgType(name, 'number', value);
  if (!Number.isInteger(value)) throw outOfRange(name, 'an integer', value);
  if (value < min || value > max) throw outOfRange(name, `>= ${min} && <= ${max}`, value);
}
function validateUint32(value, name, positive = false) {
  if (typeof value !== 'number') throw invalidArgType(name, 'number', value);
  if (!Number.isInteger(value)) throw outOfRange(name, 'an integer', value);
  const min = positive ? 1 : 0, max = 4294967295;
  if (value < min || value > max) throw outOfRange(name, `>= ${min} && <= ${max}`, value);
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
  coded, invalidArgType, invalidArgValue, outOfRange, decorate,
  validateString, validateFunction, validateBoolean, validateObject, validateArray, validateBuffer,
  validateNumber, validateInteger, validateInt32, validateUint32,
};
