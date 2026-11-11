// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// Adapted from Node.js v24.22.1 lib/dgram.js for the Silk runtime: the UDP handle is
// internal/dgram's UDP over the native network bridge, and cluster workers share bound
// sockets through cluster._getDatagram.

'use strict';

const { codes: { ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE }, validateAbortSignal, validateObject, validateString, validateNumber, validateUint32 } = require('internal/validators');
const { codes: { ERR_BUFFER_OUT_OF_BOUNDS, ERR_INVALID_FD_TYPE, ERR_IP_BLOCKED, ERR_MISSING_ARGS, ERR_SOCKET_ALREADY_BOUND, ERR_SOCKET_BAD_BUFFER_SIZE, ERR_SOCKET_DGRAM_IS_CONNECTED, ERR_SOCKET_DGRAM_NOT_CONNECTED, ERR_SOCKET_DGRAM_NOT_RUNNING }, ErrnoException, ExceptionWithHostPort, makeError, validatePort } = require('internal/net/errors');
const { kStateSymbol, newHandle, UV_UDP_IPV6ONLY, UV_UDP_REUSEADDR, UV_UDP_REUSEPORT } = require('internal/dgram');
const { native } = require('internal/net/transport');
const { Buffer } = require('buffer');
const EventEmitter = require('events');
const { deprecate } = require('util');

const BIND_STATE_UNBOUND = 0;
const BIND_STATE_BINDING = 1;
const BIND_STATE_BOUND = 2;

const CONNECT_STATE_DISCONNECTED = 0;
const CONNECT_STATE_CONNECTING = 1;
const CONNECT_STATE_CONNECTED = 2;

const RECV_BUFFER = true;
const SEND_BUFFER = false;

const isIP = input => typeof input === 'string' ? native('isIP', [input]) : 0;
const isInt32 = value => value === (value | 0);
const isBlockList = value => require('internal/blocklist').isBlockList(value);

function Socket(type, listener) {
  EventEmitter.call(this);
  let lookup;
  let recvBufferSize;
  let sendBufferSize;
  let receiveBlockList;
  let sendBlockList;

  let options;
  if (type !== null && typeof type === 'object') {
    options = type;
    type = options.type;
    lookup = options.lookup;
    if (options.recvBufferSize) validateUint32(options.recvBufferSize, 'options.recvBufferSize');
    if (options.sendBufferSize) validateUint32(options.sendBufferSize, 'options.sendBufferSize');
    recvBufferSize = options.recvBufferSize;
    sendBufferSize = options.sendBufferSize;
    if (options.receiveBlockList) {
      if (!isBlockList(options.receiveBlockList))
        throw new ERR_INVALID_ARG_TYPE('options.receiveBlockList', 'net.BlockList', options.receiveBlockList);
      receiveBlockList = options.receiveBlockList;
    }
    if (options.sendBlockList) {
      if (!isBlockList(options.sendBlockList))
        throw new ERR_INVALID_ARG_TYPE('options.sendBlockList', 'net.BlockList', options.sendBlockList);
      sendBlockList = options.sendBlockList;
    }
  }

  const handle = newHandle(type, lookup);
  handle.owner = this;
  this.type = type;

  if (typeof listener === 'function') this.on('message', listener);

  this[kStateSymbol] = {
    handle,
    receiving: false,
    bindState: BIND_STATE_UNBOUND,
    connectState: CONNECT_STATE_DISCONNECTED,
    queue: undefined,
    reuseAddr: options?.reuseAddr,
    reusePort: options?.reusePort,
    ipv6Only: options?.ipv6Only,
    recvBufferSize,
    sendBufferSize,
    receiveBlockList,
    sendBlockList,
    clusterRelease: null,
  };

  if (options?.signal !== undefined) {
    const { signal } = options;
    validateAbortSignal(signal, 'options.signal');
    const onAborted = () => {
      if (this[kStateSymbol].handle) this.close();
    };
    if (signal.aborted) {
      onAborted();
    } else {
      signal.addEventListener('abort', onAborted, { once: true });
      this.once('close', () => signal.removeEventListener('abort', onAborted));
    }
  }
}
Object.setPrototypeOf(Socket.prototype, EventEmitter.prototype);
Object.setPrototypeOf(Socket, EventEmitter);


function createSocket(type, listener) {
  return new Socket(type, listener);
}


