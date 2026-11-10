'use strict';

// UDP handles and datagram storage are owned by the native network bridge.
// Every native submission carries the original view's byte offset and length;
// a pooled Buffer must never expose its surrounding allocation on the wire.
const host = require('internal/host');
const { EventEmitter } = require('events');
const { Buffer } = require('buffer');
const { AsyncResource } = require('async_hooks');
const dns = require('dns');

function error(code, message, Type = Error) {
  const err = new Type(message);
  err.code = code;
  return err;
}
function invalid(name, expected) {
  return error('ERR_INVALID_ARG_TYPE', `The "${name}" argument must be ${expected}`, TypeError);
}
function integer(value, name, min, max) {
  if (typeof value !== 'number') throw invalid(name, 'a number');
  if (!Number.isInteger(value) || value < min || value > max)
    throw error('ERR_OUT_OF_RANGE', `The value of "${name}" must be >= ${min} and <= ${max}. Received ${value}`, RangeError);
  return value;
}
function portNumber(value, allowZero = false) {
  if (typeof value !== 'number' && typeof value !== 'string')
    throw error('ERR_SOCKET_BAD_PORT', `Port should be a number or string. Received ${String(value)}`, RangeError);
  if (typeof value === 'string' && value.trim() === '')
    throw error('ERR_SOCKET_BAD_PORT', 'Port must not be an empty string', RangeError);
  const port = Number(value);
  if (!Number.isInteger(port) || port < (allowZero ? 0 : 1) || port > 65535)
    throw error('ERR_SOCKET_BAD_PORT', `Port should be >= ${allowZero ? 0 : 1} and < 65536. Received ${value}`, RangeError);
  return port;
}
function string(value, name) {
  if (typeof value !== 'string') throw invalid(name, 'a string');
  if (value.includes('\0')) throw error('ERR_INVALID_ARG_VALUE', `The "${name}" argument must not contain null bytes`, TypeError);
  return value;
}
function callback(value) {
  if (value !== undefined && typeof value !== 'function') throw invalid('callback', 'a function');
}
function nativeError(status, syscall, address, port) {
  const info = host.net('error', [status]);
  const err = error(info.code, `${syscall} ${info.code}: ${info.message}${address === undefined ? '' : ` ${address}${port === undefined ? '' : `:${port}`}`}`);
  err.errno = status;
  err.syscall = syscall;
  if (address !== undefined) err.address = address;
  if (port !== undefined) err.port = port;
  return err;
}
function notRunning() { return error('ERR_SOCKET_DGRAM_NOT_RUNNING', 'Not running'); }
function notConnected() { return error('ERR_SOCKET_DGRAM_NOT_CONNECTED', 'Not connected'); }
function bytes(value) {
  if (typeof value === 'string') return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw invalid('buffer', 'a string, Buffer, TypedArray, or DataView');
}

