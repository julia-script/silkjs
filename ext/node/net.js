'use strict';

const { Duplex } = require('stream');
const { EventEmitter } = require('events');
const { Buffer } = require('buffer');
const { Transport, error: nativeError, native } = require('internal/net/transport');

let defaultAutoSelectFamily = true;
let defaultAutoSelectFamilyAttemptTimeout = 250;

function fail(code, message, Type = Error) { return Object.assign(new Type(message), { code }); }
function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max)
    throw fail('ERR_OUT_OF_RANGE', `The value of "${name}" is out of range. It must be >= ${min} and <= ${max}. Received ${value}`, RangeError);
  return value;
}
function portNumber(value, name = 'port') {
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && value.trim() === ''))
    throw fail('ERR_SOCKET_BAD_PORT', `${name} should be >= 0 and < 65536. Received ${value}`, RangeError);
  return integer(Number(value), name, 0, 65535);
}
function callback(value) {
  if (value !== undefined && typeof value !== 'function') throw fail('ERR_INVALID_ARG_TYPE', 'Callback must be a function', TypeError);
}
function isIP(input) { return typeof input === 'string' ? native('isIP', [input]) : 0; }
function isIPv4(input) { return isIP(input) === 4; }
function isIPv6(input) { return isIP(input) === 6; }
function normalizeArgs(args) {
  if (Array.isArray(args[0])) return args[0];
  let options;
  const first = args[0];
  if (first !== null && typeof first === 'object') options = { ...first };
  else if (typeof first === 'string' && (first.trim() === '' || !Number.isFinite(Number(first)))) options = { path: first };
  else {
    options = { port: first };
    if (typeof args[1] === 'string') options.host = args[1];
  }
  const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : undefined;
  return [options, cb];
}
function abortError(signal) {
  const err = fail('ABORT_ERR', 'The operation was aborted');
  err.name = 'AbortError';
  err.cause = signal.reason;
  return err;
}
function attachAbort(target, signal, abort) {
  if (signal === undefined) return;
  if (signal === null || typeof signal.addEventListener !== 'function' || typeof signal.aborted !== 'boolean')
    throw fail('ERR_INVALID_ARG_TYPE', 'The "signal" argument must be an AbortSignal', TypeError);
  target._removeAbort?.();
  const listener = () => abort(abortError(signal));
  target._removeAbort = () => { signal.removeEventListener('abort', listener); target._removeAbort = null; };
  if (signal.aborted) process.nextTick(listener);
  else signal.addEventListener('abort', listener, { once: true });
}

function Socket(options) {
  if (!(this instanceof Socket)) return new Socket(options);
  if (typeof options === 'number') options = { fd: options };
  options ||= {};
  if (typeof options !== 'object') throw fail('ERR_INVALID_ARG_TYPE', 'Socket options must be an object', TypeError);
  Duplex.call(this, { ...options, signal: undefined, objectMode: false, readableObjectMode: false, writableObjectMode: false,
    allowHalfOpen: !!options.allowHalfOpen, autoDestroy: true, emitClose: false, decodeStrings: true });
  this.connecting = false;
  this._transport = null;
  this._connected = false;
  this._pendingWrite = null;
  this._destroyCallback = null;
  this._hadError = false;
  this._reset = false;
  this._readPaused = false;
  this._unrefed = false;
  this._bytesRead = 0;
  this._readEOF = false;
  this._onreadPending = null;
  this._onreadQueue = null;
  this._bytesWritten = 0;
  this._timeout = null;
  this.timeout = 0;
  this._generation = 0;
  this._connectTimer = null;
  this._attemptNext = null;
  this._noDelay = options.noDelay;
  this._keepAlive = options.keepAlive;
  this._keepAliveDelay = options.keepAliveInitialDelay || 0;
  this._onread = options.onread;
  this._localAddress = undefined;
  this._remoteAddress = undefined;
  this.server = null;
  if (options.fd !== undefined) {
    integer(options.fd, 'fd', 0, 0x7fffffff);
    const kind = native('guessHandleType', [options.fd]);
    if (kind !== 1 && kind !== 2) throw nativeError(kind < 0 ? kind : -22, 'open');
    const transport = new Transport(kind, (...args) => this._onNative(...args));
    const status = transport.call('open', options.fd);
    if (status < 0) { transport.close(); throw nativeError(status, 'open'); }
    this._attachTransport(transport);
    this._connected = true;
    this._cacheAddresses();
    if (!options.manualStart) process.nextTick(() => { if (!this.destroyed && options.readable !== false) this._read(); });
  }
  attachAbort(this, options.signal, err => this.destroy(err));
}
Object.setPrototypeOf(Socket.prototype, Duplex.prototype);
Object.setPrototypeOf(Socket, Duplex);

