'use strict';

// The WebCrypto part of Node.js main (ce7aaf1c) lib/internal/crypto/diffiehellman.js:
// ecdhDeriveBits. DiffieHellman, ECDH and diffieHellman() are the runtime's
// crypto.js port.
// Copyright Node.js contributors. All rights reserved. MIT license (see
// vendor/node-api/LICENSE).

const {
  ArrayBufferPrototypeGetByteLength,
  ArrayBufferPrototypeSlice,
  TypedArrayPrototypeGetBuffer,
} = require('internal/per_context/primordials');

const {
  DHBitsJob,
  kCryptoJobWebCrypto,
} = require('internal/crypto/binding');

const {
  getCryptoKeyAlgorithm,
  getCryptoKeyHandle,
  getCryptoKeyType,
} = require('internal/crypto/keys');

const {
  jobPromise,
  jobPromiseThen,
  numBitsToBytes,
  truncateToBitLength,
} = require('internal/crypto/util');

const {
  lazyDOMException,
} = require('internal/crypto/node_util');

function ecdhDeriveBits(algorithm, baseKey, length) {
  const { 'public': key } = algorithm;

  if (getCryptoKeyType(baseKey) !== 'private') {
    throw lazyDOMException(
      'baseKey must be a private key', 'InvalidAccessError');
  }

  const keyAlgorithm = getCryptoKeyAlgorithm(key);
  const baseKeyAlgorithm = getCryptoKeyAlgorithm(baseKey);
  if (keyAlgorithm.name !== baseKeyAlgorithm.name) {
    throw lazyDOMException(
      'The public and private keys must be of the same type',
      'InvalidAccessError');
  }

  if (
    keyAlgorithm.name === 'ECDH' &&
    keyAlgorithm.namedCurve !== baseKeyAlgorithm.namedCurve
  ) {
    throw lazyDOMException('Named curve mismatch', 'InvalidAccessError');
  }

  const bits = jobPromise(() => new DHBitsJob(
    kCryptoJobWebCrypto,
    getCryptoKeyHandle(key),
    undefined,
    undefined,
    undefined,
    undefined,
    getCryptoKeyHandle(baseKey),
    undefined,
    undefined,
    undefined,
    undefined));

  // If a length is not specified, return the full derived secret
  if (length === null)
    return bits;

  return jobPromiseThen(bits, (bits) => {
    const sliceLength = numBitsToBytes(length);

    const byteLength = ArrayBufferPrototypeGetByteLength(bits);
    // If the length is larger than the derived secret, throw.
    if (byteLength < sliceLength)
      throw lazyDOMException('derived bit length is too small', 'OperationError');

    if (length % 8 === 0) {
      if (byteLength === sliceLength)
        return bits;
      return ArrayBufferPrototypeSlice(bits, 0, sliceLength);
    }

    return TypedArrayPrototypeGetBuffer(truncateToBitLength(length, bits));
  });
}

module.exports = {
  ecdhDeriveBits,
};