// Returns an error instead of throwing: cluster and IPC callers report it.
function startReceiving(socket) {
  const state = socket[kStateSymbol];
  state.handle.onmessage = onMessage;
  const err = state.handle.recvStart();
  if (err < 0) return new ErrnoException(err, 'recvStart');
  state.receiving = true;
  state.bindState = BIND_STATE_BOUND;
  try {
    if (state.recvBufferSize) bufferSize(socket, state.recvBufferSize, RECV_BUFFER);
    if (state.sendBufferSize) bufferSize(socket, state.sendBufferSize, SEND_BUFFER);
  } catch (error) { return error; }
  return null;
}

function startListening(socket) {
  const err = startReceiving(socket);
  if (err) {
    socket[kStateSymbol].bindState = BIND_STATE_UNBOUND;
    socket.emit('error', err);
    return;
  }
  socket.emit('listening');
}

function emitListeningNT(socket) {
  // Ensure the socket was not closed before the next tick.
  if (socket[kStateSymbol].handle) socket.emit('listening');
}

function emitConnectNT(socket) {
  // Ensure the socket was not closed before the next tick.
  if (socket[kStateSymbol].handle) socket.emit('connect');
}

function bindFlags(state) {
  let flags = 0;
  if (state.reuseAddr) flags |= UV_UDP_REUSEADDR;
  if (state.ipv6Only) flags |= UV_UDP_IPV6ONLY;
  if (state.reusePort) flags |= UV_UDP_REUSEPORT;
  return flags;
}

function bufferSize(self, size, buffer) {
  if (size >>> 0 !== size) throw new ERR_SOCKET_BAD_BUFFER_SIZE();
  const name = buffer === RECV_BUFFER ? 'recvBufferSize' : 'sendBufferSize';
  const result = self[kStateSymbol].handle.option(name, size);
  if (result < 0) {
    const cause = new ErrnoException(result, buffer === RECV_BUFFER ? 'uv_recv_buffer_size' : 'uv_send_buffer_size');
    const err = makeError(Error, 'ERR_SOCKET_BUFFER_SIZE', `Could not get or set buffer size: ${cause.syscall} returned ${cause.code}`);
    err.info = { errno: cause.errno, code: cause.code, message: cause.message, syscall: cause.syscall };
    err.errno = cause.errno;
    err.syscall = cause.syscall;
    throw err;
  }
  return result;
}

// Ask the cluster primary for a shared socket; it arrives through _adoptClusterHandle.
function bindServerHandle(self, options, errCb) {
  const state = self[kStateSymbol];
  require('cluster')._getDatagram(self, options, (err) => {
    if (!state.handle) return;
    if (err) errCb(err);
    else self.emit('listening');
  });
}

Socket.prototype.bind = function(port_, address_ /* , callback */) {
  let port = port_;

  healthCheck(this);
  const state = this[kStateSymbol];

  if (state.bindState !== BIND_STATE_UNBOUND) throw new ERR_SOCKET_ALREADY_BOUND();

  state.bindState = BIND_STATE_BINDING;

  const cb = arguments.length && arguments[arguments.length - 1];
  if (typeof cb === 'function') {
    function removeListeners() {
      this.removeListener(EventEmitter.errorMonitor, removeListeners);
      this.removeListener('listening', onListening);
    }

    function onListening() {
      removeListeners.call(this);
      cb.call(this);
    }

    this.on(EventEmitter.errorMonitor, removeListeners);
    this.on('listening', onListening);
  }

  // Open an existing fd instead of creating a new one.
  if (port !== null && typeof port === 'object' && isInt32(port.fd) && port.fd > 0) {
    const fd = port.fd;
    const exclusive = !!port.exclusive;
    const cluster = require('cluster');

    if (cluster.isWorker && !exclusive) {
      bindServerHandle(this, { host: null, port: null, addressType: this.type, fd, flags: null }, (err) => {
        state.bindState = BIND_STATE_UNBOUND;
        this.emit('error', err);
      });
      return this;
    }

    const type = native('guessHandleType', [fd]);
    if (type !== 3) throw new ERR_INVALID_FD_TYPE(type === 1 ? 'TCP' : type === 2 ? 'PIPE' : type === 5 ? 'TTY' : 'UNKNOWN');
    const err = state.handle.open(fd);

    if (err < 0) throw new ErrnoException(err, 'open');

    startListening(this);
    return this;
  }

  let address;
  let exclusive;

  if (port !== null && typeof port === 'object') {
    address = port.address || '';
    exclusive = !!port.exclusive;
    port = port.port;
  } else {
    address = typeof address_ === 'function' ? '' : address_;
    exclusive = false;
  }

  // Defaulting address for bind to all interfaces
  if (!address) address = this.type === 'udp4' ? '0.0.0.0' : '::';

  // Resolve address first
  state.handle.lookup(address, (err, ip) => {
    if (!state.handle) return; // Handle has been closed in the mean time

    if (err) {
      state.bindState = BIND_STATE_UNBOUND;
      this.emit('error', err);
      return;
    }

    const cluster = require('cluster');
    const flags = bindFlags(state);
    if (state.reusePort) exclusive = true;

    if (cluster.isWorker && !exclusive) {
      bindServerHandle(this, { host: ip, port, addressType: this.type, fd: undefined, flags }, (err) => {
        state.bindState = BIND_STATE_UNBOUND;
        this.emit('error', err);
      });
    } else {
      const err = state.handle.bind(ip, port || 0, flags);
      if (err < 0) {
        const ex = new ExceptionWithHostPort(err, 'bind', ip, port);
        state.bindState = BIND_STATE_UNBOUND;
        this.emit('error', ex);
        return;
      }

      startListening(this);
    }
  });

  return this;
};

