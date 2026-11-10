'use strict';

const shared = require('internal/streams/support');
const codes = { ...shared.codes };
for (const [code, Base, message] of [
  ['ERR_INVALID_STATE', Error, state => `Invalid state: ${state}`],
  ['ERR_OPERATION_FAILED', Error, reason => `Operation failed: ${reason}`],
  ['ERR_BROTLI_INVALID_PARAM', RangeError, key => `${key} is not a valid Brotli parameter`],
  ['ERR_ZSTD_INVALID_PARAM', RangeError, key => `${key} is not a valid Zstd parameter`],
]) {
  codes[code] = class extends Base {
    constructor(value) { super(message(value)); this.code = code; }
  };
  Object.defineProperty(codes[code], 'name', { value: code });
}
for (const Base of [TypeError, RangeError]) {
  codes.ERR_INVALID_STATE[Base.name] = class extends Base {
    constructor(state) { super(`Invalid state: ${state}`); this.code = 'ERR_INVALID_STATE'; }
  };
}
codes.ERR_INVALID_ARG_VALUE = class extends shared.codes.ERR_INVALID_ARG_VALUE {};
codes.ERR_INVALID_ARG_VALUE.RangeError = class extends RangeError {
  constructor(...args) {
    super(new shared.codes.ERR_INVALID_ARG_VALUE(...args).message);
    this.code = 'ERR_INVALID_ARG_VALUE';
  }
};
function validateObject(value, name, flags = 0) {
  if (value === null || typeof value !== 'object' || (!(flags & 2) && Array.isArray(value))) {
    throw new codes.ERR_INVALID_ARG_TYPE(name, 'Object', value);
  }
}
function validateArray(value, name, minLength = 0) {
  if (!Array.isArray(value)) throw new codes.ERR_INVALID_ARG_TYPE(name, 'Array', value);
  if (value.length < minLength) throw new codes.ERR_INVALID_ARG_VALUE(name, value, `must have a length of at least ${minLength}`);
}
function validateOneOf(value, name, values) {
  if (!values.includes(value)) {
    throw new codes.ERR_INVALID_ARG_VALUE(name, value,
      'must be one of: ' + values.map(v => typeof v === 'string' ? `'${v}'` : String(v)).join(', '));
  }
}
function validateFiniteNumber(value, name) {
  if (value === undefined || Number.isNaN(value)) return false;
  if (Number.isFinite(value)) return true;
  shared.validateNumber(value, name);
  throw new codes.ERR_OUT_OF_RANGE(name, 'a finite number', value);
}
function checkRangesOrGetDefault(value, name, min, max, fallback) {
  if (!validateFiniteNumber(value, name)) return fallback;
  if (value < min || value > max) throw new codes.ERR_OUT_OF_RANGE(name, `>= ${min} and <= ${max}`, value);
  return value;
}
const warned = new Set();
function emitExperimentalWarning(feature) {
  if (warned.has(feature)) return;
  warned.add(feature);
  process.emitWarning(`${feature} is an experimental feature and might change at any time`, 'ExperimentalWarning');
}
module.exports = {
  ...shared,
  codes,
  validateObject,
  validateArray,
  validateOneOf,
  validateFiniteNumber,
  checkRangesOrGetDefault,
  kValidateObjectAllowArray: 2,
  lazyDOMException: (message, name) => new DOMException(message, name),
  isError: value => require('util/types').isNativeError(value) || value instanceof DOMException,
  emitExperimentalWarning,
  TextEncoder,
  TextDecoder,
  AbortController,
  AbortSignal,
  queueMicrotask,
};
