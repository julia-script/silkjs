'use strict';

// The lib/internal/util.js helpers (Node.js main ce7aaf1c) that the ported
// lib/internal/crypto modules use, kept private to internal/crypto until the
// runtime has Node's full internal/util. Changes: DOMException is the
// runtime's; the encoding_binding pieces are added for webcrypto.js.
// Copyright Node.js contributors. All rights reserved. MIT license (see
// vendor/node-api/LICENSE).

const {
  ArrayFrom,
  ArrayPrototypeSort,
  Error,
  ErrorCaptureStackTrace,
  ObjectDefineProperty,
  ObjectFreeze,
  ObjectGetOwnPropertyDescriptor,
  ObjectIsExtensible,
  ObjectPrototypeHasOwnProperty,
  SafeMap,
  SafeSet,
  StringPrototypeToLowerCase,
  SymbolFor,
} = require('internal/per_context/primordials');

let _DOMException;
function isErrorStackTraceLimitWritable() {
  const desc = ObjectGetOwnPropertyDescriptor(Error, 'stackTraceLimit');
  if (desc === undefined) return ObjectIsExtensible(Error);
  return ObjectPrototypeHasOwnProperty(desc, 'writable') ? desc.writable : desc.set !== undefined;
}

const lazyDOMException = (message, name) => {
  _DOMException ??= require('internal/path_events/event_target').DOMException;
  if (isErrorStackTraceLimitWritable()) {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    const ex = new _DOMException(message, name);
    Error.stackTraceLimit = limit;
    ErrorCaptureStackTrace(ex, lazyDOMException);
    return ex;
  }
  return new _DOMException(message, name);
};

const kEnumerableProperty = ObjectFreeze({
  __proto__: null,
  enumerable: true,
});

const kEmptyObject = ObjectFreeze({ __proto__: null });

const customInspectSymbol = SymbolFor('nodejs.util.inspect.custom');

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

const experimentalWarnings = new SafeSet();
function emitExperimentalWarning(feature, messagePrefix, code, ctor) {
  if (experimentalWarnings.has(feature)) return;
  experimentalWarnings.add(feature);
  let msg = `${feature} is an experimental feature and might change at any time`;
  if (messagePrefix) {
    msg = messagePrefix + msg;
  }
  process.emitWarning(msg, 'ExperimentalWarning', code, ctor);
}

function filterDuplicateStrings(items, low) {
  const map = new SafeMap();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const key = StringPrototypeToLowerCase(item);
    if (low) {
      map.set(key, key);
    } else {
      map.set(key, item);
    }
  }
  return ArrayPrototypeSort(ArrayFrom(map.values()));
}

const codesWarned = new SafeSet();
function getDeprecationWarningEmitter(
  code, msg, deprecated, useEmitSync,
  shouldEmitWarning = () => true,
) {
  let warned = false;
  return function(arg) {
    if (!warned && shouldEmitWarning(arg)) {
      warned = true;
      if (code === 'ExperimentalWarning') {
        process.emitWarning(msg, code, deprecated);
      } else if (code !== undefined) {
        if (!codesWarned.has(code)) {
          process.emitWarning(msg, 'DeprecationWarning', code, deprecated);
          codesWarned.add(code);
        }
      } else {
        process.emitWarning(msg, 'DeprecationWarning', deprecated);
      }
    }
  };
}

// internalBinding('encoding_binding') decodeUTF8(buffer, ignoreBOM, fatal)
// and encodeUtf8String(string).
const encodingBinding = {
  decodeUTF8(data, ignoreBOM, fatal) {
    const { TextDecoder } = require('util');
    return new TextDecoder('utf-8', { ignoreBOM, fatal }).decode(data);
  },
  encodeUtf8String(string) {
    const { TextEncoder } = require('util');
    return new TextEncoder().encode(string);
  },
};

module.exports = {
  customInspectSymbol,
  emitExperimentalWarning,
  encodingBinding,
  filterDuplicateStrings,
  getDeprecationWarningEmitter,
  kEmptyObject,
  kEnumerableProperty,
  lazyDOMException,
  setOwnProperty,
};
