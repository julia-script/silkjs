// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

// The Node error codes of net, dgram and dns that internal/validators does not have, Node's
// ErrnoException and ExceptionWithHostPort, and validatePort. Messages follow
// lib/internal/errors.js and lib/internal/validators.js of Node 24. Private to these modules
// until the runtime has Node's whole internal/errors.

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

// Each code is a function that builds the error, so `new ERR_X(...)` and `ERR_X(...)` both work.
const codes = {
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

function validatePort(port, name = 'Port', allowZero = true) {
  if ((typeof port !== 'number' && typeof port !== 'string') ||
      (typeof port === 'string' && port.trim().length === 0) ||
      +port !== (+port >>> 0) || port > 0xFFFF || (port === 0 && !allowZero)) {
    throw codes.ERR_SOCKET_BAD_PORT(name, port, allowZero);
  }
  return port | 0;
}
module.exports = { codes, makeError, determineSpecificType, ErrnoException, ExceptionWithHostPort, validatePort };