class Socket extends EventEmitter {
  constructor(type, listener) {
    super();
    const options = typeof type === 'string' ? { type } : type;
    if (!options || typeof options !== 'object') throw invalid('type', 'a string or object');
    if (options.type !== 'udp4' && options.type !== 'udp6')
      throw error('ERR_SOCKET_BAD_TYPE', 'Bad socket type specified. Valid types are: udp4, udp6');
    callback(listener);
    if (options.lookup !== undefined && typeof options.lookup !== 'function') throw invalid('options.lookup', 'a function');
    if (options.signal !== undefined && (!options.signal || typeof options.signal.addEventListener !== 'function' || typeof options.signal.removeEventListener !== 'function' || typeof options.signal.aborted !== 'boolean'))
      throw invalid('options.signal', 'an AbortSignal');
    if (options.recvBufferSize !== undefined) integer(options.recvBufferSize, 'options.recvBufferSize', 1, 0x7fffffff);
    if (options.sendBufferSize !== undefined) integer(options.sendBufferSize, 'options.sendBufferSize', 1, 0x7fffffff);
    this.type = options.type;
    this._family = this.type === 'udp4' ? 4 : 6;
    this._lookup = options.lookup || dns.lookup;
    this._flags = (options.reuseAddr ? 4 : 0) | (options.ipv6Only ? 1 : 0) | (options.reusePort ? 64 : 0);
    this._recvBufferSize = options.recvBufferSize;
    this._sendBufferSize = options.sendBufferSize;
    this._bindState = 0;
    this._connectState = 0;
    this._closing = false;
    this._closed = false;
    this._bindQueue = [];
    this._connectQueue = [];
    this._pending = new Map();
    this._requests = new Set();
    this._nextToken = 1;
    this._queueSize = 0;
    this._resource = new AsyncResource('UDPWRAP', { requireManualDestroy: true });
    this._onHandleEvent = (event, status, payload, extra) => {
      host.invokeResource(this._resource, this._onNative, this, [event, status, payload, extra], false);
      host.checkpoint();
    };
    this._id = host.net('create', [this._family === 4 ? 3 : 4, this._onHandleEvent]);
    if (this._id < 0) {
      this._resource.emitDestroy();
      throw nativeError(this._id, 'socket');
    }
    if (listener) this.on('message', listener);
    if (options.signal) {
      const signal = options.signal;
      const abort = () => { if (!this._closing && !this._closed) this.close(); };
      this._removeAbort = () => signal.removeEventListener('abort', abort);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) this._later(abort);
    }
  }

  _later(fn, ...args) {
    process.nextTick(() => this._resource.runInAsyncScope(fn, this, ...args));
  }

  _health() {
    if (this._closing || this._closed) throw notRunning();
  }

  _resolve(address, cb) {
    let called = false;
    const done = (err, resolved, family) => {
      if (called) return;
      called = true;
      this._later(cb, err, resolved, family);
    };
    try { this._lookup(address, { family: this._family }, done); }
    catch (err) { done(err); }
  }

  _onNative(event, status, payload, extra) {
    if (event === 1) {
      if (this._closing || this._closed) return;
      if (status < 0) { this.emit('error', nativeError(status, 'recvmsg')); return; }
      const message = Buffer.from(payload);
      const rinfo = { ...extra, size: message.length };
      this.emit('message', message, rinfo);
    } else if (event === 4) {
      const request = this._pending.get(payload);
      if (!request) return;
      this._pending.delete(payload);
      this._queueSize -= request.buffer.length;
      this._finishSend(request, status < 0 ? nativeError(status, 'send', request.address, request.port) : null);
    } else if (event === 6) {
      this._closed = true;
      this._closing = false;
      this._id = 0;
      this._bindState = 0;
      this._connectState = 0;
      if (this._removeAbort) { this._removeAbort(); this._removeAbort = undefined; }
      const err = notRunning();
      this._failQueue(this._bindQueue, err);
      this._failQueue(this._connectQueue, err);
      for (const request of this._requests) this._deferSend(request, err);
      this._pending.clear();
      this._queueSize = 0;
      try { this.emit('close'); }
      finally { this._resource.emitDestroy(); }
    }
  }

  _failQueue(queue, err) {
    for (const operation of queue.splice(0)) operation.fail(err);
  }

  // Cluster primaries and IPC recipients keep bound descriptors without a
  // receive watcher. Only the eventual worker Socket may consume datagrams.
  _bindNative(options, receive = true) {
    const status = options.fd === undefined
      ? host.net('bind', [this._id, options.host, options.port, options.flags ?? this._flags])
      : host.net('open', [this._id, options.fd]);
    if (status < 0) return nativeError(status, options.fd === undefined ? 'bind' : 'open', options.host, options.port);
    if (receive) return this._bound();
    this._bindState = 2;
    return null;
  }

  _adoptClusterHandle(handle) {
    // Both wrappers already exist. Move native ownership and its callback,
    // rather than duplicating the received descriptor or forwarding packets.
    const unused = this._id;
    this._id = handle._id;
    handle._id = unused;
    host.net('callback', [unused, handle._onHandleEvent]);
    host.net('callback', [this._id, this._onHandleEvent]);
    handle.close();
    if (this._unrefed) host.net('unref', [this._id]);
    return this._bound();
  }

  _bound() {
    const status = host.net('recvStart', [this._id]);
    if (status < 0) return nativeError(status, 'recvStart');
    this._bindState = 2;
    try {
      if (this._recvBufferSize !== undefined) this.setRecvBufferSize(this._recvBufferSize);
      if (this._sendBufferSize !== undefined) this.setSendBufferSize(this._sendBufferSize);
    } catch (err) { return err; }
    return null;
  }

  _listening() {
    if (this._closing || this._closed) return;
    const queue = this._bindQueue.splice(0);
    this.emit('listening');
    for (const operation of queue) {
      if (this._closing || this._closed) operation.fail(notRunning());
      else operation.run();
    }
  }

  _bindFailed(err, onListening) {
    this._bindState = 0;
    if (onListening) this.removeListener('listening', onListening);
    this._failQueue(this._bindQueue, err);
    this.emit('error', err);
  }

  bind(...args) {
    this._health();
    if (this._bindState !== 0) throw error('ERR_SOCKET_ALREADY_BOUND', 'Socket is already bound');
    const cb = typeof args[args.length - 1] === 'function' ? args.pop() : undefined;
    let options;
    if (args[0] !== null && typeof args[0] === 'object') options = args[0];
    else options = { port: args[0], address: args[1] };
    const port = portNumber(options.port === undefined ? 0 : options.port, true);
    const address = options.address === undefined || options.address === '' ? (this._family === 4 ? '0.0.0.0' : '::') : string(options.address, 'address');
    if (options.fd !== undefined) integer(options.fd, 'fd', 0, 0x7fffffff);
    this._bindState = 1;
    if (cb) this.once('listening', cb);
    const finish = (err, resolved) => {
      if (this._closing || this._closed) { if (cb) this.removeListener('listening', cb); return; }
      if (!err) {
        const cluster = require('cluster');
        if (cluster.isWorker && !options.exclusive && !(this._flags & 64)) {
          cluster._getDatagram(this, { host: resolved, port, fd: options.fd,
            addressType: this.type, flags: this._flags }, error => {
            if (this._closing || this._closed) return;
            if (error) this._bindFailed(error, cb);
            else this._listening();
          });
          return;
        }
        err = this._bindNative({ host: resolved, port, fd: options.fd });
      }
      if (err) this._bindFailed(err, cb);
      else this._listening();
    };
    if (options.fd !== undefined) this._later(finish, null, address);
    else this._resolve(address, finish);
    return this;
  }

  _whenBound(run, fail) {
    if (this._bindState === 2) { run(); return; }
    this._bindQueue.push({ run, fail });
    if (this._bindState === 0) this.bind(0);
  }

  connect(port, address, cb) {
    this._health();
    if (this._connectState !== 0) throw error('ERR_SOCKET_DGRAM_IS_CONNECTED', 'Already connected');
    if (typeof address === 'function') { cb = address; address = undefined; }
    callback(cb);
    port = portNumber(port);
    address = address === undefined || address === '' ? (this._family === 4 ? '127.0.0.1' : '::1') : string(address, 'address');
    this._connectState = 1;
    const fail = err => {
      this._connectState = 0;
      this._failQueue(this._connectQueue, err);
      if (!this._closing && !this._closed) this.emit('error', err);
    };
    this._whenBound(() => this._resolve(address, (err, resolved) => {
      if (this._closing || this._closed) return;
      if (!err) {
        const status = host.net('udpConnect', [this._id, resolved, port]);
        if (status < 0) err = nativeError(status, 'connect', resolved, port);
      }
      if (err) { fail(err); return; }
      this._connectState = 2;
      if (cb) this.once('connect', cb);
      const queue = this._connectQueue.splice(0);
      this.emit('connect');
      for (const operation of queue) {
        if (this._closing || this._closed) operation.fail(notRunning());
        else operation.run();
      }
    }), err => {
      this._connectState = 0;
      this._failQueue(this._connectQueue, err);
    });
    return this;
  }

  disconnect() {
    this._health();
    if (this._connectState !== 2) throw notConnected();
    const status = host.net('udpDisconnect', [this._id]);
    if (status < 0) throw nativeError(status, 'disconnect');
    this._connectState = 0;
    return this;
  }

  send(message, ...args) {
    this._health();
    const cb = typeof args[args.length - 1] === 'function' ? args.pop() : undefined;
    const connected = this._connectState !== 0;
    let offset;
    let length;
    let port;
    let address;
    if (connected) {
      if (args.length === 2 && typeof args[0] === 'number' && typeof args[1] === 'number') [offset, length] = args;
      else if (args.length !== 0) throw error('ERR_SOCKET_DGRAM_IS_CONNECTED', 'Already connected');
    } else if (args.length === 3 || args.length === 4) {
      [offset, length, port, address] = args;
    } else if (args.length === 1 || args.length === 2) {
      [port, address] = args;
    } else {
      throw error('ERR_MISSING_ARGS', 'The port argument must be specified');
    }
    let buffer;
    if (Array.isArray(message)) {
      if (offset !== undefined) throw invalid('buffer', 'a string, Buffer, TypedArray, or DataView');
      const list = message.map(bytes);
      buffer = list.length === 1 ? list[0] : Buffer.concat(list);
    } else {
      buffer = bytes(message);
      if (offset !== undefined) {
        integer(offset, 'offset', 0, buffer.length);
        integer(length, 'length', 0, buffer.length - offset);
        buffer = buffer.subarray(offset, offset + length);
      }
    }
    if (!connected) {
      port = portNumber(port);
      address = address === undefined || address === '' ? (this._family === 4 ? '127.0.0.1' : '::1') : string(address, 'address');
    }
    const request = { buffer, cb, address, port, resource: new AsyncResource('UDPSENDWRAP', { requireManualDestroy: true }), done: false };
    this._requests.add(request);
    const fail = err => this._deferSend(request, err);
    const submit = resolved => {
      if (request.done) return;
      if (this._closing || this._closed) { fail(notRunning()); return; }
      if (connected && this._connectState !== 2) { fail(notConnected()); return; }
      const token = this._nextToken++;
      this._pending.set(token, request);
      this._queueSize += buffer.length;
      const status = host.net('send', [this._id, buffer.buffer, buffer.byteOffset, buffer.byteLength, connected ? null : resolved, connected ? 0 : port, token]);
      if (status < 0) {
        this._pending.delete(token);
        this._queueSize -= buffer.length;
        fail(nativeError(status, 'send', address, port));
      }
    };
    this._whenBound(() => {
      if (connected) {
        if (this._connectState === 1) this._connectQueue.push({ run: () => submit(null), fail });
        else submit(null);
      } else this._resolve(address, (err, resolved) => err ? fail(err) : submit(resolved));
    }, fail);
  }

  _deferSend(request, err) {
    process.nextTick(() => this._finishSend(request, err));
  }

  _finishSend(request, err) {
    if (request.done) return;
    request.done = true;
    this._requests.delete(request);
    try {
      request.resource.runInAsyncScope(() => {
        if (request.cb) request.cb.call(this, err, err ? undefined : request.buffer.length);
        else if (err) this.emit('error', err);
      }, this);
    } finally { request.resource.emitDestroy(); }
  }

  sendto(buffer, offset, length, port, address, cb) {
    callback(cb);
    return cb === undefined
      ? this.send(buffer, offset, length, port, address)
      : this.send(buffer, offset, length, port, address, cb);
  }

  close(cb) {
    this._health();
    callback(cb);
    if (cb) this.once('close', cb);
    this._closing = true;
    const status = host.net('close', [this._id]);
    if (status < 0) {
      this._closing = false;
      if (cb) this.removeListener('close', cb);
      throw nativeError(status, 'close');
    }
    if (this._clusterRelease) {
      const release = this._clusterRelease;
      this._clusterRelease = null;
      release();
    }
    return this;
  }

  address() {
    this._health();
    const result = host.net('address', [this._id, false]);
    if (typeof result === 'number') throw nativeError(result, 'getsockname');
    return result;
  }

  remoteAddress() {
    this._health();
    if (this._connectState !== 2) throw notConnected();
    const result = host.net('address', [this._id, true]);
    if (typeof result === 'number') throw nativeError(result, 'getpeername');
    return result;
  }

  ref() { this._unrefed = false; if (!this._closed && !this._closing) host.net('ref', [this._id]); return this; }
  unref() { this._unrefed = true; if (!this._closed && !this._closing) host.net('unref', [this._id]); return this; }

  _option(name, value) {
    this._health();
    const result = host.net('udpOption', [this._id, name, value]);
    if (result < 0) throw nativeError(result, name);
    return result;
  }

  setBroadcast(flag) { this._option('broadcast', !!flag); return this; }
  setTTL(ttl) { this._option('ttl', integer(ttl, 'ttl', 1, 255)); return ttl; }
  setMulticastTTL(ttl) { this._option('multicastTTL', integer(ttl, 'ttl', 0, 255)); return ttl; }
  setMulticastLoopback(flag) { this._option('multicastLoopback', !!flag); return !!flag; }
  setMulticastInterface(iface) { this._option('multicastInterface', string(iface, 'multicastInterface')); return this; }

  _bufferSize(name, value) {
    try { return this._option(name, value); }
    catch (cause) {
      if (cause.code === 'ERR_SOCKET_DGRAM_NOT_RUNNING') throw cause;
      const err = error('ERR_SOCKET_BUFFER_SIZE', `Could not ${value === null ? 'get' : 'set'} ${name}: ${cause.message}`);
      err.info = { errno: cause.errno, code: cause.code, message: cause.message, syscall: cause.syscall };
      throw err;
    }
  }

  getRecvBufferSize() { return this._bufferSize('recvBufferSize', null); }
  getSendBufferSize() { return this._bufferSize('sendBufferSize', null); }
  setRecvBufferSize(size) { this._bufferSize('recvBufferSize', integer(size, 'size', 1, 0x7fffffff)); }
  setSendBufferSize(size) { this._bufferSize('sendBufferSize', integer(size, 'size', 1, 0x7fffffff)); }
  getSendQueueSize() { this._health(); return this._queueSize; }
  getSendQueueCount() { this._health(); return this._pending.size; }

  _membership(group, iface, join, source) {
    this._health();
    string(group, 'multicastAddress');
    if (iface !== undefined) string(iface, 'multicastInterface');
    if (source !== undefined) string(source, 'sourceAddress');
    if (this._bindState === 0) {
      const address = this._family === 4 ? '0.0.0.0' : '::';
      const status = host.net('bind', [this._id, address, 0, this._flags]);
      if (status < 0) throw nativeError(status, 'bind', address, 0);
      const err = this._bound();
      if (err) throw err;
      this._later(this._listening);
    }
    const status = host.net('membership', [this._id, group, iface === undefined ? null : iface, join, source === undefined ? null : source]);
    if (status < 0) throw nativeError(status, source === undefined ? (join ? 'addMembership' : 'dropMembership') : (join ? 'addSourceSpecificMembership' : 'dropSourceSpecificMembership'));
    return this;
  }

  addMembership(group, iface) { return this._membership(group, iface, true); }
  dropMembership(group, iface) { return this._membership(group, iface, false); }
  addSourceSpecificMembership(source, group, iface) { string(source, 'sourceAddress'); return this._membership(group, iface, true, source); }
  dropSourceSpecificMembership(source, group, iface) { string(source, 'sourceAddress'); return this._membership(group, iface, false, source); }
}

if (Symbol.asyncDispose) {
  Socket.prototype[Symbol.asyncDispose] = function() {
    if (this._closed) return Promise.resolve();
    return new Promise(resolve => {
      this.once('close', resolve);
      if (!this._closing) this.close();
    });
  };
}

function createSocket(type, listener) { return new Socket(type, listener); }
module.exports = { Socket, createSocket };