// Synchronous counterpart of bind(): the address must be a numeric IP literal, the
// 'listening' event follows on the next tick.
Socket.prototype.bindSync = function(options = {}) {
  healthCheck(this);
  validateObject(options, 'options');
  const state = this[kStateSymbol];

  if (state.bindState !== BIND_STATE_UNBOUND) throw new ERR_SOCKET_ALREADY_BOUND();

  // Validate arguments before mutating state so a bad argument leaves the
  // socket unbound and reusable.
  const port = validatePort(options.port ?? 0, 'options.port');
  let { address } = options;
  if (!address) {
    address = this.type === 'udp4' ? '0.0.0.0' : '::';
  } else {
    validateString(address, 'options.address');
    if (isIP(address) === 0) {
      throw new ERR_INVALID_ARG_VALUE('options.address', address,
        'must be a numeric IP address; bindSync does not perform DNS resolution');
    }
  }

  state.bindState = BIND_STATE_BINDING;

  const err = state.handle.bind(address, port, bindFlags(state));
  if (err < 0) {
    state.bindState = BIND_STATE_UNBOUND;
    throw new ExceptionWithHostPort(err, 'bind', address, port);
  }

  const failure = startReceiving(this);
  if (failure) throw failure;
  process.nextTick(emitListeningNT, this);
  return this.address();
};

Socket.prototype.connect = function(port, address, callback) {
  port = validatePort(port, 'Port', false);
  if (typeof address === 'function') {
    callback = address;
    address = '';
  } else if (address === undefined) {
    address = '';
  }

  validateString(address, 'address');

  const state = this[kStateSymbol];

  if (state.connectState !== CONNECT_STATE_DISCONNECTED) throw new ERR_SOCKET_DGRAM_IS_CONNECTED();

  state.connectState = CONNECT_STATE_CONNECTING;
  if (state.bindState === BIND_STATE_UNBOUND) this.bind({ port: 0, exclusive: true }, null);

  if (state.bindState !== BIND_STATE_BOUND) {
    enqueue(this, _connect.bind(this, port, address, callback));
    return;
  }

  _connect.call(this, port, address, callback);
};

