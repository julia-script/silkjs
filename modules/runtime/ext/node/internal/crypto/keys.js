'use strict';

// The CryptoKey half of Node.js main (ce7aaf1c) lib/internal/crypto/keys.js:
// toCryptoKey, toPublicCryptoKey, CryptoKey and its internal slot helpers.
// Changes: the KeyObject half is the runtime's crypto.js port (v24.22.1), so
// those exports come from there; the binding is internal/crypto/binding;
// serializeKey and deserializeKey carry CryptoKeys through structured clone.
// Copyright Node.js contributors. All rights reserved. MIT license (see
// vendor/node-api/LICENSE).

const {
  ArrayPrototypeSlice,
  ObjectDefineProperties,
  ObjectPrototypeHasOwnProperty,
  ObjectSetPrototypeOf,
  SymbolToStringTag,
  Uint8Array,
} = require('internal/per_context/primordials');

const {
  KeyObjectHandle,
  createCryptoKeyClass,
  // eslint-disable-next-line no-restricted-syntax -- intended here
  getCryptoKeySlots: nativeGetCryptoKeySlots,
  isCryptoKey: isNativeCryptoKey,
  kKeyTypeSecret,
  kKeyTypePublic,
  kKeyTypePrivate,
} = require('internal/crypto/binding');

const {
  codes: {
    ERR_ILLEGAL_CONSTRUCTOR,
    ERR_INVALID_THIS,
  },
} = require('internal/errors');

const {
  getUsagesMask,
  getUsagesFromMask,
  hasAnyNotIn,
  hasUsage,
  toUsagesSet,
} = require('internal/crypto/util');

const {
  customInspectSymbol: kInspect,
  kEnumerableProperty,
  lazyDOMException,
} = require('internal/util');

const { inspect } = require('util');

const nodeCrypto = require('crypto');
const core = require('internal/crypto_core');
const {
  createSecretKey,
  createPublicKey,
  createPrivateKey,
  KeyObject,
} = nodeCrypto;

/**
 * Converts a secret KeyObjectHandle to a CryptoKey by dispatching to the
 * algorithm-specific Web Crypto import path.
 * @param {KeyObjectHandle} keyData
 * @param {object} algorithm
 * @param {boolean} extractable
 * @param {string[]} keyUsages
 * @returns {CryptoKey}
 */
function toCryptoKeySecret(
  keyData,
  algorithm,
  extractable,
  keyUsages,
) {
  let result;
  switch (algorithm.name) {
    case 'HMAC':
      // Fall through
    case 'KMAC128':
      // Fall through
    case 'KMAC256':
      result = require('internal/crypto/mac')
        .macImportKey('KeyObjectHandle', keyData, algorithm, extractable, keyUsages);
      break;
    case 'AES-CTR':
      // Fall through
    case 'AES-CBC':
      // Fall through
    case 'AES-GCM':
      // Fall through
    case 'AES-KW':
      // Fall through
    case 'AES-OCB':
      result = require('internal/crypto/aes')
        .aesImportKey(algorithm, 'KeyObjectHandle', keyData, extractable, keyUsages);
      break;
    case 'ChaCha20-Poly1305':
      result = require('internal/crypto/chacha20_poly1305')
        .c20pImportKey(algorithm, 'KeyObjectHandle', keyData, extractable, keyUsages);
      break;
    case 'HKDF':
      // Fall through
    case 'PBKDF2':
      // Fall through
    case 'Argon2d':
      // Fall through
    case 'Argon2i':
      // Fall through
    case 'Argon2id':
      result = importGenericSecretKey(
        algorithm,
        'KeyObjectHandle',
        keyData,
        extractable,
        keyUsages);
      break;
    default:
      throw lazyDOMException('Unrecognized algorithm name', 'NotSupportedError');
  }

  if (getCryptoKeyUsagesMask(result) === 0) {
    throw lazyDOMException(
      `Usages cannot be empty when importing a ${getCryptoKeyType(result)} key.`,
      'SyntaxError');
  }

  return result;
}

