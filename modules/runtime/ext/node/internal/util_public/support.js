'use strict';

const shared = require('internal/path_events/support');
const {
  ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE, ERR_OUT_OF_RANGE, ERR_INVALID_MIME_SYNTAX,
  ERR_ILLEGAL_CONSTRUCTOR, ERR_PARSE_ARGS_INVALID_OPTION_VALUE,
  ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL, ERR_PARSE_ARGS_UNKNOWN_OPTION, ERR_THROTTLED,
} = require('internal/errors').codes;
function validateInteger(value, name, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'number') throw new ERR_INVALID_ARG_TYPE(name, 'number', value);
  if (!Number.isInteger(value)) throw new ERR_OUT_OF_RANGE(name, 'an integer', value);
  if (value < min || value > max) throw new ERR_OUT_OF_RANGE(name, `>= ${min} && <= ${max}`, value);
}
function validateArray(value, name) {
  if (!Array.isArray(value)) throw new ERR_INVALID_ARG_TYPE(name, 'Array', value);
}
function validateStringArray(value, name) {
  validateArray(value, name);
  for (let i = 0; i < value.length; i++) shared.validateString(value[i], `${name}[${i}]`);
}
function validateBooleanArray(value, name) {
  validateArray(value, name);
  for (let i = 0; i < value.length; i++) shared.validateBoolean(value[i], `${name}[${i}]`);
}
function validateUnion(value, name, union) {
  if (!union.includes(value)) throw new ERR_INVALID_ARG_TYPE(name, `('${union.join('|')}')`, value);
}
function validateOneOf(value, name, allowed) {
  if (!allowed.includes(value)) {
    throw new ERR_INVALID_ARG_VALUE(name, value, 'must be one of: ' + allowed.map(v => typeof v === 'string' ? `'${v}'` : String(v)).join(', '));
  }
}
module.exports = {
  ...shared,
  codes: { ...shared.codes, ERR_INVALID_ARG_VALUE, ERR_OUT_OF_RANGE, ERR_INVALID_MIME_SYNTAX,
    ERR_ILLEGAL_CONSTRUCTOR, ERR_PARSE_ARGS_INVALID_OPTION_VALUE,
    ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL, ERR_PARSE_ARGS_UNKNOWN_OPTION, ERR_THROTTLED },
  validateArray, validateStringArray, validateBooleanArray, validateUnion, validateOneOf, validateInteger,
};
