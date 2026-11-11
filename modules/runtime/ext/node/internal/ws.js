'use strict';

// The `ws` package's API over the runtime's native WebSocket peers (net_native.silk). As in Bun,
// a program that requires the installed `ws` package gets this module: the frames are read,
// checked and written in Silk, and the frames that one poll's callbacks send go out in one
// system call per socket. permessage-deflate is not negotiated.

const EventEmitter = require('events');
const http = require('http');
const https = require('https');
const { Duplex } = require('stream');
const { Buffer } = require('buffer');
const { createHash, randomBytes } = require('crypto');
const { URL } = require('url');
const host = require('internal/host');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3;
const readyStates = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
const EMPTY = Buffer.alloc(0);
const wsSend = host.wsSend;
// net_native event kinds.
const WS_FRAME = 7, WS_WRITE_FAILED = 8;

function wireError(code) {
  if (code === 1007) return Object.assign(new Error('Invalid WebSocket frame: invalid UTF-8 sequence'), { code: 'WS_ERR_INVALID_UTF8' });
  if (code === 1009) return Object.assign(new RangeError('Max payload size exceeded'), { code: 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' });
  return Object.assign(new RangeError('Invalid WebSocket frame'), { code: 'WS_ERR_INVALID_FRAME' });
}
function validCloseCode(code) {
  return (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) || (code >= 3000 && code <= 4999);
}
function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(String(data));
}
function seed() { return randomBytes(6).readUIntBE(0, 6); }

class WebSocket extends EventEmitter {
  constructor(address, protocols, options) {
    super();
    this._binaryType = 'nodebuffer';
    this._readyState = CONNECTING;
    this._socket = null;
    this._id = 0;
    this._protocol = '';
    this._extensions = '';
    this._url = undefined;
    this._isServer = true;
    this._paused = false;
    this._queued = null;
    this._closeCode = 1006;
    this._closeMessage = EMPTY;
    this._closeFrameSent = false;
    this._closeFrameReceived = false;
    this._closeTimer = null;
    this._closeTimeout = 30000;
    this._bufferedAmount = 0;
    this._errorEmitted = false;
    this._req = null;
    if (address !== null) {
      this._isServer = false;
      if (protocols !== undefined && !Array.isArray(protocols) && typeof protocols === 'object' && protocols !== null) { options = protocols; protocols = []; }
      else if (protocols === undefined) protocols = [];
      else if (!Array.isArray(protocols)) protocols = [protocols];
      initAsClient(this, address, protocols, options);
    } else if (options && options.closeTimeout !== undefined) this._closeTimeout = options.closeTimeout;
  }
  get binaryType() { return this._binaryType; }
  set binaryType(type) {
    if (type === 'nodebuffer' || type === 'arraybuffer' || type === 'fragments') this._binaryType = type;
  }
  get bufferedAmount() {
    if (!this._socket) return this._bufferedAmount;
    return this._bufferedAmount + (this._id ? host.net('wsBuffered', [this._id]) : 0) + this._socket.writableLength;
  }
  get extensions() { return this._extensions; }
  get isPaused() { return this._paused; }
  get onclose() { return listenerOf(this, 'close'); }
  set onclose(handler) { setListener(this, 'close', handler); }
  get onerror() { return listenerOf(this, 'error'); }
  set onerror(handler) { setListener(this, 'error', handler); }
  get onmessage() { return listenerOf(this, 'message'); }
  set onmessage(handler) { setListener(this, 'message', handler); }
  get onopen() { return listenerOf(this, 'open'); }
  set onopen(handler) { setListener(this, 'open', handler); }
  get protocol() { return this._protocol; }
  get readyState() { return this._readyState; }
  get url() { return this._url; }

  // Takes over `socket`, whose HTTP upgrade is done: its bytes are frames from now on.
  setSocket(socket, head, options = {}) {
    this._socket = socket;
    socket._wsPeer = this;
    socket.setTimeout(0);
    if (socket.setNoDelay) socket.setNoDelay();
    const transport = socket._transport;
    if (!transport) { this._readyState = CLOSING; socket.destroy(); return; }
    this._id = transport.id;
    const maxPayload = options.maxPayload === undefined ? 104857600 : options.maxPayload;
    const status = host.net('wsAdopt', [this._id, this._isServer ? 0 : 1, maxPayload > 0 ? maxPayload : Infinity, seed(), 0, options.preamble]);
    if (status < 0) { socket.destroy(); return; }
    socket.on('close', socketOnClose);
    socket.on('end', socketOnEnd);
    socket.on('error', socketOnError);
    this._readyState = OPEN;
    // Bytes that came with or after the handshake, before the peer existed.
    if (head && head.length) feed(this, head);
    let chunk;
    while (socket.readableLength > 0 && (chunk = socket.read()) !== null) feed(this, chunk);
    transport.readStart();
    this.emit('open');
  }
  _frame(type, status, payload) {
    if (this._paused || this._queued) { (this._queued ||= []).push([type, status, payload]); return; }
    if (type === WS_WRITE_FAILED) { this._socket.destroy(Object.assign(new Error('write failed'), { errno: status })); return; }
    if (status === 1 || status === 2) {
      const binary = status === 2;
      let data;
      if (this._binaryType === 'arraybuffer') data = payload;
      else {
        data = Buffer.from(payload);
        if (this._binaryType === 'fragments') data = [data];
      }
      this.emit('message', data, binary);
    } else if (status === 9) this.emit('ping', Buffer.from(payload));
    else if (status === 10) this.emit('pong', Buffer.from(payload));
    else if (status === 8) {
      const bytes = Buffer.from(payload);
      this._closeFrameReceived = true;
      this._closeCode = bytes.length >= 2 ? bytes.readUInt16BE(0) : 1005;
      this._closeMessage = bytes.length > 2 ? bytes.subarray(2) : EMPTY;
      // The session answered the Close, unless this side had sent one.
      this._closeFrameSent = true;
      this._readyState = CLOSING;
      this._socket.end();
      armCloseTimer(this);
    } else if (status < 0) {
      // The session sent the Close for the error.
      this._closeFrameSent = true;
      this._readyState = CLOSING;
      this._closeCode = -status;
      if (!this._errorEmitted) { this._errorEmitted = true; this.emit('error', wireError(-status)); }
      this._socket.end();
      armCloseTimer(this);
    }
  }
  send(data, options, cb) {
    if (typeof options === 'function') { cb = options; options = undefined; }
    if (this._readyState !== OPEN) { sendNotOpen(this, data, cb); return; }
    let kind = 2;
    let status;
    const token = cb === undefined ? 0 : requestToken(this, cb);
    if (typeof data === 'string') {
      kind = options !== undefined && options.binary === true ? 2 : 1;
      if (options !== undefined && options.fin === false) kind += 16;
      status = wsSend(this._id, kind, token, data);
    } else {
      if (typeof data === 'number') data = String(data);
      if (typeof data === 'string') kind = 1;
      if (options !== undefined) {
        if (options.binary === false) kind = 1;
        if (options.fin === false) kind += 16;
      }
      status = sendBytes(this._id, kind, token, data);
    }
    finishSend(this, status, token, cb);
  }
  ping(data, mask, cb) { this._control(9, data, mask, cb); }
  pong(data, mask, cb) { this._control(10, data, mask, cb); }
  _control(kind, data, mask, cb) {
    if (this._readyState === CONNECTING) throw new Error('WebSocket is not open: readyState 0 (CONNECTING)');
    if (typeof data === 'function') { cb = data; data = mask = undefined; }
    else if (typeof mask === 'function') { cb = mask; mask = undefined; }
    if (typeof data === 'number') data = String(data);
    if (this._readyState !== OPEN) { sendNotOpen(this, data, cb); return; }
    if (data === undefined) data = EMPTY;
    const size = typeof data === 'string' ? Buffer.byteLength(data) : toBuffer(data).length;
    if (size > 125) throw new RangeError('The data size must not be greater than 125 bytes');
    const token = cb === undefined ? 0 : requestToken(this, cb);
    const status = typeof data === 'string' ? wsSend(this._id, kind, token, data) : sendBytes(this._id, kind, token, data);
    finishSend(this, status, token, cb);
  }
  close(code, data) {
    if (this._readyState === CLOSED) return;
    if (this._readyState === CONNECTING) {
      abortHandshake(this, this._req, 'WebSocket was closed before the connection was established');
      return;
    }
    if (this._readyState === CLOSING) {
      if (this._closeFrameSent && this._closeFrameReceived) this._socket.end();
      return;
    }
    if (code !== undefined && (typeof code !== 'number' || !validCloseCode(code) || code === 1005)) {
      throw new TypeError('First argument must be a valid error code number');
    }
    const reason = data === undefined ? '' : typeof data === 'string' ? data : toBuffer(data).toString();
    if (Buffer.byteLength(reason) > 123) throw new RangeError('The message must not be greater than 123 bytes');
    if (code === undefined && reason) throw new TypeError('First argument must be a valid error code number');
    this._readyState = CLOSING;
    host.net('wsClose', [this._id, code === undefined ? 0 : code, reason]);
    this._closeFrameSent = true;
    if (this._closeFrameReceived) this._socket.end();
    armCloseTimer(this);
  }
  pause() {
    if (this._readyState === CONNECTING || this._readyState === CLOSED) return;
    this._paused = true;
    if (this._socket && this._socket._transport) this._socket._transport.readStop();
  }
  resume() {
    if (this._readyState === CONNECTING || this._readyState === CLOSED) return;
    this._paused = false;
    const queued = this._queued;
    this._queued = null;
    if (queued) for (let i = 0; i < queued.length && !this._paused; i++) {
      this._frame(queued[i][0], queued[i][1], queued[i][2]);
      if (this._paused) { this._queued = queued.slice(i + 1).concat(this._queued || []); break; }
    }
    if (!this._paused && this._socket && this._socket._transport) this._socket._transport.readStart();
  }
  terminate() {
    if (this._readyState === CLOSED) return;
    if (this._readyState === CONNECTING) {
      abortHandshake(this, this._req, 'WebSocket was closed before the connection was established');
      return;
    }
    if (this._socket) { this._readyState = CLOSING; this._socket.destroy(); }
  }
  addEventListener(type, handler, options = {}) {
    if (typeof handler !== 'function' && !(handler && typeof handler.handleEvent === 'function')) return;
    for (const listener of this.listeners(type)) if (listener._wsHandler === handler && !listener._wsAttribute) return;
    const call = event => typeof handler === 'function' ? handler.call(this, event) : handler.handleEvent(event);
    let wrapped;
    if (type === 'message') wrapped = (data, isBinary) => call({ type, target: this, data: isBinary ? data : data.toString() });
    else if (type === 'close') wrapped = (code, message) => call({ type, target: this, code, reason: message.toString(), wasClean: this._closeFrameReceived && this._closeFrameSent });
    else if (type === 'error') wrapped = error => call({ type, target: this, error, message: error.message });
    else if (type === 'open') wrapped = () => call({ type, target: this });
    else return;
    wrapped._wsHandler = handler;
    if (options.once) this.once(type, wrapped); else this.on(type, wrapped);
  }
  removeEventListener(type, handler) {
    for (const listener of this.listeners(type)) {
      if (listener._wsHandler === handler && !listener._wsAttribute) { this.removeListener(type, listener); break; }
    }
  }
}
for (const [name, value] of [['CONNECTING', CONNECTING], ['OPEN', OPEN], ['CLOSING', CLOSING], ['CLOSED', CLOSED]]) {
  Object.defineProperty(WebSocket, name, { enumerable: true, value });
  Object.defineProperty(WebSocket.prototype, name, { enumerable: true, value });
}

function listenerOf(ws, type) {
  for (const listener of ws.listeners(type)) if (listener._wsAttribute) return listener._wsHandler;
  return null;
}
function setListener(ws, type, handler) {
  for (const listener of ws.listeners(type)) if (listener._wsAttribute) ws.removeListener(type, listener);
  if (typeof handler !== 'function') return;
  ws.addEventListener(type, handler);
  const listeners = ws.listeners(type);
  listeners[listeners.length - 1]._wsAttribute = true;
}
function feed(ws, chunk) {
  if (chunk.length) host.net('wsFeed', [ws._id, chunk.buffer, chunk.byteOffset, chunk.byteLength]);
}
function sendBytes(id, kind, token, data) {
  if (data instanceof ArrayBuffer) return wsSend(id, kind, token, data, 0, data.byteLength);
  if (ArrayBuffer.isView(data)) return wsSend(id, kind, token, data.buffer, data.byteOffset, data.byteLength);
  if (data === undefined) return wsSend(id, kind, token, '');
  const bytes = toBuffer(data);
  return wsSend(id, kind, token, bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
function requestToken(ws, cb) {
  const transport = ws._socket._transport;
  const token = ++transport.sequence;
  transport.requests.set(token, { callback: cb, chunk: null });
  return token;
}
function finishSend(ws, status, token, cb) {
  if (token === 0) return;
  const transport = ws._socket._transport;
  if (status === 0) return;
  transport.requests.delete(token);
  const error = status === 1 ? null : new Error(status === -22 ? 'WebSocket frame refused' : 'WebSocket is not open: readyState ' + ws._readyState + ' (' + readyStates[ws._readyState] + ')');
  process.nextTick(cb, error);
}
function sendNotOpen(ws, data, cb) {
  if (data) ws._bufferedAmount += typeof data === 'string' ? Buffer.byteLength(data) : toBuffer(data).length;
  if (ws._readyState === CONNECTING) throw new Error('WebSocket is not open: readyState 0 (CONNECTING)');
  if (cb) {
    const error = new Error(`WebSocket is not open: readyState ${ws._readyState} (${readyStates[ws._readyState]})`);
    process.nextTick(cb, error);
  }
}
function armCloseTimer(ws) {
  if (ws._closeTimer || !ws._socket) return;
  ws._closeTimer = setTimeout(() => ws._socket.destroy(), ws._closeTimeout);
  ws._closeTimer.unref?.();
}
function socketOnClose() {
  const ws = this._wsPeer;
  this.removeListener('close', socketOnClose);
  this.removeListener('end', socketOnEnd);
  if (!ws) return;
  clearTimeout(ws._closeTimer);
  ws._closeTimer = null;
  ws._readyState = CLOSED;
  // Events the poll queued before the close still arrive in order: hand any paused ones over.
  ws._queued = null;
  ws.emit('close', ws._closeCode, ws._closeMessage);
}
function socketOnEnd() {
  const ws = this._wsPeer;
  if (ws) ws._readyState = CLOSING;
  this.end();
}
function socketOnError() {
  const ws = this._wsPeer;
  this.removeListener('error', socketOnError);
  this.on('error', () => {});
  if (ws) ws._readyState = CLOSING;
  this.destroy();
}

// ---- Client ----

function initAsClient(ws, address, protocols, options) {
  const opts = {
    protocolVersion: 13, maxPayload: 104857600, perMessageDeflate: true, followRedirects: false,
    maxRedirects: 10, handshakeTimeout: undefined, closeTimeout: 30000, ...options,
  };
  ws._closeTimeout = opts.closeTimeout;
  let url;
  if (address instanceof URL) url = address;
  else {
    try { url = new URL(address); } catch { throw new SyntaxError(`Invalid URL: ${address}`); }
  }
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  ws._url = url.href;
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:' && url.protocol !== 'ws+unix:') {
    throw new SyntaxError('The URL\'s protocol must be one of "ws:", "wss:", "http:", "https:", or "ws+unix:"');
  }
  if (url.hash) throw new SyntaxError('The URL contains a fragment identifier');
  const secure = url.protocol === 'wss:';
  const key = randomBytes(16).toString('base64');
  const request = secure ? https.request : http.request;
  const seen = new Set();
  for (const protocol of protocols) {
    if (typeof protocol !== 'string' || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(protocol) || seen.has(protocol)) {
      throw new SyntaxError('An invalid or duplicated subprotocol was specified');
    }
    seen.add(protocol);
  }
  const headers = {
    ...opts.headers,
    'Sec-WebSocket-Version': opts.protocolVersion,
    'Sec-WebSocket-Key': key,
    Connection: 'Upgrade',
    Upgrade: 'websocket',
  };
  if (protocols.length) headers['Sec-WebSocket-Protocol'] = protocols.join(',');
  if (opts.origin) headers[opts.protocolVersion < 13 ? 'Sec-WebSocket-Origin' : 'Origin'] = opts.origin;
  const requestOptions = { ...opts, headers, timeout: opts.handshakeTimeout };
  delete requestOptions.perMessageDeflate;
  if (url.protocol === 'ws+unix:') {
    const [socketPath, path] = url.pathname.split(':');
    requestOptions.socketPath = socketPath;
    requestOptions.path = path || '/';
  } else {
    requestOptions.host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
    requestOptions.port = url.port || (secure ? 443 : 80);
    requestOptions.path = url.pathname + url.search;
  }
  if (url.username || url.password) requestOptions.auth = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
  const req = ws._req = request(requestOptions);
  if (opts.handshakeTimeout) req.on('timeout', () => abortHandshake(ws, req, 'Opening handshake has timed out'));
  req.on('error', error => {
    if (req === null || req.aborted) return;
    ws._req = null;
    emitErrorAndClose(ws, error);
  });
  req.on('response', res => {
    if (!ws.emit('unexpected-response', req, res)) abortHandshake(ws, req, `Unexpected server response: ${res.statusCode}`);
  });
  req.on('upgrade', (res, socket, head) => {
    ws.emit('upgrade', res);
    if (ws._readyState !== CONNECTING) return;
    ws._req = null;
    if (res.headers.upgrade?.toLowerCase() !== 'websocket') { abortHandshake(ws, socket, 'Invalid Upgrade header'); return; }
    const digest = createHash('sha1').update(key + GUID).digest('base64');
    if (res.headers['sec-websocket-accept'] !== digest) { abortHandshake(ws, socket, 'Invalid Sec-WebSocket-Accept header'); return; }
    const serverProtocol = res.headers['sec-websocket-protocol'];
    let protocolError;
    if (serverProtocol !== undefined) {
      if (!seen.size) protocolError = 'Server sent a subprotocol but none was requested';
      else if (!seen.has(serverProtocol)) protocolError = 'Server sent an invalid subprotocol';
    } else if (seen.size) protocolError = 'Server sent no subprotocol';
    if (protocolError) { abortHandshake(ws, socket, protocolError); return; }
    if (serverProtocol) ws._protocol = serverProtocol;
    if (res.headers['sec-websocket-extensions'] !== undefined) { abortHandshake(ws, socket, 'Server indicated an extension that was not requested'); return; }
    ws.setSocket(socket, head, { maxPayload: opts.maxPayload });
  });
  if (opts.finishRequest) opts.finishRequest(req, ws); else req.end();
}
function emitErrorAndClose(ws, error) {
  ws._readyState = CLOSING;
  ws._errorEmitted = true;
  ws.emit('error', error);
  ws._readyState = CLOSED;
  ws.emit('close', ws._closeCode, ws._closeMessage);
}
function abortHandshake(ws, stream, message) {
  ws._readyState = CLOSING;
  const error = new Error(message);
  if (stream && stream.setHeader) {
    ws._req = null;
    stream.abort?.();
    stream.destroy();
    if (stream.socket && !stream.socket.destroyed) stream.socket.destroy();
    process.nextTick(emitErrorAndClose, ws, error);
  } else {
    if (stream) stream.destroy(error);
    stream?.once?.('error', () => {});
    process.nextTick(emitErrorAndClose, ws, error);
  }
}

// ---- Server ----

const RUNNING = 0, SERVER_CLOSING = 1, SERVER_CLOSED = 2;

class WebSocketServer extends EventEmitter {
  constructor(options, callback) {
    super();
    options = {
      allowSynchronousEvents: true, autoPong: true, maxPayload: 100 * 1024 * 1024, skipUTF8Validation: false,
      perMessageDeflate: false, handleProtocols: null, clientTracking: true, verifyClient: null,
      noServer: false, backlog: null, server: null, host: null, path: null, port: null,
      closeTimeout: 30000, WebSocket, ...options,
    };
    if ((options.port == null && !options.server && !options.noServer) ||
        (options.port != null && (options.server || options.noServer)) || (options.server && options.noServer)) {
      throw new TypeError('One and only one of the "port", "server", or "noServer" options must be specified');
    }
    if (options.port != null) {
      this._server = http.createServer((req, res) => {
        const body = http.STATUS_CODES[426];
        res.writeHead(426, { 'Content-Length': body.length, 'Content-Type': 'text/plain' });
        res.end(body);
      });
      this._server.listen(options.port, options.host, options.backlog, callback);
    } else if (options.server) this._server = options.server;
    if (this._server) {
      const emitConnection = this.emit.bind(this, 'connection');
      this._removeListeners = addListeners(this._server, {
        listening: this.emit.bind(this, 'listening'),
        error: this.emit.bind(this, 'error'),
        upgrade: (req, socket, head) => this.handleUpgrade(req, socket, head, emitConnection),
      });
    }
    if (options.clientTracking) { this.clients = new Set(); this._shouldEmitClose = false; }
    this.options = options;
    this._state = RUNNING;
  }
  address() {
    if (this.options.noServer) throw new Error('The server is operating in "noServer" mode');
    if (!this._server) return null;
    return this._server.address();
  }
  close(cb) {
    if (this._state === SERVER_CLOSED) {
      if (cb) this.once('close', () => cb(new Error('The server is not running')));
      process.nextTick(emitClose, this);
      return;
    }
    if (cb) this.once('close', cb);
    if (this._state === SERVER_CLOSING) return;
    this._state = SERVER_CLOSING;
    if (this.options.noServer || this.options.server) {
      if (this._server) { this._removeListeners(); this._removeListeners = this._server = null; }
      if (this.clients && this.clients.size) this._shouldEmitClose = true;
      else process.nextTick(emitClose, this);
    } else {
      const server = this._server;
      this._removeListeners();
      this._removeListeners = this._server = null;
      server.close(() => emitClose(this));
    }
  }
  shouldHandle(req) {
    if (this.options.path) {
      const index = req.url.indexOf('?');
      const pathname = index !== -1 ? req.url.slice(0, index) : req.url;
      if (pathname !== this.options.path) return false;
    }
    return true;
  }
  handleUpgrade(req, socket, head, cb) {
    socket.on('error', socketOnHandshakeError);
    const key = req.headers['sec-websocket-key'];
    const upgrade = req.headers.upgrade;
    const version = +req.headers['sec-websocket-version'];
    if (req.method !== 'GET') return rejectHandshake(this, req, socket, 405, 'Invalid HTTP method');
    if (upgrade === undefined || upgrade.toLowerCase() !== 'websocket') return rejectHandshake(this, req, socket, 400, 'Invalid Upgrade header');
    if (key === undefined || !/^[+/0-9A-Za-z]{22}==$/.test(key)) return rejectHandshake(this, req, socket, 400, 'Missing or invalid Sec-WebSocket-Key header');
    if (version !== 13 && version !== 8) return rejectHandshake(this, req, socket, 400, 'Missing or invalid Sec-WebSocket-Version header', { 'Sec-WebSocket-Version': '13, 8' });
    if (!this.shouldHandle(req)) { abortServerHandshake(socket, 400); return; }
    const header = req.headers['sec-websocket-protocol'];
    const protocols = new Set();
    if (header !== undefined) {
      for (const part of header.split(',')) {
        const protocol = part.trim();
        if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(protocol) || protocols.has(protocol)) {
          return rejectHandshake(this, req, socket, 400, 'Invalid Sec-WebSocket-Protocol header');
        }
        protocols.add(protocol);
      }
    }
    if (this.options.verifyClient) {
      const info = { origin: req.headers[version === 8 ? 'sec-websocket-origin' : 'origin'], secure: !!(req.socket.authorized || req.socket.encrypted), req };
      if (this.options.verifyClient.length === 2) {
        this.options.verifyClient(info, (verified, code, message, headers) => {
          if (!verified) return abortServerHandshake(socket, code || 401, message, headers);
          this.completeUpgrade({}, key, protocols, req, socket, head, cb);
        });
        return;
      }
      if (!this.options.verifyClient(info)) return abortServerHandshake(socket, 401);
    }
    this.completeUpgrade({}, key, protocols, req, socket, head, cb);
  }
  completeUpgrade(extensions, key, protocols, req, socket, head, cb) {
    if (!socket.readable || !socket.writable) return socket.destroy();
    if (socket._wsPeer) {
      throw new Error('server.handleUpgrade() was called more than once with the same socket, possibly due to a misconfiguration');
    }
    if (this._state > RUNNING) return abortServerHandshake(socket, 503);
    const digest = createHash('sha1').update(key + GUID).digest('base64');
    const headers = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${digest}`];
    const ws = new this.options.WebSocket(null, undefined, this.options);
    if (protocols.size) {
      const protocol = this.options.handleProtocols ? this.options.handleProtocols(protocols, req) : protocols.values().next().value;
      if (protocol) { headers.push(`Sec-WebSocket-Protocol: ${protocol}`); ws._protocol = protocol; }
    }
    this.emit('headers', headers, req);
    socket.removeListener('error', socketOnHandshakeError);
    ws.setSocket(socket, head, { maxPayload: this.options.maxPayload, preamble: headers.concat('\r\n').join('\r\n') });
    if (this.clients) {
      this.clients.add(ws);
      ws.on('close', () => {
        this.clients.delete(ws);
        if (this._shouldEmitClose && !this.clients.size) process.nextTick(emitClose, this);
      });
    }
    cb(ws, req);
  }
}
function addListeners(server, map) {
  for (const event of Object.keys(map)) server.on(event, map[event]);
  return function removeListeners() { for (const event of Object.keys(map)) server.removeListener(event, map[event]); };
}
function emitClose(server) { server._state = SERVER_CLOSED; server.emit('close'); }
function socketOnHandshakeError() { this.destroy(); }
function abortServerHandshake(socket, code, message, headers) {
  message = message || http.STATUS_CODES[code];
  headers = { Connection: 'close', 'Content-Type': 'text/html', 'Content-Length': Buffer.byteLength(message), ...headers };
  socket.once('finish', socket.destroy);
  socket.end(`HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r\n` + Object.keys(headers).map(h => `${h}: ${headers[h]}`).join('\r\n') + '\r\n\r\n' + message);
}
function rejectHandshake(server, req, socket, code, message, headers) {
  if (server.listenerCount('wsClientError')) {
    const error = new Error(message);
    Error.captureStackTrace?.(error, rejectHandshake);
    server.emit('wsClientError', error, socket, req);
  } else abortServerHandshake(socket, code, message, headers);
}

// ---- Streams ----

function createWebSocketStream(ws, options) {
  let terminateOnDestroy = true;
  const duplex = new Duplex({ ...options, autoDestroy: false, emitClose: false, objectMode: false, writableObjectMode: false });
  ws.on('message', (message, isBinary) => {
    const data = !isBinary && duplex._readableState.objectMode ? message.toString() : message;
    if (!duplex.push(data)) ws.pause();
  });
  ws.once('error', error => {
    if (duplex.destroyed) return;
    terminateOnDestroy = false;
    duplex.destroy(error);
  });
  ws.once('close', () => { if (!duplex.destroyed) duplex.push(null); });
  duplex._destroy = (error, callback) => {
    if (ws.readyState === CLOSED) { callback(error); process.nextTick(() => duplex.emit('close')); return; }
    let called = false;
    ws.once('error', err => { called = true; callback(err); });
    ws.once('close', () => { if (!called) callback(error); process.nextTick(() => duplex.emit('close')); });
    if (terminateOnDestroy) ws.terminate();
  };
  duplex._final = callback => {
    if (ws.readyState === CONNECTING) { ws.once('open', () => duplex._final(callback)); return; }
    if (ws._socket === null) return;
    if (ws._socket._writableState?.finished) { callback(); if (duplex._readableState.endEmitted) duplex.destroy(); }
    else { ws._socket.once('finish', () => callback()); ws.close(); }
  };
  duplex._read = () => { if (ws.isPaused) ws.resume(); };
  duplex._write = (chunk, encoding, callback) => {
    if (ws.readyState === CONNECTING) { ws.once('open', () => duplex._write(chunk, encoding, callback)); return; }
    ws.send(chunk, callback);
  };
  duplex.on('end', () => { if (!duplex.destroyed && duplex._writableState.finished) duplex.destroy(); });
  duplex.on('error', function duplexOnError() { this.removeListener('error', duplexOnError); this.destroy(); });
  return duplex;
}

WebSocket.WebSocket = WebSocket;
WebSocket.WebSocketServer = WebSocketServer;
WebSocket.Server = WebSocketServer;
WebSocket.createWebSocketStream = createWebSocketStream;
module.exports = WebSocket;