/**
 * Converts an asymmetric KeyObjectHandle to a CryptoKey by dispatching to
 * the algorithm-specific Web Crypto import path. This preserves the same
 * algorithm and usage validation used by SubtleCrypto.importKey().
 * @param {KeyObjectHandle} keyData
 * @param {object} algorithm
 * @param {boolean} extractable
 * @param {string[]} keyUsages
 * @returns {CryptoKey}
 */
function toCryptoKey(
  keyData,
  algorithm,
  extractable,
  keyUsages,
) {
  let result;
  switch (algorithm.name) {
    case 'RSASSA-PKCS1-v1_5':
      // Fall through
    case 'RSA-PSS':
      // Fall through
    case 'RSA-OAEP':
      result = require('internal/crypto/rsa')
        .rsaImportKey('KeyObjectHandle', keyData, algorithm, extractable, keyUsages);
      break;
    case 'ECDSA':
      // Fall through
    case 'ECDH':
      result = require('internal/crypto/ec')
        .ecImportKey('KeyObjectHandle', keyData, algorithm, extractable, keyUsages);
      break;
    case 'Ed25519':
      // Fall through
    case 'Ed448':
      // Fall through
    case 'X25519':
      // Fall through
    case 'X448':
      result = require('internal/crypto/cfrg')
        .cfrgImportKey('KeyObjectHandle', keyData, algorithm, extractable, keyUsages);
      break;
    case 'ML-DSA-44':
      // Fall through
    case 'ML-DSA-65':
      // Fall through
    case 'ML-DSA-87':
      result = require('internal/crypto/ml_dsa')
        .mlDsaImportKey('KeyObjectHandle', keyData, algorithm, extractable, keyUsages);
      break;
    case 'ML-KEM-512':
      // Fall through
    case 'ML-KEM-768':
      // Fall through
    case 'ML-KEM-1024':
      result = require('internal/crypto/ml_kem')
        .mlKemImportKey('KeyObjectHandle', keyData, algorithm, extractable, keyUsages);
      break;
    default:
      throw lazyDOMException('Unrecognized algorithm name', 'NotSupportedError');
  }

  const resultType = getCryptoKeyType(result);
  if (resultType === 'private' && getCryptoKeyUsagesMask(result) === 0) {
    throw lazyDOMException(
      `Usages cannot be empty when importing a ${resultType} key.`,
      'SyntaxError');
  }

  return result;
}

/**
 * Derives a public CryptoKey from a private CryptoKey. The resulting key uses
 * the private key's algorithm, is extractable, and validates the requested
 * public usages through the shared asymmetric import path.
 * @param {CryptoKey} key
 * @param {string[]} keyUsages
 * @returns {CryptoKey}
 */
function toPublicCryptoKey(key, keyUsages) {
  const handle = new KeyObjectHandle();
  handle.init(kKeyTypePublic, getCryptoKeyHandle(key),
              null, null, null, null);
  return toCryptoKey(
    handle,
    getCryptoKeyAlgorithm(key),
    true,
    keyUsages);
}


// CryptoKey is a plain JS class whose prototype's [[Prototype]] is
// Object.prototype, as Web Crypto requires. Instance storage (type enum,
// extractable, algorithm, usages mask, the primary KeyObject handle, an
// optional Hybrid KEM-only secondary KeyObject handle, and optional Hybrid
// KEM-only seed data) lives
// on a C++ class, NativeCryptoKey, created by createCryptoKeyClass.
// InternalCryptoKey is the only constructor we expose to internal
// code; it extends NativeCryptoKey to get that storage and then has
// its prototype spliced so the chain visible to user code is:
//   instance -> InternalCryptoKey.prototype
//            -> CryptoKey.prototype
//            -> Object.prototype
//
// Normal construction caches all native internal slots in a private class
// field on `InternalCryptoKey`. Partially initialized transferred keys read
// them from C++ in a single `getCryptoKeySlots` call on first access. The
// cache is invisible to reflection (`Object.getOwnPropertySymbols` etc.) and
// CryptoKey's hidden class pristine. The `getCryptoKey{Type,Extractable,
// Algorithm,Usages,Handle,SecondaryHandle,SeedData}` helpers index into that
// array and convert native enums/masks back to Web Crypto strings.
// The internal algorithm object is stored as a null-prototype clone
// so it cannot observe polluted Object.prototype properties.
// The public `algorithm` getter caches a cloned dictionary and the
// public `usages` getter caches a synthesized array (as Web Crypto
// requires repeat reads to return the same object so a consumer's
// mutation is visible next time).
let getSlots; // Populated by the createCryptoKeyClass callback below.
let isCryptoKey;

