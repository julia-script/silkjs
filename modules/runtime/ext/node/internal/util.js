// Copyright Joyent, Inc. and other Node contributors. MIT license (see vendor/node-api/LICENSE).
// The parts of Node.js v24.22.1 lib/internal/util.js that the ported modules use.
'use strict';

const assert = require('internal/assert');
const kEmptyObject = Object.freeze({ __proto__: null });

function normalizeEncoding(enc) {
  if (enc == null || enc === 'utf8' || enc === 'utf-8') return 'utf8';
  return slowCases(enc);
}

function slowCases(enc) {
  switch (enc.length) {
    case 4:
      if (enc === 'UTF8') return 'utf8';
      if (enc === 'ucs2' || enc === 'UCS2') return 'utf16le';
      enc = enc.toLowerCase();
      if (enc === 'utf8') return 'utf8';
      if (enc === 'ucs2') return 'utf16le';
      break;
    case 3:
      if (enc === 'hex' || enc === 'HEX' ||
      enc.toLowerCase() === 'hex')
        return 'hex';
      break;
    case 5:
      if (enc === 'ascii') return 'ascii';
      if (enc === 'ucs-2') return 'utf16le';
      if (enc === 'UTF-8') return 'utf8';
      if (enc === 'ASCII') return 'ascii';
      if (enc === 'UCS-2') return 'utf16le';
      enc = enc.toLowerCase();
      if (enc === 'utf-8') return 'utf8';
      if (enc === 'ascii') return 'ascii';
      if (enc === 'ucs-2') return 'utf16le';
      break;
    case 6:
      if (enc === 'base64') return 'base64';
      if (enc === 'latin1' || enc === 'binary') return 'latin1';
      if (enc === 'BASE64') return 'base64';
      if (enc === 'LATIN1' || enc === 'BINARY') return 'latin1';
      enc = enc.toLowerCase();
      if (enc === 'base64') return 'base64';
      if (enc === 'latin1' || enc === 'binary') return 'latin1';
      break;
    case 7:
      if (enc === 'utf16le' || enc === 'UTF16LE' ||
      enc.toLowerCase() === 'utf16le')
        return 'utf16le';
      break;
    case 8:
      if (enc === 'utf-16le' || enc === 'UTF-16LE' ||
      enc.toLowerCase() === 'utf-16le')
        return 'utf16le';
      break;
    case 9:
      if (enc === 'base64url' || enc === 'BASE64URL' ||
      enc.toLowerCase() === 'base64url')
        return 'base64url';
      break;
    default:
      if (enc === '') return 'utf8';
  }
}

function once(callback, { preserveReturnValue = false } = kEmptyObject) {
  let called = false;
  let returnValue;
  return function(...args) {
    if (called) return returnValue;
    called = true;
    const result = Reflect.apply(callback, this, args);
    returnValue = preserveReturnValue ? result : undefined;
    return result;
  };
}

function getLazy(initializer) {
  let value;
  let initialized = false;
  return function() {
    if (initialized === false) {
      value = initializer();
      initialized = true;
    }
    return value;
  };
}

function assignFunctionName(name, fn, descriptor = kEmptyObject) {
  if (typeof name !== 'string') {
    const symbolDescription = name.description;
    assert(symbolDescription !== undefined, 'Attempted to name function after descriptionless Symbol');
    name = `[${symbolDescription}]`;
  }
  return Object.defineProperty(fn, 'name', {
    __proto__: null,
    writable: false,
    enumerable: false,
    configurable: true,
    ...Object.getOwnPropertyDescriptor(fn, 'name'),
    ...descriptor,
    value: name,
  });
}

function setOwnProperty(obj, key, value) {
  Object.defineProperty(obj, key, {
    __proto__: null,
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
  return value;
}

// The runtime always has crypto.
function assertCrypto() {}

function lazyUtil() { return require('util'); }
function promisify(original) { return lazyUtil().promisify(original); }
function deprecate(fn, msg, code) { return lazyUtil().deprecate(fn, msg, code); }

const experimentalWarnings = new Set();
function emitExperimentalWarning(feature, messagePrefix, code, ...args) {
  if (experimentalWarnings.has(feature)) return;
  experimentalWarnings.add(feature);
  let msg = `${feature} is an experimental feature and might change at any time`;
  if (messagePrefix) msg = messagePrefix + msg;
  process.emitWarning(msg, 'ExperimentalWarning', code, ...args);
}

module.exports = {
  assertCrypto, assignFunctionName, deprecate, emitExperimentalWarning, getLazy, kEmptyObject,
  normalizeEncoding, once, promisify, setOwnProperty,
};
