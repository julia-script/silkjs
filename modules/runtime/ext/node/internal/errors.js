'use strict';

// Node-format error messages for the codes that builtin modules raise. Messages follow
// lib/internal/errors.js of Node 24 word for word, because tests and user code match them.

const kTypes = ['string', 'function', 'number', 'object', 'Function', 'Object', 'boolean', 'bigint', 'symbol'];
const classRegExp = /^[A-Z][a-zA-Z0-9]*$/;
let inspect;
function lazyInspect(value, options) {
  inspect ??= require('util').inspect;
  return inspect(value, options);
}

function formatList(array, type = 'and') {
  switch (array.length) {
    case 0: return '';
    case 1: return `${array[0]}`;
    case 2: return `${array[0]} ${type} ${array[1]}`;
    case 3: return `${array[0]}, ${array[1]}, ${type} ${array[2]}`;
    default: return `${array.slice(0, -1).join(', ')}, ${type} ${array[array.length - 1]}`;
  }
}

function determineSpecificType(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  switch (typeof value) {
    case 'bigint': return `type bigint (${value}n)`;
    case 'number':
      if (value === 0) return 1 / value === -Infinity ? 'type number (-0)' : 'type number (0)';
      return `type number (${value})`;
    case 'boolean': return `type boolean (${value})`;
    case 'symbol': return `type symbol (${String(value)})`;
    case 'function': return `function ${value.name}`;
    case 'object': {
      const name = value.constructor?.name;
      if (typeof name === 'string' && name !== '') return `an instance of ${name}`;
      return `${lazyInspect(value, { depth: -1 })}`;
    }
    case 'string':
      if (value.length > 28) value = `${value.slice(0, 25)}...`;
      if (value.indexOf("'") === -1) return `type string ('${value}')`;
      return `type string (${JSON.stringify(value)})`;
  }
  return `type ${typeof value} (${lazyInspect(value, { colors: false })})`;
}

function invalidArgTypeMessage(name, expected, actual) {
  if (!Array.isArray(expected)) expected = [expected];
  let msg = 'The ';
  if (name.endsWith(' argument')) msg += `${name} `;
  else msg += `"${name}" ${name.includes('.') ? 'property' : 'argument'} `;
  msg += 'must be ';
  const types = [], instances = [], other = [];
  for (const value of expected) {
    if (kTypes.includes(value)) types.push(value.toLowerCase());
    else if (classRegExp.test(value)) instances.push(value);
    else other.push(value);
  }
  if (instances.length > 0) {
    const position = types.indexOf('object');
    if (position !== -1) { types.splice(position, 1); instances.push('Object'); }
  }
  if (types.length > 0) {
    msg += `${types.length > 1 ? 'one of type' : 'of type'} ${formatList(types, 'or')}`;
    if (instances.length > 0 || other.length > 0) msg += ' or ';
  }
  if (instances.length > 0) {
    msg += `an instance of ${formatList(instances, 'or')}`;
    if (other.length > 0) msg += ' or ';
  }
  if (other.length > 0) {
    if (other.length > 1) msg += `one of ${formatList(other, 'or')}`;
    else {
      if (other[0].toLowerCase() !== other[0]) msg += 'an ';
      msg += `${other[0]}`;
    }
  }
  return `${msg}. Received ${determineSpecificType(actual)}`;
}

function addNumericalSeparator(value) {
  let result = '';
  let i = value.length;
  const start = value[0] === '-' ? 1 : 0;
  for (; i >= start + 4; i -= 3) result = `_${value.slice(i - 3, i)}${result}`;
  return `${value.slice(0, i)}${result}`;
}

function outOfRangeMessage(name, range, input, replaceDefaultBoolean = false) {
  let msg = replaceDefaultBoolean ? name : `The value of "${name}" is out of range.`;
  let received;
  if (Number.isInteger(input) && Math.abs(input) > 2 ** 32) received = addNumericalSeparator(String(input));
  else if (typeof input === 'bigint') {
    received = String(input);
    if (input > 2n ** 32n || input < -(2n ** 32n)) received = addNumericalSeparator(received);
    received += 'n';
  } else received = lazyInspect(input);
  msg += ` It must be ${range}. Received ${received}`;
  return msg;
}

function invalidArgValueMessage(name, value, reason = 'is invalid') {
  let inspected = lazyInspect(value);
  if (inspected.length > 128) inspected = `${inspected.slice(0, 128)}...`;
  return `The ${name.includes('.') ? 'property' : 'argument'} '${name}' ${reason}. Received ${inspected}`;
}

function missingArgsMessage(...args) {
  let msg = 'The ';
  const wrap = a => `"${a}"`;
  args = args.map(a => Array.isArray(a) ? a.map(wrap).join(' or ') : wrap(a));
  switch (args.length) {
    case 1: msg += `${args[0]} argument`; break;
    case 2: msg += `${args[0]} and ${args[1]} arguments`; break;
    default: msg += `${args.slice(0, -1).join(', ')}, and ${args[args.length - 1]} arguments`;
  }
  return `${msg} must be specified`;
}

function make(Base, code, message) {
  const error = new Base(message);
  Object.defineProperty(error, 'code', { value: code, enumerable: true, writable: true, configurable: true });
  return error;
}

const codes = {
  ERR_INVALID_ARG_TYPE: (name, expected, actual) => make(TypeError, 'ERR_INVALID_ARG_TYPE', invalidArgTypeMessage(name, expected, actual)),
  ERR_INVALID_ARG_VALUE: (name, value, reason) => make(TypeError, 'ERR_INVALID_ARG_VALUE', invalidArgValueMessage(name, value, reason)),
  ERR_INVALID_ARG_VALUE_RANGE: (name, value, reason) => make(RangeError, 'ERR_INVALID_ARG_VALUE', invalidArgValueMessage(name, value, reason)),
  ERR_OUT_OF_RANGE: (name, range, input, replace) => make(RangeError, 'ERR_OUT_OF_RANGE', outOfRangeMessage(name, range, input, replace)),
  ERR_MISSING_ARGS: (...names) => make(TypeError, 'ERR_MISSING_ARGS', missingArgsMessage(...names)),
  ERR_INVALID_THIS: type => make(TypeError, 'ERR_INVALID_THIS', `Value of "this" must be of type ${type}`),
  ERR_ILLEGAL_CONSTRUCTOR: () => make(TypeError, 'ERR_ILLEGAL_CONSTRUCTOR', 'Illegal constructor'),
};

function validateFunction(value, name) {
  if (typeof value !== 'function') throw codes.ERR_INVALID_ARG_TYPE(name, 'Function', value);
}
function validateString(value, name) {
  if (typeof value !== 'string') throw codes.ERR_INVALID_ARG_TYPE(name, 'string', value);
}
function validateObject(value, name, { allowArray = false, allowFunction = false, nullable = false } = {}) {
  if ((!nullable && value === null) || (!allowArray && Array.isArray(value)) ||
      (typeof value !== 'object' && (!allowFunction || typeof value !== 'function'))) {
    throw codes.ERR_INVALID_ARG_TYPE(name, 'Object', value);
  }
}
function validateBoolean(value, name) {
  if (typeof value !== 'boolean') throw codes.ERR_INVALID_ARG_TYPE(name, 'boolean', value);
}

module.exports = {
  codes, determineSpecificType, formatList,
  validateFunction, validateString, validateObject, validateBoolean,
};
