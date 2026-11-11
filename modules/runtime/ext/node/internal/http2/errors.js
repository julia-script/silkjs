'use strict';
// HTTP/2 error codes and messages from Node.js v24 lib/internal/errors.js.
// Copyright Joyent, Inc. and other Node contributors. MIT license (see
// THIRD_PARTY_NOTICES).
const support = require('internal/path_events/support');
const { format, inspect } = require('util');
const codes = { ERR_INVALID_ARG_TYPE: support.codes.ERR_INVALID_ARG_TYPE };
// Node throws the HideStackFramesError variant from validation helpers; stack frames
// are not trimmed here, so the variant is the class itself.
function hidden(Type) {
  if (!Object.hasOwn(Type, 'HideStackFramesError')) Object.defineProperty(Type, 'HideStackFramesError', { value: Type });
  return Type;
}
hidden(codes.ERR_INVALID_ARG_TYPE);
function define(code, Base, message) {
  codes[code] = hidden(class extends Base {
    constructor(...args) {
      super(typeof message === 'function' ? '' : args.length ? format(message, ...args) : message);
      if (typeof message === 'function') this.message = message.apply(this, args);
      this.code = code;
    }
  });
  Object.defineProperty(codes[code], 'name', { value: Base.name });
}
const simple = {
  ERR_HTTP2_ALTSVC_INVALID_ORIGIN: [TypeError, 'HTTP/2 ALTSVC frames require a valid origin'],
  ERR_HTTP2_ALTSVC_LENGTH: [TypeError, 'HTTP/2 ALTSVC frames are limited to 16382 bytes'],
  ERR_HTTP2_CONNECT_AUTHORITY: [Error, ':authority header is required for CONNECT requests'],
  ERR_HTTP2_CONNECT_PATH: [Error, 'The :path header is forbidden for CONNECT requests'],
  ERR_HTTP2_CONNECT_SCHEME: [Error, 'The :scheme header is forbidden for CONNECT requests'],
  ERR_HTTP2_GOAWAY_SESSION: [Error, 'New streams cannot be created after receiving a GOAWAY'],
  ERR_HTTP2_HEADERS_AFTER_RESPOND: [Error, 'Cannot specify additional headers after response initiated'],
  ERR_HTTP2_HEADERS_SENT: [Error, 'Response has already been initiated.'],
  ERR_HTTP2_HEADER_SINGLE_VALUE: [TypeError, 'Header field "%s" must only have a single value'],
  ERR_HTTP2_INFO_STATUS_NOT_ALLOWED: [RangeError, 'Informational status codes cannot be used'],
  ERR_HTTP2_INVALID_CONNECTION_HEADERS: [TypeError, 'HTTP/1 Connection specific headers are forbidden: "%s"'],
  ERR_HTTP2_INVALID_HEADER_VALUE: [TypeError, 'Invalid value "%s" for header "%s"'],
  ERR_HTTP2_INVALID_INFO_STATUS: [RangeError, 'Invalid informational status code: %s'],
  ERR_HTTP2_INVALID_ORIGIN: [TypeError, 'HTTP/2 ORIGIN frames require a valid origin'],
  ERR_HTTP2_INVALID_PACKED_SETTINGS_LENGTH: [RangeError, 'Packed settings length must be a multiple of six'],
  ERR_HTTP2_INVALID_PSEUDOHEADER: [TypeError, '"%s" is an invalid pseudoheader or is used incorrectly'],
  ERR_HTTP2_INVALID_SESSION: [Error, 'The session has been destroyed'],
  ERR_HTTP2_INVALID_STREAM: [Error, 'The stream has been destroyed'],
  ERR_HTTP2_MAX_PENDING_SETTINGS_ACK: [Error, 'Maximum number of pending settings acknowledgements'],
  ERR_HTTP2_NESTED_PUSH: [Error, 'A push stream cannot initiate another push stream.'],
  ERR_HTTP2_NO_MEM: [Error, 'Out of memory'],
  ERR_HTTP2_NO_SOCKET_MANIPULATION: [Error, 'HTTP/2 sockets should not be directly manipulated (e.g. read and written)'],
  ERR_HTTP2_ORIGIN_LENGTH: [TypeError, 'HTTP/2 ORIGIN frames are limited to 16382 bytes'],
  ERR_HTTP2_OUT_OF_STREAMS: [Error, 'No stream ID is available because maximum stream ID has been reached'],
  ERR_HTTP2_PAYLOAD_FORBIDDEN: [Error, 'Responses with %s status must not have a payload'],
  ERR_HTTP2_PING_CANCEL: [Error, 'HTTP2 ping cancelled'],
  ERR_HTTP2_PING_LENGTH: [RangeError, 'HTTP2 ping payload must be 8 bytes'],
  ERR_HTTP2_PSEUDOHEADER_NOT_ALLOWED: [TypeError, 'Cannot set HTTP/2 pseudo-headers'],
  ERR_HTTP2_PUSH_DISABLED: [Error, 'HTTP/2 client has disabled push streams'],
  ERR_HTTP2_SEND_FILE: [Error, 'Directories cannot be sent'],
  ERR_HTTP2_SEND_FILE_NOSEEK: [Error, 'Offset or length can only be specified for regular files'],
  ERR_HTTP2_SESSION_ERROR: [Error, 'Session closed with error code %s'],
  ERR_HTTP2_SETTINGS_CANCEL: [Error, 'HTTP2 session settings canceled'],
  ERR_HTTP2_SOCKET_BOUND: [Error, 'The socket is already bound to an Http2Session'],
  ERR_HTTP2_SOCKET_UNBOUND: [Error, 'The socket has been disconnected from the Http2Session'],
  ERR_HTTP2_STATUS_101: [Error, 'HTTP status code 101 (Switching Protocols) is forbidden in HTTP/2'],
  ERR_HTTP2_STATUS_INVALID: [RangeError, 'Invalid status code: %s'],
  ERR_HTTP2_STREAM_ERROR: [Error, 'Stream closed with error code %s'],
  ERR_HTTP2_STREAM_SELF_DEPENDENCY: [Error, 'A stream cannot depend on itself'],
  ERR_HTTP2_TOO_MANY_CUSTOM_SETTINGS: [Error, 'Number of custom settings exceeds MAX_ADDITIONAL_SETTINGS'],
  ERR_HTTP2_TOO_MANY_INVALID_FRAMES: [Error, 'Too many invalid HTTP/2 frames'],
  ERR_HTTP2_TOO_MANY_ORIGINS: [Error, 'The server sent more ORIGIN frames than the allowed number of %s'],
  ERR_HTTP2_TRAILERS_ALREADY_SENT: [Error, 'Trailing headers have already been sent'],
  ERR_HTTP2_TRAILERS_NOT_READY: [Error, 'Trailing headers cannot be sent until after the wantTrailers event is emitted'],
  ERR_HTTP2_UNSUPPORTED_PROTOCOL: [Error, 'protocol "%s" is unsupported.'],
};
for (const code of Object.keys(simple)) define(code, simple[code][0], simple[code][1]);
define('ERR_HTTP2_INVALID_SETTING_VALUE', TypeError, function(name, actual, min = undefined, max = undefined) {
  this.actual = actual;
  if (min !== undefined) { this.min = min; this.max = max; }
  return `Invalid value for setting "${name}": ${actual}`;
});
codes.ERR_HTTP2_INVALID_SETTING_VALUE.RangeError = hidden(class extends RangeError {
  constructor(name, actual, min = undefined, max = undefined) {
    super(`Invalid value for setting "${name}": ${actual}`);
    this.code = 'ERR_HTTP2_INVALID_SETTING_VALUE'; this.actual = actual;
    if (min !== undefined) { this.min = min; this.max = max; }
  }
});
define('ERR_HTTP2_STREAM_CANCEL', Error, function(error) {
  let message = 'The pending stream has been canceled';
  if (error) { this.cause = error; if (typeof error.message === 'string') message += ` (caused by: ${error.message})`; }
  return message;
});
define('ERR_HTTP2_ERROR', Error, message => message);
define('ERR_HTTP2_OUT_OF_MEMORY', Error, 'HTTP/2 session memory limit exceeded');
define('ERR_INVALID_ARG_VALUE', TypeError, (name, value, reason = 'is invalid') => {
  let received = inspect(value);
  if (received.length > 128) received = `${received.slice(0, 128)}...`;
  return `The ${name.includes('.') ? 'property' : 'argument'} '${name}' ${reason}. Received ${received}`;
});
function separated(text) {
  let out = '', i = text.length;
  const start = text[0] === '-' ? 1 : 0;
  for (; i >= start + 4; i -= 3) out = `_${text.slice(i - 3, i)}${out}`;
  return `${text.slice(0, i)}${out}`;
}
define('ERR_OUT_OF_RANGE', RangeError, (name, range, value) => {
  const received = Number.isInteger(value) && Math.abs(value) > 2 ** 32 ? separated(String(value)) : inspect(value);
  return `The value of "${name}" is out of range. It must be ${range}. Received ${received}`;
});
define('ERR_INVALID_CHAR', TypeError, (name, field = undefined) => `Invalid character in ${name}` + (field !== undefined ? ` ["${field}"]` : ''));
define('ERR_INVALID_HTTP_TOKEN', TypeError, '%s must be a valid HTTP token ["%s"]');
define('ERR_HTTP_INVALID_HEADER_VALUE', TypeError, 'Invalid value "%s" for header "%s"');
define('ERR_MISSING_ARGS', TypeError, (...args) => {
  const names = args.map(arg => Array.isArray(arg) ? arg.map(name => `"${name}"`).join(' or ') : `"${arg}"`);
  const last = names.pop();
  return `The ${names.length ? `${names.join(', ')} and ` : ''}${last} argument${args.length > 1 ? 's' : ''} must be specified`;
});
define('ERR_STREAM_WRITE_AFTER_END', Error, 'write after end');
define('ERR_SOCKET_CLOSED', Error, 'Socket is closed');
function hideStackFrames(fn) { fn.withoutStackTrace = fn; return fn; }
function getMessage(code, args) { return new codes[code](...args).message; }
function aggregateTwoErrors(innerError, outerError) {
  if (innerError && outerError && innerError !== outerError) {
    if (Array.isArray(outerError.errors)) { outerError.errors.push(innerError); return outerError; }
    const err = new AggregateError([outerError, innerError], outerError.message);
    err.code = outerError.code;
    return err;
  }
  return innerError || outerError;
}
class ErrnoException extends Error {
  constructor(err, syscall, original) {
    const code = require('util').getSystemErrorName(err);
    super(original ? `${syscall} ${code} ${original}` : `${syscall} ${code}`);
    this.errno = err; this.code = code; this.syscall = syscall;
  }
}
module.exports = { codes, AbortError: support.AbortError, ErrnoException, aggregateTwoErrors, getMessage, hideStackFrames, kIsNodeError: Symbol('kIsNodeError') };
