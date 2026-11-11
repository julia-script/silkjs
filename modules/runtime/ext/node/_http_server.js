'use strict';
const net = require('net');
const { setInterval, clearInterval } = require('timers');
const { OutgoingMessage, validateHeaderName, validateHeaderValue } = require('_http_outgoing');
const { IncomingMessage } = require('_http_incoming');
const { Parser, error, invalidValue, hasToken, setParserOptions } = require('internal/http/parser');
const { STATUS_CODES } = require('internal/http/constants');

class ServerResponse extends OutgoingMessage {
  constructor(req, options = {}) {
    super(options); this.req = req; this.statusCode = 200; this.statusMessage = undefined;
    this.sendDate = true; this._sent100 = false;
    this._hasBody = req.method !== 'HEAD'; this._rejectBody = !!options.rejectNonStandardBodyWrites;
    this.shouldKeepAlive = req._keepAlive !== false;
    this.useChunkedEncodingByDefault = req.httpVersionMinor !== 0;
  }
  assignSocket(socket) { this.socket = socket; this.emit('socket', socket); this._flushOutput(); }
  detachSocket(socket) { if (this.socket === socket) this.socket = null; }
  _implicitHeader() { this.writeHead(this.statusCode); }
  writeHead(statusCode, statusMessage, headers) {
    this._assertMutable();
    if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 999) throw error('ERR_HTTP_INVALID_STATUS_CODE', 'Invalid status code: ' + statusCode);
    if (typeof statusMessage !== 'string') { headers = statusMessage; statusMessage = undefined; }
    this.statusCode = statusCode; this.statusMessage = statusMessage === undefined ? this.statusMessage || STATUS_CODES[statusCode] || 'unknown' : statusMessage;
    if (invalidValue.test(this.statusMessage)) throw error('ERR_INVALID_CHAR', 'Invalid character in statusMessage');
    if (headers) {
      if (Array.isArray(headers)) { for (let i = 0; i < headers.length; i += 2) this.appendHeader(headers[i], headers[i + 1]); }
      else for (const name of Object.keys(headers)) this.setHeader(name, headers[name]);
    }
    if (statusCode < 200 || statusCode === 204 || statusCode === 304) { this._hasBody = false; if (this.hasHeader('transfer-encoding')) this.removeHeader('transfer-encoding'); }
    if (this.req.headers.expect && !this._sent100 && !this.req.complete) this.shouldKeepAlive = false;
    this._storeHeader('HTTP/1.1 ' + statusCode + ' ' + this.statusMessage + '\r\n'); return this;
  }
  writeContinue(callback) { this._sent100 = true; this._send('HTTP/1.1 100 Continue\r\n\r\n', callback); }
  writeProcessing() { this._send('HTTP/1.1 102 Processing\r\n\r\n'); }
  writeEarlyHints(hints, callback) {
    let text = 'HTTP/1.1 103 Early Hints\r\n';
    if (!hints || !hints.link || (Array.isArray(hints.link) && !hints.link.length)) return;
    for (const name of Object.keys(hints)) { validateHeaderName(name); const value = Array.isArray(hints[name]) ? hints[name].join(', ') : hints[name]; validateHeaderValue(name, value, this._isLenientHeaderValidation()); text += name + ': ' + value + '\r\n'; }
    this._send(text + '\r\n', callback);
  }
}

