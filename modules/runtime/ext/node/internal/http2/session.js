'use strict';
const { EventEmitter } = require('events');
const { Duplex } = require('stream');
const { Buffer } = require('buffer');
const { native, error, integer, headers: encodeHeaders, addHeader, packSettings, readSettings, packOptions, validateOptions } = require('internal/http2/util');
const { URL } = require('url');
const blockedSocketMethods = new Set(['emit', 'end', 'pause', 'read', 'resume', 'write', 'setEncoding', 'setKeepAlive', 'setNoDelay']);
const sessionSocketMethods = new Set(['setTimeout', 'ref', 'unref', 'destroy']);
const socketProxy = {
  get(session, key) {
    if (blockedSocketMethods.has(key)) throw error('ERR_HTTP2_NO_SOCKET_MANIPULATION', 'HTTP/2 sockets should not be directly manipulated');
    if (sessionSocketMethods.has(key)) return session[key].bind(session);
    if (session.destroyed) throw error('ERR_HTTP2_SOCKET_UNBOUND', 'The socket has been disconnected from the session');
    const value = session._socket[key]; return typeof value === 'function' ? value.bind(session._socket) : value;
  },
  set(session, key, value) {
    if (blockedSocketMethods.has(key)) throw error('ERR_HTTP2_NO_SOCKET_MANIPULATION', 'HTTP/2 sockets should not be directly manipulated');
    if (sessionSocketMethods.has(key)) { session[key] = value; return true; }
    if (session.destroyed) throw error('ERR_HTTP2_SOCKET_UNBOUND', 'The socket has been disconnected from the session');
    session._socket[key] = value; return true;
  },
  getPrototypeOf(session) { if (session.destroyed) throw error('ERR_HTTP2_SOCKET_UNBOUND', 'The socket has been disconnected from the session'); return Object.getPrototypeOf(session._socket); }
};

