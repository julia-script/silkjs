'use strict';
// Argument validators from Node.js v24 lib/internal/validators.js, as used by the
// http2 modules. Copyright Joyent, Inc. and other Node contributors. MIT license
// (see THIRD_PARTY_NOTICES).
const { codes: { ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE, ERR_OUT_OF_RANGE }, hideStackFrames } = require('internal/http2/errors');

const isUint32 = (value) => value === (value >>> 0);

const validateString = hideStackFrames((value, name) => {
  if (typeof value !== 'string') throw new ERR_INVALID_ARG_TYPE(name, 'string', value);
});
const validateBoolean = hideStackFrames((value, name) => {
  if (typeof value !== 'boolean') throw new ERR_INVALID_ARG_TYPE(name, 'boolean', value);
});
const validateFunction = hideStackFrames((value, name) => {
  if (typeof value !== 'function') throw new ERR_INVALID_ARG_TYPE(name, 'Function', value);
});
const validateObject = hideStackFrames((value, name) => {
  if (value === null || Array.isArray(value) || typeof value !== 'object') throw new ERR_INVALID_ARG_TYPE(name, 'Object', value);
});
const validateNumber = hideStackFrames((value, name, min = undefined, max) => {
  if (typeof value !== 'number') throw new ERR_INVALID_ARG_TYPE(name, 'number', value);
  if ((min != null && value < min) || (max != null && value > max) ||
      ((min != null || max != null) && Number.isNaN(value))) {
    throw new ERR_OUT_OF_RANGE(name,
      `${min != null ? `>= ${min}` : ''}${min != null && max != null ? ' && ' : ''}${max != null ? `<= ${max}` : ''}`,
      value);
  }
});
const validateInteger = hideStackFrames((value, name, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) => {
  if (typeof value !== 'number') throw new ERR_INVALID_ARG_TYPE(name, 'number', value);
  if (!Number.isInteger(value)) throw new ERR_OUT_OF_RANGE(name, 'an integer', value);
  if (value < min || value > max) throw new ERR_OUT_OF_RANGE(name, `>= ${min} && <= ${max}`, value);
});
const validateInt32 = hideStackFrames((value, name, min = -2147483648, max = 2147483647) => {
  if (typeof value !== 'number') throw new ERR_INVALID_ARG_TYPE(name, 'number', value);
  if (!Number.isInteger(value)) throw new ERR_OUT_OF_RANGE(name, 'an integer', value);
  if (value < min || value > max) throw new ERR_OUT_OF_RANGE(name, `>= ${min} && <= ${max}`, value);
});
const validateUint32 = hideStackFrames((value, name, positive = false) => {
  if (typeof value !== 'number') throw new ERR_INVALID_ARG_TYPE(name, 'number', value);
  if (!Number.isInteger(value)) throw new ERR_OUT_OF_RANGE(name, 'an integer', value);
  const min = positive ? 1 : 0;
  const max = 4294967295;
  if (value < min || value > max) throw new ERR_OUT_OF_RANGE(name, `>= ${min} && <= ${max}`, value);
});
const validateBuffer = hideStackFrames((buffer, name = 'buffer') => {
  if (!ArrayBuffer.isView(buffer)) throw new ERR_INVALID_ARG_TYPE(name, ['Buffer', 'TypedArray', 'DataView'], buffer);
});
const validateAbortSignal = hideStackFrames((signal, name) => {
  if (signal !== undefined && (signal === null || typeof signal !== 'object' || !('aborted' in signal))) {
    throw new ERR_INVALID_ARG_TYPE(name, 'AbortSignal', signal);
  }
});

const linkValueRegExp = /^(?:<[^>]*>)(?:\s*;\s*[^;"\s]+(?:=(")?[^;"\s]*\1)?)*$/;
function validateLinkHeaderFormat(value, name) {
  if (typeof value === 'undefined' || !linkValueRegExp.exec(value)) {
    throw new ERR_INVALID_ARG_VALUE(name, value,
      'must be an array or string of format "</styles.css>; rel=preload; as=style"');
  }
}
function validateLinkHeaderValue(hints) {
  if (typeof hints === 'string') {
    validateLinkHeaderFormat(hints, 'hints');
    return hints;
  } else if (Array.isArray(hints)) {
    let result = '';
    for (let i = 0; i < hints.length; i++) {
      validateLinkHeaderFormat(hints[i], 'hints');
      result += hints[i];
      if (i !== hints.length - 1) result += ', ';
    }
    return result;
  }
  throw new ERR_INVALID_ARG_VALUE('hints', hints,
    'must be an array or string of format "</styles.css>; rel=preload; as=style"');
}

module.exports = {
  isUint32, validateAbortSignal, validateBoolean, validateBuffer, validateFunction,
  validateInt32, validateInteger, validateLinkHeaderValue, validateNumber, validateObject,
  validateString, validateUint32,
};
