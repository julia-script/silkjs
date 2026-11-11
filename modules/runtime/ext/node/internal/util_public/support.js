'use strict';

const shared = require('internal/path_events/support');
const { inspect } = require('internal/util/inspect');
const { ERR_INVALID_ARG_TYPE } = shared.codes;
class ERR_INVALID_ARG_VALUE extends TypeError {
  constructor(name, value, reason = 'is invalid') {
    let inspected = inspect(value);
    if (inspected.length > 128) inspected = inspected.slice(0, 128) + '...';
    super(`The ${name.includes('.') ? 'property' : 'argument'} '${name}' ${reason}. Received ${inspected}`);
    this.code = 'ERR_INVALID_ARG_VALUE';
  }
}
class ERR_OUT_OF_RANGE extends RangeError {
  constructor(name, range, value) {
    const received = Number.isInteger(value) && Math.abs(value) > 2 ** 32
      ? String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '_') : inspect(value);
    super(`The value of "${name}" is out of range. It must be ${range}. Received ${received}`);
    this.code = 'ERR_OUT_OF_RANGE';
  }
}
class ERR_INVALID_MIME_SYNTAX extends TypeError {
  constructor(production, string, index) {
    super(`The MIME syntax for a ${production} in "${string}" is invalid${index !== -1 ? ` at ${index}` : ''}`);
    this.code = 'ERR_INVALID_MIME_SYNTAX';
  }
}
class ERR_ILLEGAL_CONSTRUCTOR extends TypeError {
  constructor() { super('Illegal constructor'); this.code = 'ERR_ILLEGAL_CONSTRUCTOR'; }
}
class ERR_PARSE_ARGS_INVALID_OPTION_VALUE extends TypeError {
  constructor(message) { super(message); this.code = 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE'; }
}
class ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL extends TypeError {
  constructor(value) {
    super(`Unexpected argument '${value}'. This command does not take positional arguments`);
    this.code = 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL';
  }
}
class ERR_PARSE_ARGS_UNKNOWN_OPTION extends TypeError {
  constructor(option, allowPositionals) {
    super(`Unknown option '${option}'${allowPositionals ? ". To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- " + JSON.stringify(option) : ''}`);
    this.code = 'ERR_PARSE_ARGS_UNKNOWN_OPTION';
  }
}
class ERR_THROTTLED extends Error {
  constructor() { super('The call was dropped by the throttled function'); this.code = 'ERR_THROTTLED'; }
}
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
