'use strict';

// The parts of Node's internalBinding('util') that util.inspect reads, over the
// runtime's introspection natives. Like V8's, these read internal slots and
// never run user code (no getters, no proxy traps).

const {
  ArrayPrototypeFilter,
  ObjectPrototypePropertyIsEnumerable,
  ReflectOwnKeys,
} = require('internal/per_context/primordials');
const host = require('internal/host');

// v8::PropertyFilter values, as Node's binding exposes them.
const ALL_PROPERTIES = 0;
const ONLY_ENUMERABLE = 2;
const SKIP_SYMBOLS = 16;
// v8::Promise::PromiseState.
const kPending = 0;
const kFulfilled = 1;
const kRejected = 2;

// Canonical array index: a uint32 below 2 ** 32 - 1 in its shortest decimal form.
const arrayIndexRegExp = /^(?:0|[1-9][0-9]*)$/;
function isArrayIndex(key) {
  return typeof key === 'string' && key.length <= 10 && arrayIndexRegExp.test(key) && +key < 4294967295;
}

// The own keys of `value` without integer indices, in property order
// (v8::KeyCollectionMode::kOwnOnly, IndexFilter::kSkipIndices), filtered by
// the ONLY_ENUMERABLE and SKIP_SYMBOLS bits of `filter`.
function getOwnNonIndexProperties(value, filter) {
  const onlyEnumerable = (filter & ONLY_ENUMERABLE) !== 0;
  const skipSymbols = (filter & SKIP_SYMBOLS) !== 0;
  return ArrayPrototypeFilter(ReflectOwnKeys(value), (key) =>
    (typeof key === 'symbol' ? !skipSymbols : !isArrayIndex(key)) &&
    (!onlyEnumerable || ObjectPrototypePropertyIsEnumerable(value, key)));
}

// [state, result]; result is undefined while pending.
function getPromiseDetails(promise) {
  return host.getPromiseDetails(promise);
}

// undefined for a non-proxy. A revoked proxy has no target or handler: null
// for the target alone, [null, null] for both, as V8 reports them.
function getProxyDetails(value, showProxy = true) {
  const details = host.getProxyDetails(value);
  if (details === undefined) return undefined;
  if (details === null) return showProxy ? [null, null] : null;
  return showProxy ? details : details[0];
}

// The engine's class name for an object (v8::Object::GetConstructorName).
function getConstructorName(value) {
  return host.getConstructorName(value);
}

// Without isKeyValue: the entries of a WeakMap (as key, value, key, value...)
// or WeakSet. With it: [entries, isKeyValue] for the entries a Map or Set
// iterator has not yet produced, without advancing it.
function previewEntries(value, isIterator) {
  const preview = host.previewEntries(value);
  if (preview === undefined) return undefined;
  if (isIterator) return preview;
  return preview[0];
}

// The runtime creates no v8::External values (util.types.isExternal is
// always false), so there is no external pointer to report.
function getExternalValue(value) {
  const error = new TypeError('The value is not an External');
  error.code = 'ERR_INVALID_ARG_TYPE';
  throw error;
}

// Node's privateSymbols are V8 private symbols, invisible to reflection. Here
// they are ordinary symbols shared by the modules that read and write them.
const privateSymbols = {
  __proto__: null,
  arrow_message_private_symbol: Symbol('node:arrowMessage'),
  decorated_private_symbol: Symbol('node:decorated'),
};

// uv_sleep: blocks the thread for msec milliseconds without running the loop.
let sleepCell;
function sleep(msec) {
  sleepCell ??= new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sleepCell, 0, 0, msec);
}

// node_util.cc GetCallerLocation: [line, column, script name] of the caller of the JS
// function that called this one (V8 stack frames 0 and 1), or undefined without two frames.
function getCallerLocation() {
  const frames = host.captureCallSites(2, getCallerLocation);
  if (frames.length !== 2) return undefined;
  const frame = frames[1];
  return [frame.lineNumber, frame.columnNumber, frame.scriptName];
}

module.exports = {
  getCallerLocation,
  privateSymbols,
  sleep,
  ALL_PROPERTIES,
  ONLY_ENUMERABLE,
  SKIP_SYMBOLS,
  kPending,
  kFulfilled,
  kRejected,
  getOwnNonIndexProperties,
  getPromiseDetails,
  getProxyDetails,
  getConstructorName,
  previewEntries,
  getExternalValue,
};
