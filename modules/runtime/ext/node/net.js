'use strict';

const { Duplex } = require('stream');
const { EventEmitter } = require('events');
const { Buffer } = require('buffer');
const diagnostics = require('internal/host').diagnostics;
const { Transport, error: nativeError, native } = require('internal/net/transport');

let defaultAutoSelectFamily = true;
let defaultAutoSelectFamilyAttemptTimeout = 250;

const { codedError, validateAbortSignal, validateBoolean, validateFunction, validateInt32, validateNumber, validatePort, validateString } = require('internal/validators');
const {
  AbortError, ExceptionWithHostPort,
  codes: {
    ERR_INVALID_ADDRESS_FAMILY, ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE, ERR_INVALID_HANDLE_TYPE, ERR_INVALID_IP_ADDRESS,
    ERR_IP_BLOCKED, ERR_MISSING_ARGS, ERR_OUT_OF_RANGE, ERR_SERVER_ALREADY_LISTEN, ERR_SERVER_NOT_RUNNING, ERR_SOCKET_CLOSED,
    ERR_SOCKET_CLOSED_BEFORE_CONNECTION,
  },
} = require('internal/errors');
const UV_ETIMEDOUT = -require('os').constants.errno.ETIMEDOUT;

function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new ERR_OUT_OF_RANGE(name, `>= ${min} and <= ${max}`, value);
  return value;
}
function callback(value) {
  if (value !== undefined) validateFunction(value, 'callback');
}
// Like Node's regular expressions: the input is converted to a string, and an IPv6 address may
// carry a zone ID such as `%eth0`.
function isIP(input) {
  const text = `${input}`;
  const zone = text.indexOf('%');
  if (zone === -1) return native('isIP', [text]);
  return /^%[0-9a-zA-Z\-.:]+$/.test(text.slice(zone)) && native('isIP', [text.slice(0, zone)]) === 6 ? 6 : 0;
}
function isIPv4(input) { return isIP(input) === 4; }
function isIPv6(input) { return isIP(input) === 6; }
function socketToDnsFamily(family) { return family === 'IPv4' ? 4 : family === 'IPv6' ? 6 : family; }
function toNumber(value) { return (value = Number(value)) >= 0 ? value : false; }
function isPipeName(value) { return typeof value === 'string' && toNumber(value) === false; }
const normalizedArgs = Symbol('normalizedArgs');
// Node's normalizeArgs: (options[, cb]), (path[, cb]) or ([port][, host][, cb]).
function normalizeArgs(args) {
  let options = {};
  if (args.length > 0) {
    const first = args[0];
    if (typeof first === 'object' && first !== null) options = first;
    else if (isPipeName(first)) options.path = first;
    else {
      options.port = first;
      if (args.length > 1 && typeof args[1] === 'string') options.host = args[1];
    }
  }
  const cb = args[args.length - 1];
  const normalized = [options, typeof cb === 'function' ? cb : null];
  normalized[normalizedArgs] = true;
  return normalized;
}
function blockList(options) {
  if (!options.blockList) return undefined;
  if (!require('internal/blocklist').isBlockList(options.blockList)) throw new ERR_INVALID_ARG_TYPE('options.blockList', 'net.BlockList', options.blockList);
  return options.blockList;
}
function abortError(signal) {
  return new AbortError(undefined, { cause: signal.reason });
}
function attachAbort(target, signal, abort) {
  if (signal === undefined) return;
  validateAbortSignal(signal, 'options.signal');
  target._removeAbort?.();
  const listener = () => abort(abortError(signal));
  target._removeAbort = () => { signal.removeEventListener('abort', listener); target._removeAbort = null; };
  if (signal.aborted) process.nextTick(listener);
  else signal.addEventListener('abort', listener, { once: true });
}

