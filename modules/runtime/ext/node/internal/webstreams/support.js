// Helpers the Node.js v24.22.1 web streams modules take from internal/util,
// internal/util/types, internal/validators, internal/assert,
// internal/worker/js_transferable and the messaging/buffer/util bindings.
// The validators and assert are ported from Node.js v24.22.1.
// Copyright Node.js contributors. All rights reserved. MIT license (see
// vendor/node-api/LICENSE).

'use strict';

const {
  ArrayIsArray,
  ArrayPrototypeIncludes,
  ArrayPrototypeJoin,
  ArrayPrototypeMap,
  NumberIsNaN,
  ObjectDefineProperty,
  ObjectFreeze,
  RegExpPrototypeSymbolReplace,
  SafeSet,
  String,
  SymbolFor,
  Uint8Array,
} = require('internal/per_context/primordials');

const {
  codes: {
    ERR_INTERNAL_ASSERTION,
    ERR_INVALID_ARG_TYPE,
    ERR_INVALID_ARG_VALUE,
    ERR_OUT_OF_RANGE,
  },
} = require('internal/errors');

const host = require('internal/host');
const types = require('util/types');
const { DOMException } = require('internal/path_events/event_target');
const { normalizeEncoding } = require('internal/streams/support');

// internal/util
const customInspectSymbol = SymbolFor('nodejs.util.inspect.custom');
const kEmptyObject = ObjectFreeze({ __proto__: null });
const kEnumerableProperty = ObjectFreeze({ __proto__: null, enumerable: true });

function setOwnProperty(obj, key, value) {
  ObjectDefineProperty(obj, key, {
    __proto__: null,
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
  return value;
}

// Node runs the replacement through a RegExp from a separate realm so that
// user changes to RegExp.prototype are not observed; the primordial is the
// original RegExp.prototype[Symbol.replace], which gives the same guarantee.
function SideEffectFreeRegExpPrototypeSymbolReplace(regex, string, replacement) {
  return RegExpPrototypeSymbolReplace(regex, string, replacement);
}

// internal/validators
const kValidateObjectNone = 0;
const kValidateObjectAllowNullable = 1 << 0;
const kValidateObjectAllowArray = 1 << 1;
const kValidateObjectAllowFunction = 1 << 2;
const kValidateObjectAllowObjects = kValidateObjectAllowArray |
  kValidateObjectAllowFunction;
const kValidateObjectAllowObjectsAndNull = kValidateObjectAllowNullable |
  kValidateObjectAllowArray |
  kValidateObjectAllowFunction;

function validateObject(value, name, options = kValidateObjectNone) {
  if (options === kValidateObjectNone) {
    if (value === null || ArrayIsArray(value)) {
      throw new ERR_INVALID_ARG_TYPE(name, 'Object', value);
    }

    if (typeof value !== 'object') {
      throw new ERR_INVALID_ARG_TYPE(name, 'Object', value);
    }
  } else {
    const throwOnNullable = (kValidateObjectAllowNullable & options) === 0;

    if (throwOnNullable && value === null) {
      throw new ERR_INVALID_ARG_TYPE(name, 'Object', value);
    }

    const throwOnArray = (kValidateObjectAllowArray & options) === 0;

    if (throwOnArray && ArrayIsArray(value)) {
      throw new ERR_INVALID_ARG_TYPE(name, 'Object', value);
    }

    const throwOnFunction = (kValidateObjectAllowFunction & options) === 0;
    const typeofValue = typeof value;

    if (typeofValue !== 'object' && (throwOnFunction || typeofValue !== 'function')) {
      throw new ERR_INVALID_ARG_TYPE(name, 'Object', value);
    }
  }
}

function validateNumber(value, name, min = undefined, max) {
  if (typeof value !== 'number')
    throw new ERR_INVALID_ARG_TYPE(name, 'number', value);

  if ((min != null && value < min) || (max != null && value > max) ||
    ((min != null || max != null) && NumberIsNaN(value))) {
    throw new ERR_OUT_OF_RANGE(
      name,
      `${min != null ? `>= ${min}` : ''}${min != null && max != null ? ' && ' : ''}${max != null ? `<= ${max}` : ''}`,
      value);
  }
}

function validateOneOf(value, name, oneOf) {
  if (!ArrayPrototypeIncludes(oneOf, value)) {
    const allowed = ArrayPrototypeJoin(
      ArrayPrototypeMap(oneOf, (v) =>
        (typeof v === 'string' ? `'${v}'` : String(v))),
      ', ');
    const reason = 'must be one of: ' + allowed;
    throw new ERR_INVALID_ARG_VALUE(name, value, reason);
  }
}

function validateBoolean(value, name) {
  if (typeof value !== 'boolean')
    throw new ERR_INVALID_ARG_TYPE(name, 'boolean', value);
}

function validateBuffer(buffer, name = 'buffer') {
  if (!types.isArrayBufferView(buffer)) {
    throw new ERR_INVALID_ARG_TYPE(name,
                                   ['Buffer', 'TypedArray', 'DataView'],
                                   buffer);
  }
}

function validateAbortSignal(signal, name) {
  if (signal !== undefined &&
      (signal === null ||
       typeof signal !== 'object' ||
       !('aborted' in signal))) {
    throw new ERR_INVALID_ARG_TYPE(name, 'AbortSignal', signal);
  }
}

function validateFunction(value, name) {
  if (typeof value !== 'function')
    throw new ERR_INVALID_ARG_TYPE(name, 'Function', value);
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

// internal/assert
function assert(value, message) {
  if (!value) {
    throw new ERR_INTERNAL_ASSERTION(message);
  }
}
function fail(message) {
  throw new ERR_INTERNAL_ASSERTION(message);
}
assert.fail = fail;

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