const kSlotType = 0;
const kSlotExtractable = 1;
const kSlotAlgorithm = 2;
const kSlotUsagesMask = 3;
const kSlotHandle = 4;
const kSlotSecondaryHandle = 5;
const kSlotSeedData = 6;
const kSlotClonedAlgorithm = 7;
const kSlotClonedUsages = 8;
const kSlotUsages = 9;

function cloneAlgorithm(raw) {
  const cloned = { ...raw };
  if (ObjectPrototypeHasOwnProperty(cloned, 'hash') &&
      cloned.hash !== undefined) {
    cloned.hash = { ...cloned.hash };
  }
  if (ObjectPrototypeHasOwnProperty(cloned, 'publicExponent') &&
      cloned.publicExponent !== undefined) {
    cloned.publicExponent = new Uint8Array(cloned.publicExponent);
  }
  return cloned;
}

function cloneInternalAlgorithm(raw) {
  const cloned = { __proto__: null, ...raw };
  if (ObjectPrototypeHasOwnProperty(cloned, 'hash') &&
      cloned.hash !== undefined) {
    cloned.hash = { __proto__: null, ...cloned.hash };
  }
  if (ObjectPrototypeHasOwnProperty(cloned, 'publicExponent') &&
      cloned.publicExponent !== undefined) {
    cloned.publicExponent = new Uint8Array(cloned.publicExponent);
  }
  return cloned;
}

const {
  0: CryptoKey,
  1: InternalCryptoKey,
} = createCryptoKeyClass((NativeCryptoKey) => {
  class CryptoKey {
    constructor() {
      throw new ERR_ILLEGAL_CONSTRUCTOR();
    }

    [kInspect](depth, options) {
      if (depth < 0)
        return this;

      if (!isCryptoKey(this))
        throw new ERR_INVALID_THIS('CryptoKey');

      const opts = {
        ...options,
        depth: options.depth == null ? null : options.depth - 1,
      };

      return `CryptoKey ${inspect({
        type: getCryptoKeyType(this),
        extractable: getCryptoKeyExtractable(this),
        algorithm: cloneAlgorithm(getCryptoKeyAlgorithm(this)),
        usages: ArrayPrototypeSlice(getCryptoKeyUsages(this), 0),
      }, opts)}`;
    }

    get type() {
      if (!isCryptoKey(this))
        throw new ERR_INVALID_THIS('CryptoKey');
      return getCryptoKeyType(this);
    }

    get extractable() {
      if (!isCryptoKey(this))
        throw new ERR_INVALID_THIS('CryptoKey');
      return getCryptoKeyExtractable(this);
    }

    get algorithm() {
      if (!isCryptoKey(this))
        throw new ERR_INVALID_THIS('CryptoKey');
      const slots = getSlots(this);
      let cached = slots[kSlotClonedAlgorithm];
      if (cached === undefined) {
        cached = cloneAlgorithm(slots[kSlotAlgorithm]);
        slots[kSlotClonedAlgorithm] = cached;
      }
      return cached;
    }

    get usages() {
      if (!isCryptoKey(this))
        throw new ERR_INVALID_THIS('CryptoKey');
      const slots = getSlots(this);
      let cached = slots[kSlotClonedUsages];
      if (cached === undefined) {
        cached = ArrayPrototypeSlice(getCryptoKeyUsagesFromSlots(slots), 0);
        slots[kSlotClonedUsages] = cached;
      }
      return cached;
    }
  }

  class InternalCryptoKey extends NativeCryptoKey {
    #slots;

    constructor(
      handle,
      algorithm,
      usagesMask,
      extractable,
      secondaryHandle,
      seedData) {
      if (algorithm !== undefined)
        algorithm = cloneInternalAlgorithm(algorithm);
      if (seedData !== undefined)
        seedData = new Uint8Array(seedData);
      super(
        handle,
        algorithm,
        usagesMask,
        extractable,
        secondaryHandle,
        seedData);
      if (algorithm !== undefined) {
        this.#slots = [
          handle.getKeyType(),
          extractable,
          algorithm,
          usagesMask,
          handle,
          secondaryHandle,
          seedData,
        ];
      }
    }

    static {
      isCryptoKey = (key) => {
        if (key == null || typeof key !== 'object') return false;
        return #slots in key || isNativeCryptoKey(key);
      };
      getSlots = (key) => {
        const cached = key.#slots;
        if (cached !== undefined) return cached;
        const slots = nativeGetCryptoKeySlots(key);
        slots[kSlotAlgorithm] = cloneInternalAlgorithm(slots[kSlotAlgorithm]);
        if (slots[kSlotSeedData] !== undefined)
          slots[kSlotSeedData] = new Uint8Array(slots[kSlotSeedData]);
        key.#slots = slots;
        return slots;
      };
    }
  }
  // Hide NativeCryptoKey from user code.
  InternalCryptoKey.prototype.constructor = CryptoKey;
  ObjectSetPrototypeOf(InternalCryptoKey.prototype, CryptoKey.prototype);

  ObjectDefineProperties(CryptoKey.prototype, {
    type: kEnumerableProperty,
    extractable: kEnumerableProperty,
    algorithm: kEnumerableProperty,
    usages: kEnumerableProperty,
    [SymbolToStringTag]: {
      __proto__: null,
      configurable: true,
      value: 'CryptoKey',
    },
  });

  return [CryptoKey, InternalCryptoKey];
});

