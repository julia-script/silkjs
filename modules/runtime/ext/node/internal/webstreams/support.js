// What the Node.js v24.22.1 web streams modules take from internal/util,
// internal/util/types, internal/validators, internal/assert, internal/webidl,
// internal/worker/js_transferable and the messaging/buffer/util bindings, in
// one place. The webidl enumeration converter is ported from Node.js v24.22.1.
// Copyright Node.js contributors. All rights reserved. MIT license (see
// vendor/node-api/LICENSE).

'use strict';

const {
  RegExpPrototypeSymbolReplace,
  SafeSet,
  String,
  Uint8Array,
} = require('internal/per_context/primordials');

const host = require('internal/host');
const types = require('util/types');
const { DOMException } = require('internal/path_events/event_target');

const { customInspectSymbol, kEmptyObject, kEnumerableProperty, normalizeEncoding, setOwnProperty } = require('internal/util');
const {
  kValidateObjectAllowObjects, kValidateObjectAllowObjectsAndNull, validateAbortSignal, validateBoolean,
  validateBuffer, validateFunction, validateNumber, validateObject, validateOneOf,
} = require('internal/validators');
const assert = require('internal/assert');

// Node runs the replacement through a RegExp from a separate realm so that
// user changes to RegExp.prototype are not observed; the primordial is the
// original RegExp.prototype[Symbol.replace], which gives the same guarantee.
function SideEffectFreeRegExpPrototypeSymbolReplace(regex, string, replacement) {
  return RegExpPrototypeSymbolReplace(regex, string, replacement);
}

// internal/webidl: the enumeration converter.
function makeException(message, options = kEmptyObject) {
  const prefix = options.prefix ? options.prefix + ': ' : '';
  const context = options.context?.length === 0 ?
    '' : (options.context ?? 'Value') + ' ';
  const err = new TypeError(`${prefix}${context}${message}`);
  setOwnProperty(err, 'code', options.code || 'ERR_INVALID_ARG_TYPE');
  return err;
}

function makeOptions(options, context = options.context, code = options.code) {
  return {
    prefix: options.prefix,
    context,
    code,
    enforceRange: options.enforceRange,
    clamp: options.clamp,
    allowShared: options.allowShared,
    allowResizable: options.allowResizable,
  };
}

function webidlToString(V, options = kEmptyObject) {
  if (typeof V === 'symbol') {
    throw makeException(
      'is a Symbol and cannot be converted to a string.',
      options);
  }
  return String(V);
}

function createEnumConverter(name, values) {
  const E = new SafeSet(values);

  return function(V, options = kEmptyObject) {
    const S = webidlToString(V, options);
    if (!E.has(S)) {
      throw makeException(
        `'${S}' is not a valid enum value of type ${name}.`,
        makeOptions(options, options.context, 'ERR_INVALID_ARG_VALUE'));
    }
    return S;
  };
}

// internal/worker/js_transferable
const {
  kClone,
  kDeserialize,
  kTransfer,
  kTransferList,
  markTransferMode,
} = require('internal/worker/js_transferable');

function structuredClone(value, options) {
  return require('internal/worker/clone').structuredClone(value, options);
}

// The buffer binding's copyArrayBuffer(destination, destinationOffset,
// source, sourceOffset, bytesToCopy). Callers check the ranges first.
function copyArrayBuffer(destination, destinationOffset, source, sourceOffset, bytesToCopy) {
  const target = new Uint8Array(destination, destinationOffset, bytesToCopy);
  target.set(new Uint8Array(source, sourceOffset, bytesToCopy));
}

module.exports = {
  // messaging binding
  DOMException,
  // buffer binding
  copyArrayBuffer,
  // util binding
  constants: { kPending: 0, kFulfilled: 1, kRejected: 2 },
  getPromiseDetails: host.getPromiseDetails,
  // internal/process/task_queues
  queueMicrotask: globalThis.queueMicrotask,
  // internal/util
  customInspectSymbol,
  kEmptyObject,
  kEnumerableProperty,
  normalizeEncoding,
  setOwnProperty,
  SideEffectFreeRegExpPrototypeSymbolReplace,
  // internal/util/types
  isAnyArrayBuffer: types.isAnyArrayBuffer,
  isArrayBufferView: types.isArrayBufferView,
  isDataView: types.isDataView,
  isSharedArrayBuffer: types.isSharedArrayBuffer,
  // internal/validators
  kValidateObjectAllowObjects,
  kValidateObjectAllowObjectsAndNull,
  validateAbortSignal,
  validateBoolean,
  validateBuffer,
  validateFunction,
  validateNumber,
  validateObject,
  validateOneOf,
  // internal/webidl
  createEnumConverter,
  // internal/assert
  assert,
  // internal/worker/js_transferable
  kClone,
  kDeserialize,
  kTransfer,
  kTransferList,
  markTransferMode,
  structuredClone,
};
