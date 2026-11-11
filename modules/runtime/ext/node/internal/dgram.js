'use strict';

// The UDP handle behind dgram.Socket: Node's UDPWrap contract over the native network bridge.
// Every native submission carries the original view's byte offset and length; a pooled Buffer
// must never expose its surrounding allocation on the wire.

const host = require('internal/host');
const { AsyncResource } = require('async_hooks');
const { Buffer } = require('buffer');
const { validateFunction } = require('internal/validators');
const { codes: { ERR_SOCKET_BAD_TYPE } } = require('internal/errors');

const kStateSymbol = Symbol('state symbol');
const isIP = input => typeof input === 'string' ? host.net('isIP', [input]) : 0;
const UV_UDP_IPV6ONLY = 1;
const UV_UDP_REUSEADDR = 4;
const UV_UDP_REUSEPORT = 64;
const EVENT_MESSAGE = 1;
const EVENT_SENT = 4;
const EVENT_CLOSED = 6;

class UDP {
  constructor(family) {
    this.family = family;
    this.owner = null;
    this.onmessage = null;
    this.closed = false;
    this.requests = new Map();
    this.sequence = 0;
    this.queueSize = 0;
    this.resource = new AsyncResource('UDPWRAP', { requireManualDestroy: true });
    this.callback = (event, status, payload, extra) => {
      host.invokeResource(this.resource, this.dispatch, this, [event, status, payload, extra], false);
      host.checkpoint();
    };
    this.id = host.net('create', [family === 4 ? 3 : 4, this.callback]);
    if (this.id < 0) {
      this.resource.emitDestroy();
      throw new (require('internal/errors').ErrnoException)(this.id, 'socket');
    }
  }
  dispatch(event, status, payload, extra) {
    if (event === EVENT_MESSAGE) {
      if (!this.closed && this.onmessage) this.onmessage(status, this, status < 0 ? undefined : Buffer.from(payload), extra);
    } else if (event === EVENT_SENT) {
      const request = this.requests.get(payload);
      if (!request) return;
      this.requests.delete(payload);
      this.queueSize -= request.length;
      request.oncomplete(status, request.length);
    } else if (event === EVENT_CLOSED) {
      this.resource.emitDestroy();
    }
  }
  call(operation, ...args) { return host.net(operation, [this.id, ...args]); }
  // Node's handle.lookup: an IP literal of the socket's family resolves to itself.
  lookup(address, callback) {
    address ||= this.family === 4 ? '127.0.0.1' : '::1';
    if (this.lookupFunction === undefined) {
      if (isIP(address) === this.family) { process.nextTick(callback, null, address, this.family); return; }
      require('dns').lookup(address, this.family, callback);
    } else this.lookupFunction(address, this.family, callback);
  }
  bind(ip, port, flags) { return this.call('bind', ip, port, flags); }
  open(fd) { return this.call('open', fd); }
  recvStart() { return this.call('recvStart'); }
  recvStop() { return this.closed ? 0 : this.call('recvStop'); }
  connect(ip, port) { return this.call('udpConnect', ip, port); }
  disconnect() { return this.call('udpDisconnect'); }
  // Returns 0 when the send was submitted (oncomplete follows) or a negative errno.
  send(request, list, port, ip) {
    const buffer = list.length === 1 ? list[0] : Buffer.concat(list);
    const token = ++this.sequence;
    request.length = buffer.length;
    this.requests.set(token, request);
    this.queueSize += buffer.length;
    const status = this.call('send', buffer.buffer, buffer.byteOffset, buffer.byteLength, port ? ip : null, port || 0, token);
    if (status < 0) {
      this.requests.delete(token);
      this.queueSize -= buffer.length;
    }
    return status;
  }
  address(peer) { return this.call('address', peer); }
  option(name, value) { return this.call('udpOption', name, value); }
  membership(group, iface, join, source) {
    return this.call('membership', group, iface === undefined ? null : iface, join, source === undefined ? null : source);
  }
  getSendQueueSize() { return this.queueSize; }
  getSendQueueCount() { return this.requests.size; }
  // Like a closed UDPWrap, pending sends never call back.
  close() {
    if (this.closed) return;
    this.closed = true;
    this.requests.clear();
    this.queueSize = 0;
    host.net('close', [this.id]);
  }
  ref() { if (!this.closed) this.call('ref'); }
  unref() { if (!this.closed) this.call('unref'); }
  hasRef() { return !this.closed && !!this.call('hasRef'); }
}

function newHandle(type, lookup) {
  if (lookup !== undefined) validateFunction(lookup, 'lookup');
  if (type !== 'udp4' && type !== 'udp6') throw new ERR_SOCKET_BAD_TYPE();
  const handle = new UDP(type === 'udp4' ? 4 : 6);
  handle.lookupFunction = lookup;
  return handle;
}

module.exports = { kStateSymbol, newHandle, UDP, UV_UDP_IPV6ONLY, UV_UDP_REUSEADDR, UV_UDP_REUSEPORT };
