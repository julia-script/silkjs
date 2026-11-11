'use strict';
const net = require('net');
const { Buffer } = require('buffer');
const { URL, urlToHttpOptions } = require('url');
const { OutgoingMessage } = require('_http_outgoing');
const { IncomingMessage } = require('_http_incoming');
const { Agent } = require('_http_agent');
const { Parser, token, error, setParserOptions } = require('internal/http/parser');
const diagnostics = require('internal/host').diagnostics;

class ClientRequest extends OutgoingMessage {
  constructor(input, options, callback) {
    if (typeof options === 'function') { callback = options; options = undefined; }
    let base;
    if (typeof input === 'string' || input instanceof URL) base = urlToHttpOptions(typeof input === 'string' ? new URL(input) : input);
    else base = input || {};
    options = { ...base, ...options };
    super(options);
    // As in Node: stream.destroy() tells a client response (req set, false)
    // from a server request (no req) by this field.
    this.upgradeOrConnect = false;
    const protocol = options.protocol || 'http:';
    this.agent = options.agent === undefined ? (options.createConnection ? null : options._defaultAgent || require('_http_agent').globalAgent) : options.agent;
    if (this.agent === false) this.agent = new Agent({ keepAlive: false });
    if (this.agent !== null && (!this.agent || typeof this.agent.addRequest !== 'function')) throw error('ERR_INVALID_ARG_TYPE', 'agent must implement addRequest');
    const expected = this.agent?.protocol || options._defaultAgent?.protocol || 'http:';
    if (protocol !== expected) throw error('ERR_INVALID_PROTOCOL', 'Protocol "' + protocol + '" not supported. Expected "' + expected + '"');
    this.protocol = protocol;
    this.method = String(options.method || 'GET').toUpperCase();
    if (!token.test(this.method)) throw error('ERR_INVALID_HTTP_TOKEN', 'Method must be a valid HTTP token');
    this.path = options.path || '/';
    if (typeof this.path !== 'string' || /[^\x21-\xff]|\x7f/.test(this.path)) throw error('ERR_UNESCAPED_CHARACTERS', 'Request path contains unescaped characters');
    this.host = options.hostname || options.host || 'localhost';
    if (this.host[0] === '[' && this.host.endsWith(']')) this.host = this.host.slice(1, -1);
    const defaultPort = options.defaultPort || this.agent?.defaultPort || 80;
    const port = options.port === undefined || options.port === '' ? defaultPort : Number(options.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw error('ERR_SOCKET_BAD_PORT', 'Port should be >= 0 and < 65536');
    this._options = { ...options, host: this.host, port };
    this.maxHeadersCount = null; this.maxHeaderSize = options.maxHeaderSize || 16384;
    setParserOptions(this, options);
    this.reusedSocket = false; this.aborted = false; this.res = null;
    this._released = false; this._responseEnded = false; this._responseKeepAlive = false;
    this._bodyOptional = ['GET', 'HEAD', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT'].includes(this.method);
    this.useChunkedEncodingByDefault = !this._bodyOptional;
    this.shouldKeepAlive = !!this.agent && (this.agent.keepAlive || this.agent.maxSockets !== Infinity);
    if (options.headers) {
      if (Array.isArray(options.headers)) for (let i = 0; i < options.headers.length; i += 2) this.appendHeader(options.headers[i], options.headers[i + 1]);
      else for (const name of Object.keys(options.headers)) this.setHeader(name, options.headers[name]);
    }
    if (options.setHost !== false && !this.hasHeader('host')) {
      const host = this.host.includes(':') ? '[' + this.host + ']' : this.host;
      this.setHeader('Host', host + (port !== defaultPort ? ':' + port : ''));
    }
    if (options.auth && !this.hasHeader('authorization')) this.setHeader('Authorization', 'Basic ' + Buffer.from(options.auth).toString('base64'));
    if (callback) this.once('response', callback);
    this.once('finish', () => this._maybeRelease());
    if (options.signal) {
      const signal = options.signal;
      if (typeof signal.addEventListener !== 'function') throw error('ERR_INVALID_ARG_TYPE', 'signal must be an AbortSignal');
      const abort = () => { const err = error('ABORT_ERR', 'The operation was aborted'); err.name = 'AbortError'; err.cause = signal.reason; this.destroy(err); };
      if (signal.aborted) process.nextTick(abort);
      else { signal.addEventListener('abort', abort, { once: true }); this.once('close', () => signal.removeEventListener('abort', abort)); }
    }
    if (this.agent) this.agent.addRequest(this, this._options);
    else {
      let assigned = false;
      const done = (err, socket) => { if (assigned) return; if (err) { assigned = true; this.destroy(err); } else if (socket) { assigned = true; this.onSocket(socket); } };
      try { const socket = (options.createConnection || net.createConnection)({ ...this._options, path: options.socketPath }, done); if (socket) done(null, socket); }
      catch (err) { process.nextTick(() => this.destroy(err)); }
    }
    diagnostics.publish('http.client.request.created', { request: this });
  }
  end(chunk, encoding, callback) {
    const first = !this.finished;
    super.end(chunk, encoding, callback);
    if (first && this.finished) diagnostics.publish('http.client.request.start', { request: this });
    return this;
  }
  _implicitHeader() { this._storeHeader(this.method + ' ' + this.path + ' HTTP/1.1\r\n'); }
  onSocket(socket) {
    process.nextTick(() => {
      if (this.destroyed) { socket.destroy(); return; }
      this.socket = socket;
      let current = null, finalSeen = false;
      const parser = new Parser('response', {
        headers: info => {
          if (finalSeen) { parser.fail('HPE_UNEXPECTED_CONTENT_LENGTH', 'Unexpected response after final response'); }
          current = new IncomingMessage(socket); Object.assign(current, info); current.req = this; current._parser = parser;
          current.joinDuplicateHeaders = !!this._options.joinDuplicateHeaders;
          const tunnel = this.method === 'CONNECT' && info.statusCode >= 200 && info.statusCode < 300;
          if (info.statusCode === 101 || tunnel) { this.upgradeOrConnect = true; this.res = current; return { upgrade: true }; }
          if (info.statusCode < 200) {
            if (info.statusCode === 100) this.emit('continue');
            this.emit('information', { statusCode: info.statusCode, statusMessage: info.statusMessage, httpVersion: info.httpVersion, httpVersionMajor: info.httpVersionMajor, httpVersionMinor: info.httpVersionMinor, headers: current.headers, rawHeaders: current.rawHeaders });
            current.resume(); return { skipBody: true };
          }
          finalSeen = true; this.res = current; this._responseKeepAlive = info.keepAlive;
          const keepAlive = /(?:^|,)\s*timeout\s*=\s*(\d+)/i.exec(String(current.headers['keep-alive'] || ''));
          socket._httpKeepAliveTimeout = keepAlive ? Math.max(0, Number(keepAlive[1]) * 1000 - (this.agent?.agentKeepAliveTimeoutBuffer || 0)) : undefined;
          current.once('end', () => { this._responseEnded = true; this._maybeRelease(); });
          diagnostics.publish('http.client.response.finish', { request: this, response: current });
          if (!this.emit('response', current)) current._dump();
          return { skipBody: this.method === 'HEAD' };
        },
        body: chunk => { if (current._dumped) return true; const ok = current.push(chunk); if (!ok) socket.pause(); return ok; },
        trailers: raw => { current.complete = true; current._addHeaderLines(raw, raw.length); },
        complete: () => {
          const message = current;
          if (message === this.res && parser.pendingBytes) parser.fail('HPE_UNEXPECTED_CONTENT_LENGTH', 'Unexpected bytes after final response');
          current = null; message.complete = true; message.push(null);
        },
        eofBody: () => { this._responseKeepAlive = false; },
        upgrade: (info, head) => {
          const message = current; current = null; message.complete = true; message._parser = null;
          this._released = true; detach(); socket.setTimeout(0); socket.emit('agentRemove'); this.agent?.removeSocket(socket, this._options);
          if (!this.emit(this.method === 'CONNECT' ? 'connect' : 'upgrade', message, socket, head)) socket.destroy();
          this._emitClose();
        },
        error: err => { if (this.res && !this.res.complete) this.res._abort(); this.destroy(err); },
      }, { maxHeaderSize: this.maxHeaderSize, maxHeadersCount: this.maxHeadersCount,
        httpValidation: this.httpValidation, insecureHTTPParser: this.insecureHTTPParser });
      const onData = data => parser.feed(data);
      const onEnd = () => { parser.end(); if (!this.res && !this.destroyed) this.destroy(error('ECONNRESET', 'socket hang up')); };
      const onError = err => { if (this.res && !this.res.complete) this.res._abort(); if (!this._released) this.destroy(err); };
      const onClose = () => {
        parser.stopped = true;
        if (this._released) return;
        if (!this.res) { if (!this.destroyed) this.destroy(error('ECONNRESET', 'socket hang up')); }
        else if (!this.res.complete) this.res._abort();
        this._emitClose();
      };
      const onTimeout = () => this.emit('timeout');
      const onConnect = () => { socket.setNoDelay(true); this._flushOutput(); };
      const onDrain = () => this._onSocketDrain();
      const detach = () => {
        socket.removeListener('drain', onDrain); socket.removeListener('data', onData); socket.removeListener('end', onEnd); socket.removeListener('error', onError); socket.removeListener('close', onClose); socket.removeListener('timeout', onTimeout); socket.removeListener('connect', onConnect);
      };
      this._detachSocket = detach; this._parser = parser;
      socket.on('data', onData); socket.on('end', onEnd); socket.on('error', onError); socket.on('close', onClose); socket.on('timeout', onTimeout); socket.on('drain', onDrain);
      socket.once('connect', onConnect);
      if (this._options.timeout !== undefined) socket.setTimeout(this._options.timeout);
      this.emit('socket', socket);
      if (!socket.connecting) onConnect();
    });
  }
  _maybeRelease() {
    if (this._released || !this._responseEnded || !this.writableFinished || !this.socket) return;
    this._released = true; this._parser.stopped = true; this._detachSocket();
    const socket = this.socket;
    if (this.shouldKeepAlive && this._responseKeepAlive && this.agent && !socket.destroyed && socket.writable) { socket.setTimeout(0); socket.emit('free'); }
    else socket.end();
    process.nextTick(() => this._emitClose());
  }
  _destroy(err, callback) {
    if (err) diagnostics.publish('http.client.request.error', { request: this, error: err });
    if (this.agent && this._agentKey && typeof this.agent._remove === 'function') this.agent._remove(this.agent.requests, this._agentKey, this);
    if (this.res && !this.res.complete) this.res._abort();
    if (this._parser) this._parser.stopped = true;
    if (this._released) { callback(err); process.nextTick(() => this._emitClose()); return; }
    super._destroy(err, callback);
  }
  abort() { if (this.aborted) return; this.aborted = true; process.nextTick(() => this.emit('abort')); this.destroy(); }
  setNoDelay(noDelay = true) { if (this.socket) this.socket.setNoDelay(noDelay); else this.once('socket', socket => socket.setNoDelay(noDelay)); return this; }
  setSocketKeepAlive(enable = false, initialDelay = 0) { if (this.socket) this.socket.setKeepAlive(enable, initialDelay); else this.once('socket', socket => socket.setKeepAlive(enable, initialDelay)); return this; }
}
function request(input, options, callback) { return new ClientRequest(input, options, callback); }
function get(input, options, callback) { const req = request(input, options, callback); req.end(); return req; }
module.exports = { ClientRequest, request, get };
