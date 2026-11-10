'use strict';
const { Readable, Writable } = require('stream');
const { error, integer } = require('internal/http2/util');
const { validateHeaderName, validateHeaderValue } = require('http');
class Http2ServerRequest extends Readable {
  constructor(stream, headers, options = {}, rawHeaders = []) {
    super({ autoDestroy: true, highWaterMark: options.highWaterMark });
    this.stream = stream; this.headers = headers; this.rawHeaders = rawHeaders;
    this.trailers = {}; this.rawTrailers = []; this.httpVersion = '2.0'; this.httpVersionMajor = 2; this.httpVersionMinor = 0;
    this.complete = false; this.aborted = false; this.url = headers[':path']; this.method = headers[':method']; this.authority = headers[':authority']; this.scheme = headers[':scheme'];
    stream.on('data', chunk => { if (!this.push(chunk)) stream.pause(); });
    stream.on('end', () => { this.complete = true; this.push(null); });
    stream.on('trailers', (trailers, flags, raw) => { this.trailers = trailers; this.rawTrailers = raw; });
    stream.on('aborted', () => { this.aborted = true; this.emit('aborted'); });
    stream.on('error', err => this.destroy(err));
    stream.on('close', () => { if (!this.complete) this.destroy(); });
    stream.pause();
  }
  get socket() { return this.stream.session.socket; }
  get connection() { return this.socket; }
  get headersDistinct() { const out = {}; for (let i = 0; i < this.rawHeaders.length; i += 2) (out[this.rawHeaders[i]] ||= []).push(this.rawHeaders[i + 1]); return out; }
  get trailersDistinct() { const out = {}; for (let i = 0; i < this.rawTrailers.length; i += 2) (out[this.rawTrailers[i]] ||= []).push(this.rawTrailers[i + 1]); return out; }
  _read() { this.stream.resume(); }
  _destroy(err, callback) { if (!this.complete && !this.stream.destroyed) this.stream.destroy(err); callback(err); }
  setTimeout(msecs, callback) { this.stream.setTimeout(msecs, callback); return this; }
}
class Http2ServerResponse extends Writable {
  constructor(stream, options = {}) {
    super({ autoDestroy: false, highWaterMark: options.highWaterMark });
    this.stream = stream; this.statusCode = 200; this.statusMessage = ''; this.sendDate = true;
    this._headers = Object.create(null); this._names = Object.create(null); this._trailers = null; this._sent = false;
    this._closed = false; this.req = undefined;
    stream.on('wantTrailers', () => stream.sendTrailers(this._trailers || {}));
    stream.on('error', err => this.destroy(err));
    stream.on('close', () => { if (!this._closed) { this._closed = true; this.emit('close'); } });
  }
  get socket() { return this.stream.session.socket; }
  get connection() { return this.socket; }
  get headersSent() { return this._sent || this.stream.headersSent; }
  get finished() { return this.writableEnded; }
  get writableFinished() { return this._writableState.finished; }
  _mutable() { if (this.headersSent) throw error('ERR_HTTP2_HEADERS_SENT', 'Response headers have already been sent'); }
  setHeader(name, value) { this._mutable(); validateHeaderName(name); for (const v of Array.isArray(value) ? value : [value]) validateHeaderValue(name, v); const lower = name.toLowerCase(); this._headers[lower] = value; this._names[lower] = name; return this; }
  appendHeader(name, value) { this._mutable(); const old = this.getHeader(name); return this.setHeader(name, old === undefined ? value : [].concat(old, value)); }
  getHeader(name) { return this._headers[String(name).toLowerCase()]; }
  getHeaders() { return Object.assign(Object.create(null), this._headers); }
  getHeaderNames() { return Object.keys(this._headers); }
  getRawHeaderNames() { return Object.values(this._names); }
  hasHeader(name) { return Object.prototype.hasOwnProperty.call(this._headers, String(name).toLowerCase()); }
  removeHeader(name) { this._mutable(); name = String(name).toLowerCase(); delete this._headers[name]; delete this._names[name]; if (name === 'date') this.sendDate = false; }
  setHeaders(headers) { for (const [name, value] of headers) this.setHeader(name, value); return this; }
  writeHead(statusCode, statusMessage, headers) {
    this._mutable(); integer(statusCode, 'statusCode', 200, 599); this.statusCode = statusCode;
    if (typeof statusMessage !== 'string') headers = statusMessage;
    if (headers) { if (Array.isArray(headers)) for (let i = 0; i < headers.length; i += 2) this.appendHeader(headers[i], headers[i + 1]); else for (const name of Object.keys(headers)) this.setHeader(name, headers[name]); }
    this.flushHeaders(); return this;
  }
  flushHeaders() { if (this.headersSent) return; integer(this.statusCode, 'statusCode', 200, 599); if (this.sendDate && !this.hasHeader('date')) this._headers.date = new Date().toUTCString(); this.stream.respond({ ...this._headers, ':status': this.statusCode }, { waitForTrailers: true }); this._sent = true; }
  _write(chunk, encoding, callback) { try { this.flushHeaders(); if (this.stream._localEnded) { callback(); return; } this.stream.write(chunk, encoding, callback); } catch (err) { callback(err); } }
  _final(callback) { try { this.flushHeaders(); if (this.stream.writableFinished) { callback(); return; } this.stream.end(callback); } catch (err) { callback(err); } }
  _destroy(err, callback) { this.stream.destroy(err); callback(err); }
  addTrailers(headers) { if (Array.isArray(headers)) { const out = {}; for (let i = 0; i < headers.length; i += 2) out[headers[i]] = headers[i + 1]; headers = out; } require('internal/http2/util').headers(headers, 'trailers'); this._trailers = { ...this._trailers, ...headers }; }
  writeContinue(callback) { this.stream.additionalHeaders({ ':status': 100 }); if (callback) process.nextTick(callback); }
  writeProcessing() { this.stream.additionalHeaders({ ':status': 102 }); }
  writeEarlyHints(hints, callback) { this.stream.additionalHeaders({ ...hints, ':status': 103 }); if (callback) process.nextTick(callback); }
  createPushResponse(headers, callback) { this.stream.pushStream(headers, (err, stream) => callback(err, err ? undefined : new Http2ServerResponse(stream))); }
  setTimeout(msecs, callback) { this.stream.setTimeout(msecs, callback); return this; }
  cork() { this.stream.cork(); }
  uncork() { this.stream.uncork(); }
}
function compatibility(server, stream, headers, flags, raw) {
  if (!server.listenerCount('request') && !server.listenerCount('checkContinue') && !server.listenerCount('checkExpectation')) return;
  const req = new (server._http2Options.Http2ServerRequest || Http2ServerRequest)(stream, headers, server._http2Options, raw);
  const res = new (server._http2Options.Http2ServerResponse || Http2ServerResponse)(stream, server._http2Options); req.res = res; res.req = req;
  if (headers.expect) {
    if (headers.expect.toLowerCase() === '100-continue') { if (server.listenerCount('checkContinue')) { server.emit('checkContinue', req, res); return; } res.writeContinue(); }
    else { if (server.listenerCount('checkExpectation')) server.emit('checkExpectation', req, res); else { res.writeHead(417); res.end(); } return; }
  }
  server.emit('request', req, res);
}
module.exports = { Http2ServerRequest, Http2ServerResponse, compatibility };
