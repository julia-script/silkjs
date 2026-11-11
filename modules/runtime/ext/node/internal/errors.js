'use strict';

// Node-style error codes and argument validators shared by the node: modules.
// Messages follow lib/internal/errors.js and lib/internal/validators.js of Node 24.

const kTypes = ['string', 'function', 'number', 'object', 'Function', 'Object', 'boolean', 'bigint', 'symbol'];

function formatList(list, word) {
  return list.length < 3 ? list.join(` ${word} `) : `${list.slice(0, -1).join(', ')}, ${word} ${list[list.length - 1]}`;
}

function determineSpecificType(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  switch (typeof value) {
    case 'bigint': return `type bigint (${value}n)`;
    case 'number': return `type number (${Object.is(value, -0) ? '-0' : String(value)})`;
    case 'boolean': return `type boolean (${value})`;
    case 'symbol': return `type symbol (${String(value)})`;
    case 'function': return `function ${value.name}`;
    case 'object': {
      const name = value.constructor?.name;
      if (typeof name === 'string' && name !== '') return `an instance of ${name}`;
      return require('util').inspect(value, { depth: -1 });
    }
    case 'string': {
      const shown = value.length > 28 ? `${value.slice(0, 25)}...` : value;
      return `type string (${require('util').inspect(shown)})`;
    }
  }
}

function addNumericalSeparator(text) {
  let result = '';
  let i = text.length;
  const start = text[0] === '-' ? 1 : 0;
  for (; i >= start + 4; i -= 3) result = `_${text.slice(i - 3, i)}${result}`;
  return `${text.slice(0, i)}${result}`;
}

// Like Node's NodeError: the stack and toString() show the code ("TypeError [ERR_X]: ...").
function makeError(Base, code, message) {
  const err = new Base(message);
  err.code = code;
  if (typeof err.stack === 'string') err.stack = err.stack.replace(`${err.name}:`, `${err.name} [${code}]:`);
  Object.defineProperty(err, 'toString', {
    value() { return `${this.name} [${code}]: ${this.message}`; }, writable: true, configurable: true,
  });
  return err;
}

function invalidArgTypeMessage(name, expected, actual) {
  if (!Array.isArray(expected)) expected = [expected];
  let message = 'The ';
  if (name.endsWith(' argument')) message += `${name} `;
  else message += `"${name}" ${name.includes('.') ? 'property' : 'argument'} `;
  message += 'must be ';
  const types = [];
  const instances = [];
  const other = [];
  for (const value of expected) {
    if (kTypes.includes(value)) types.push(value.toLowerCase());
    else if (/^[A-Z][a-zA-Z0-9]*$/.test(value)) instances.push(value);
    else other.push(value);
  }
  if (instances.length > 0) {
    const index = types.indexOf('object');
    if (index !== -1) { types.splice(index, 1); instances.push('Object'); }
  }
  if (types.length > 0) {
    message += `${types.length > 1 ? 'one of type' : 'of type'} ${formatList(types, 'or')}`;
    if (instances.length > 0 || other.length > 0) message += ' or ';
  }
  if (instances.length > 0) {
    message += `an instance of ${formatList(instances, 'or')}`;
    if (other.length > 0) message += ' or ';
  }
  if (other.length > 0) {
    if (other.length > 1) message += `one of ${formatList(other, 'or')}`;
    else message += `${other[0].toLowerCase() !== other[0] ? 'an ' : ''}${other[0]}`;
  }
  return `${message}. Received ${determineSpecificType(actual)}`;
}

function outOfRangeMessage(name, range, input) {
  let received;
  if (Number.isInteger(input) && Math.abs(input) > 2 ** 32) received = addNumericalSeparator(String(input));
  else if (typeof input === 'bigint') {
    received = String(input);
    if (input > 2n ** 32n || input < -(2n ** 32n)) received = addNumericalSeparator(received);
    received += 'n';
  } else received = require('util').inspect(input);
  return `The value of "${name}" is out of range. It must be ${range}. Received ${received}`;
}

