'use strict';
const { EventEmitter } = require('events');
const Worker = require('internal/cluster/worker');
const cluster = module.exports = new EventEmitter();
Object.assign(cluster, { isWorker: true, isPrimary: false, isMaster: false, worker: null, Worker });
const servers = new Map(), requests = new Map(), indexes = new Map();
let sequence = 0;
function send(message, callback) {
  if (!process.connected) { if (callback) process.nextTick(callback, new Error('IPC channel closed')); return false; }
  return process.send({ cmd: 'NODE_CLUSTER', ...message }, callback);
}
function release(key, indexKey, index) {
  servers.delete(key);
  const state = indexes.get(indexKey);
  state?.active.delete(index);
  if (state && !state.active.size) indexes.delete(indexKey);
  send({ act: 'close', key });
}
function disconnect(primaryInitiated) {
  const worker = cluster.worker;
  if (worker.state === 'disconnecting' || worker.state === 'destroying') return;
  worker.state = 'disconnecting'; worker.exitedAfterDisconnect = true;
  const open = new Set([...servers.values(), ...[...requests.values()].map(item => item.server)]);
  let pending = open.size;
  const done = () => {
    if (pending || !process.connected) return;
    if (primaryInitiated) process.disconnect();
    else send({ act: 'exitedAfterDisconnect' });
  };
  for (const server of open) {
    if (server._closed) { --pending; continue; }
    if (server._closing) server.once('close', () => { --pending; done(); });
    else server.close(() => { --pending; done(); });
  }
  done();
}
function onmessage(message, handle) {
  if (message.cmd !== 'NODE_CLUSTER') return;
  if (message.act === 'disconnect') { disconnect(true); return; }
  if (message.act === 'disconnectAck') { if (process.connected) process.disconnect(); return; }
  if (message.act === 'newconn') {
    const server = servers.get(message.key);
    const accepted = !!server?._listening && !(server.maxConnections != null && server._connections >= server.maxConnections && !server.dropMaxConnection);
    send({ act: 'accepted', key: message.key, seq: message.seq, accepted });
    if (!accepted) { handle?.destroy(); return; }
    if (server.domain) {
      Object.defineProperty(handle, 'domain', { configurable: true, writable: true, value: server.domain });
      require('domain')._associateResource(handle._transport.resource, server.domain);
    }
    server._acceptSocket(handle); return;
  }
  if (message.act !== 'queryServer') return;
  const item = requests.get(message.request);
  if (!item) { handle?.close(); return; }
  requests.delete(message.request);
  const { server, generation, failed, indexKey, index } = item;
  if (item.options.addressType) {
    const key = message.key;
    if (server._closing || server._closed || message.error) {
      handle?.close();
      if (key) release(key, indexKey, index);
      else {
        const state = indexes.get(indexKey); state?.active.delete(index);
        if (state && !state.active.size) indexes.delete(indexKey);
      }
      if (message.error && !server._closing && !server._closed)
        failed(Object.assign(new Error(message.error.message), message.error));
      return;
    }
    servers.set(key, server);
    const error = server._adoptClusterHandle(handle);
    if (error) {
      release(key, indexKey, index);
      failed(error);
      return;
    }
    server._clusterRelease = () => release(key, indexKey, index);
    failed(null);
    if (server._closing || server._closed) return;
    cluster.worker.state = 'listening';
    send({ act: 'listening', address: { ...server.address(), addressType: server.type, fd: item.options.fd } });
    return;
  }
  if (server._generation !== generation || !server._starting) {
    handle?.close();
    if (message.key) release(message.key, indexKey, index);
    return;
  }
  if (message.error) {
    if (message.key) release(message.key, indexKey, index);
    const state = indexes.get(indexKey); state?.active.delete(index);
    if (state && !state.active.size) indexes.delete(indexKey);
    failed(Object.assign(new Error(message.error.message), message.error)); return;
  }
  const key = message.key;
  servers.set(key, server);
  if (handle) {
    const transport = handle._transport;
    handle._transport = null; handle._listening = false;
    server._transport = transport;
    if (server.domain) require('domain')._associateResource(transport.resource, server.domain);
    transport.onEvent = (...args) => server._onNative(...args);
    const close = transport.close.bind(transport);
    let released = false;
    transport.close = (...args) => {
      if (!released) { released = true; release(key, indexKey, index); }
      return close(...args);
    };
    if (server._unrefed) transport.unref();
  } else {
    // The primary owns the listener; transferred accepted descriptors are real
    // sockets. A ref timer models the listener lifetime, as in Node's RR handle.
    let timer = null, closed = false;
    const transport = {
      address: () => message.address,
      ref() { if (!timer && !closed) timer = setInterval(() => {}, 0x7fffffff); },
      unref() { clearInterval(timer); timer = null; },
      close() {
        if (closed) return 0;
        closed = true; this.unref(); release(key, indexKey, index);
        server._transport = null; server._emitCloseIfDrained(); return 0;
      }
    };
    server._transport = transport;
    if (!server._unrefed) transport.ref();
  }
  server._starting = false; server._listening = true;
  process.nextTick(() => {
    if (!server._listening || server._generation !== generation) return;
    server.emit('listening');
    if (!server._listening) return;
    cluster.worker.state = 'listening';
    const address = server.address();
    send({ act: 'listening', address: {
      address: typeof address === 'string' ? address : address?.address,
      port: typeof address === 'string' ? -1 : address?.port,
      addressType: typeof address === 'string' ? -1 : address?.family === 'IPv6' ? 6 : 4,
      fd: item.options.fd
    } });
  });
}
cluster._setupWorker = function() {
  if (cluster.worker) return;
  cluster.worker = new Worker({ id: Number(process.env.NODE_UNIQUE_ID), process, state: 'online' });
  delete process.env.NODE_UNIQUE_ID;
  process.on('internalMessage', onmessage);
  process.once('disconnect', () => {
    cluster.worker.state = 'disconnected'; cluster.worker.emit('disconnect');
    if (!cluster.worker.exitedAfterDisconnect) process.exit(0);
  });
  send({ act: 'online' });
};
// Called after address validation/resolution, before binding a local descriptor.
cluster._getServer = function(server, options, generation, failed) {
  options = { ...options };
  delete options.signal;
  if (options.path !== undefined) options.path = require('path').resolve(options.path);
  const indexKey = JSON.stringify([options.host || '', options.port, options.path, options.fd, options.addressType]);
  let state = indexes.get(indexKey);
  if (!state) { state = { next: 0, active: new Set() }; indexes.set(indexKey, state); }
  const index = state.next++; state.active.add(index);
  const request = ++sequence;
  requests.set(request, { server, options, generation, failed, indexKey, index });
  send({ act: 'queryServer', options, request, index }, error => {
    if (!error || !requests.has(request)) return;
    requests.delete(request); state.active.delete(index);
    if (!state.active.size) indexes.delete(indexKey);
    if (options.addressType ? !server._closing && !server._closed : server._generation === generation && server._starting) failed(error);
  });
};
cluster._getDatagram = function(socket, options, done) {
  cluster._getServer(socket, options, undefined, done);
};
Worker.prototype.disconnect = function() { disconnect(false); return this; };
Worker.prototype.destroy = function() {
  if (this.state === 'destroying') return;
  this.state = 'destroying'; this.exitedAfterDisconnect = true;
  if (!process.connected) { process.exit(0); return; }
  process.once('disconnect', () => process.exit(0));
  send({ act: 'exitedAfterDisconnect' });
};
cluster._setupWorker();