// Synchronous counterpart of connect(); the address must be a numeric IP literal.
Socket.prototype.connectSync = function(port, address) {
  healthCheck(this);
  port = validatePort(port, 'Port', false);

  const state = this[kStateSymbol];

  if (state.connectState !== CONNECT_STATE_DISCONNECTED) throw new ERR_SOCKET_DGRAM_IS_CONNECTED();

  // Validate arguments before mutating state so a bad argument leaves the
  // socket reusable.
  if (address == null || address === '') {
    address = this.type === 'udp4' ? '127.0.0.1' : '::1';
  } else {
    validateString(address, 'address');
    if (isIP(address) === 0) {
      throw new ERR_INVALID_ARG_VALUE('address', address,
        'must be a numeric IP address; connectSync does not perform DNS resolution');
    }
  }

  if (state.bindState === BIND_STATE_UNBOUND) this.bindSync();
  else if (state.bindState !== BIND_STATE_BOUND) throw new ERR_SOCKET_ALREADY_BOUND();

  state.connectState = CONNECT_STATE_CONNECTING;

  if (state.sendBlockList?.check(address, `ipv${isIP(address)}`)) {
    state.connectState = CONNECT_STATE_DISCONNECTED;
    throw new ERR_IP_BLOCKED(address);
  }

  const err = state.handle.connect(address, port);
  if (err < 0) {
    state.connectState = CONNECT_STATE_DISCONNECTED;
    throw new ExceptionWithHostPort(err, 'connect', address, port);
  }

  state.connectState = CONNECT_STATE_CONNECTED;
  process.nextTick(emitConnectNT, this);
};


function _connect(port, address, callback) {
  const state = this[kStateSymbol];
  if (callback) this.once('connect', callback);
  state.handle.lookup(address, (ex, ip) => doConnect(ex, this, ip, address, port, callback));
}


function doConnect(ex, self, ip, address, port, callback) {
  const state = self[kStateSymbol];
  if (!state.handle) return;
  if (!ex && state.sendBlockList?.check(ip, `ipv${isIP(ip)}`)) ex = new ERR_IP_BLOCKED(ip);
  if (!ex) {
    const err = state.handle.connect(ip, port);
    if (err < 0) ex = new ExceptionWithHostPort(err, 'connect', address, port);
  }

  if (ex) {
    state.connectState = CONNECT_STATE_DISCONNECTED;
    return process.nextTick(() => {
      if (callback) {
        self.removeListener('connect', callback);
        callback(ex);
      } else {
        self.emit('error', ex);
      }
    });
  }

  state.connectState = CONNECT_STATE_CONNECTED;
  process.nextTick(() => self.emit('connect'));
}


Socket.prototype.disconnect = function() {
  const state = this[kStateSymbol];
  if (state.connectState !== CONNECT_STATE_CONNECTED) throw new ERR_SOCKET_DGRAM_NOT_CONNECTED();

  const err = state.handle.disconnect();
  if (err < 0) throw new ErrnoException(err, 'connect');
  state.connectState = CONNECT_STATE_DISCONNECTED;
};


// Thin wrapper around `send`, here for compatibility with dgram_legacy.js
Socket.prototype.sendto = function(buffer, offset, length, port, address, callback) {
  validateNumber(offset, 'offset');
  validateNumber(length, 'length');
  validateNumber(port, 'port');
  validateString(address, 'address');

  this.send(buffer, offset, length, port, address, callback);
};


function sliceBuffer(buffer, offset, length) {
  if (typeof buffer === 'string') {
    buffer = Buffer.from(buffer);
  } else if (!ArrayBuffer.isView(buffer)) {
    throw new ERR_INVALID_ARG_TYPE('buffer', ['Buffer', 'TypedArray', 'DataView', 'string'], buffer);
  }

  offset = offset >>> 0;
  length = length >>> 0;
  if (offset > buffer.byteLength) throw new ERR_BUFFER_OUT_OF_BOUNDS('offset');
  if (offset + length > buffer.byteLength) throw new ERR_BUFFER_OUT_OF_BOUNDS('length');

  return Buffer.from(buffer.buffer, buffer.byteOffset + offset, length);
}