// Each code is a function that builds the error, so `new ERR_X(...)` and `ERR_X(...)` both work.
const codes = {
  ERR_INVALID_ARG_TYPE: function(name, expected, actual) {
    return makeError(TypeError, 'ERR_INVALID_ARG_TYPE', invalidArgTypeMessage(name, expected, actual));
  },
  ERR_INVALID_ARG_VALUE: function(name, value, reason = 'is invalid', Base = TypeError) {
    let shown = require('util').inspect(value);
    if (shown.length > 128) shown = `${shown.slice(0, 128)}...`;
    return makeError(Base, 'ERR_INVALID_ARG_VALUE', `The ${name.includes('.') ? 'property' : 'argument'} '${name}' ${reason}. Received ${shown}`);
  },
  ERR_OUT_OF_RANGE: function(name, range, input) {
    return makeError(RangeError, 'ERR_OUT_OF_RANGE', outOfRangeMessage(name, range, input));
  },
  ERR_SOCKET_BAD_PORT: function(name, port, allowZero = true) {
    return makeError(RangeError, 'ERR_SOCKET_BAD_PORT',
      `${name} should be ${allowZero ? '>=' : '>'} 0 and < 65536. Received ${determineSpecificType(port)}.`);
  },
  ERR_MISSING_ARGS: function(...names) {
    const wrapped = names.map(name => Array.isArray(name) ? name.map(each => `"${each}"`).join(' or ') : `"${name}"`);
    let message = 'The ';
    if (wrapped.length === 1) message += `${wrapped[0]} argument`;
    else if (wrapped.length === 2) message += `${wrapped[0]} and ${wrapped[1]} arguments`;
    else message += `${wrapped.slice(0, -1).join(', ')}, and ${wrapped[wrapped.length - 1]} arguments`;
    return makeError(TypeError, 'ERR_MISSING_ARGS', `${message} must be specified`);
  },
  ERR_IP_BLOCKED: function(ip) {
    return makeError(Error, 'ERR_IP_BLOCKED', `IP(${ip}) is blocked by net.BlockList`);
  },
  ERR_BUFFER_OUT_OF_BOUNDS: function(name) {
    return makeError(RangeError, 'ERR_BUFFER_OUT_OF_BOUNDS', name ? `"${name}" is outside of buffer bounds` : 'Attempt to access memory outside buffer bounds');
  },
  ERR_INVALID_FD_TYPE: function(type) { return makeError(TypeError, 'ERR_INVALID_FD_TYPE', `Unsupported fd type: ${type}`); },
  ERR_SOCKET_ALREADY_BOUND: function() { return makeError(Error, 'ERR_SOCKET_ALREADY_BOUND', 'Socket is already bound'); },
  ERR_SOCKET_BAD_BUFFER_SIZE: function() { return makeError(TypeError, 'ERR_SOCKET_BAD_BUFFER_SIZE', 'Buffer size must be a positive integer'); },
  ERR_SOCKET_BAD_TYPE: function() { return makeError(TypeError, 'ERR_SOCKET_BAD_TYPE', 'Bad socket type specified. Valid types are: udp4, udp6'); },
  ERR_SOCKET_DGRAM_IS_CONNECTED: function() { return makeError(Error, 'ERR_SOCKET_DGRAM_IS_CONNECTED', 'Already connected'); },
  ERR_SOCKET_DGRAM_NOT_CONNECTED: function() { return makeError(Error, 'ERR_SOCKET_DGRAM_NOT_CONNECTED', 'Not connected'); },
  ERR_SOCKET_DGRAM_NOT_RUNNING: function() { return makeError(Error, 'ERR_SOCKET_DGRAM_NOT_RUNNING', 'Not running'); },
  ERR_INVALID_ADDRESS_FAMILY: function(addressType, host, port) {
    const err = makeError(RangeError, 'ERR_INVALID_ADDRESS_FAMILY', `Invalid address family: ${addressType} ${host}:${port}`);
    err.host = host;
    err.port = port;
    return err;
  },
  ERR_INVALID_IP_ADDRESS: function(address) {
    return makeError(TypeError, 'ERR_INVALID_IP_ADDRESS', `Invalid IP address: ${address}`);
  },
};

function errorName(status) { return require('internal/host').net('error', [status]).code; }

// Node's ErrnoException and ExceptionWithHostPort for a negative errno status.
function ErrnoException(status, syscall, original) {
  const code = errorName(status);
  const err = new Error(original ? `${syscall} ${code} ${original}` : `${syscall} ${code}`);
  err.errno = status;
  err.code = code;
  err.syscall = syscall;
  return err;
}
function ExceptionWithHostPort(status, syscall, address, port, additional) {
  const code = errorName(status);
  let details = port && port > 0 ? ` ${address}:${port}` : address ? ` ${address}` : '';
  if (additional) details += ` - Local (${additional})`;
  const err = new Error(`${syscall} ${code}${details}`);
  err.errno = status;
  err.code = code;
  err.syscall = syscall;
  err.address = address;
  if (port) err.port = port;
  return err;
}