Socket.prototype._attachTransport = function(transport) {
  this._transport = transport;
  transport.owner = this;
  transport.onEvent = (...args) => this._onNative(...args);
  if (this._unrefed) transport.unref();
};
Socket.prototype._cacheAddresses = function() {
  if (!this._transport) return;
  this._localAddress = this._transport.address(false);
  this._remoteAddress = this._transport.address(true);
};
Socket.prototype._refreshTimeout = function() {
  if (!this.timeout || this.destroyed) return;
  if (this._timeout) { this._timeout.refresh(); return; }
  this._timeout = setTimeout(() => {
    this._timeout = null;
    if (!this.destroyed) this.emit('timeout');
  }, this.timeout);
  this._timeout.unref?.();
};
Socket.prototype._onNative = function(type, status, payload) {
  if (type === 6) {
    this._connected = false;
    const done = this._destroyCallback;
    this._destroyCallback = null;
    this._transport = null;
    if (done) done();
    else if (!this.destroyed) this.destroy();
    return;
  }
  if (this.destroyed) return;
  if (type === 3) {
    if (status < 0) { this._connectionFailed(nativeError(status, 'connect', this._connectAddress, this._connectPort)); return; }
    this.connecting = false;
    this._connected = true;
    this._cacheAddresses();
    if (this._noDelay !== undefined) this.setNoDelay(this._noDelay);
    clearTimeout(this._connectTimer);
    this._connectTimer = null;
    this._attemptNext = null;
    if (this._keepAlive !== undefined) this.setKeepAlive(this._keepAlive, this._keepAliveDelay);
    this._refreshTimeout();
    this.emit('connect');
    if (this.destroyed) return;
    this.emit('ready');
    const pending = this._pendingWrite;
    this._pendingWrite = null;
    if (pending) pending();
    if (!this._readPaused && !this.destroyed) this._read();
    return;
  }
  if (type === 1) {
    if (status >= 0 && payload?.byteLength) {
      this._bytesRead += payload.byteLength;
      this._refreshTimeout();
    }
    const consumer = this._streamConsumers?.[this._streamConsumers.length - 1];
    if (consumer) { consumer.read(status, payload); return; }
    if (status === -4095) {
      this._readEOF = true;
      // Match Node's onStreamRead: read(0) schedules end for an empty,
      // unconsumed socket without consuming any buffered application data.
      if (!this._onreadPending) { this.push(null); this.read(0); }
      return;
    }
    if (status < 0) { this.destroy(nativeError(status, 'read')); return; }
    if (!payload || !payload.byteLength) return;
    const chunk = Buffer.from(payload);
    if (this._onread && typeof this._onread.callback === 'function') {
      if (this._onreadPending) (this._onreadQueue ||= []).push(chunk);
      else this._onreadPending = chunk;
      this._deliverOnread();
    } else if (!this.push(chunk) && this._transport) this._transport.readStop();
  }
};
Socket.prototype._deliverOnread = function() {
  while (this._onreadPending?.length && !this._readPaused && !this.destroyed) {
    const destination = typeof this._onread.buffer === 'function' ? this._onread.buffer() : this._onread.buffer;
    if (!(destination instanceof Uint8Array) || destination.byteLength === 0) {
      this.destroy(fail('ERR_INVALID_ARG_VALUE', 'onread.buffer must provide a nonempty Uint8Array')); return;
    }
    const chunk = this._onreadPending;
    const count = Math.min(destination.byteLength, chunk.length);
    destination.set(chunk.subarray(0, count));
    this._onreadPending = count < chunk.length ? chunk.subarray(count) : this._onreadQueue?.shift() || null;
    if (this._onread.callback.call(this, count, destination) === false) this.pause();
  }
  if (this._readEOF && !this._onreadPending && !this.destroyed) { this.push(null); this.read(0); }
};
Socket.prototype._read = function() {
  if (!this._connected || this.destroyed || this._readPaused || this.readableEnded) return;
  if (this._onreadPending) {
    this._deliverOnread();
    if (this._readPaused || this.destroyed) return;
  }
  if (this._readEOF) return;
  const status = this._transport.readStart();
  if (status < 0) this.destroy(nativeError(status, 'read'));
};
Socket.prototype.pause = function() {
  this._readPaused = true;
  this._transport?.readStop();
  return Duplex.prototype.pause.call(this);
};
Socket.prototype.resume = function() {
  this._readPaused = false;
  const result = Duplex.prototype.resume.call(this);
  this._read();
  return result;
};
Socket.prototype._send = function(chunks, cb, vector) {
  if (this.connecting) { this._pendingWrite = () => this._send(chunks, cb, vector); return; }
  if (!this._connected || !this._transport) { cb(fail('ERR_SOCKET_CLOSED', 'Socket is closed')); return; }
  if (vector) for (const entry of chunks) this._bytesWritten += entry.chunk.length;
  else this._bytesWritten += chunks.length;
  this._refreshTimeout();
  const done = err => { this._refreshTimeout(); cb(err); };
  if (vector) this._transport.writev(chunks, done);
  else this._transport.write(chunks, done);
};
Socket.prototype._write = function(chunk, encoding, cb) { this._send(chunk, cb, false); };
Socket.prototype._writev = function(chunks, cb) { this._send(chunks, cb, true); };
Socket.prototype._final = function(cb) {
  if (this.connecting) { this._pendingWrite = () => this._final(cb); return; }
  if (!this._transport || !this._connected) { cb(); return; }
  this._transport.shutdown(cb);
};
Socket.prototype._destroy = function(err, cb) {
  ++this._generation;
  this._hadError ||= !!err;
  this.connecting = false;
  this._connected = false;
  clearTimeout(this._connectTimer);
  this._connectTimer = null;
  this._attemptNext = null;
  this._onreadPending = null;
  this._onreadQueue = null;
  clearTimeout(this._timeout);
  this._timeout = null;
  this._removeAbort?.();
  const pending = this._pendingWrite;
  this._pendingWrite = null;
  if (pending) pending();
  const done = () => {
    cb(err);
    process.nextTick(() => this.emit('close', this._hadError));
  };
  if (!this._transport || this._transport.closed) { this._transport = null; done(); return; }
  this._destroyCallback = done;
  const status = this._transport.close(this._reset);
  if (status < 0) {
    err ||= nativeError(status, this._reset ? 'reset' : 'close');
    this._hadError = true;
    this._transport.close();
  }
};
Socket.prototype._connectionFailed = function(err) {
  clearTimeout(this._connectTimer);
  this._connectTimer = null;
  if (this._attemptNext) this._attemptNext(err);
  else this.destroy(err);
};
Socket.prototype.connect = function(...args) {
  const [options, cb] = normalizeArgs(args);
  if (this.connecting || this._connected) throw fail('ERR_SOCKET_IS_CONNECTED', 'Socket is already connected');
  if (this._transport?.closing) throw fail('ERR_SOCKET_CLOSED', 'Socket is still closing');
  if (options.path === undefined && options.port === undefined) throw fail('ERR_MISSING_ARGS', 'The "options" or "port" or "path" argument must be specified');
  if (options.path !== undefined && typeof options.path !== 'string') throw fail('ERR_INVALID_ARG_TYPE', 'The "path" argument must be a string', TypeError);
  const port = options.path === undefined ? portNumber(options.port) : undefined;
  if (options.localPort !== undefined) portNumber(options.localPort, 'localPort');
  if (options.localAddress !== undefined && !isIP(options.localAddress)) throw fail('ERR_INVALID_IP_ADDRESS', `Invalid IP address: ${options.localAddress}`, TypeError);
  if (options.lookup !== undefined && typeof options.lookup !== 'function') throw fail('ERR_INVALID_ARG_TYPE', 'The "lookup" option must be a function', TypeError);
  if (options.host !== undefined && typeof options.host !== 'string') throw fail('ERR_INVALID_ARG_TYPE', 'The "host" argument must be a string', TypeError);
  if (options.family !== undefined && options.family !== 0 && options.family !== 4 && options.family !== 6) throw fail('ERR_INVALID_ARG_VALUE', 'The "family" option must be 0, 4, or 6', TypeError);
  if (options.autoSelectFamily !== undefined && typeof options.autoSelectFamily !== 'boolean') throw fail('ERR_INVALID_ARG_TYPE', 'The "autoSelectFamily" option must be a boolean', TypeError);
  const attemptTimeout = options.autoSelectFamilyAttemptTimeout === undefined ? defaultAutoSelectFamilyAttemptTimeout :
    Math.max(10, integer(options.autoSelectFamilyAttemptTimeout, 'autoSelectFamilyAttemptTimeout', 1, 0x7fffffff));
  if (this.destroyed) { this._undestroy(); this._hadError = false; this._reset = false; }
  if (cb) this.once('connect', cb);
  this._bytesRead = 0;
  this._readEOF = false;
  this._bytesWritten = 0;
  this._localAddress = undefined;
  this._remoteAddress = undefined;
  this._connectPort = port;
  this._noDelay = options.noDelay ?? this._noDelay;
  this._keepAlive = options.keepAlive ?? this._keepAlive;
  this._keepAliveDelay = options.keepAliveInitialDelay ?? this._keepAliveDelay;
  this.connecting = true;
  const generation = ++this._generation;
  attachAbort(this, options.signal, err => this.destroy(err));
  if (options.timeout !== undefined) this.setTimeout(options.timeout);
  this._refreshTimeout();
  const start = (address, family) => {
    if (this.destroyed || generation !== this._generation) return;
    this._connectAddress = address;
    try {
      this._attachTransport(new Transport(options.path === undefined ? 1 : 2, (...event) => this._onNative(...event)));
      if (options.localAddress !== undefined || options.localPort !== undefined) {
        const local = options.localAddress || (family === 6 ? '::' : '0.0.0.0');
        const status = this._transport.call('bind', local, Number(options.localPort || 0), 0);
        if (status < 0) { this.destroy(nativeError(status, 'bind', local, options.localPort)); return; }
      }
      if (options.path === undefined) this.emit('connectionAttempt', address, port, family);
      if (this.destroyed) return;
      const status = this._transport.call('connect', address, port || 0);
      if (status < 0) this._connectionFailed(nativeError(status, 'connect', address, port));
    } catch (err) { this.destroy(err); }
  };
  if (options.path !== undefined) process.nextTick(start, options.path, 0);
  else {
    const host = options.host || 'localhost';
    if (typeof host !== 'string') throw fail('ERR_INVALID_ARG_TYPE', 'The "host" argument must be a string', TypeError);
    this._host = host;
    const family = isIP(host);
    if (family) process.nextTick(start, host, family);
    else {
      const lookup = options.lookup || require('dns').lookup;
      const auto = (options.autoSelectFamily ?? defaultAutoSelectFamily) && !options.family && !options.localAddress;
      lookup(host, { family: options.family || 0, hints: options.hints || 0, all: auto }, (err, address, resolvedFamily) => {
        if (this.destroyed || generation !== this._generation) return;
        if (err) { this.emit('lookup', err, undefined, undefined, host); this.destroy(err); return; }
        const records = auto ? address : [{ address, family: resolvedFamily }];
        if (!Array.isArray(records) || records.length === 0 || records.some(record => !record || !isIP(record.address))) {
          this.destroy(fail('ERR_INVALID_IP_ADDRESS', 'Lookup did not return a valid IP address', TypeError)); return;
        }
        for (const record of records) this.emit('lookup', null, record.address, record.family, host);
        if (this.destroyed) return;
        if (!auto || records.length === 1) { start(records[0].address, records[0].family); return; }
        const firstFamily = records[0].family;
        const primary = records.filter(record => record.family === firstFamily);
        const secondary = records.filter(record => record.family !== firstFamily);
        const ordered = [];
        const seen = new Set();
        for (let i = 0; i < Math.max(primary.length, secondary.length); ++i) {
          for (const record of [primary[i], secondary[i]]) {
            if (record && !seen.has(record.address)) { ordered.push(record); seen.add(record.address); }
          }
        }
        this.autoSelectFamilyAttemptedAddresses = [];
        const errors = [];
        let index = 0;
        this._attemptNext = failure => {
          if (this.destroyed || generation !== this._generation) return;
          if (failure) {
            errors.push(failure);
            const previous = ordered[index - 1];
            this.emit('connectionAttemptFailed', previous.address, port, previous.family, failure);
            if (this.destroyed) return;
          }
          if (this._transport) {
            this._transport.onEvent = () => {};
            this._transport.close();
            this._transport = null;
          }
          if (index === ordered.length) {
            this._attemptNext = null;
            const aggregate = new AggregateError(errors, errors.map(error => error.message).join(', '));
            aggregate.code = errors[0]?.code;
            this.destroy(aggregate);
            return;
          }
          const record = ordered[index++];
          this.autoSelectFamilyAttemptedAddresses.push(`${record.address}:${port}`);
          // Install the deadline before submission: immediate connect failures can
          // synchronously advance to a new attempt and replace this timer.
          if (index < ordered.length) {
            this._connectTimer = setTimeout(() => {
              this._connectTimer = null;
              this.emit('connectionAttemptTimeout', record.address, port, record.family);
              const timeout = fail('ETIMEDOUT', `connect ETIMEDOUT ${record.address}:${port}`);
              timeout.syscall = 'connect';
              timeout.address = record.address;
              timeout.port = port;
              this._connectionFailed(timeout);
            }, attemptTimeout);
            if (this._unrefed) this._connectTimer.unref?.();
          }
          start(record.address, record.family);
        };
        this._attemptNext();
      });
    }
  }
  return this;
};
Socket.prototype.setTimeout = function(milliseconds, cb) {
  if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds) || milliseconds < 0)
    throw fail('ERR_OUT_OF_RANGE', 'Timeout must be a non-negative finite number', RangeError);
  callback(cb);
  clearTimeout(this._timeout);
  this._timeout = null;
  this.timeout = milliseconds;
  if (cb) { if (milliseconds === 0) this.removeListener('timeout', cb); else this.once('timeout', cb); }
  this._refreshTimeout();
  return this;
};
Socket.prototype.setNoDelay = function(enable = true) {
  this._noDelay = !!enable;
  if (this._transport?.kind === 1) {
    const status = this._transport.call('noDelay', this._noDelay);
    if (status < 0) this.destroy(nativeError(status, 'setsockopt'));
  }
  return this;
};
Socket.prototype.setKeepAlive = function(enable = false, initialDelay = 0) {
  const seconds = ~~(initialDelay / 1000);
  this._keepAlive = !!enable;
  this._keepAliveDelay = initialDelay;
  if (this._transport?.kind === 1) {
    // Like Node's TCPWrap caller, do not turn an optional socket tuning error
    // into connection destruction. libuv sets SO_KEEPALIVE before checking
    // idle: zero enables keepalive but leaves the kernel's timer defaults.
    this._transport.call('keepAlive', this._keepAlive, seconds);
  }
  return this;
};
Socket.prototype.ref = function() { this._unrefed = false; this._transport?.ref(); this._connectTimer?.ref?.(); return this; };
Socket.prototype.unref = function() { this._unrefed = true; this._transport?.unref(); this._connectTimer?.unref?.(); return this; };
Socket.prototype.address = function() { return this._transport?.address() || {}; };
Socket.prototype.destroySoon = function() {
  if (this.writableFinished) this.destroy();
  else { this.once('finish', () => this.destroy()); this.end(); }
  return this;
};
Socket.prototype.resetAndDestroy = function() {
  if (this._transport && this._transport.kind !== 1) throw fail('ERR_INVALID_HANDLE_TYPE', 'This handle type cannot be reset');
  if (this.connecting) { this.once('connect', () => this.resetAndDestroy()); return this; }
  this._reset = true;
  return this.destroy();
};
Object.defineProperties(Socket.prototype, {
  _handle: { get() { return this._transport; }, configurable: true },
  pending: { get() { return !this._transport || this.connecting; } },
  readyState: { get() { return this.connecting ? 'opening' : this.readable && this.writable ? 'open' : this.readable ? 'readOnly' : this.writable ? 'writeOnly' : 'closed'; } },
  bufferSize: { get() { return this._transport ? this.writableLength : undefined; } },
  bytesRead: { get() { return this._bytesRead; } },
  bytesWritten: { get() { return this._bytesWritten + this.writableLength - (this._writableState.writing && !this.connecting ? this._writableState.writelen : 0); } },
  localAddress: { get() { return this._localAddress?.address; } },
  localPort: { get() { return this._localAddress?.port; } },
  localFamily: { get() { return this._localAddress?.family; } },
  remoteAddress: { get() { return this._remoteAddress?.address; } },
  remotePort: { get() { return this._remoteAddress?.port; } },
  remoteFamily: { get() { return this._remoteAddress?.family; } }
});