class Server extends net.Server {
  constructor(options, requestListener) {
    if (typeof options === 'function') { requestListener = options; options = {}; }
    options = options || {};
    super({ ...options, allowHalfOpen: true });
    this.httpAllowHalfOpen = false; this.timeout = 0;
    this.requestTimeout = options.requestTimeout === undefined ? 300000 : options.requestTimeout;
    this.headersTimeout = options.headersTimeout === undefined ? Math.min(60000, this.requestTimeout || 60000) : options.headersTimeout;
    if (this.requestTimeout > 0 && this.headersTimeout > this.requestTimeout) throw error('ERR_OUT_OF_RANGE', 'headersTimeout must not exceed requestTimeout');
    // Like Node, header and request deadlines are checked for every connection at this
    // interval rather than with timers per request.
    this.connectionsCheckingInterval = options.connectionsCheckingInterval === undefined ? 30000 : options.connectionsCheckingInterval;
    this._checkTimer = null;
    this.keepAliveTimeout = options.keepAliveTimeout === undefined ? 5000 : options.keepAliveTimeout;
    this.keepAliveTimeoutBuffer = options.keepAliveTimeoutBuffer === undefined ? 1000 : options.keepAliveTimeoutBuffer;
    this.maxHeadersCount = null; this.maxRequestsPerSocket = 0;
    this.maxHeaderSize = options.maxHeaderSize || 16384;
    setParserOptions(this, options);
    this.requireHostHeader = options.requireHostHeader !== false;
    this.joinDuplicateHeaders = !!options.joinDuplicateHeaders;
    this.rejectNonStandardBodyWrites = !!options.rejectNonStandardBodyWrites;
    this.shouldUpgradeCallback = options.shouldUpgradeCallback || (() => this.listenerCount('upgrade') > 0);
    this._responseOptions = { highWaterMark: options.highWaterMark, uniqueHeaders: options.uniqueHeaders, rejectNonStandardBodyWrites: this.rejectNonStandardBodyWrites };
    this._IncomingMessage = options.IncomingMessage || IncomingMessage;
    this._ServerResponse = options.ServerResponse || ServerResponse;
    this._httpSockets = new Map(); this._httpClosing = false;
    if (requestListener) this.on('request', requestListener);
    this.on('connection', socket => this._connection(socket));
  }
  setTimeout(msecs, callback) { this.timeout = msecs; if (callback) this.on('timeout', callback); return this; }
  close(callback) {
    this._httpClosing = true; this.closeIdleConnections();
    if (this._checkTimer) { clearInterval(this._checkTimer); this._checkTimer = null; }
    return super.close(callback);
  }
  _checkConnections() {
    const now = Date.now();
    for (const state of this._httpSockets.values()) {
      if ((state.headerStart && this.headersTimeout > 0 && now - state.headerStart >= this.headersTimeout) ||
          (state.requestStart && this.requestTimeout > 0 && now - state.requestStart >= this.requestTimeout)) state.expire();
    }
  }
  closeAllConnections() { for (const [socket] of this._httpSockets) socket.destroy(); }
  closeIdleConnections() { for (const [socket, state] of this._httpSockets) if (!state.responses.length && !state.current) socket.destroy(); }
  _connection(socket) {
    const state = { responses: [], requests: new Set(), current: null, count: 0, upgraded: false, ended: false, failed: false, headerStart: 0, requestStart: 0, expire: null };
    this._httpSockets.set(socket, state);
    if (!this._checkTimer && (this.headersTimeout > 0 || this.requestTimeout > 0) && this.connectionsCheckingInterval > 0) {
      this._checkTimer = setInterval(() => this._checkConnections(), this.connectionsCheckingInterval);
      this._checkTimer.unref();
    }
    socket.setNoDelay(true); socket.setTimeout(this.timeout);
    const clearTimers = () => { state.headerStart = state.requestStart = 0; };
    const clientError = err => {
      if (state.failed || state.upgraded) return;
      state.failed = true; clearTimers(); parser.stopped = true;
      err.rawPacket = state.lastPacket;
      if (!this.emit('clientError', err, socket)) {
        if (socket.writable && !socket.destroyed && (!state.responses.length || !state.responses[0].headersSent)) {
          const code = err.code === 'HPE_HEADER_OVERFLOW' ? 431 : err.code === 'ERR_HTTP_REQUEST_TIMEOUT' ? 408 : 400;
          socket.end('HTTP/1.1 ' + code + ' ' + STATUS_CODES[code] + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        } else socket.destroy();
      }
    };
    state.expire = () => clientError(error('ERR_HTTP_REQUEST_TIMEOUT', 'Request timeout'));
    const armHeaders = () => { if (this.headersTimeout > 0 && !state.headerStart) state.headerStart = Date.now(); };
    const armRequest = () => { if (this.requestTimeout > 0 && !state.requestStart) state.requestStart = Date.now(); };
    const parser = new Parser('request', {
      canResume: () => !state.outputPaused,
      headers: info => {
        state.headerStart = 0;
        armRequest();
        socket.setTimeout(this.timeout);
        const req = new this._IncomingMessage(socket); Object.assign(req, info);
        req.joinDuplicateHeaders = this.joinDuplicateHeaders; req._keepAlive = info.keepAlive; req._parser = parser;
        state.current = req; state.requests.add(req); state.count++;
        if (info.upgrade && info.method !== 'CONNECT' && !this.shouldUpgradeCallback(req)) { info.upgrade = false; req.upgrade = false; }
        req.on('close', () => state.requests.delete(req));
        if (info.upgrade) return { upgrade: true };
        const res = new this._ServerResponse(req, this._responseOptions);
        req.res = res; res._active = state.responses.length === 0;
        state.responses.push(res); res.assignSocket(socket);
        if (this.maxRequestsPerSocket > 0 && state.count >= this.maxRequestsPerSocket) res.shouldKeepAlive = false;
        res.on('error', err => socket.destroy(err));
        res.on('finish', () => {
          if (!req.complete || !req.readableEnded) req._dump();
          if (state.responses[0] === res) state.responses.shift();
          res.detachSocket(socket);
          process.nextTick(() => res._emitClose());
          if (!res.shouldKeepAlive || ((state.ended || this._httpClosing) && !state.responses.length)) { parser.stopped = true; socket.end(); }
          else if (state.responses.length) { const next = state.responses[0]; next._active = true; next._flushOutput(); }
          else if (state.deliverUpgrade) state.deliverUpgrade();
          else if (req.complete) socket.setTimeout(this.keepAliveTimeout ? this.keepAliveTimeout + this.keepAliveTimeoutBuffer : 0);
          if (state.outputPaused && state.responses.length < 2 && !parser.stopped) { state.outputPaused = false; parser.resume(); socket.resume(); }
        });
        if (this.requireHostHeader && req.httpVersionMinor === 1 && !req.headers.host) { res.statusCode = 400; res.shouldKeepAlive = false; res.end(); }
        else if (this.maxRequestsPerSocket > 0 && state.count > this.maxRequestsPerSocket) { this.emit('dropRequest', req, socket); res.statusCode = 503; res.end(); }
        else if (req.headers.expect !== undefined) {
          if (/^100-continue$/i.test(req.headers.expect)) { if (this.listenerCount('checkContinue')) this.emit('checkContinue', req, res); else { res.writeContinue(); this.emit('request', req, res); } }
          else if (this.listenerCount('checkExpectation')) this.emit('checkExpectation', req, res);
          else { res.statusCode = 417; res.end(); }
        } else this.emit('request', req, res);
        return {};
      },
      body: chunk => { if (state.current._dumped) return true; const ok = state.current.push(chunk); if (!ok) socket.pause(); return ok; },
      trailers: raw => { state.current.complete = true; state.current._addHeaderLines(raw, raw.length); },
      complete: () => {
        const req = state.current; state.current = null; clearTimers();
        if (req) { req.complete = true; req.push(null); }
        if (state.responses.length >= 2) { state.outputPaused = true; parser.paused = true; socket.pause(); }
      },
      upgrade: (info, head) => {
        const req = state.current; state.current = null; req.complete = true; req._parser = null;
        state.upgraded = true; clearTimers(); socket.pause();
        socket.removeListener('data', onData);
        state.deliverUpgrade = () => {
          state.deliverUpgrade = null; detach(); this._httpSockets.delete(socket); socket.setTimeout(0);
          const event = req.method === 'CONNECT' ? 'connect' : 'upgrade';
          socket.resume();
          if (!this.emit(event, req, socket, head)) socket.destroy();
        };
        if (!state.responses.length) state.deliverUpgrade();
      },
      error: clientError,
    }, { maxHeaderSize: this.maxHeaderSize, maxHeadersCount: this.maxHeadersCount,
      httpValidation: this.httpValidation, insecureHTTPParser: this.insecureHTTPParser });
    const onData = data => {
      state.lastPacket = data;
      if (parser.state === 'headers') armHeaders();
      armRequest();
      parser.feed(data);
      if (parser.state === 'headers' && parser.messageStarted) armHeaders();
    };
    const onEnd = () => { state.ended = true; parser.end(); if (!state.responses.length) socket.end(); };
    const onError = err => clientError(err);
    const onTimeout = () => { let handled = state.current?.emit('timeout') || false; if (state.responses[0]?.emit('timeout')) handled = true; if (this.emit('timeout', socket)) handled = true; if (!handled) socket.destroy(); };
    const onClose = () => {
      clearTimers(); parser.stopped = true; this._httpSockets.delete(socket);
      for (const req of state.requests) req._abort();
      for (const res of state.responses) if (!res._closed) res.destroy();
    };
    const detach = () => { socket.removeListener('data', onData); socket.removeListener('end', onEnd); socket.removeListener('error', onError); socket.removeListener('timeout', onTimeout); socket.removeListener('close', onClose); };
    socket.on('data', onData); socket.on('end', onEnd); socket.on('error', onError); socket.on('timeout', onTimeout); socket.on('close', onClose);
    armHeaders();
  }
}
function createServer(options, requestListener) { return new Server(options, requestListener); }
module.exports = { Server, ServerResponse, STATUS_CODES, createServer };