function validateString(value, name) {
  if (typeof value !== 'string') throw codes.ERR_INVALID_ARG_TYPE(name, 'string', value);
}
function validateNumber(value, name, min, max) {
  if (typeof value !== 'number') throw codes.ERR_INVALID_ARG_TYPE(name, 'number', value);
  if ((min != null && value < min) || (max != null && value > max) || ((min != null || max != null) && Number.isNaN(value))) {
    throw codes.ERR_OUT_OF_RANGE(name,
      `${min != null ? `>= ${min}` : ''}${min != null && max != null ? ' && ' : ''}${max != null ? `<= ${max}` : ''}`, value);
  }
}
function validateInteger(value, name, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'number') throw codes.ERR_INVALID_ARG_TYPE(name, 'number', value);
  if (!Number.isInteger(value)) throw codes.ERR_OUT_OF_RANGE(name, 'an integer', value);
  if (value < min || value > max) throw codes.ERR_OUT_OF_RANGE(name, `>= ${min} && <= ${max}`, value);
}
function validateInt32(value, name, min = -2147483648, max = 2147483647) {
  if (typeof value !== 'number') throw codes.ERR_INVALID_ARG_TYPE(name, 'number', value);
  if (!Number.isInteger(value)) throw codes.ERR_OUT_OF_RANGE(name, 'an integer', value);
  if (value < min || value > max) throw codes.ERR_OUT_OF_RANGE(name, `>= ${min} && <= ${max}`, value);
}
function validateUint32(value, name, positive = false) {
  if (typeof value !== 'number') throw codes.ERR_INVALID_ARG_TYPE(name, 'number', value);
  if (!Number.isInteger(value)) throw codes.ERR_OUT_OF_RANGE(name, 'an integer', value);
  const min = positive ? 1 : 0;
  if (value < min || value > 4294967295) throw codes.ERR_OUT_OF_RANGE(name, `>= ${min} && <= 4294967295`, value);
}
function validateBoolean(value, name) {
  if (typeof value !== 'boolean') throw codes.ERR_INVALID_ARG_TYPE(name, 'boolean', value);
}
function validateFunction(value, name) {
  if (typeof value !== 'function') throw codes.ERR_INVALID_ARG_TYPE(name, 'Function', value);
}
function validateObject(value, name, { allowArray = false, allowFunction = false, nullable = false } = {}) {
  if ((!nullable && value === null) || (!allowArray && Array.isArray(value)) ||
      (typeof value !== 'object' && (!allowFunction || typeof value !== 'function'))) {
    throw codes.ERR_INVALID_ARG_TYPE(name, 'Object', value);
  }
}
function validateArray(value, name, minLength = 0) {
  if (!Array.isArray(value)) throw codes.ERR_INVALID_ARG_TYPE(name, 'Array', value);
  if (value.length < minLength) throw codes.ERR_INVALID_ARG_VALUE(name, value, `must be longer than ${minLength}`);
}
function validateOneOf(value, name, oneOf) {
  if (!oneOf.includes(value)) {
    const allowed = oneOf.map(each => typeof each === 'string' ? `'${each}'` : String(each)).join(', ');
    throw codes.ERR_INVALID_ARG_VALUE(name, value, `must be one of: ${allowed}`);
  }
}
function validatePort(port, name = 'Port', allowZero = true) {
  if ((typeof port !== 'number' && typeof port !== 'string') ||
      (typeof port === 'string' && port.trim().length === 0) ||
      +port !== (+port >>> 0) || port > 0xFFFF || (port === 0 && !allowZero)) {
    throw codes.ERR_SOCKET_BAD_PORT(name, port, allowZero);
  }
  return port | 0;
}
function validateAbortSignal(signal, name) {
  if (signal !== undefined && (signal === null || typeof signal !== 'object' || !('aborted' in signal))) {
    throw codes.ERR_INVALID_ARG_TYPE(name, 'AbortSignal', signal);
  }
}

module.exports = {
  codes, makeError, determineSpecificType, ErrnoException, ExceptionWithHostPort,
  validateString, validateNumber, validateInteger, validateInt32, validateUint32, validateBoolean,
  validateFunction, validateObject, validateArray, validateOneOf, validatePort, validateAbortSignal,
};