// The helpers below return a CryptoKey's internal slot value. The public
// `type` getter converts the native enum to the Web Crypto string. The
// `usages` helper converts the native usage mask to Web Crypto strings. The
// public `algorithm` / `usages` getters cache their returned objects.

/**
 * Returns the value of a CryptoKey's `[[type]]` internal slot.
 * @param {CryptoKey} key
 * @returns {'secret' | 'public' | 'private'}
 */
function getCryptoKeyType(key) {
  switch (getSlots(key)[kSlotType]) {
    case kKeyTypeSecret: return 'secret';
    case kKeyTypePublic: return 'public';
    case kKeyTypePrivate: return 'private';
    default: {
      const assert = require('internal/assert');
      assert.fail('Unreachable code');
    }
  }
}

/**
 * Returns the value of a CryptoKey's `[[extractable]]` internal slot.
 * @param {CryptoKey} key
 * @returns {boolean}
 */
function getCryptoKeyExtractable(key) {
  return getSlots(key)[kSlotExtractable];
}

/**
 * Returns the CryptoKey's `[[algorithm]]` internal slot, bypassing the
 * public `algorithm` getter (which returns a cloned copy).
 * @param {CryptoKey} key
 * @returns {object}
 */
function getCryptoKeyAlgorithm(key) {
  return getSlots(key)[kSlotAlgorithm];
}

/**
 * Returns the CryptoKey's native `[[usages]]` mask.
 * @param {CryptoKey} key
 * @returns {number}
 */
function getCryptoKeyUsagesMask(key) {
  return getSlots(key)[kSlotUsagesMask];
}

/**
 * Returns whether a CryptoKey's `[[usages]]` contains `usage`.
 * @param {CryptoKey} key
 * @param {string} usage
 * @returns {boolean}
 */
function hasCryptoKeyUsage(key, usage) {
  return hasUsage(getCryptoKeyUsagesMask(key), usage);
}

/**
 * Returns the CryptoKey's cached canonical usages array for internal
 * consumers, expanding it from the native usage mask on first access.
 * @param {Array} slots
 * @returns {string[]}
 */
function getCryptoKeyUsagesFromSlots(slots) {
  let usages = slots[kSlotUsages];
  if (usages === undefined) {
    usages = getUsagesFromMask(slots[kSlotUsagesMask]);
    slots[kSlotUsages] = usages;
  }
  return usages;
}

/**
 * Returns the CryptoKey's `[[usages]]` internal slot, bypassing the
 * public `usages` getter (which returns a cloned array). The internal
 * array is expanded lazily from the native usage mask.
 * @param {CryptoKey} key
 * @returns {string[]}
 */
function getCryptoKeyUsages(key) {
  return getCryptoKeyUsagesFromSlots(getSlots(key));
}

