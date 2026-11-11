'use strict';

// The WebCrypto part of Node.js main (ce7aaf1c) lib/internal/crypto/hash.js:
// asyncDigest. Hash, Hmac and hash() are the runtime's crypto.js port.
// Copyright Node.js contributors. All rights reserved. MIT license (see
// vendor/node-api/LICENSE).

const {
  TypedArrayPrototypeGetBuffer,
} = require('internal/per_context/primordials');

const {
  CShakeJob,
  HashJob,
  kCryptoJobWebCrypto,
  TurboShakeJob,
  KangarooTwelveJob,
} = require('internal/crypto/binding');

const {
  jobPromise,
  jobPromiseThen,
  normalizeHashName,
  numBitsToBytes,
  truncateToBitLength,
  validateMaxBufferLength,
  getOptionalByteLength,
} = require('internal/crypto/util');

const {
  lazyDOMException,
} = require('internal/crypto/node_util');

// Implementation for WebCrypto subtle.digest()

function asyncDigest(algorithm, data) {
  validateMaxBufferLength(data, 'data');

  switch (algorithm.name) {
    case 'SHA-1':
      // Fall through
    case 'SHA-256':
      // Fall through
    case 'SHA-384':
      // Fall through
    case 'SHA-512':
      // Fall through
    case 'SHA3-256':
      // Fall through
    case 'SHA3-384':
      // Fall through
    case 'SHA3-512':
      return jobPromise(() => new HashJob(
        kCryptoJobWebCrypto,
        normalizeHashName(algorithm.name),
        data));
    case 'cSHAKE128':
      // Fall through
    case 'cSHAKE256': {
      const outputLength = algorithm.outputLength;
      if (getOptionalByteLength(algorithm.functionName) ||
          getOptionalByteLength(algorithm.customization)) {
        if (CShakeJob === undefined) {
          throw lazyDOMException(
            'Non-empty CShakeParams functionName or customization is not supported',
            'NotSupportedError');
        }

        return jobPromise(() => new CShakeJob(
          kCryptoJobWebCrypto,
          algorithm.name,
          data,
          algorithm.functionName,
          algorithm.customization,
          outputLength));
      }

      const bits = jobPromise(() => new HashJob(
        kCryptoJobWebCrypto,
        normalizeHashName(algorithm.name),
        data,
        numBitsToBytes(outputLength) * 8));
      if (outputLength % 8 === 0)
        return bits;
      return jobPromiseThen(bits, (bits) =>
        TypedArrayPrototypeGetBuffer(truncateToBitLength(outputLength, bits)));
    }
    case 'TurboSHAKE128':
      // Fall through
    case 'TurboSHAKE256':
      return jobPromise(() => new TurboShakeJob(
        kCryptoJobWebCrypto,
        algorithm.name,
        algorithm.domainSeparation ?? 0x1f,
        algorithm.outputLength / 8,
        data));
    case 'KT128':
      // Fall through
    case 'KT256':
      return jobPromise(() => new KangarooTwelveJob(
        kCryptoJobWebCrypto,
        algorithm.name,
        algorithm.customization,
        algorithm.outputLength / 8,
        data));
    /* c8 ignore start */
    default: {
      const assert = require('internal/assert');
      assert.fail('Unreachable code');
    }
    /* c8 ignore stop */
  }
}

module.exports = {
  asyncDigest,
  hash: (algorithm, input, options) => require('crypto').hash(algorithm, input, options),
};
