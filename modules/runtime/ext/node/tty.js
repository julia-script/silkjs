'use strict';

const { Socket } = require('net');
const { Transport, native, error: nativeError } = require('internal/net/transport');
const { getColorDepth, hasColors } = require('internal/tty/colors');
const { writeAll } = require('internal/tty/write');
const fs = require('fs');

function isatty(fd) {
  return Number.isInteger(fd) && fd >= 0 && fd <= 0x7fffffff && native('guessHandleType', [fd]) === 5;
}
function initialize(stream, fd, options) {
  if (!Number.isInteger(fd) || fd < 0 || fd > 0x7fffffff)
    throw Object.assign(new RangeError(`"fd" must be a non-negative integer: ${fd}`), { code: 'ERR_INVALID_FD' });
  Socket.call(stream, { readableHighWaterMark: 0, ...options, fd: undefined });
  const owned = native('duplicateFd', [fd]);
  if (owned < 0) throw Object.assign(nativeError(owned, 'uv_tty_init'), { code: 'ERR_TTY_INIT_FAILED' });
  let transport;
  try { transport = new Transport(5, stream, (...args) => stream._onNative(...args), undefined, owned); }
  catch (cause) {
    fs.closeSync(owned);
    throw Object.assign(new Error(`TTY initialization failed: ${cause.message}`), { code: 'ERR_TTY_INIT_FAILED', cause });
  }
  // libuv reopens a slave terminal to isolate O_NONBLOCK from the caller's
  // descriptor. On its fallback path it instead adopts the supplied duplicate.
  if (transport.call('fileno') !== owned) fs.closeSync(owned);
  stream._attachTransport(transport);
  stream._connected = true;
  stream.fd = fd;
  stream.isTTY = true;
}

function ReadStream(fd, options) {
  if (!(this instanceof ReadStream)) return new ReadStream(fd, options);
  initialize(this, fd, options);
  this.isRaw = false;
  this.rawMode = false;
}
Object.setPrototypeOf(ReadStream.prototype, Socket.prototype);
Object.setPrototypeOf(ReadStream, Socket);
ReadStream.prototype.setRawMode = function(mode) {
  let rawMode;
  if (mode === 'io' || mode === 'raw') rawMode = mode;
  else if (typeof mode === 'string')
    throw Object.assign(new TypeError(`The argument 'mode' must be true, false, 'raw', or 'io'. Received '${mode}'`), { code: 'ERR_INVALID_ARG_VALUE' });
  else rawMode = mode ? 'raw' : false;
  const status = this._transport?.call('ttyMode', rawMode === 'io' ? 2 : rawMode === 'raw' ? 3 : 0);
  if (status < 0) { this.emit('error', nativeError(status, 'setRawMode')); return this; }
  this.isRaw = rawMode !== false;
  this.rawMode = rawMode;
  return this;
};

function WriteStream(fd) {
  if (!(this instanceof WriteStream)) return new WriteStream(fd);
  initialize(this, fd);
  if (process.platform !== 'win32') {
    const status = this._transport.call('setBlocking', true);
    if (status < 0) { this._transport.close(); throw nativeError(status, 'setBlocking'); }
  }
  const size = this._transport.call('ttyWindowSize');
  if (typeof size === 'object') { this.columns = size.columns; this.rows = size.rows; }
}
Object.setPrototypeOf(WriteStream.prototype, Socket.prototype);
Object.setPrototypeOf(WriteStream, Socket);
WriteStream.prototype.isTTY = true;
WriteStream.prototype.getColorDepth = getColorDepth;
WriteStream.prototype.hasColors = hasColors;
WriteStream.prototype._write = function(chunk, encoding, callback) {
  if (process.platform === 'win32') return Socket.prototype._write.call(this, chunk, encoding, callback);
  let failure;
  try { writeAll(this._transport.call('fileno'), chunk); this._bytesWritten += chunk.length; }
  catch (error) { failure = error; }
  callback(failure);
};
WriteStream.prototype._writev = function(chunks, callback) {
  if (process.platform === 'win32') return Socket.prototype._writev.call(this, chunks, callback);
  let failure;
  try { const fd = this._transport.call('fileno'); for (const { chunk } of chunks) { writeAll(fd, chunk); this._bytesWritten += chunk.length; } }
  catch (error) { failure = error; }
  callback(failure);
};
// A terminal has no socket write-half to shut down.
ReadStream.prototype._final = WriteStream.prototype._final = function(callback) { callback(); };
WriteStream.prototype._refreshSize = function() {
  if (!this._transport || this._transport.closing) return;
  const size = this._transport.call('ttyWindowSize');
  if (typeof size === 'number') { this.emit('error', nativeError(size, 'getWindowSize')); return; }
  if (this.columns !== size.columns || this.rows !== size.rows) {
    this.columns = size.columns;
    this.rows = size.rows;
    this.emit('resize');
  }
};
WriteStream.prototype.getWindowSize = function() { return [this.columns, this.rows]; };
for (const name of ['cursorTo', 'moveCursor', 'clearLine', 'clearScreenDown']) {
  WriteStream.prototype[name] = function(...args) { return require('readline')[name](this, ...args); };
}

module.exports = { isatty, ReadStream, WriteStream };