/**
 * Returns the KeyObjectHandle wrapping the CryptoKey's underlying
 * key material.
 * @param {CryptoKey} key
 * @returns {KeyObjectHandle}
 */
function getCryptoKeyHandle(key) {
  return getSlots(key)[kSlotHandle];
}

/**
 * Returns the optional Hybrid KEM-only secondary KeyObjectHandle wrapping a
 * CryptoKey's other underlying key material.
 * @param {CryptoKey} key
 * @returns {KeyObjectHandle | undefined}
 */
function getCryptoKeySecondaryHandle(key) {
  return getSlots(key)[kSlotSecondaryHandle];
}

/**
 * Returns the optional Hybrid KEM-only seed data stored with a CryptoKey.
 * @param {CryptoKey} key
 * @returns {Uint8Array | undefined}
 */
function getCryptoKeySeedData(key) {
  return getSlots(key)[kSlotSeedData];
}

function importGenericSecretKey(
  algorithm,
  format,
  keyData,
  extractable,
  keyUsages,
) {
  const usagesSet = toUsagesSet(keyUsages);
  const { name } = algorithm;
  if (extractable)
    throw lazyDOMException(`${name} keys are not extractable`, 'SyntaxError');

  if (hasAnyNotIn(usagesSet, ['deriveKey', 'deriveBits'])) {
    throw lazyDOMException(
      `Unsupported key usage for a ${name} key`,
      'SyntaxError');
  }

  let handle;
  switch (format) {
    case 'KeyObjectHandle': {
      handle = keyData;
      break;
    }
    case 'raw-secret':
    case 'raw': {
      handle = new KeyObjectHandle();
      handle.init(kKeyTypeSecret, keyData);
      break;
    }
    default:
      return undefined;
  }

  return new InternalCryptoKey(
    handle,
    { name },
    getUsagesMask(usagesSet),
    false);
}


// Structured clone: the key material as DER or bytes, then the slots.
function serializeKey(key) {
  if (!isCryptoKey(key)) return undefined;
  const type = getCryptoKeyType(key);
  const object = core.keyObjectFromHandle(type, getCryptoKeyHandle(key));
  const result = core.serializeKeyObject(object);
  result.algorithm = cloneAlgorithm(getCryptoKeyAlgorithm(key));
  result.extractable = getCryptoKeyExtractable(key);
  result.usagesMask = getCryptoKeyUsagesMask(key);
  // Hybrid KEM keys carry their group key and seed too (Node clones the
  // whole CryptoKey slot list).
  const secondary = getCryptoKeySecondaryHandle(key);
  if (secondary !== undefined) result.secondary = core.serializeKeyObject(core.keyObjectFromHandle(type, secondary));
  const seed = getCryptoKeySeedData(key);
  if (seed !== undefined) result.seed = new Uint8Array(seed);
  return result;
}

function deserializeKey(value) {
  const object = core.deserializeKeyObject(value);
  const secondary = value.secondary === undefined ? undefined : core.keyObjectHandle(core.deserializeKeyObject(value.secondary));
  return new InternalCryptoKey(core.keyObjectHandle(object), value.algorithm, value.usagesMask, value.extractable, secondary, value.seed);
}

module.exports = {
  // Public API.
  createSecretKey,
  createPublicKey,
  createPrivateKey,
  KeyObject,
  CryptoKey,
  InternalCryptoKey,

  // These are designed for internal use only and should not be exposed.
  toCryptoKey,
  toCryptoKeySecret,
  toPublicCryptoKey,
  prepareSecretKey: (key, encoding, bufferOnly) => core.prepareSecretKey(key, encoding, bufferOnly),
  isKeyObject: (value) => require('internal/host').types.isKeyObject(value),
  isCryptoKey,
  getCryptoKeyType,
  getCryptoKeyExtractable,
  getCryptoKeyAlgorithm,
  getCryptoKeyUsages,
  getCryptoKeyUsagesMask,
  hasCryptoKeyUsage,
  getCryptoKeyHandle,
  getCryptoKeySecondaryHandle,
  getCryptoKeySeedData,
  importGenericSecretKey,
  serializeKey,
  deserializeKey,
};
