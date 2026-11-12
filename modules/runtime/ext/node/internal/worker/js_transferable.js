'use strict';

// The JS transferable protocol of Node.js v24.22.1 lib/internal/worker/js_transferable.js.
// An object marked transferable implements [kTransferList]() (extra objects to
// move with it, such as a MessagePort) and [kTransfer]() returning
// { data, deserializeInfo: 'module:Constructor' }; the receiving side builds
// `new Constructor()` and calls its [kDeserialize](data). internal/worker/clone
// carries such objects through structured clone and postMessage.
// Copyright Node.js contributors. All rights reserved. MIT license (see
// vendor/node-api/LICENSE).

const kDisallowCloneAndTransfer = 0;
const kTransferable = 1;
const kCloneable = 2;

// Node keeps the mode in a V8 private symbol; a WeakMap is the runtime's
// equivalent that user code cannot observe.
const transferModes = new WeakMap();

const kClone = Symbol('messaging_clone_symbol');
const kDeserialize = Symbol('messaging_deserialize_symbol');
const kTransfer = Symbol('messaging_transfer_symbol');
const kTransferList = Symbol('messaging_transfer_list_symbol');

/**
 * Mark an object as being transferable or customized cloneable in
 * `.postMessage()`.
 * @param {object} obj Host objects that can be either cloned or transferred.
 * @param {boolean} [cloneable] if the object can be cloned and `@@kClone` is
 *   implemented.
 * @param {boolean} [transferable] if the object can be transferred and
 *   `@@kTransfer` is implemented.
 */
function markTransferMode(obj, cloneable = false, transferable = false) {
  if ((typeof obj !== 'object' && typeof obj !== 'function') || obj === null)
    return;  // This object is a primitive and therefore already untransferable.
  let mode = kDisallowCloneAndTransfer;
  if (cloneable) mode |= kCloneable;
  if (transferable) mode |= kTransferable;
  transferModes.set(obj, mode);
}

function getTransferMode(obj) {
  if ((typeof obj !== 'object' && typeof obj !== 'function') || obj === null)
    return undefined;
  return transferModes.get(obj);
}

// The deserializer-side constructor lookup Node registers with
// setDeserializerCreateObjectFunction(): only built-in modules, through the
// internal require, which knows no other module.
function createDeserializedObject(deserializeInfo) {
  const { 0: module, 1: ctor } = String(deserializeInfo).split(':');
  if (!require('internal/host').builtinExists(module)) throw new TypeError(`Missing internal module '${module}'`);
  const Ctor = require(module)[ctor];
  if (typeof Ctor !== 'function' ||
      typeof Ctor.prototype[kDeserialize] !== 'function') {
    throw new Error(`Unknown deserialize spec ${deserializeInfo}`);
  }
  return new Ctor();
}

module.exports = {
  createDeserializedObject,
  getTransferMode,
  markTransferMode,
  kDisallowCloneAndTransfer,
  kTransferable,
  kCloneable,
  kClone,
  kDeserialize,
  kTransfer,
  kTransferList,
};
