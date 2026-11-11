'use strict';
const { Writable } = require('stream');
const { Buffer } = require('buffer');
const { token, error, hasToken, checkInvalidHeaderChar, isLenient } = require('internal/http/parser');
function validateHeaderName(name) {
  if (typeof name !== 'string' || !token.test(name)) throw error('ERR_INVALID_HTTP_TOKEN', 'Header name must be a valid HTTP token ["' + name + '"]');
}
function validateHeaderValue(name, value, relaxed = false) {
  if (value === undefined) throw error('ERR_HTTP_INVALID_HEADER_VALUE', 'Invalid value "undefined" for header "' + name + '"');
  if (checkInvalidHeaderChar(String(value), relaxed)) throw error('ERR_INVALID_CHAR', 'Invalid character in header content ["' + name + '"]');
}
// The Date header changes once a second; format it once a second.
let dateSecond = -1, dateText = '';
function utcDate() {
  const now = Date.now(), second = Math.floor(now / 1000);
  if (second !== dateSecond) { dateSecond = second; dateText = new Date(now).toUTCString(); }
  return dateText;
}
// The head and the first body chunk go out in one write.
function joinHead(head, chunk) {
  const output = Buffer.allocUnsafe(head.length + chunk.length);
  output.write(head, 0, 'latin1');
  output.set(chunk, head.length);
  return output;
}
class OutgoingMessage extends Writable {
  constructor(options = {}) {
    super({ decodeStrings: true, autoDestroy: false, emitClose: false, highWaterMark: options.highWaterMark });
    this.socket = null; this._headersMap = new Map(); this._removed = new Set();
    this._header = null; this._headerSent = false; this._chunked = false; this._hasBody = true;
    this._pendingOutput = []; this._active = true; this._bytesWritten = 0; this._trailers = '';
    this.shouldKeepAlive = true; this.useChunkedEncodingByDefault = true;
    this.sendDate = false; this.strictContentLength = false;
    this._closed = false; this._last = false;
    this._uniqueHeaders = new Set((options.uniqueHeaders || []).map(name => name.toLowerCase()));
  }
  get connection() { return this.socket; }
  set connection(socket) { this.socket = socket; }
  get headersSent() { return this._header !== null; }
  get finished() { return this.writableEnded; }
  get writableFinished() { return super.writableFinished; }
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
    for (const v of Array.isArray(value) ? value : [value]) validateHeaderValue(name, v, relaxed);
    this._headersMap.set(name.toLowerCase(), { name, value });
    this._removed.delete(name.toLowerCase());
    return this;
  }
  setHeaders(headers) { this._assertMutable(); if (!headers || typeof headers.entries !== 'function') throw error('ERR_INVALID_ARG_TYPE', 'headers must be a Headers or Map'); for (const [name, value] of headers.entries()) this.setHeader(name, value); return this; }
  appendHeader(name, value) { this._assertMutable(); const current = this.getHeader(name); return this.setHeader(name, current === undefined ? value : [].concat(current, value)); }
  getHeader(name) { if (typeof name !== 'string') throw error('ERR_INVALID_ARG_TYPE', 'name must be a string'); return this._headersMap.get(name.toLowerCase())?.value; }
  getHeaderNames() { return Array.from(this._headersMap.keys()); }
  getRawHeaderNames() { return Array.from(this._headersMap.values(), h => h.name); }
  getHeaders() { const result = Object.create(null); for (const [name, header] of this._headersMap) result[name] = header.value; return result; }
  hasHeader(name) { return this.getHeader(name) !== undefined; }
  removeHeader(name) { this._assertMutable(); this._headersMap.delete(name.toLowerCase()); this._removed.add(name.toLowerCase()); }
  addTrailers(headers) {
    const pairs = Array.isArray(headers) ? headers : Object.entries(headers);
    for (const [name, value] of pairs) {
      validateHeaderName(name);
      if (['content-length', 'transfer-encoding', 'host', 'connection', 'trailer', 'upgrade'].includes(name.toLowerCase())) throw error('ERR_HTTP_TRAILER_INVALID', 'Forbidden framing trailer');
      for (const v of Array.isArray(value) ? value : [value]) { validateHeaderValue(name, v, this._isLenientHeaderValidation()); this._trailers += name + ': ' + v + '\r\n'; }
    }
  }
  _storeHeader(firstLine) {
    let length = this.getHeader('content-length'), transfer = this.getHeader('transfer-encoding');
    if (length !== undefined && transfer !== undefined) throw error('ERR_HTTP_INVALID_HEADER_VALUE', 'Content-Length and Transfer-Encoding cannot coexist');
    if (length !== undefined && (Array.isArray(length) || !/^[0-9]+$/.test(String(length)) || !Number.isSafeInteger(Number(length)))) throw error('ERR_HTTP_INVALID_HEADER_VALUE', 'Invalid Content-Length');
    if (this.sendDate && !this.hasHeader('date') && !this._removed.has('date')) this.setHeader('Date', utcDate());
    if (this._hasBody && length === undefined && transfer === undefined) {
      if (this.useChunkedEncodingByDefault && !this._removed.has('transfer-encoding')) this.setHeader('Transfer-Encoding', transfer = 'chunked');
      else if (!this._bodyOptional) this.shouldKeepAlive = false;
    }
    if (transfer !== undefined) {
      const codings = String(transfer).toLowerCase().split(',').map(s => s.trim());
      if (codings.some(s => !token.test(s)) || codings.filter(s => s === 'chunked').length > 1 || (codings.includes('chunked') && codings[codings.length - 1] !== 'chunked')) throw error('ERR_HTTP_INVALID_HEADER_VALUE', 'Invalid Transfer-Encoding');
      this._chunked = this._hasBody && codings[codings.length - 1] === 'chunked';
      if (!this._chunked && this._hasBody) this.shouldKeepAlive = false;
    }
    if (hasToken(this.getHeader('connection'), 'close')) this.shouldKeepAlive = false;
    if (!this.hasHeader('connection') && !this._removed.has('connection')) this.setHeader('Connection', this.shouldKeepAlive ? 'keep-alive' : 'close');
    this._last = !this.shouldKeepAlive;
    this._contentLength = length === undefined ? null : Number(length);
    let header = firstLine;
    for (const { name, value } of this._headersMap.values()) {
      if (Array.isArray(value)) {
        if (name.toLowerCase() === 'cookie' || this._uniqueHeaders.has(name.toLowerCase())) header += name + ': ' + value.join('; ') + '\r\n';
        else for (const item of value) header += name + ': ' + item + '\r\n';
      } else header += name + ': ' + value + '\r\n';
    }
    this._header = header + '\r\n';
  }
  _implicitHeader() { throw error('ERR_METHOD_NOT_IMPLEMENTED', '_implicitHeader() is not implemented'); }
  _send(data, callback) {
    if (typeof data === 'string') data = Buffer.from(data, 'latin1');
    if (this.destroyed) { if (callback) callback(error('ERR_STREAM_DESTROYED', 'Cannot write to destroyed HTTP message')); return false; }
    if (!this.socket || !this._active || this.socket.connecting) { this._pendingOutput.push([data, callback]); return false; }
    return this.socket.write(data, callback);
  }
  _flushOutput() {
    if (!this.socket || this.socket.connecting || !this._active || this.destroyed) return;
    const queued = this._pendingOutput; this._pendingOutput = [];
    for (const [data, callback] of queued) this.socket.write(data, callback);
  }
  _sendHeader() { if (!this._header) this._implicitHeader(); if (!this._headerSent) { this._headerSent = true; this._send(this._header); } }
  flushHeaders() { this._sendHeader(); }
  _write(chunk, encoding, callback) {
    try {
      if (this._bodyOptional && chunk.length && !this.headersSent) { this._bodyOptional = false; this.useChunkedEncodingByDefault = true; }
      let head = null;
      if (!this._headerSent) {
        if (!this._header) this._implicitHeader();
        this._headerSent = true;
        head = this._header;
      }
      const flushHead = () => { if (head !== null) { this._send(head); head = null; } };
      if (!this._hasBody) { flushHead(); if (this._rejectBody) callback(error('ERR_HTTP_BODY_NOT_ALLOWED', 'Adding content for this response is not allowed')); else callback(); return; }
      if (this._bodyOptional && chunk.length && !this._chunked && this._contentLength === null) { flushHead(); callback(error('ERR_HTTP_CONTENT_LENGTH_MISMATCH', 'Cannot send an unframed request body after headers')); return; }
      this._bytesWritten += chunk.length;
      if (this.strictContentLength && this._contentLength !== null && this._bytesWritten > this._contentLength) { flushHead(); callback(error('ERR_HTTP_CONTENT_LENGTH_MISMATCH', 'Body exceeds Content-Length')); return; }
      if (!chunk.length) { flushHead(); callback(); return; }
      if (this._chunked) {
        this._send((head ?? '') + chunk.length.toString(16) + '\r\n'); this._send(chunk); this._send('\r\n', callback);
      } else if (head !== null) this._send(joinHead(head, chunk), callback);
      else this._send(chunk, callback);
    } catch (err) { callback(err); }
  }
  end(chunk, encoding, callback) {
    if (typeof chunk === 'function') { callback = chunk; chunk = undefined; encoding = undefined; }
    else if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
    if (!this.headersSent && this._bytesWritten === 0 && !this.writableLength && !this.hasHeader('content-length') && !this.hasHeader('transfer-encoding') && !this._removed.has('content-length') && this._hasBody) {
      const length = chunk == null ? 0 : typeof chunk === 'string' ? Buffer.byteLength(chunk, encoding) : chunk.byteLength;
      this.setHeader('Content-Length', length);
    }
    return super.end(chunk, encoding, callback);
  }
  _final(callback) {
    try {
      this._sendHeader();
      if (this.strictContentLength && this._hasBody && this._contentLength !== null && this._bytesWritten !== this._contentLength) { callback(error('ERR_HTTP_CONTENT_LENGTH_MISMATCH', 'Body does not match Content-Length')); return; }
      if (this._trailers && !this._chunked) { callback(error('ERR_HTTP_TRAILER_INVALID', 'Trailers require chunked encoding')); return; }
      // An unchunked body has nothing left to send: complete without an empty write.
      if (this._chunked) this._send('0\r\n' + this._trailers + '\r\n', callback);
      else if (this._pendingOutput.length) this._send(Buffer.alloc(0), callback);
      else callback();
    } catch (err) { callback(err); }
  }
  _destroy(err, callback) {
    const queued = this._pendingOutput; this._pendingOutput = [];
    for (const [, done] of queued) if (done) done(err || error('ERR_STREAM_DESTROYED', 'HTTP message destroyed'));
    if (this.socket && !this.socket.destroyed) this.socket.destroy(err);
    callback(err);
    process.nextTick(() => this._emitClose());
  }
  _emitClose() { if (!this._closed) { this._closed = true; this.emit('close'); } }
  setTimeout(msecs, callback) { if (callback) this.once('timeout', callback); if (this.socket) this.socket.setTimeout(msecs); else this.once('socket', socket => socket.setTimeout(msecs)); return this; }
}
module.exports = { OutgoingMessage, validateHeaderName, validateHeaderValue };
