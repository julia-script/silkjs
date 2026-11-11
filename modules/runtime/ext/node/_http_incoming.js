'use strict';
const { Readable } = require('stream');
const { error } = require('internal/http/parser');
const single = new Set(['age', 'authorization', 'content-length', 'content-type', 'etag', 'expires', 'from', 'host', 'if-modified-since', 'if-unmodified-since', 'last-modified', 'location', 'max-forwards', 'proxy-authorization', 'referer', 'retry-after', 'server', 'user-agent']);
// Field names repeat across requests; lower-casing each one costs more than a lookup.
const lowered = new Map();
function lowerName(name) {
  let lower = lowered.get(name);
  if (lower === undefined) {
    lower = name.toLowerCase();
    if (lowered.size >= 512) lowered.clear();
    lowered.set(name, lower);
  }
  return lower;
}
const hasOwn = Object.prototype.hasOwnProperty;
function collect(raw, distinct, join, result = {}, length = raw.length) {
  for (let i = 0; i < length; i += 2) {
    const key = lowerName(raw[i]), value = raw[i + 1];
    if (!hasOwn.call(result, key)) {
      const first = distinct || key === 'set-cookie' ? [value] : value;
      // A plain store would hit the __proto__ setter.
      if (key === '__proto__') Object.defineProperty(result, key, { value: first, writable: true, enumerable: true, configurable: true });
      else result[key] = first;
    }
    else if (distinct || key === 'set-cookie') result[key].push(value);
    else if (!single.has(key) || join) result[key] += (key === 'cookie' ? '; ' : ', ') + value;
  }
  return result;
}
class IncomingMessage extends Readable {
  constructor(socket) {
    super({ autoDestroy: true, highWaterMark: socket?.readableHighWaterMark });
    this.socket = socket;
    this.httpVersionMajor = null; this.httpVersionMinor = null; this.httpVersion = null;
    this.complete = false; this.aborted = false; this.upgrade = false;
    this.url = ''; this.method = null; this.statusCode = null; this.statusMessage = null;
    this.rawHeaders = []; this.rawTrailers = []; this.joinDuplicateHeaders = false;
    this._parser = null; this._headers = null; this._trailers = null;
  }
  get connection() { return this.socket; }
  set connection(value) { this.socket = value; }
  get headers() { return this._headers || (this._headers = collect(this.rawHeaders, false, this.joinDuplicateHeaders)); }
  set headers(value) { this._headers = value; }
  get headersDistinct() { return collect(this.rawHeaders, true, true); }
  get trailers() { return this._trailers || (this._trailers = collect(this.rawTrailers, false, this.joinDuplicateHeaders)); }
  set trailers(value) { this._trailers = value; }
  get trailersDistinct() { return collect(this.rawTrailers, true, true); }
  _addHeaderLines(headers, length) {
    const raw = this.complete ? this.rawTrailers : this.rawHeaders;
    const cached = this.complete ? this._trailers : this._headers;
    for (let i = 0; i < length; i++) raw.push(headers[i]);
    if (cached) collect(headers, false, this.joinDuplicateHeaders, cached, length);
  }
  _read() { if (this._parser) this._parser.resume(); if (this.socket && !this.destroyed) { if (this._parser?.paused) this.socket.pause(); else this.socket.resume(); } }
  _destroy(err, callback) {
    if (!this.complete || !this.readableEnded) {
      if (!this.aborted) { this.aborted = true; this.emit('aborted'); }
      if (this.socket && !this.socket.destroyed) this.socket.destroy(err);
    }
    // A fully received message does not own its pooled connection anymore.
    if (err) process.nextTick(() => callback(this.listenerCount('error') ? err : null));
    else callback();
  }
  setTimeout(msecs, callback) { if (callback) this.once('timeout', callback); this.socket?.setTimeout(msecs); return this; }
  _abort() { if (!this.complete && !this.destroyed) this.destroy(error('ECONNRESET', 'aborted')); }
  _dump() {
    if (this._dumped) return;
    this._dumped = true;
    this.removeAllListeners('data');
    if (this.complete && !this.destroyed && this.readableLength === 0) this.read(0);
    else this.resume();
  }
}
function readStart(socket) { if (socket && !socket._paused && socket.readable) socket.resume(); }
function readStop(socket) { if (socket) socket.pause(); }
module.exports = { IncomingMessage, readStart, readStop };