function fixBufferList(list) {
  const newlist = new Array(list.length);

  for (let i = 0, l = list.length; i < l; i++) {
    const buf = list[i];
    if (typeof buf === 'string') newlist[i] = Buffer.from(buf);
    else if (Buffer.isBuffer(buf)) newlist[i] = buf;
    else if (!ArrayBuffer.isView(buf)) return null;
    else newlist[i] = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  return newlist;
}


function enqueue(self, toEnqueue) {
  const state = self[kStateSymbol];

  // If the send queue hasn't been initialized yet, do it, and install an
  // event handler that flushes the send queue after binding is done.
  if (state.queue === undefined) {
    state.queue = [];
    self.once(EventEmitter.errorMonitor, onListenError);
    self.once('listening', onListenSuccess);
  }
  state.queue.push(toEnqueue);
}


function onListenSuccess() {
  this.removeListener(EventEmitter.errorMonitor, onListenError);
  clearQueue.call(this);
}


function onListenError() {
  this.removeListener('listening', onListenSuccess);
  this[kStateSymbol].queue = undefined;
}


function clearQueue() {
  const state = this[kStateSymbol];
  const queue = state.queue;
  state.queue = undefined;

  // Flush the send queue.
  for (const queueEntry of queue) queueEntry();
}

// valid combinations
// For connectionless sockets
// send(buffer, offset, length, port, address, callback)
// send(buffer, offset, length, port, address)
// send(buffer, offset, length, port, callback)
// send(buffer, offset, length, port)
// send(bufferOrList, port, address, callback)
// send(bufferOrList, port, address)
// send(bufferOrList, port, callback)
// send(bufferOrList, port)
// For connected sockets
// send(buffer, offset, length, callback)
// send(buffer, offset, length)
// send(bufferOrList, callback)
// send(bufferOrList)
Socket.prototype.send = function(buffer, offset, length, port, address, callback) {
  let list;
  const state = this[kStateSymbol];
  const connected = state.connectState === CONNECT_STATE_CONNECTED;
  if (!connected) {
    if (address || (port && typeof port !== 'function')) {
      buffer = sliceBuffer(buffer, offset, length);
    } else {
      callback = port;
      port = offset;
      address = length;
    }
  } else {
    if (typeof length === 'number') {
      buffer = sliceBuffer(buffer, offset, length);
      if (typeof port === 'function') {
        callback = port;
        port = null;
      }
    } else {
      callback = offset;
    }

    if (port || address) throw new ERR_SOCKET_DGRAM_IS_CONNECTED();
  }

  if (!Array.isArray(buffer)) {
    if (typeof buffer === 'string') {
      list = [Buffer.from(buffer)];
    } else if (!ArrayBuffer.isView(buffer)) {
      throw new ERR_INVALID_ARG_TYPE('buffer', ['Buffer', 'TypedArray', 'DataView', 'string'], buffer);
    } else {
      list = [buffer];
    }
  } else if (!(list = fixBufferList(buffer))) {
    throw new ERR_INVALID_ARG_TYPE('buffer list arguments', ['Buffer', 'TypedArray', 'DataView', 'string'], buffer);
  }

  if (!connected) port = validatePort(port, 'Port', false);

  // Normalize callback so it's either a function or undefined but not anything
  // else.
  if (typeof callback !== 'function') callback = undefined;

  if (typeof address === 'function') {
    callback = address;
    address = undefined;
  } else if (address != null) {
    validateString(address, 'address');
  }

  healthCheck(this);

  if (state.bindState === BIND_STATE_UNBOUND) this.bind({ port: 0, exclusive: true }, null);

  if (list.length === 0) list.push(Buffer.alloc(0));

  // If the socket hasn't been bound yet, push the outbound packet onto the
  // send queue and send after binding is complete.
  if (state.bindState !== BIND_STATE_BOUND) {
    enqueue(this, this.send.bind(this, list, port, address, callback));
    return;
  }

  const afterDns = (ex, ip) => doSend(ex, this, ip, list, address, port, callback);

  if (!connected) state.handle.lookup(address, afterDns);
  else afterDns(null, null);
};

function doSend(ex, self, ip, list, address, port, callback) {
  const state = self[kStateSymbol];

  if (ex) {
    if (typeof callback === 'function') {
      process.nextTick(callback, ex);
      return;
    }

    process.nextTick(() => self.emit('error', ex));
    return;
  } else if (!state.handle) {
    return;
  }

  if (ip && state.sendBlockList?.check(ip, `ipv${isIP(ip)}`)) {
    if (callback) process.nextTick(callback, new ERR_IP_BLOCKED(ip));
    return;
  }

  const req = {
    oncomplete(status, sent) {
      if (callback) callback.call(self, status < 0 ? new ExceptionWithHostPort(status, 'send', address, port) : null, sent);
    },
  };
  const err = state.handle.send(req, list, port, ip);

  if (err < 0 && callback) {
    // Don't emit as error, dgram_legacy.js compatibility
    process.nextTick(callback, new ExceptionWithHostPort(err, 'send', address, port));
  }
}

Socket.prototype.close = function(callback) {
  const state = this[kStateSymbol];
  const queue = state.queue;

  if (typeof callback === 'function') this.on('close', callback);

  if (queue !== undefined) {
    queue.push(this.close.bind(this));
    return this;
  }

  healthCheck(this);
  stopReceiving(this);
  state.handle.close();
  state.handle = null;
  const release = state.clusterRelease;
  state.clusterRelease = null;
  if (release) release();
  process.nextTick(socketCloseNT, this);

  return this;
};

Socket.prototype[Symbol.asyncDispose] = async function() {
  if (!this[kStateSymbol].handle) return;
  await new Promise(resolve => this.close(resolve));
};


function socketCloseNT(self) {
  self.emit('close');
}


function socketAddress(socket, peer) {
  const result = socket[kStateSymbol].handle.address(peer);
  if (typeof result === 'number') throw new ErrnoException(result, peer ? 'getpeername' : 'getsockname');
  return result;
}

Socket.prototype.address = function() {
  healthCheck(this);
  return socketAddress(this, false);
};

Socket.prototype.remoteAddress = function() {
  healthCheck(this);

  const state = this[kStateSymbol];
  if (state.connectState !== CONNECT_STATE_CONNECTED) throw new ERR_SOCKET_DGRAM_NOT_CONNECTED();

  return socketAddress(this, true);
};


function setOption(socket, name, value, syscall = name) {
  const err = socket[kStateSymbol].handle.option(name, value);
  if (err < 0) throw new ErrnoException(err, syscall);
}

Socket.prototype.setBroadcast = function(arg) {
  setOption(this, 'broadcast', arg ? 1 : 0, 'setBroadcast');
};


Socket.prototype.setTTL = function(ttl) {
  validateNumber(ttl, 'ttl');
  setOption(this, 'ttl', ttl, 'setTTL');
  return ttl;
};


Socket.prototype.setMulticastTTL = function(ttl) {
  validateNumber(ttl, 'ttl');
  setOption(this, 'multicastTTL', ttl, 'setMulticastTTL');
  return ttl;
};


Socket.prototype.setMulticastLoopback = function(arg) {
  setOption(this, 'multicastLoopback', arg ? 1 : 0, 'setMulticastLoopback');
  return arg; // 0.4 compatibility
};


Socket.prototype.setMulticastInterface = function(interfaceAddress) {
  healthCheck(this);
  validateString(interfaceAddress, 'interfaceAddress');
  setOption(this, 'multicastInterface', interfaceAddress, 'setMulticastInterface');
};

// Like libuv, a membership change binds an unbound socket to the wildcard address first.
function membership(socket, syscall, group, iface, join, source) {
  const state = socket[kStateSymbol];
  if (state.bindState === BIND_STATE_UNBOUND) {
    const address = socket.type === 'udp4' ? '0.0.0.0' : '::';
    const err = state.handle.bind(address, 0, bindFlags(state));
    if (err < 0) throw new ExceptionWithHostPort(err, 'bind', address, 0);
    const failure = startReceiving(socket);
    if (failure) throw failure;
    process.nextTick(emitListeningNT, socket);
  }
  const err = state.handle.membership(group, typeof iface === 'string' ? iface : undefined, join, source);
  if (err < 0) throw new ErrnoException(err, syscall);
}

Socket.prototype.addMembership = function(multicastAddress, interfaceAddress) {
  healthCheck(this);
  if (!multicastAddress) throw new ERR_MISSING_ARGS('multicastAddress');
  membership(this, 'addMembership', multicastAddress, interfaceAddress, true);
};


Socket.prototype.dropMembership = function(multicastAddress, interfaceAddress) {
  healthCheck(this);
  if (!multicastAddress) throw new ERR_MISSING_ARGS('multicastAddress');
  membership(this, 'dropMembership', multicastAddress, interfaceAddress, false);
};

Socket.prototype.addSourceSpecificMembership = function(sourceAddress, groupAddress, interfaceAddress) {
  healthCheck(this);
  validateString(sourceAddress, 'sourceAddress');
  validateString(groupAddress, 'groupAddress');
  membership(this, 'addSourceSpecificMembership', groupAddress, interfaceAddress, true, sourceAddress);
};


Socket.prototype.dropSourceSpecificMembership = function(sourceAddress, groupAddress, interfaceAddress) {
  healthCheck(this);
  validateString(sourceAddress, 'sourceAddress');
  validateString(groupAddress, 'groupAddress');
  membership(this, 'dropSourceSpecificMembership', groupAddress, interfaceAddress, false, sourceAddress);
};


function healthCheck(socket) {
  // Error message from dgram_legacy.js.
  if (!socket[kStateSymbol].handle) throw new ERR_SOCKET_DGRAM_NOT_RUNNING();
}


function stopReceiving(socket) {
  const state = socket[kStateSymbol];
  if (!state.receiving) return;
  state.handle.recvStop();
  state.receiving = false;
}


function onMessage(nread, handle, buf, rinfo) {
  const self = handle.owner;
  if (nread < 0) return self.emit('error', new ErrnoException(nread, 'recvmsg'));
  if (self[kStateSymbol]?.receiveBlockList?.check(rinfo.address, rinfo.family?.toLowerCase())) return;
  rinfo = { ...rinfo, size: buf.length }; // compatibility
  self.emit('message', buf, rinfo);
}


Socket.prototype.ref = function() {
  this[kStateSymbol].handle?.ref();
  return this;
};


Socket.prototype.unref = function() {
  this[kStateSymbol].handle?.unref();
  return this;
};


Socket.prototype.setRecvBufferSize = function(size) {
  bufferSize(this, size, RECV_BUFFER);
};


Socket.prototype.setSendBufferSize = function(size) {
  bufferSize(this, size, SEND_BUFFER);
};


Socket.prototype.getRecvBufferSize = function() {
  return bufferSize(this, 0, RECV_BUFFER);
};


Socket.prototype.getSendBufferSize = function() {
  return bufferSize(this, 0, SEND_BUFFER);
};

Socket.prototype.getSendQueueSize = function() {
  return this[kStateSymbol].handle.getSendQueueSize();
};

Socket.prototype.getSendQueueCount = function() {
  return this[kStateSymbol].handle.getSendQueueCount();
};

// Cluster and IPC handle sharing (internal/cluster, internal/child_process/ipc).

// Binds or opens a descriptor; a primary or an IPC recipient that only passes the socket
// on does not start receiving. Returns the error instead of throwing.
Socket.prototype._bindNative = function(options, receive = true) {
  const state = this[kStateSymbol];
  const err = options.fd === undefined ?
    state.handle.bind(options.host, options.port || 0, options.flags ?? bindFlags(state)) :
    state.handle.open(options.fd);
  if (err < 0) {
    return options.fd === undefined ?
      new ExceptionWithHostPort(err, 'bind', options.host, options.port) : new ErrnoException(err, 'open');
  }
  if (receive) return startReceiving(this);
  state.bindState = BIND_STATE_BOUND;
  return null;
};

// Takes over the bound handle of a socket received from the cluster primary.
Socket.prototype._adoptClusterHandle = function(other) {
  const state = this[kStateSymbol];
  const theirs = other[kStateSymbol];
  const unused = state.handle;
  if (!unused.hasRef()) theirs.handle.unref();
  state.handle = theirs.handle;
  state.handle.owner = this;
  theirs.handle = unused;
  unused.owner = other;
  other.close();
  return startReceiving(this);
};

Object.defineProperties(Socket.prototype, {
  _id: { get() { return this[kStateSymbol].handle?.id ?? 0; } },
  _closed: { get() { return !this[kStateSymbol].handle; } },
  _clusterRelease: {
    get() { return this[kStateSymbol].clusterRelease; },
    set(release) { this[kStateSymbol].clusterRelease = release; },
  },
});

// Deprecated private APIs.
for (const [name, key] of [['_handle', 'handle'], ['_receiving', 'receiving'], ['_bindState', 'bindState'],
  ['_queue', 'queue'], ['_reuseAddr', 'reuseAddr']]) {
  Object.defineProperty(Socket.prototype, name, {
    get: deprecate(function() { return this[kStateSymbol][key]; }, `Socket.prototype.${name} is deprecated`, 'DEP0112'),
    set: deprecate(function(value) { this[kStateSymbol][key] = value; }, `Socket.prototype.${name} is deprecated`, 'DEP0112'),
  });
}

Socket.prototype._healthCheck = deprecate(function() {
  healthCheck(this);
}, 'Socket.prototype._healthCheck() is deprecated', 'DEP0112');


Socket.prototype._stopReceiving = deprecate(function() {
  stopReceiving(this);
}, 'Socket.prototype._stopReceiving() is deprecated', 'DEP0112');


module.exports = {
  createSocket,
  Socket,
};