function Server(options, listener) {
  if (!(this instanceof Server)) return new Server(options, listener);
  if (typeof options === 'function') { listener = options; options = {}; }
  options ||= {};
  if (typeof options !== 'object') throw fail('ERR_INVALID_ARG_TYPE', 'Server options must be an object', TypeError);
  callback(listener);
  EventEmitter.call(this);
  this.allowHalfOpen = !!options.allowHalfOpen;
  this.pauseOnConnect = !!options.pauseOnConnect;
  this._options = options;
  this._transport = null;
  this._connections = 0;
  this._listening = false;
  this._starting = false;
  this._closing = false;
  this._generation = 0;
  this._unrefed = false;
  this.maxConnections = undefined;
  this.dropMaxConnection = false;
  if (listener) this.on('connection', listener);
}
Object.setPrototypeOf(Server.prototype, EventEmitter.prototype);
Object.setPrototypeOf(Server, EventEmitter);
Server.prototype._onNative = function(type, status, id) {
  if (type === 6) { this._transport = null; this._emitCloseIfDrained(); return; }
  if (type !== 2) return;
  if (status < 0) { this.emit('error', nativeError(status, 'accept')); return; }
  const socket = new Socket({ ...this._options, allowHalfOpen: this.allowHalfOpen, signal: undefined });
  try { socket._attachTransport(new Transport(this._transport.kind, (...args) => socket._onNative(...args), id)); }
  catch (err) { this.emit('error', err); return; }
  socket._connected = true;
  socket._cacheAddresses();
  this._acceptSocket(socket);
};
Server.prototype._acceptSocket = function(socket) {
  socket.allowHalfOpen = this.allowHalfOpen;
  if (!this._listening || (this.maxConnections !== undefined && this._connections >= this.maxConnections)) {
    if (this._listening) this.emit('drop', {
      localAddress: socket.localAddress, localPort: socket.localPort, localFamily: socket.localFamily,
      remoteAddress: socket.remoteAddress, remotePort: socket.remotePort, remoteFamily: socket.remoteFamily
    });
    socket.destroy();
    return;
  }
  ++this._connections;
  socket.server = this;
  socket._server = this;
  socket.once('close', () => { --this._connections; this._emitCloseIfDrained(); });
  if (this._options.noDelay !== undefined) socket.setNoDelay(this._options.noDelay);
  if (this._options.keepAlive !== undefined) socket.setKeepAlive(this._options.keepAlive, this._options.keepAliveInitialDelay || 0);
  if (this.pauseOnConnect) socket.pause();
  this.emit('connection', socket);
  if (!this.pauseOnConnect && !socket.destroyed) socket._read();
};
Server.prototype.listen = function(...args) {
  if (this._transport || this._starting || this._closing) throw fail('ERR_SERVER_ALREADY_LISTEN', 'Listen method has been called more than once without closing');
  const [options, cb] = normalizeArgs(args);
  if (options.port === undefined && options.path === undefined && options.fd === undefined) {
    if (args.length === 0 || typeof args[0] === 'function') options.port = 0;
    else throw fail('ERR_INVALID_ARG_VALUE', 'Listen options must specify a port, path, or fd', TypeError);
  }
  let backlog = options.backlog;
  if (backlog === undefined && typeof args[0] !== 'object') {
    if (typeof args[1] === 'number') backlog = args[1];
    else if (typeof args[2] === 'number') backlog = args[2];
  }
  backlog = backlog === undefined ? 511 : integer(backlog, 'backlog', 0, 0x7fffffff);
  const port = options.path === undefined && options.fd === undefined ? portNumber(options.port) : 0;
  if (options.path !== undefined && typeof options.path !== 'string') throw fail('ERR_INVALID_ARG_TYPE', 'The "path" argument must be a string', TypeError);
  if (options.fd !== undefined) integer(options.fd, 'fd', 0, 0x7fffffff);
  if (cb) this.once('listening', cb);
  this._starting = true;
  const generation = ++this._generation;
  attachAbort(this, options.signal, () => this.close());
  const failed = err => {
    this._starting = false;
    this._removeAbort?.();
    const transport = this._transport;
    if (transport) transport.close();
    process.nextTick(() => this.emit('error', err));
  };
  const cluster = require('cluster');
  if (cluster.isWorker && !options.exclusive && !options.reusePort) {
    cluster._getServer(this, { ...options, port: options.path === undefined && options.fd === undefined ? port : undefined, backlog }, generation, failed);
    return this;
  }
  const start = address => {
    if (generation !== this._generation || !this._starting) return;
    try {
      let kind = options.path === undefined ? 1 : 2;
      if (options.fd !== undefined) {
        kind = native('guessHandleType', [options.fd]);
        if (kind !== 1 && kind !== 2) { failed(nativeError(kind < 0 ? kind : -22, 'open')); return; }
      }
      this._transport = new Transport(kind, (...event) => this._onNative(...event));
      if (this._unrefed) this._transport.unref();
      let status;
      if (options.fd !== undefined) status = this._transport.call('open', options.fd);
      else {
        const flags = (options.ipv6Only ? 1 : 0) | (options.reusePort ? 2 : 0);
        status = this._transport.call('bind', address, port, flags);
        if (status < 0 && options.host === undefined && options.path === undefined && address === '::') {
          this._transport.onEvent = () => {};
          this._transport.close();
          this._transport = new Transport(1, (...event) => this._onNative(...event));
          if (this._unrefed) this._transport.unref();
          address = '0.0.0.0';
          status = this._transport.call('bind', address, port, 0);
        }
      }
      if (status < 0) { failed(nativeError(status, 'listen', address, port)); return; }
      if (kind === 2 && (options.readableAll || options.writableAll)) {
        status = this._transport.call('chmod', !!options.readableAll, !!options.writableAll);
        if (status < 0) { failed(nativeError(status, 'chmod', address)); return; }
      }
      status = this._transport.call('listen', backlog);
      // The bind of a TCP server takes effect at listen, so a host without IPv6 fails here.
      if (status < 0 && kind === 1 && options.fd === undefined && options.host === undefined && address === '::') {
        this._transport.onEvent = () => {};
        this._transport.close();
        this._transport = new Transport(1, (...event) => this._onNative(...event));
        if (this._unrefed) this._transport.unref();
        address = '0.0.0.0';
        status = this._transport.call('bind', address, port, 0);
        if (status >= 0) status = this._transport.call('listen', backlog);
      }
      if (status < 0) { failed(nativeError(status, 'listen', address, port)); return; }
      this._starting = false;
      this._listening = true;
      process.nextTick(() => { if (this._listening && generation === this._generation) this.emit('listening'); });
    } catch (err) { failed(err); }
  };
  if (options.path !== undefined) start(options.path);
  else if (options.fd !== undefined) start(undefined);
  else if (!options.host) start('::');
  else if (isIP(options.host)) start(options.host);
  else require('dns').lookup(options.host, { family: 0 }, (err, address) => {
    if (generation !== this._generation || !this._starting) return;
    if (err) failed(err); else start(address);
  });
  return this;
};
Server.prototype._emitCloseIfDrained = function() {
  if (!this._closing || this._transport || this._connections) return;
  this._closing = false;
  process.nextTick(() => this.emit('close'));
};
Server.prototype.close = function(cb) {
  callback(cb);
  if (!this._listening && !this._starting && !this._closing) {
    if (cb) process.nextTick(cb, fail('ERR_SERVER_NOT_RUNNING', 'Server is not running'));
    return this;
  }
  if (cb) this.once('close', cb);
  ++this._generation;
  this._starting = false;
  this._listening = false;
  this._closing = true;
  this._removeAbort?.();
  if (this._transport) this._transport.close();
  this._emitCloseIfDrained();
  return this;
};
Server.prototype.address = function() { return this._listening ? this._transport.address() : null; };
Server.prototype.getConnections = function(cb) { callback(cb); if (!cb) throw fail('ERR_INVALID_ARG_TYPE', 'Callback must be a function', TypeError); process.nextTick(cb, null, this._connections); return this; };
Server.prototype.ref = function() { this._unrefed = false; this._transport?.ref(); return this; };
Server.prototype.unref = function() { this._unrefed = true; this._transport?.unref(); return this; };
Object.defineProperty(Server.prototype, 'listening', { get() { return this._listening; } });
if (Symbol.asyncDispose) Server.prototype[Symbol.asyncDispose] = function() {
  return new Promise((resolve, reject) => this.close(err => err && err.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(err) : resolve()));
};
function createConnection(...args) { const [options] = normalizeArgs(args); return new Socket(options).connect(...args); }
function createServer(options, listener) { return new Server(options, listener); }
function getDefaultAutoSelectFamily() { return defaultAutoSelectFamily; }
function setDefaultAutoSelectFamily(value) {
  if (typeof value !== 'boolean') throw fail('ERR_INVALID_ARG_TYPE', 'The "value" argument must be a boolean', TypeError);
  defaultAutoSelectFamily = value;
}
function getDefaultAutoSelectFamilyAttemptTimeout() { return defaultAutoSelectFamilyAttemptTimeout; }
function setDefaultAutoSelectFamilyAttemptTimeout(value) {
  defaultAutoSelectFamilyAttemptTimeout = Math.max(10, integer(value, 'value', 1, 0x7fffffff));
}

module.exports = {
  Socket, Stream: Socket, Server, createConnection, connect: createConnection, createServer,
  isIP, isIPv4, isIPv6, _normalizeArgs: normalizeArgs,
  getDefaultAutoSelectFamily, setDefaultAutoSelectFamily,
  getDefaultAutoSelectFamilyAttemptTimeout, setDefaultAutoSelectFamilyAttemptTimeout
};
