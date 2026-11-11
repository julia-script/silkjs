'use strict';

// The WebCrypto part of Node.js main (ce7aaf1c) lib/internal/crypto/random.js:
// getRandomValues. randomBytes, randomFillSync and randomUUID are the
// runtime's crypto.js port.
// Copyright Node.js contributors. All rights reserved. MIT license (see
// vendor/node-api/LICENSE).

const {
  lazyDOMException,
} = require('internal/crypto/node_util');

const {
  isTypedArray,
  isFloat16Array,
  isFloat32Array,
  isFloat64Array,
} = require('util/types');

function randomFillSync(data, offset) { return require('crypto').randomFillSync(data, offset); }

function getRandomValues(data) {
  if (!isTypedArray(data) ||
      isFloat16Array(data) ||
      isFloat32Array(data) ||
      isFloat64Array(data)) {
    // Ordinarily this would be an ERR_INVALID_ARG_TYPE. However,
    // the Web Crypto API and web platform tests expect this to
    // be a DOMException with type TypeMismatchError.
    throw lazyDOMException(
      'The data argument must be an integer-type TypedArray',
      'TypeMismatchError');
  }
  if (data.byteLength > 65536) {
    throw lazyDOMException(
      'The requested length exceeds 65,536 bytes',
      'QuotaExceededError');
  }
  randomFillSync(data, 0);
  return data;
}

module.exports = {
  getRandomValues,
  randomBytes: (size, callback) => require('crypto').randomBytes(size, callback),
  randomUUID: (options) => require('crypto').randomUUID(options),
};