class Http2Stream extends Duplex {
  constructor(session, id, options = {}) {
    super({ allowHalfOpen: true, autoDestroy: true, emitClose: true, highWaterMark: options.highWaterMark });
    this.session = session; this.id = id; this.pending = id === undefined; this.closed = false; this.rstCode = 0;
    this.sentHeaders = undefined; this.sentTrailers = undefined; this.sentInfoHeaders = [];
    this._body = false; this._localEnded = !!options.endStream; this._remoteEnded = false; this._nativeClosed = false;
    this._writeCallbacks = []; this._credit = 0; this._waitTrailers = !!options.waitForTrailers; this._wantTrailers = false;
    this._timer = null; this._head = false; this._responded = false;
    if (this.pending) session._pending.add(this); else session._streams.set(id, this);
    this.once('close', () => { clearTimeout(this._timer); });
    if (!this.pending) process.nextTick(() => { if (!this.destroyed) this.emit('ready'); });
  }
  get closed() { return !!this._closed; }
  set closed(value) { this._closed = value; }
  get bufferSize() { return this.writableLength; }
  get endAfterHeaders() { return this._localEnded && !this._body; }
  get state() {
    const session = this.session;
    if (!session || session.destroyed || this._nativeClosed || this.pending) return {};
    const state = native('streamState', session._id, this.id);
    if (!state) return {};
    const local = native('localClose', session._id, this.id), remote = native('remoteClose', session._id, this.id);
    return { localWindowSize: native('localWindow', session._id, this.id), state, localClose: local, remoteClose: remote, sumDependencyWeight: native('sumWeight', session._id, this.id), weight: native('weight', session._id, this.id) };
  }
  _touch() { if (this._timeout) { clearTimeout(this._timer); this._timer = setTimeout(() => this.emit('timeout'), this._timeout); this._timer.unref?.(); } }
  setTimeout(msecs, callback) { integer(msecs, 'msecs', 0, 0x7fffffff); this._timeout = msecs; if (callback) this.once('timeout', callback); clearTimeout(this._timer); this._touch(); return this; }
  _read() { if (this._credit && !this.session.destroyed) { const n = this._credit; this._credit = 0; this.session._call('consume', this.id, n); } }
  _receive(data) { this._touch(); if (this.destroyed || this.push(data)) this.session._call('consume', this.id, data.length); else this._credit += data.length; }
  _ensureBody() { if (!this._body && !this._localEnded) { native('body', this.session._id, this.id); this._body = true; } }
  _write(chunk, encoding, callback) {
    if (this.pending) { this.once('ready', () => this._write(chunk, encoding, callback)); return; }
    try {
      if (this._localEnded || this._nativeClosed || this.session.destroyed) throw error('ERR_STREAM_WRITE_AFTER_END', 'write after end');
      if (this.session.type === 0 && !this._responded) this.respond();
      this._ensureBody(); this._writeCallbacks.push(callback); native('write', this.session._id, this.id, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)); this._touch(); this.session._pump();
    } catch (err) { const at = this._writeCallbacks.indexOf(callback); if (at !== -1) this._writeCallbacks.splice(at, 1); callback(err); }
  }
  _final(callback) {
    if (this.pending) { this.once('ready', () => this._final(callback)); return; }
    try {
      if (this._localEnded || this._nativeClosed) { callback(); return; }
      if (this.session.type === 0 && !this._responded) this.respond();
      this._ensureBody(); this._localEnded = true; native('end', this.session._id, this.id, +this._waitTrailers); this.session._pump(); callback();
    } catch (err) { callback(err); }
  }
  _destroy(err, callback) {
    clearTimeout(this._timer);
    const session = this.session;
    if (this.pending) { session._pending.delete(this); this._nativeClosed = true; }
    if (session && !session.destroyed && this._credit) { try { native('consume', session._id, this.id, this._credit); this._credit = 0; } catch (failure) { err ||= failure; } }
    if (session && !session.destroyed && !this._nativeClosed) { try { native('rst', session._id, this.id, this.closed ? this.rstCode : err ? (err.code === 'ABORT_ERR' ? 8 : 2) : 0); session._pump(); } catch (failure) { err ||= failure; } }
    this.closed = true;
    for (const cb of this._writeCallbacks.splice(0)) cb(err || error('ERR_STREAM_DESTROYED', 'Stream was destroyed'));
    callback(err);
  }
  close(code = 0, callback) { integer(code, 'code'); if (callback) this.once('close', callback); if (this.closed || this.destroyed) return; this.rstCode = code; this.closed = true; if (this.pending) { this.destroy(); return; } if (!this.session.destroyed) this.session._call('rst', this.id, code); }
  sendTrailers(headers) { if (this.destroyed || this.closed) throw error('ERR_HTTP2_INVALID_STREAM', 'The stream has been destroyed'); if (this.sentTrailers) throw error('ERR_HTTP2_TRAILERS_ALREADY_SENT', 'Trailers already sent'); if (!this._wantTrailers) throw error('ERR_HTTP2_TRAILERS_NOT_READY', 'Trailers cannot be sent before wantTrailers'); const packed = encodeHeaders(headers, 'trailers'); this.sentTrailers = { ...headers }; this.session._call('headers', this.id, packed, 1); }
}
Http2Stream.prototype.priority = require('util').deprecate(function priority(options) {
  if (this.destroyed) throw error('ERR_HTTP2_INVALID_STREAM', 'The stream has been destroyed');
}, 'http2Stream.priority is longer supported after priority signalling was deprecated in RFC 9113', 'DEP0194');
class ClientHttp2Stream extends Http2Stream {}
class ServerHttp2Stream extends Http2Stream {
  get headersSent() { return this._responded; }
  get pushAllowed() { return !this.session.destroyed && !this.session.closed && this.session.remoteSettings.enablePush; }
  respond(headers = {}, options = {}) {
    if (this._responded) throw error('ERR_HTTP2_HEADERS_SENT', 'Response has already been initiated');
    const h = { ':status': 200, ...headers }; integer(+h[':status'], ':status', 200, 599);
    const noBody = this._head || +h[':status'] === 204 || +h[':status'] === 304;
    const end = !!options.endStream || noBody;
    const packed = encodeHeaders(h, 'response');
    this._responded = true; this.sentHeaders = h; this._waitTrailers = !!options.waitForTrailers;
    native('headers', this.session._id, this.id, packed, end ? 1 : 0);
    if (end) { this._localEnded = true; if (!this.writableEnded) this.end(); } else this._ensureBody();
    this.session._pump();
  }
  additionalHeaders(headers) { if (this._responded) throw error('ERR_HTTP2_HEADERS_AFTER_RESPOND', 'Cannot send additional headers after response'); const status = +headers[':status']; integer(status, ':status', 100, 199); if (status === 101) throw error('ERR_HTTP2_STATUS_101', 'HTTP/2 does not support status 101'); this.sentInfoHeaders.push({ ...headers }); this.session._call('headers', this.id, encodeHeaders(headers, 'response'), 0); }
  pushStream(headers, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; } options ||= {};
    if (typeof callback !== 'function') throw error('ERR_INVALID_ARG_TYPE', 'callback must be a function', TypeError);
    if (!this.pushAllowed) { process.nextTick(callback, error('ERR_HTTP2_PUSH_DISABLED', 'HTTP/2 push is disabled')); return; }
    try {
      const h = { ':method': 'GET', ':scheme': this.session.encrypted ? 'https' : 'http', ':authority': this._requestHeaders?.[':authority'], ':path': '/', ...headers };
      this.session._syncMemory();
      const id = native('push', this.session._id, this.id, encodeHeaders(h));
      const stream = new ServerHttp2Stream(this.session, id, options); stream._requestHeaders = h; stream._remoteEnded = true; stream.push(null); stream._head = h[':method'] === 'HEAD';
      this.session._pump(); process.nextTick(callback, null, stream, h, 0);
    } catch (err) { process.nextTick(callback, err); }
  }
  respondWithFD(fd, headers = {}, options = {}) {
    const fs = require('fs'); let stat;
    try { stat = fs.fstatSync(typeof fd === 'object' ? fd.fd : fd); } catch (err) { if (options.onError) options.onError(err); else this.destroy(err); return; }
    const h = { ...headers }, statOptions = { offset: options.offset || 0, length: options.length === undefined ? stat.size - (options.offset || 0) : options.length };
    if (options.statCheck && options.statCheck(stat, h, statOptions) === false) return false;
    const { offset, length } = statOptions;
    if (!stat.isFile()) { const err = error('ERR_HTTP2_SEND_FILE', 'File descriptor must refer to a regular file'); if (options.onError) options.onError(err); else this.destroy(err); return; }
    integer(offset, 'offset', 0, Number.MAX_SAFE_INTEGER); integer(length, 'length', 0, Number.MAX_SAFE_INTEGER);
    if (h['content-length'] === undefined) h['content-length'] = length;
    this.respond(h, options); if (this._localEnded) return;
    if (!length) { this.end(); return; }
    const input = fs.createReadStream(null, { fd: typeof fd === 'object' ? fd.fd : fd, autoClose: false, start: offset, end: offset + length - 1 });
    input.on('error', err => this.destroy(err)); this.once('close', () => input.destroy()); input.pipe(this);
  }
  respondWithFile(path, headers = {}, options = {}) {
    const fs = require('fs'); fs.open(path, 'r', (err, fd) => {
      if (err) { if (options.onError) options.onError(err); else this.destroy(err); return; }
      let closed = false; const close = () => { if (!closed) { closed = true; fs.close(fd, () => {}); } };
      this.once('close', close); this.once('finish', close);
      if (this.destroyed) { close(); return; }
      try { if (this.respondWithFD(fd, headers, { ...options, onError: failure => { close(); if (options.onError) options.onError(failure); else this.destroy(failure); } }) === false) close(); } catch (failure) { close(); this.destroy(failure); }
    });
  }
}
class Http2Session extends EventEmitter {
  constructor(socket, server, options = {}, authority) {
    super(); this.type = server ? 0 : 1; this._socket = socket; this._socketProxy = new Proxy(this, socketProxy); this.encrypted = !!socket.encrypted; this.alpnProtocol = this.encrypted ? socket.alpnProtocol : 'h2c';
    validateOptions(options, true);
    options = { ...options, remoteCustomSettings: options.remoteCustomSettings?.map(id => id >>> 0) };
    this.connecting = true; this.closed = false; this.destroyed = false; this._id = native('create', server ? 1 : 0, packOptions(options, server));
    this._streams = new Map(); this._pending = new Set(); this._headers = new Map(); this._settings = []; this._pings = []; this._pumping = false; this._blocked = false; this._authority = authority; this._options = options;
    this._customRemote = {}; this._customLocal = { ...options.settings?.customSettings }; this._origins = new Set(); this._receivedOrigins = [];
    this._goawayCode = 0; this._goawayLastStreamID = 0;
    this._onData = data => {
      if (this.destroyed) return;
      try { this._syncMemory(); const count = native('recv', this._id, data); if (count !== data.length) throw error('ERR_HTTP2_ERROR', 'HTTP/2 parser did not consume input'); this._pump(); }
      catch (err) {
        while (!this.destroyed) { const record = Buffer.from(native('poll', this._id)); if (!record.length) break; this._event(record); }
        if (!this.destroyed) this.destroy(err);
      }
    };
    socket.on('data', this._onData); socket.on('drain', () => { this._blocked = false; this._pump(); });
    socket.on('error', err => this.destroy(err)); socket.on('end', () => { if (!this.destroyed) this.destroy(this._streams.size ? error('ERR_HTTP2_SESSION_ERROR', 'Connection ended with active streams') : undefined); });
    socket.on('close', () => this.destroy()); socket.on('timeout', () => this.emit('timeout'));
    native('settings', this._id, packSettings(options.settings || {}, true)); this._settings.push({ callback: null, start: Date.now() });
    if (server && Array.isArray(options.origins)) this.origin(...options.origins);
    const connected = () => {
      if (this.destroyed || !this.connecting) return;
      if (this.encrypted && socket.alpnProtocol !== 'h2') { this.destroy(error('ERR_HTTP2_ERROR', 'HTTP/2 ALPN negotiation failed')); return; }
      this.alpnProtocol = this.encrypted ? 'h2' : 'h2c'; this.connecting = false; this.emit('connect', this, socket); this._pump();
      for (const stream of [...this._pending]) if (!stream.destroyed) stream._init();
    };
    if (server || (!socket.connecting && (!this.encrypted || socket._secureEstablished))) process.nextTick(connected);
    else socket.once(this.encrypted ? 'secureConnect' : 'connect', connected);
    socket.setNoDelay?.(true);
    // TLS listeners pause accepted sockets until a protocol takes ownership.
    socket.resume();
  }
  get socket() { return this.destroyed ? undefined : this._socketProxy; }
  get originSet() {
    if (!this.encrypted || this.destroyed) return undefined;
    if (!this._originsInitialized) {
      this._originsInitialized = true;
      let host = this._socket.servername || this._socket.remoteAddress;
      if (host?.includes(':') && !host.startsWith('[')) host = '[' + host + ']';
      const authority = this._authority || (host && host + ':' + this._socket.remotePort);
      if (authority) this._origins.add(new URL('https://' + authority).origin);
    }
    return [...this._origins];
  }
  get pendingSettingsAck() { return !!this._settings.length; }
  get goawayCode() { return this._goawayCode; }
  get goawayLastStreamID() { return this._goawayLastStreamID; }
  get localSettings() { if (this.destroyed) return {}; const settings = readSettings(this._id, false); if (Object.keys(this._customLocal).length) settings.customSettings = { ...this._customLocal }; return settings; }
  get remoteSettings() { if (this.destroyed) return {}; const settings = readSettings(this._id, true); if (Object.keys(this._customRemote).length) settings.customSettings = { ...this._customRemote }; return settings; }
  get state() { if (this.connecting || this.destroyed) return {}; return { effectiveLocalWindowSize: native('effectiveLocalWindow', this._id), effectiveRecvDataLength: native('effectiveRecvLength', this._id), localWindowSize: native('localWindow', this._id, 0), remoteWindowSize: native('remoteWindow', this._id, 0), lastProcStreamID: native('lastStream', this._id), nextStreamID: native('nextStream', this._id), outboundQueueSize: native('outboundSize', this._id), deflateDynamicTableSize: native('deflateSize', this._id), inflateDynamicTableSize: native('inflateSize', this._id) }; }
  _call(op, ...args) { if (this.destroyed) throw error('ERR_HTTP2_INVALID_SESSION', 'Session has been destroyed'); const result = native(op, this._id, ...args); this._pump(); return result; }
  _syncMemory() { native('socketMemory', this._id, this._socket.writableLength || 0); }
  _pump() {
    if (this.connecting || this.destroyed || this._pumping) return;
    this._pumping = true;
    try {
      let progress = true;
      while (progress && !this.destroyed) {
        progress = false;
        this._syncMemory();
        if (!this._blocked && !this._ending) { const wire = Buffer.from(native('send', this._id)); if (wire.length) { progress = true; this._blocked = !this._socket.write(wire); } }
        while (!this.destroyed) { const record = Buffer.from(native('poll', this._id)); if (!record.length) break; progress = true; this._event(record); }
      }
    } catch (err) { this.destroy(err); }
    finally { this._pumping = false; }
    // nghttp2 can terminate internally (for example, on a reset flood) without
    // returning a receive error. Wait until its final frames reach the socket,
    // including a backpressured write, before committing FIN in destroy().
    if (!this.destroyed && !this._blocked && !native('wantIO', this._id)) { this.destroy(); return; }
    this._maybeClose();
  }
  _event(record) {
    const kind = record.readInt32LE(0), id = record.readInt32LE(4), flags = record.readInt32LE(8), a = record.readInt32LE(12), b = record.readInt32LE(16), payload = record.subarray(24);
    if (kind === 10) { this.destroy(error('ERR_HTTP2_TOO_MANY_INVALID_FRAMES', 'Too many invalid HTTP/2 frames'), 2); return; }
    if (kind === 11) { this.emit('altsvc', payload.subarray(a).toString('latin1'), payload.subarray(0, a).toString('latin1'), id); return; }
    if (kind === 12) { this._receivedOrigins.push(payload.toString('latin1')); return; }
    if (kind === 13) {
      const origins = this._receivedOrigins; this._receivedOrigins = [];
      if (this.encrypted) {
        this.originSet;
        for (const origin of origins) {
          if (this._origins.size >= (this._options.maxOriginSetSize ?? 128)) { this.destroy(error('ERR_HTTP2_TOO_MANY_ORIGINS', 'Too many origins in the HTTP/2 session')); return; }
          this._origins.add(origin);
        }
        this.emit('origin', origins);
      }
      return;
    }
    let stream = this._streams.get(id);
    if (kind === 1) { let h = this._headers.get(id); if (!h) { h = { headers: Object.create(null), raw: [] }; this._headers.set(id, h); } addHeader(h.headers, h.raw, payload.subarray(0, a).toString(), payload.subarray(a).toString(), flags & 1); return; }
    if (kind === 3) { if (stream) stream._receive(payload); return; }
    if (kind === 4) {
      this._headers.delete(id); if (!stream) return; this._streams.delete(id); stream._nativeClosed = true; stream.closed = true; stream.rstCode = a;
      if (!stream._remoteEnded) { stream._remoteEnded = true; if (a) stream.emit('aborted'); stream.push(null); }
      if (a && a !== 8) stream.destroy(error('ERR_HTTP2_STREAM_ERROR', 'Stream closed with error code ' + a));
      else if (a === 8) stream.destroy();
      else { if (!stream.writableEnded) stream.end(); }
      return;
    }
    if (kind === 6) { stream?._writeCallbacks.shift()?.(); return; }
    if (kind === 7) { if (stream) { stream._wantTrailers = true; if (!stream.emit('wantTrailers')) stream.sendTrailers({}); } return; }
    if (kind === 8) {
      this._goawayCode = a >>> 0; this._goawayLastStreamID = id;
      this.emit('goaway', this._goawayCode, id, payload);
      if (a) { this.destroy(error('ERR_HTTP2_SESSION_ERROR', 'Session closed with error code ' + this._goawayCode), 0); return; }
      for (const [streamID, pending] of this._streams) if (streamID > id && (streamID & 1) === (this.type === 1 ? 1 : 0)) pending.destroy(error('ERR_HTTP2_GOAWAY_SESSION', 'Stream was not processed before GOAWAY'));
      this.close(); return;
    }
    if (kind === 9) {
      if (stream) {
        const code = a === -522 ? 6 : 2;
        stream.emit('frameError', b, code, id); stream.rstCode = code; stream.closed = true;
        stream.destroy(error('ERR_HTTP2_STREAM_ERROR', 'Stream closed with error code ' + code));
      } else this.emit('frameError', b, a, id);
      return;
    }
    if (kind === 5) return;
    if (kind !== 2) return;
    if (a === 4) {
      if (flags & 1) { const pending = this._settings.shift(); const settings = this.localSettings; pending?.callback?.(null, settings, Date.now() - pending.start); this.emit('localSettings', settings); }
      else { for (let offset = 0; offset + 8 <= payload.length; offset += 8) { const key = payload.readInt32LE(offset); if (this._options.remoteCustomSettings?.includes(key)) this._customRemote[key] = payload.readUInt32LE(offset + 4); } this.emit('remoteSettings', this.remoteSettings); }
      return;
    }
    if (a === 6) {
      if (flags & 1) { const index = this._pings.findIndex(p => p.payload.equals(payload)); if (index !== -1) { const pending = this._pings.splice(index, 1)[0]; clearTimeout(pending.timer); pending.callback(null, Date.now() - pending.start, payload); } }
      else this.emit('ping', payload); return;
    }
    if (a === 5) {
      const h = this._headers.get(b); this._headers.delete(b); if (!h) return;
      const pushed = new ClientHttp2Stream(this, b, { endStream: true }); pushed._pushed = true; pushed._localEnded = true; pushed.end(); pushed._requestHeaders = h.headers;
      this.emit('stream', pushed, h.headers, flags, h.raw); return;
    }
    if (a === 1) {
      const h = this._headers.get(id) || { headers: {}, raw: [] }; this._headers.delete(id);
      if (!stream && this.type === 0) { stream = new ServerHttp2Stream(this, id); stream._requestHeaders = h.headers; stream._head = h.headers[':method'] === 'HEAD'; this.emit('stream', stream, h.headers, flags, h.raw); }
      else if (stream) {
        if (h.headers[':status'] === 421 && this.encrypted) { this.originSet; const headers = stream.sentHeaders || stream._requestHeaders; if (headers?.[':authority']) this._origins.delete(new URL((headers[':scheme'] || 'https') + '://' + headers[':authority']).origin); }
        if (h.headers[':status'] !== undefined) { const informational = h.headers[':status'] < 200; if (informational) { stream.emit('headers', h.headers, flags, h.raw); if (h.headers[':status'] === 100) stream.emit('continue'); } else { stream._responseHeaders = h.headers; stream.emit(stream._pushed ? 'push' : 'response', h.headers, flags, h.raw); } }
        else stream.emit('trailers', h.headers, flags, h.raw);
      }
    }
    if ((a === 0 || a === 1) && flags & 1 && stream && !stream._remoteEnded) { stream._remoteEnded = true; stream.push(null); }
  }
  request(headers = {}, options = {}) {
    if (this.type !== 1) throw error('ERR_HTTP2_INVALID_SESSION', 'Only client sessions can initiate requests');
    const requestError = this.destroyed ? error('ERR_HTTP2_INVALID_SESSION', 'Session has been destroyed') : this.closed ? error('ERR_HTTP2_GOAWAY_SESSION', 'Session is closed') : undefined;
    if (!headers || typeof headers !== 'object') throw error('ERR_INVALID_ARG_TYPE', 'headers must be an object or array', TypeError);
    const rawHeaders = Array.isArray(headers) ? headers : undefined;
    if (rawHeaders) {
      if (rawHeaders.length % 2) throw error('ERR_INVALID_ARG_VALUE', 'Raw headers must contain name/value pairs', TypeError);
      headers = Object.create(null);
      for (let i = 0; i < rawHeaders.length; i += 2) {
        const name = rawHeaders[i];
        if (typeof name !== 'string') throw error('ERR_INVALID_ARG_TYPE', 'header name must be a string', TypeError);
        if (headers[name] === undefined) headers[name] = rawHeaders[i + 1];
        else headers[name] = [].concat(headers[name], rawHeaders[i + 1]);
      }
    }
    const h = { ':method': 'GET', ...headers };
    const connect = h[':method'] === 'CONNECT' && !h[':protocol'];
    if (h[':authority'] === undefined) h[':authority'] = this._authority;
    if (!connect) { if (h[':scheme'] === undefined) h[':scheme'] = this.encrypted ? 'https' : 'http'; if (h[':path'] === undefined) h[':path'] = '/'; }
    const packed = encodeHeaders(h);
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw error('ERR_INVALID_ARG_TYPE', 'options must be an object', TypeError);
    if (options.endStream !== undefined && typeof options.endStream !== 'boolean') throw error('ERR_INVALID_ARG_TYPE', 'options.endStream must be a boolean', TypeError);
    if (options.signal !== undefined && (!options.signal || typeof options.signal.aborted !== 'boolean' || typeof options.signal.addEventListener !== 'function')) throw error('ERR_INVALID_ARG_TYPE', 'options.signal must be an AbortSignal', TypeError);
    const end = options.endStream === undefined ? ['GET', 'HEAD', 'DELETE'].includes(h[':method']) : !!options.endStream;
    const stream = new ClientHttp2Stream(this, undefined, { ...options, endStream: end }); stream.sentHeaders = rawHeaders ? undefined : h;
    if (requestError) { process.nextTick(() => stream.destroy(requestError)); return stream; }
    stream._init = () => {
      this._pending.delete(stream);
      if (stream.destroyed || this.destroyed) return;
      try {
        this._syncMemory();
        stream.id = native('headers', this._id, -1, packed, end ? 1 : 0);
        stream.pending = false; this._streams.set(stream.id, stream);
        if (!end) stream._ensureBody();
        process.nextTick(() => { if (!stream.destroyed) stream.emit('ready'); }); this._pump();
      } catch (err) { stream._nativeClosed = true; stream.destroy(err.errno === -901 ? error('ERR_HTTP2_OUT_OF_MEMORY', 'HTTP/2 session memory limit exceeded') : err); }
    };
    if (end) stream.end();
    if (options.signal) { if (options.signal.aborted) stream.destroy(error('ABORT_ERR', 'The operation was aborted')); else { const abort = () => stream.destroy(error('ABORT_ERR', 'The operation was aborted')); options.signal.addEventListener('abort', abort, { once: true }); stream.once('close', () => options.signal.removeEventListener('abort', abort)); } }
    if (!this.connecting) stream._init(); return stream;
  }
  settings(settings, callback) {
    if (this.destroyed) throw error('ERR_HTTP2_INVALID_SESSION', 'Session is destroyed');
    const packed = packSettings(settings, true);
    if (callback !== undefined && typeof callback !== 'function') throw error('ERR_INVALID_ARG_TYPE', 'callback must be a function', TypeError);
    if (this._settings.length >= (this._options.maxOutstandingSettings ?? 10)) {
      if (callback) process.nextTick(callback, error('ERR_HTTP2_SETTINGS_CANCEL', 'HTTP2 settings cancelled'));
      this.destroy(error('ERR_HTTP2_MAX_PENDING_SETTINGS_ACK', 'Maximum number of pending settings acknowledgements'));
      return;
    }
    native('settings', this._id, packed); this._customLocal = { ...this._customLocal, ...settings.customSettings }; this._settings.push({ callback, start: Date.now() }); this._pump();
  }
  ping(payload, callback) {
    if (this.destroyed) throw error('ERR_HTTP2_INVALID_SESSION', 'Session has been destroyed');
    if (typeof payload === 'function') { callback = payload; payload = undefined; }
    if (payload) { if (!ArrayBuffer.isView(payload)) throw error('ERR_INVALID_ARG_TYPE', 'payload must be a Buffer, TypedArray, or DataView', TypeError); if (payload.byteLength !== 8) throw error('ERR_HTTP2_PING_LENGTH', 'PING payload must be 8 bytes', RangeError); }
    if (typeof callback !== 'function') throw error('ERR_INVALID_ARG_TYPE', 'callback must be a function', TypeError);
    if (this.connecting || this.closed) { process.nextTick(callback, error('ERR_HTTP2_PING_CANCEL', 'HTTP2 ping cancelled')); return; }
    if (this._pings.length >= (this._options.maxOutstandingPings ?? 10)) { process.nextTick(callback, error('ERR_HTTP2_PING_CANCEL', 'HTTP2 ping cancelled')); return false; }
    if (!payload) { payload = Buffer.alloc(8); payload.writeDoubleLE(Date.now(), 0); }
    else payload = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
    const pending = { payload: Buffer.from(payload), callback, start: Date.now(), timer: null }; this._pings.push(pending);
    native('ping', this._id, payload); this._pump(); return true;
  }
  goaway(code = 0, lastStreamID, opaqueData) { integer(code, 'code'); if (lastStreamID === undefined) lastStreamID = native('lastStream', this._id); integer(lastStreamID, 'lastStreamID', 0, 0x7fffffff); this._call('goaway', lastStreamID, code, opaqueData === undefined ? Buffer.alloc(0) : Buffer.from(opaqueData)); }
  close(callback) { if (callback) this.once('close', callback); if (this.closed || this.destroyed) return; this.closed = true; this.goaway(); this._maybeClose(); }
  _maybeClose() {
    // Stream/GOAWAY callbacks can close the session while _pump is polling.
    // Commit the socket FIN only after that pump has drained all final frames.
    if (this.closed && !this.destroyed && !this._pumping && !this._streams.size && !this._pending.size && !this._blocked && !this._ending) { this._ending = true; this._socket.end(); }
  }
  destroy(err, code) {
    if (this.destroyed) return;
    if (typeof err === 'number') { code = err; err = code ? error('ERR_HTTP2_SESSION_ERROR', 'Session closed with error code ' + code) : undefined; }
    if (code === undefined) code = err ? 2 : 0;
    const socket = this._socket, wasConnecting = this.connecting;
    this.destroyed = true; this.closed = true; this.connecting = false;
    socket.removeListener('data', this._onData);
    socket.setTimeout(0);
    // Fatal receive failures use INTERNAL_ERROR unless the caller supplied a
    // code. Termination suppresses unsent stream work and queues final GOAWAY.
    // Transfer every final frame to the socket before releasing native state.
    if (!wasConnecting && !this._ending && !socket.destroyed && !socket.writableEnded) {
      try {
        native('terminate', this._id, code);
        while (!socket.destroyed && !socket.writableEnded) { const data = Buffer.from(native('send', this._id)); if (!data.length) break; socket.write(data); }
      } catch {}
    }
    native('release', this._id); this._id = 0;
    for (const stream of this._pending) { stream._nativeClosed = true; stream.destroy(err || error('ERR_HTTP2_STREAM_CANCEL', 'The pending stream has been canceled')); } this._pending.clear();
    for (const stream of this._streams.values()) { stream._nativeClosed = true; stream.destroy(err); } this._streams.clear(); this._headers.clear();
    const cancelled = error('ERR_HTTP2_SETTINGS_CANCEL', 'HTTP2 settings cancelled');
    for (const pending of this._settings.splice(0)) if (pending.callback) process.nextTick(pending.callback, cancelled);
    for (const pending of this._pings.splice(0)) { clearTimeout(pending.timer); process.nextTick(pending.callback, error('ERR_HTTP2_PING_CANCEL', 'HTTP2 ping cancelled')); }
    const completed = () => { process.nextTick(() => { if (err) this.emit('error', err); this.emit('close'); }); };
    if (socket.destroyed) { completed(); return; }
    socket.once('close', completed);
    const finish = () => { if (!socket.destroyed) socket.destroy(); };
    // end() waits for pending writes, including GOAWAY, to reach the transport.
    // Never queue a frame or another end after the graceful-close FIN.
    if (wasConnecting || socket.writableFinished) finish();
    else if (socket.writableEnded || this._ending) socket.once('finish', finish);
    else { this._ending = true; socket.end(finish); }
  }
  setTimeout(msecs, callback) { this._socket.setTimeout(msecs); if (callback) this.once('timeout', callback); return this; }
  setLocalWindowSize(size) { integer(size, 'windowSize', 0, 0x7fffffff); this._call('window', 0, size); }
  setNextStreamID(id) { if (this.destroyed) throw error('ERR_HTTP2_INVALID_SESSION', 'Session has been destroyed'); if (typeof id !== 'number') throw error('ERR_INVALID_ARG_TYPE', 'id must be a number', TypeError); if (id <= 0 || id > 0x7fffffff) throw error('ERR_OUT_OF_RANGE', 'id must be > 0 and <= 2147483647', RangeError); native('setNextStream', this._id, id >>> 0); }
  ref() { this._socket.ref(); return this; }
  unref() { this._socket.unref(); return this; }
}
class ServerHttp2Session extends Http2Session {
  altsvc(alt, originOrStream) {
    if (this.destroyed) throw error('ERR_HTTP2_INVALID_SESSION', 'Session has been destroyed');
    let stream = 0, origin = '';
    if (typeof originOrStream === 'number') stream = integer(originOrStream, 'originOrStream', 1);
    else if (typeof originOrStream === 'string') origin = new URL(originOrStream).origin;
    else if (originOrStream !== undefined) { origin = originOrStream?.origin; if (typeof origin !== 'string') throw error('ERR_INVALID_ARG_TYPE', 'originOrStream must be a string, number, URL, or object', TypeError); }
    if (origin === 'null' || (!origin && originOrStream !== undefined && !stream)) throw error('ERR_HTTP2_ALTSVC_INVALID_ORIGIN', 'Invalid origin');
    if (typeof alt !== 'string') throw error('ERR_INVALID_ARG_TYPE', 'alt must be a string', TypeError);
    if (/[^\x09\x20-\x7e\x80-\xff]/.test(alt)) throw error('ERR_INVALID_CHAR', 'Invalid character in alt', TypeError);
    if (alt.length + origin.length > 16382) throw error('ERR_HTTP2_ALTSVC_LENGTH', 'ALTSVC payload is too large');
    this._call('altsvc', stream, Buffer.from(origin, 'latin1'), Buffer.from(alt, 'latin1'));
  }
  origin(...origins) {
    if (this.destroyed) throw error('ERR_HTTP2_INVALID_SESSION', 'Session has been destroyed');
    if (!origins.length) return;
    const parts = []; let length = 0;
    for (let origin of origins) {
      origin = typeof origin === 'string' ? new URL(origin).origin : origin?.origin;
      if (typeof origin !== 'string') throw error('ERR_INVALID_ARG_TYPE', 'origin must be a string', TypeError);
      if (origin === 'null') throw error('ERR_HTTP2_INVALID_ORIGIN', 'Invalid origin');
      length += origin.length; const value = Buffer.from(origin, 'latin1'), size = Buffer.alloc(4); size.writeUInt32LE(value.length); parts.push(size, value);
    }
    if (length > 16382) throw error('ERR_HTTP2_ORIGIN_LENGTH', 'ORIGIN payload is too large');
    this._call('origin', Buffer.concat(parts));
  }
}
module.exports = { Http2Session, ServerHttp2Session, Http2Stream, ClientHttp2Stream, ServerHttp2Stream };
