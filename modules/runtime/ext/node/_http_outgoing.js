'use strict';
// Like Node, OutgoingMessage is a legacy Stream with its own write/end, not a Writable:
// the head goes out with the first body bytes and 'finish' rides on the last write.
const Stream = require('stream');
const { Buffer } = require('buffer');
const { token, error, hasToken, checkInvalidHeaderChar, isLenient } = require('internal/http/parser');
function validateHeaderName(name) {
  if (typeof name !== 'string' || !token.test(name)) throw error('ERR_INVALID_HTTP_TOKEN', 'Header name must be a valid HTTP token ["' + name + '"]');
}
function validateHeaderValue(name, value, relaxed = false) {
  if (value === undefined) throw error('ERR_HTTP_INVALID_HEADER_VALUE', 'Invalid value "undefined" for header "' + name + '"');
  if (checkInvalidHeaderChar(String(value), relaxed)) throw error('ERR_INVALID_CHAR', 'Invalid character in header content ["' + name + '"]');
}
let streamCodes = null;
function codes() { return streamCodes ??= require('internal/streams/support').codes; }
function nop() {}
function uncorkSocket(socket) { socket.uncork(); }
// The Date header changes once a second; format it once a second.
let dateSecond = -1, dateText = '';
function utcDate() {
  const now = Date.now(), second = Math.floor(now / 1000);
  if (second !== dateSecond) { dateSecond = second; dateText = new Date(now).toUTCString(); }
  return dateText;
}
// One buffer for latin1 text before (head, chunk size line) and after (CRLF, last chunk) a body chunk.
function joined(before, chunk, after) {
  const output = Buffer.allocUnsafe(before.length + chunk.length + after.length);
  if (before.length) output.write(before, 0, 'latin1');
  output.set(chunk, before.length);
  if (after.length) output.write(after, before.length + chunk.length, 'latin1');
  return output;
}
const noHeaders = new Set();
function lookup(message, lower) { return message._headersMap.get(lower)?.value; }
function removed(message, lower) { return message._removed !== null && message._removed.has(lower); }
function lengthMismatch(actual, expected) {
  return error('ERR_HTTP_CONTENT_LENGTH_MISMATCH', "Response body's content-length of " + actual + ' byte(s) does not match the content-length of ' + expected + ' byte(s) set in header');
}
function strictLength(message) {
  return message.strictContentLength && message._contentLength !== null && message._hasBody && !removed(message, 'content-length') &&
    !message._chunked && lookup(message, 'transfer-encoding') === undefined;
}
function emitError(message, err, callback) {
  callback(err);
  if (!message.destroyed) message.emit('error', err);
}
function emitFinish(message) {
  if (message._finishEmitted) return;
  message._finishEmitted = true;
  message.emit('finish');
}
class OutgoingMessage extends Stream {
  constructor(options = {}) {
    super();
    this.socket = null; this._headersMap = new Map(); this._removed = null;
    this._header = null; this._headerSent = false; this._chunked = false; this._hasBody = true;
    this._pendingOutput = []; this.outputSize = 0; this._active = true; this._bytesWritten = 0; this._trailers = '';
    this._contentLength = null; this._keepAliveTimeout = 0;
    this.shouldKeepAlive = true; this.useChunkedEncodingByDefault = true;
    this.sendDate = false; this.strictContentLength = false;
    this.writable = true; this.destroyed = false; this.errored = null; this.finished = false;
    this._finishEmitted = false; this._finishQueued = false; this._prefinished = false; this._needDrain = false; this._corked = 0;
    this._closed = false; this._last = false;
    this._highWaterMark = options.highWaterMark ?? require('internal/streams/state').getDefaultHighWaterMark(false);
    this._uniqueHeaders = options.uniqueHeaders ? new Set(options.uniqueHeaders.map(name => name.toLowerCase())) : noHeaders;
  }
  get connection() { return this.socket; }
  set connection(socket) { this.socket = socket; }
  get headersSent() { return this._header !== null; }
  get writableEnded() { return this.finished; }
  get writableFinished() { return this.finished && this.outputSize === 0 && (!this.socket || this.socket.writableLength === 0); }
  get writableObjectMode() { return false; }
  get writableLength() { return this.outputSize + (this.socket ? this.socket.writableLength : 0); }
  get writableHighWaterMark() { return this.socket ? this.socket.writableHighWaterMark : this._highWaterMark; }
  get writableCorked() { return this.socket ? this.socket.writableCorked : this._corked; }
  get writableNeedDrain() { return !this.destroyed && !this.finished && this._needDrain; }
  get closed() { return this._closed; }
  cork() { if (this.socket) this.socket.cork(); else this._corked++; }
  uncork() { if (this.socket) this.socket.uncork(); else if (this._corked) this._corked--; }
  _isLenientHeaderValidation() {
    if (this.httpValidation !== undefined) return this.httpValidation !== 'strict';
    const server = this.req?.socket?.server;
    if (server?.httpValidation !== undefined) return server.httpValidation !== 'strict';
    if (typeof this.insecureHTTPParser === 'boolean') return this.insecureHTTPParser;
    if (typeof server?.insecureHTTPParser === 'boolean') return server.insecureHTTPParser;
    return isLenient();
  }
  _assertMutable() { if (this.headersSent) throw error('ERR_HTTP_HEADERS_SENT', 'Cannot modify headers after they are sent to the client'); }
  setHeader(name, value) {
    this._assertMutable();
    validateHeaderName(name);
    const relaxed = this._isLenientHeaderValidation();
    if (Array.isArray(value)) { for (const v of value) validateHeaderValue(name, v, relaxed); }
    else validateHeaderValue(name, value, relaxed);
    const lower = name.toLowerCase();
    this._headersMap.set(lower, { name, value });
    if (this._removed !== null) this._removed.delete(lower);
    return this;
  }
  setHeaders(headers) { this._assertMutable(); if (!headers || typeof headers.entries !== 'function') throw error('ERR_INVALID_ARG_TYPE', 'headers must be a Headers or Map'); for (const [name, value] of headers.entries()) this.setHeader(name, value); return this; }
  appendHeader(name, value) { this._assertMutable(); const current = this.getHeader(name); return this.setHeader(name, current === undefined ? value : [].concat(current, value)); }
  getHeader(name) { if (typeof name !== 'string') throw error('ERR_INVALID_ARG_TYPE', 'name must be a string'); return this._headersMap.get(name.toLowerCase())?.value; }
  getHeaderNames() { return Array.from(this._headersMap.keys()); }
  getRawHeaderNames() { return Array.from(this._headersMap.values(), h => h.name); }
  getHeaders() { const result = Object.create(null); for (const [name, header] of this._headersMap) result[name] = header.value; return result; }
  hasHeader(name) { return this.getHeader(name) !== undefined; }
  removeHeader(name) {
    this._assertMutable();
    const lower = name.toLowerCase();
    this._headersMap.delete(lower);
    (this._removed ??= new Set()).add(lower);
  }
  addTrailers(headers) {
    const pairs = Array.isArray(headers) ? headers : Object.entries(headers);
    for (const [name, value] of pairs) {
      validateHeaderName(name);
      if (['content-length', 'transfer-encoding', 'host', 'connection', 'trailer', 'upgrade'].includes(name.toLowerCase())) throw error('ERR_HTTP_TRAILER_INVALID', 'Forbidden framing trailer');
      for (const v of Array.isArray(value) ? value : [value]) { validateHeaderValue(name, v, this._isLenientHeaderValidation()); this._trailers += name + ': ' + v + '\r\n'; }
    }
  }
  // As in Node: the message's own headers first, then Date, Connection and framing.
  _storeHeader(firstLine) {
    const length = lookup(this, 'content-length'), transfer = lookup(this, 'transfer-encoding');
    if (length !== undefined && transfer !== undefined) throw error('ERR_HTTP_INVALID_HEADER_VALUE', 'Content-Length and Transfer-Encoding cannot coexist');
    if (length !== undefined && (Array.isArray(length) || !/^[0-9]+$/.test(String(length)) || !Number.isSafeInteger(Number(length)))) throw error('ERR_HTTP_INVALID_HEADER_VALUE', 'Invalid Content-Length');
    let framing = '';
    if (transfer !== undefined) {
      const codings = String(transfer).toLowerCase().split(',').map(s => s.trim());
      if (codings.some(s => !token.test(s)) || codings.filter(s => s === 'chunked').length > 1 || (codings.includes('chunked') && codings[codings.length - 1] !== 'chunked')) throw error('ERR_HTTP_INVALID_HEADER_VALUE', 'Invalid Transfer-Encoding');
      this._chunked = this._hasBody && codings[codings.length - 1] === 'chunked';
      if (!this._chunked && this._hasBody) this.shouldKeepAlive = false;
    } else if (length !== undefined) this._contentLength = Number(length);
    else if (this._hasBody) {
      if (!this.useChunkedEncodingByDefault) { if (!this._bodyOptional) this.shouldKeepAlive = false; }
      else if (this._contentLength !== null && !removed(this, 'content-length')) framing = 'Content-Length: ' + this._contentLength + '\r\n';
      else if (!removed(this, 'transfer-encoding')) { framing = 'Transfer-Encoding: chunked\r\n'; this._chunked = true; }
      else if (!this._bodyOptional) this.shouldKeepAlive = false;
    }
    let header = firstLine;
    for (const entry of this._headersMap.values()) {
      const name = entry.name, value = entry.value;
      if (Array.isArray(value)) {
        if (name.toLowerCase() === 'cookie' || this._uniqueHeaders.has(name.toLowerCase())) header += name + ': ' + value.join('; ') + '\r\n';
        else for (const item of value) header += name + ': ' + item + '\r\n';
      } else header += name + ': ' + value + '\r\n';
    }
    if (this.sendDate && lookup(this, 'date') === undefined && !removed(this, 'date')) header += 'Date: ' + utcDate() + '\r\n';
    const connection = lookup(this, 'connection');
    if (connection !== undefined) { if (hasToken(connection, 'close')) this.shouldKeepAlive = false; }
    else if (!removed(this, 'connection')) {
      if (this.shouldKeepAlive) {
        header += 'Connection: keep-alive\r\n';
        if (this._keepAliveTimeout > 0) header += 'Keep-Alive: timeout=' + Math.floor(this._keepAliveTimeout / 1000) + (this._maxRequestsPerSocket > 0 ? ', max=' + this._maxRequestsPerSocket : '') + '\r\n';
      } else header += 'Connection: close\r\n';
    }
    this._last = !this.shouldKeepAlive;
    this._header = header + framing + '\r\n';
  }
  _implicitHeader() { throw error('ERR_METHOD_NOT_IMPLEMENTED', '_implicitHeader() is not implemented'); }
  // Raw bytes for the socket, queued while the message has none or waits its turn.
  _send(data, callback) {
    if (typeof data === 'string') data = Buffer.from(data, 'latin1');
    if (this.destroyed) { if (callback) process.nextTick(callback, error('ERR_STREAM_DESTROYED', 'Cannot write to destroyed HTTP message')); return false; }
    if (!this.socket || !this._active || this.socket.connecting) {
      this._pendingOutput.push(data, callback); this.outputSize += data.length;
      return this.outputSize < this._highWaterMark;
    }
    return this.socket.write(data, callback);
  }
  _flushOutput() {
    if (!this.socket || this.socket.connecting || !this._active || this.destroyed || !this._pendingOutput.length) return;
    const queued = this._pendingOutput; this._pendingOutput = []; this.outputSize = 0;
    let ok = true;
    for (let i = 0; i < queued.length; i += 2) ok = this.socket.write(queued[i], queued[i + 1]);
    if (this.finished) this._prefinish();
    if (ok && this._needDrain) process.nextTick(() => this._onSocketDrain());
  }
  _prefinish() { if (!this._prefinished) { this._prefinished = true; this.emit('prefinish'); } }
  _onSocketDrain() {
    if (!this.finished && this._needDrain) { this._needDrain = false; this.emit('drain'); }
  }
  _takeHead() {
    if (this._headerSent) return '';
    if (!this._header) this._implicitHeader();
    this._headerSent = true;
    return this._header;
  }
  flushHeaders() { const head = this._takeHead(); if (head) this._send(head); }
  write(chunk, encoding, callback) {
    if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
    const ok = this._writeChunk(chunk, encoding, callback, false);
    if (!ok) this._needDrain = true;
    return ok;
  }
  _writeChunk(chunk, encoding, callback, fromEnd) {
    if (typeof callback !== 'function') callback = nop;
    if (chunk === null) throw new (codes().ERR_STREAM_NULL_VALUES)();
    if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) throw new (codes().ERR_INVALID_ARG_TYPE)('chunk', ['string', 'Buffer', 'Uint8Array'], chunk);
    let err = null;
    if (this.finished) err = new (codes().ERR_STREAM_WRITE_AFTER_END)();
    else if (this.destroyed) err = new (codes().ERR_STREAM_DESTROYED)('write');
    if (err !== null) {
      if (!this.destroyed) process.nextTick(emitError, this, err, callback);
      else process.nextTick(callback, err);
      return false;
    }
    if (typeof chunk === 'string') chunk = Buffer.from(chunk, encoding || 'utf8');
    if (this._bodyOptional && chunk.length && !this._header) { this._bodyOptional = false; this.useChunkedEncodingByDefault = true; }
    if (!this._header) { if (fromEnd) this._contentLength = chunk.length; this._implicitHeader(); }
    if (!this._hasBody) {
      if (this._rejectBody) throw error('ERR_HTTP_BODY_NOT_ALLOWED', 'Adding content for this response is not allowed');
      if (!fromEnd) process.nextTick(callback);
      return true;
    }
    if (this._bodyOptional && chunk.length && !this._chunked && this._contentLength === null) throw error('ERR_HTTP_CONTENT_LENGTH_MISMATCH', 'Cannot send an unframed request body after headers');
    this._bytesWritten += chunk.length;
    if (!chunk.length) {
      if (fromEnd) return true;
      const head = this._takeHead();
      if (head) return this._send(head, callback);
      process.nextTick(callback); return true;
    }
    const head = this._takeHead();
    if (fromEnd) return this._endChunk(head, chunk);
    // As in Node: writes in one turn leave in one socket write.
    const socket = this.socket;
    if (socket && this._active && !socket.writableCorked) { socket.cork(); process.nextTick(uncorkSocket, socket); }
    if (this._chunked) return this._send(joined(head + chunk.length.toString(16) + '\r\n', chunk, '\r\n'), callback);
    return this._send(head ? joined(head, chunk, '') : chunk, callback);
  }
  // end()'s chunk carries the last chunk and 'finish' with it, so end sends one write.
  _endChunk(head, chunk) {
    this._finishQueued = true;
    const finish = () => emitFinish(this);
    if (this._chunked) return this._send(joined(head + chunk.length.toString(16) + '\r\n', chunk, '\r\n0\r\n' + this._trailers + '\r\n'), finish);
    return this._send(head ? joined(head, chunk, '') : chunk, finish);
  }
  end(chunk, encoding, callback) {
    if (typeof chunk === 'function') { callback = chunk; chunk = undefined; encoding = undefined; }
    else if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
    if (chunk) {
      if (this.finished) { process.nextTick(emitError, this, new (codes().ERR_STREAM_WRITE_AFTER_END)(), typeof callback === 'function' ? callback : nop); return this; }
    } else if (this.finished) {
      if (typeof callback === 'function') {
        if (!this.writableFinished) this.once('finish', callback);
        else process.nextTick(callback, new (codes().ERR_STREAM_ALREADY_FINISHED)('end'));
      }
      return this;
    }
    if (typeof callback === 'function') this.once('finish', callback);
    this._finishQueued = false;
    if (chunk) this._writeChunk(chunk, encoding, null, true);
    else if (!this._header) { this._contentLength = 0; this._implicitHeader(); }
    if (strictLength(this) && this._bytesWritten !== this._contentLength) throw lengthMismatch(this._bytesWritten, this._contentLength);
    this.finished = true;
    if (!this._finishQueued) {
      const finish = () => emitFinish(this);
      const head = this._takeHead();
      if (this._hasBody && this._chunked) this._send(head + '0\r\n' + this._trailers + '\r\n', finish);
      else if (head || this.writableLength) this._send(head, finish);
      else process.nextTick(finish);
    }
    if (this.outputSize === 0) this._prefinish();
    return this;
  }
  destroy(err) {
    if (this.destroyed) return this;
    this.destroyed = true;
    if (err) this.errored = err;
    this._destroy(err ?? null, failure => { if (failure) process.nextTick(() => this.emit('error', failure)); });
    return this;
  }
  _destroy(err, callback) {
    const queued = this._pendingOutput; this._pendingOutput = []; this.outputSize = 0;
    for (let i = 1; i < queued.length; i += 2) if (queued[i]) queued[i](err || error('ERR_STREAM_DESTROYED', 'HTTP message destroyed'));
    if (this.socket) { if (!this.socket.destroyed) this.socket.destroy(err); }
    else this.once('socket', socket => socket.destroy(err));
    callback(err);
    process.nextTick(() => this._emitClose());
  }
  _emitClose() { if (!this._closed) { this._closed = true; this.emit('close'); } }
  setTimeout(msecs, callback) { if (callback) this.once('timeout', callback); if (this.socket) this.socket.setTimeout(msecs); else this.once('socket', socket => socket.setTimeout(msecs)); return this; }
}
module.exports = { OutgoingMessage, validateHeaderName, validateHeaderValue };