function Socket(options) {
  if (!(this instanceof Socket)) return new Socket(options);
  if (options?.objectMode) throw new ERR_INVALID_ARG_VALUE('options.objectMode', options.objectMode, 'is not supported');
  if (options?.readableObjectMode || options?.writableObjectMode) {
    throw new ERR_INVALID_ARG_VALUE(`options.${options.readableObjectMode ? 'readableObjectMode' : 'writableObjectMode'}`,
      options.readableObjectMode || options.writableObjectMode, 'is not supported');
  }
  if (options?.keepAliveInitialDelay !== undefined) validateNumber(options.keepAliveInitialDelay, 'options.keepAliveInitialDelay');
  options = typeof options === 'number' ? { fd: options } : { ...options };
  this.blockList = blockList(options);
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
  this._keepAliveDelay = Math.max(0, options.keepAliveInitialDelay || 0);
  this._onread = options.onread;
  this._localAddress = undefined;
  this._remoteAddress = undefined;
  this.server = null;
  if (options.handle) {
    this._attachTransport(options.handle);
    this._connected = true;
    this._cacheAddresses();
  } else if (options.fd !== undefined) {
    validateInt32(options.fd, 'fd', 0);
    const kind = native('guessHandleType', [options.fd]);
    if (kind !== 1 && kind !== 2) throw nativeError(kind < 0 ? kind : -22, 'open');
    const transport = new Transport(kind, this, (...args) => this._onNative(...args));
    const status = transport.call('open', options.fd);
    if (status < 0) { transport.close(); throw nativeError(status, 'open'); }
    this._attachTransport(transport);
    this._connected = true;
    this._cacheAddresses();
  }
  if (this._transport && !options.manualStart) process.nextTick(() => { if (!this.destroyed && options.readable !== false) this._read(); });
  attachAbort(this, options.signal, err => this.destroy(err));
  this.on('end', onReadableStreamEnd);
}
Object.setPrototypeOf(Socket.prototype, Duplex.prototype);
// Like Node: without allowHalfOpen, a write after the peer's FIN and our own end fails with EPIPE.
function onReadableStreamEnd() {
  if (!this.allowHalfOpen) this.write = writeAfterFIN;
}
function writeAfterFIN(chunk, encoding, cb) {
  if (!this.writableEnded) return Duplex.prototype.write.call(this, chunk, encoding, cb);
  if (typeof encoding === 'function') { cb = encoding; encoding = null; }
  const err = new Error('This socket has been ended by the other party');
  err.code = 'EPIPE';
  if (typeof cb === 'function') process.nextTick(cb, err);
  this.destroy(err);
  return false;
}
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
  // A WebSocket peer (internal/ws) owns the frames of this socket after its upgrade.
  if (type === 7 || type === 8) { this._wsPeer?._frame(type, status, payload); return; }
  if (type === 1 && status >= 0 && this._wsPeer) {
    if (payload?.byteLength) { this._bytesRead += payload.byteLength; native('wsFeed', [this._transport.id, payload, 0, payload.byteLength]); }
    return;
  }
  if (type === 3) {
    if (status < 0) {
      // Like Node's createConnectionError: a given local address and port are in the message.
      const local = this._connectLocal;
      const err = new ExceptionWithHostPort(status, 'connect', this._connectAddress, this._connectPort, local && `${local.address}:${local.port}`);
      if (local) { err.localAddress = local.address; err.localPort = local.port; }
      this._connectionFailed(err);
      return;
    }
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
      if (!this._onreadPending) this._pushEOF();
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
      this.destroy(new ERR_INVALID_ARG_VALUE('options.onread.buffer', destination, 'must provide a nonempty Uint8Array')); return;
    }
    const chunk = this._onreadPending;
    const count = Math.min(destination.byteLength, chunk.length);
    destination.set(chunk.subarray(0, count));
    this._onreadPending = count < chunk.length ? chunk.subarray(count) : this._onreadQueue?.shift() || null;
    if (this._onread.callback.call(this, count, destination) === false) this.pause();
  }
  if (this._readEOF && !this._onreadPending && !this.destroyed) this._pushEOF();
};
Socket.prototype._pushEOF = function() {
  // Like libuv under Node, an onread socket is asked for a buffer for the read that sees EOF too.
  if (!this._eofPushed && typeof this._onread?.callback === 'function' && typeof this._onread.buffer === 'function') this._onread.buffer();
  this._eofPushed = true;
  this.push(null);
  this.read(0);
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
  if (this.connecting) {
    this._pendingWrite = () => this._send(chunks, cb, vector);
    this._pendingWrite.callback = cb;
    this._pendingWrite.chunks = chunks;
    return;
  }
  if (!this._connected || !this._transport) { cb(new ERR_SOCKET_CLOSED()); return; }
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
  // Like Node: a shutdown that fails at submission reports it, but the status of a submitted
  // shutdown is not reported (afterShutdown); a peer that reset the connection fails the reads.
  let submitted = false;
  this._transport.shutdown(err => { if (submitted) cb(); else cb(err); });
  submitted = true;
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
  // Like Node, a write waiting for the connect fails once the socket closes.
  if (pending?.callback) process.nextTick(pending.callback, new ERR_SOCKET_CLOSED_BEFORE_CONNECTION());
  else if (pending) pending();
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
  const [options, cb] = Array.isArray(args[0]) && args[0][normalizedArgs] ? args[0] : normalizeArgs(args);
  diagnostics.publish('net.client.socket', { socket: this });
  if (cb !== null) this.once('connect', cb);
  if (options.port === undefined && options.path == null) throw new ERR_MISSING_ARGS(['options', 'port', 'path']);
  if (this.connecting || this._connected) // Node reuses the handle here; a connected transport here cannot be redirected yet.
    throw codedError(Error, 'ERR_SOCKET_IS_CONNECTED', 'Socket is already connected');
  if (this._transport?.closing) throw new ERR_SOCKET_CLOSED();
  let port;
  let attemptTimeout = defaultAutoSelectFamilyAttemptTimeout;
  if (options.path) validateString(options.path, 'options.path');
  else {
    // Node's lookupAndConnect checks, in its order.
    const host = options.host || 'localhost';
    validateString(host, 'options.host');
    if (host.includes('\0')) throw new ERR_INVALID_ARG_VALUE('options.host', host, 'must be a string without null bytes');
    if (options.localAddress && !isIP(options.localAddress)) throw new ERR_INVALID_IP_ADDRESS(options.localAddress);
    if (options.localPort) validateNumber(options.localPort, 'options.localPort');
    if (options.port !== undefined) {
      if (typeof options.port !== 'number' && typeof options.port !== 'string') throw new ERR_INVALID_ARG_TYPE('options.port', ['number', 'string'], options.port);
      validatePort(options.port);
    }
    port = options.port | 0;
    if (options.autoSelectFamily != null) validateBoolean(options.autoSelectFamily, 'options.autoSelectFamily');
    if (options.autoSelectFamilyAttemptTimeout != null) {
      validateInt32(options.autoSelectFamilyAttemptTimeout, 'options.autoSelectFamilyAttemptTimeout', 1);
      attemptTimeout = Math.max(10, options.autoSelectFamilyAttemptTimeout);
    }
    if (!isIP(host) && options.lookup != null) validateFunction(options.lookup, 'options.lookup');
  }
  if (this.destroyed) { this._undestroy(); this._hadError = false; this._reset = false; }
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
    this._connectLocal = options.localAddress && options.localPort ? { address: options.localAddress, port: options.localPort } : undefined;
    try {
      this._attachTransport(new Transport(options.path ? 2 : 1, this, (...event) => this._onNative(...event)));
      if (options.localAddress !== undefined || options.localPort !== undefined) {
        const local = options.localAddress || (family === 6 ? '::' : '0.0.0.0');
        const status = this._transport.call('bind', local, Number(options.localPort || 0), 0);
        if (status < 0) { this.destroy(nativeError(status, 'bind', local, options.localPort)); return; }
      }
      if (!options.path) this.emit('connectionAttempt', address, port, family);
      if (this.destroyed) return;
      if (!options.path && this.blockList?.check(address, `ipv${family}`)) { this._connectionFailed(new ERR_IP_BLOCKED(address)); return; }
      const status = this._transport.call('connect', address, port || 0);
      if (status < 0) {
        // Like Node's internalConnect, a TCP connect that fails at once names the local address,
        // which is empty when the socket has none.
        const local = options.path ? undefined : this.address();
        this._connectionFailed(new ExceptionWithHostPort(status, 'connect', address, port, local && `${local.address}:${local.port}`));
      }
    } catch (err) { this.destroy(err); }
  };
  if (options.path) process.nextTick(start, options.path, 0);
  else {
    const host = options.host || 'localhost';
    this._host = host;
    const family = isIP(host);
    if (family) process.nextTick(start, host, family);
    else {
      const lookup = options.lookup || require('dns').lookup;
      const family = socketToDnsFamily(options.family);
      const auto = (options.autoSelectFamily ?? defaultAutoSelectFamily) && family !== 4 && family !== 6 && !options.localAddress;
      // Like Node, without a family or hints the lookup asks only for configured address families.
      const hints = options.hints || (family !== 4 && family !== 6 ? require('dns').ADDRCONFIG : 0);
      lookup(host, { family, hints, all: auto }, (err, address, resolvedFamily) => {
        if (this.destroyed || generation !== this._generation) return;
        if (err) { this.emit('lookup', err, undefined, undefined, host); this.destroy(err); return; }
        const answers = auto ? address : [{ address, family: resolvedFamily }];
        if (!Array.isArray(answers) || answers.length === 0 || !answers[0]) {
          this.destroy(new ERR_INVALID_IP_ADDRESS(auto ? undefined : address)); return;
        }
        for (const record of answers) this.emit('lookup', null, record?.address, record?.family, host);
        if (this.destroyed) return;
        // Node keeps the IPv4 and IPv6 answers, and fails on the first answer when none is valid.
        const valid = address => typeof address === 'string' && isIP(address) !== 0;
        const records = answers.filter(record => record && valid(record.address) && (record.family === 4 || record.family === 6));
        if (records.length === 0) {
          const first = answers[0];
          this.destroy(!valid(first.address) ? new ERR_INVALID_IP_ADDRESS(first.address)
            : new ERR_INVALID_ADDRESS_FAMILY(first.family, options.host, options.port));
          return;
        }
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
              const timeout = new ExceptionWithHostPort(UV_ETIMEDOUT, 'connect', record.address, port);
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
  if (this.destroyed) return this;
  validateNumber(milliseconds, 'msecs');
  if (milliseconds < 0 || !Number.isFinite(milliseconds)) throw new ERR_OUT_OF_RANGE('msecs', 'a non-negative finite number', milliseconds);
  if (cb !== undefined) validateFunction(cb, 'callback');
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
  if (this._transport && this._transport.kind !== 1) throw new ERR_INVALID_HANDLE_TYPE();
  if (this.connecting) { this.once('connect', () => this.resetAndDestroy()); return this; }
  this._reset = true;
  return this.destroy();
};
Object.defineProperties(Socket.prototype, {
  _handle: { get() { return this._transport; }, set(value) { this._transport = value; }, configurable: true },
  _connecting: { get() { return this.connecting; } },
  pending: { get() { return !this._transport || this.connecting; } },
  readyState: { get() { return this.connecting ? 'opening' : this.readable && this.writable ? 'open' : this.readable ? 'readOnly' : this.writable ? 'writeOnly' : 'closed'; } },
  // Node creates the handle in connect(), so a connecting socket has a buffer size too.
  bufferSize: { get() { return this._transport || this.connecting ? this.writableLength : undefined; } },
  bytesRead: { get() { return this._bytesRead; } },
  // Like Node: the bytes sent, plus the buffered writes and the write that waits for the connect.
  bytesWritten: { get() {
    const buffered = this.writableBuffer;
    if (!buffered) return undefined;
    const length = entry => typeof entry.chunk === 'string' ? Buffer.byteLength(entry.chunk, entry.encoding) : entry.chunk.length;
    let bytes = this._bytesWritten;
    for (const entry of buffered) bytes += length(entry);
    const pending = this._pendingWrite?.chunks;
    if (Array.isArray(pending)) for (const entry of pending) bytes += length(entry);
    else if (pending) bytes += pending.length;
    return bytes;
  } },
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
  else if (options == null || typeof options === 'object') options = { ...options };
  else throw new ERR_INVALID_ARG_TYPE('options', 'Object', options);
  if (typeof listener !== 'function') listener = undefined;
  if (options.keepAliveInitialDelay !== undefined) {
    validateNumber(options.keepAliveInitialDelay, 'options.keepAliveInitialDelay');
    if (options.keepAliveInitialDelay < 0) options.keepAliveInitialDelay = 0;
  }
  this.blockList = blockList(options);
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
  try { socket._attachTransport(new Transport(this._transport.kind, socket, (...args) => socket._onNative(...args), id)); }
  catch (err) { this.emit('error', err); return; }
  socket._connected = true;
  socket._cacheAddresses();
  const remote = socket._remoteAddress?.address;
  if (this.blockList && isIP(remote) && this.blockList.check(remote, `ipv${isIP(remote)}`)) { socket.destroy(); return; }
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
  diagnostics.publish('net.server.socket', { socket });
  if (!this.pauseOnConnect && !socket.destroyed) socket._read();
};
Server.prototype.listen = function(...args) {
  const [normalized, cb] = normalizeArgs(args);
  if (this._transport) throw new ERR_SERVER_ALREADY_LISTEN();
  if (cb !== null) this.once('listening', cb);
  const backlogFromArgs = toNumber(args.length > 1 && args[1]) || toNumber(args.length > 2 && args[2]);
  const options = normalized._handle || normalized.handle || normalized;
  const generation = ++this._generation;
  attachAbort(this, options.signal, () => this.close());
  // Node's listen overloads, in its order: fd, port (listen(), listen(cb), listen(null) and an
  // explicit port: undefined mean port 0), then path.
  let port = 0;
  let backlog = options.backlog || backlogFromArgs || 511;
  if (!(typeof options.fd === 'number' && options.fd >= 0)) {
    if (args.length === 0 || typeof args[0] === 'function' || (options.port === undefined && 'port' in options) || options.port === null) options.port = 0;
    if (typeof options.port === 'number' || typeof options.port === 'string') port = validatePort(options.port, 'options.port');
    else if (options.path && isPipeName(options.path)) {
      if (options.path[0] === '\0' && (options.readableAll || options.writableAll))
        throw new ERR_INVALID_ARG_VALUE('options', options, 'can not set readableAll or writableAllt to true when path is abstract unix socket');
    } else if (!('port' in options || 'path' in options)) {
      throw new ERR_INVALID_ARG_VALUE('options', options, 'must have the property "port" or "path"');
    } else throw new ERR_INVALID_ARG_VALUE('options', options);
  }
  const fd = typeof options.fd === 'number' && options.fd >= 0 ? options.fd : undefined;
  const path = fd === undefined && options.port === undefined ? options.path : undefined;
  const listenTracing = diagnostics.tracing('net.server.listen');
  listenTracing?.asyncStart.publish({ server: this, options });
  this._starting = true;
  const failed = err => {
    listenTracing?.error.publish({ server: this, error: err });
    this._starting = false;
    this._removeAbort?.();
    this._detachTransport();
    process.nextTick(() => this.emit('error', err));
  };
  const cluster = require('cluster');
  if (cluster.isWorker && !options.exclusive && !options.reusePort) {
    cluster._getServer(this, { ...options, fd, path, port: path === undefined && fd === undefined ? port : undefined, backlog }, generation, failed);
    return this;
  }
  const start = address => {
    if (generation !== this._generation || !this._starting) return;
    try {
      let kind = path === undefined ? 1 : 2;
      if (fd !== undefined) {
        kind = native('guessHandleType', [fd]);
        if (kind !== 1 && kind !== 2) { failed(nativeError(kind < 0 ? kind : -22, 'open')); return; }
      }
      this._transport = new Transport(kind, this, (...event) => this._onNative(...event));
      if (this._unrefed) this._transport.unref();
      let status;
      if (fd !== undefined) status = this._transport.call('open', fd);
      else {
        const flags = (options.ipv6Only ? 1 : 0) | (options.reusePort ? 2 : 0);
        status = this._transport.call('bind', address, port, flags);
        if (status < 0 && !options.host && address === '::') {
          this._transport.onEvent = () => {};
          this._transport.close();
          this._transport = new Transport(1, this, (...event) => this._onNative(...event));
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
      if (status < 0 && kind === 1 && fd === undefined && !options.host && address === '::') {
        this._transport.onEvent = () => {};
        this._transport.close();
        this._transport = new Transport(1, this, (...event) => this._onNative(...event));
        if (this._unrefed) this._transport.unref();
        address = '0.0.0.0';
        status = this._transport.call('bind', address, port, 0);
        if (status >= 0) status = this._transport.call('listen', backlog);
      }
      if (status < 0) { failed(nativeError(status, 'listen', address, port)); return; }
      // Node's key for the listening address: type, address and the requested port.
      this._connectionKey = kind === 1 && fd === undefined ? `${isIP(address)}:${address}:${port}`
        : `-1:${fd === undefined ? address : null}:-1`;
      this._starting = false;
      this._listening = true;
      listenTracing?.asyncEnd.publish({ server: this });
      process.nextTick(() => { if (this._listening && generation === this._generation) this.emit('listening'); });
    } catch (err) { failed(err); }
  };
  if (path !== undefined) start(path);
  else if (fd !== undefined) start(undefined);
  else if (!options.host) start('::');
  else if (isIP(options.host)) start(options.host);
  else require('dns').lookup(options.host, { family: 0 }, (err, address) => {
    if (generation !== this._generation || !this._starting) return;
    if (err) failed(err); else start(address);
  });
  return this;
};
// Like Node dropping server._handle: the closing handle no longer belongs to the server.
Server.prototype._detachTransport = function() {
  const transport = this._transport;
  this._transport = null;
  if (transport) { transport.onEvent = () => {}; transport.close(); }
};
Server.prototype._emitCloseIfDrained = function() {
  if (!this._closing || this._connections) return;
  this._closing = false;
  process.nextTick(() => this.emit('close'));
};
// Like Node: a callback that is not a function is ignored, and 'close' is emitted even when the
// server was not listening, with ERR_SERVER_NOT_RUNNING for the callback.
Server.prototype.close = function(cb) {
  if (typeof cb === 'function') {
    if (!this._transport) this.once('close', function close() { cb(new ERR_SERVER_NOT_RUNNING()); });
    else this.once('close', cb);
  }
  ++this._generation;
  this._starting = false;
  this._listening = false;
  this._closing = true;
  this._removeAbort?.();
  this._detachTransport();
  this._emitCloseIfDrained();
  return this;
};
Server.prototype.address = function() { return this._listening ? this._transport.address() : null; };
// Like Node: with captureRejections, a rejected 'connection' listener destroys that socket.
Server.prototype[EventEmitter.captureRejectionSymbol] = function(err, event, sock) {
  if (event === 'connection') sock.destroy(err);
  else this.emit('error', err);
};
Server.prototype.getConnections = function(cb) { validateFunction(cb, 'cb'); process.nextTick(cb, null, this._connections); return this; };
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
  validateBoolean(value, 'value');
  defaultAutoSelectFamily = value;
}
function getDefaultAutoSelectFamilyAttemptTimeout() { return defaultAutoSelectFamilyAttemptTimeout; }
function setDefaultAutoSelectFamilyAttemptTimeout(value) {
  defaultAutoSelectFamilyAttemptTimeout = Math.max(10, integer(value, 'value', 1, 0x7fffffff));
}

module.exports = {
  get BlockList() { return require('internal/blocklist').BlockList; },
  get SocketAddress() { return require('internal/socketaddress').SocketAddress; },
  Socket, Stream: Socket, Server, createConnection, connect: createConnection, createServer,
  isIP, isIPv4, isIPv6, _normalizeArgs: normalizeArgs,
  getDefaultAutoSelectFamily, setDefaultAutoSelectFamily,
  getDefaultAutoSelectFamilyAttemptTimeout, setDefaultAutoSelectFamilyAttemptTimeout
};
