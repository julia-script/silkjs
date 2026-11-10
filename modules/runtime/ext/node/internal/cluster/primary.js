'use strict';
const { EventEmitter } = require('events');
const Worker = require('internal/cluster/worker');
const cluster = module.exports = new EventEmitter();
const handles = new Map();
let ids = 0, sequence = 0, policy;
Object.assign(cluster, {
  isWorker: false, isPrimary: true, isMaster: true, Worker, workers: {}, settings: {},
  SCHED_NONE: 1, SCHED_RR: 2,
  schedulingPolicy: process.env.NODE_CLUSTER_SCHED_POLICY === 'none' ? 1 : 2
});
const send = (worker, message, handle, callback) => {
  if (!worker.isConnected()) { if (callback) process.nextTick(callback, new Error('Worker disconnected')); return false; }
  return worker.process.send({ cmd: 'NODE_CLUSTER', ...message }, handle, { keepOpen: true }, callback);
};
cluster.setupPrimary = function(options) {
  cluster.settings = { args: process.argv.slice(2), exec: process.argv[1], execArgv: process.execArgv,
    silent: false, ...cluster.settings, ...options };
  if (policy === undefined) {
    policy = cluster.schedulingPolicy;
    if (policy !== 1 && policy !== 2) throw Object.assign(new Error(`Bad cluster.schedulingPolicy: ${policy}`), { code: 'ERR_ASSERTION' });
  }
  const settings = cluster.settings;
  process.nextTick(() => cluster.emit('setup', settings));
};
cluster.setupMaster = cluster.setupPrimary;
function closeServer(entry) {
  const server = entry.server;
  if (entry.datagram) {
    if (!server._closing && !server._closed) server.close();
  } else if (server._listening || server._starting) server.close();
  else server._transport?.close();
}
function remove(entry, worker) {
  entry.workers.delete(worker.id);
  for (const [id, pending] of entry.pending) if (pending.worker === worker) {
    entry.pending.delete(id); entry.queue.push(pending.socket);
  }
  if (entry.workers.size) { distribute(entry); return; }
  handles.delete(entry.key);
  for (const socket of entry.queue) socket.destroy();
  entry.queue.length = 0;
  closeServer(entry);
}
function removeHandles(worker) { for (const entry of handles.values()) remove(entry, worker); }
function distribute(entry) {
  if (!entry.ready || entry.shared) return;
  const workers = [...entry.workers.values()].filter(worker => worker.isConnected() && !worker.exitedAfterDisconnect);
  if (!workers.length) return;
  while (entry.queue.length) {
    const worker = workers[entry.cursor++ % workers.length], socket = entry.queue.shift();
    const seq = ++sequence;
    entry.pending.set(seq, { worker, socket });
    send(worker, { act: 'newconn', key: entry.key, seq }, socket, error => {
      if (!error || !entry.pending.has(seq)) return;
      entry.pending.delete(seq);
      entry.queue.push(socket); remove(entry, worker);
    });
  }
}
function reply(entry, worker, request) {
  send(worker, { act: 'queryServer', request, key: entry.key, address: entry.address, shared: entry.shared, backlog: entry.backlog },
    entry.shared ? entry.server : undefined);
}
function query(worker, message) {
  if (worker.exitedAfterDisconnect) return;
  const options = message.options;
  const datagram = options.addressType === 'udp4' || options.addressType === 'udp6';
  const key = JSON.stringify([options.host || '', options.port, options.path, options.fd, options.addressType,
    datagram || options.port === 0 ? message.index : 0]);
  let entry = handles.get(key);
  if (entry) {
    entry.workers.set(worker.id, worker);
    if (entry.ready) reply(entry, worker, message.request);
    else entry.waiting.push([worker, message.request]);
    return;
  }
  const server = datagram ? require('dgram').createSocket(options.addressType) :
    new (require('net').Server)({ pauseOnConnect: true });
  entry = { key, server, datagram, workers: new Map([[worker.id, worker]]), waiting: [[worker, message.request]],
    shared: datagram || policy === 1, backlog: options.backlog, ready: false, queue: [], pending: new Map(), cursor: 0 };
  handles.set(key, entry);
  const failed = error => {
    if (handles.get(key) !== entry) return;
    handles.delete(key);
    closeServer(entry);
    for (const [target, request] of entry.waiting) send(target, { act: 'queryServer', request,
      error: { message: error.message, code: error.code, errno: error.errno, syscall: error.syscall } });
    entry.waiting.length = 0;
  };
  const ready = () => {
    if (handles.get(key) !== entry) { closeServer(entry); return; }
    entry.ready = true;
    entry.address = entry.shared && !datagram ? server._transport.address() : server.address();
    for (const [target, request] of entry.waiting) if (entry.workers.has(target.id)) reply(entry, target, request);
    entry.waiting.length = 0; distribute(entry);
  };
  server.on('error', failed);
  if (datagram) {
    // SCM_RIGHTS duplicates one bound UDP socket, under either scheduling
    // policy. The primary never starts receiving from that socket.
    const error = server._bindNative(options, false);
    if (error) failed(error);
    else ready();
    return;
  }
  server.on('connection', socket => { entry.queue.push(socket); distribute(entry); });
  if (!entry.shared) { server.listen({ ...options, exclusive: true }, ready); return; }
  // A passive primary descriptor cannot steal accepts from workers.
  // SCM_RIGHTS duplicates this same socket; each child registers its own watcher.
  const { Transport, native, error: nativeError } = require('internal/net/transport');
  const bind = address => {
    if (handles.get(key) !== entry) return;
    try {
      const kind = options.fd === undefined ? (options.path === undefined ? 1 : 2) : native('guessHandleType', [options.fd]);
      server._transport = new Transport(kind, () => {});
      let status = options.fd === undefined ? server._transport.call('bind', address, options.port || 0, options.ipv6Only ? 1 : 0) :
        server._transport.call('open', options.fd);
      if (status < 0) { failed(nativeError(status, 'bind', address, options.port)); return; }
      if (kind === 2 && (options.readableAll || options.writableAll)) {
        status = server._transport.call('chmod', !!options.readableAll, !!options.writableAll);
        if (status < 0) { failed(nativeError(status, 'chmod', address)); return; }
      }
      // A passive listen makes the bound socket that workers share, and never accepts here.
      if (options.fd === undefined) {
        status = server._transport.call('listen', options.backlog || 511, true);
        if (status < 0 && address === '::' && !options.host) { server._transport.close(); bind('0.0.0.0'); return; }
        if (status < 0) { failed(nativeError(status, 'listen', address, options.port)); return; }
      }
      ready();
    } catch (error) { failed(error); }
  };
  if (options.path !== undefined) bind(options.path);
  else if (options.fd !== undefined) bind(undefined);
  else if (!options.host || require('net').isIP(options.host)) bind(options.host || '::');
  else require('dns').lookup(options.host, (error, address) => error ? failed(error) : bind(address));
}
function onmessage(worker, message) {
  if (message.cmd !== 'NODE_CLUSTER') return;
  if (message.act === 'online') {
    worker.state = 'online'; worker.emit('online'); cluster.emit('online', worker);
  } else if (message.act === 'listening') {
    worker.state = 'listening'; worker.emit('listening', message.address); cluster.emit('listening', worker, message.address);
  } else if (message.act === 'queryServer') query(worker, message);
  else if (message.act === 'close') { const entry = handles.get(message.key); if (entry) remove(entry, worker); }
  else if (message.act === 'exitedAfterDisconnect') {
    worker.exitedAfterDisconnect = true; send(worker, { act: 'disconnectAck' });
  } else if (message.act === 'accepted') {
    const entry = handles.get(message.key), pending = entry?.pending.get(message.seq);
    if (!pending || pending.worker !== worker) return;
    entry.pending.delete(message.seq);
    if (message.accepted) pending.socket.destroy();
    else { entry.queue.push(pending.socket); distribute(entry); }
  }
}
cluster.fork = function(env) {
  cluster.setupPrimary();
  const id = ++ids, settings = cluster.settings;
  const child = require('child_process').fork(settings.exec, settings.args, {
    cwd: settings.cwd, env: { ...process.env, ...env, NODE_UNIQUE_ID: String(id) },
    execArgv: settings.execArgv, silent: settings.silent, stdio: settings.stdio,
    serialization: settings.serialization, uid: settings.uid, gid: settings.gid, windowsHide: settings.windowsHide
  });
  const worker = new Worker({ id, process: child });
  cluster.workers[id] = worker;
  worker.on('message', (message, handle) => cluster.emit('message', worker, message, handle));
  child.on('internalMessage', message => onmessage(worker, message));
  child.once('disconnect', () => {
    removeHandles(worker);
    if (worker.isDead()) delete cluster.workers[id];
    worker.exitedAfterDisconnect = !!worker.exitedAfterDisconnect;
    worker.state = 'disconnected'; worker.emit('disconnect'); cluster.emit('disconnect', worker);
  });
  child.once('exit', (code, signal) => {
    if (!worker.isConnected()) { removeHandles(worker); delete cluster.workers[id]; }
    worker.exitedAfterDisconnect = !!worker.exitedAfterDisconnect;
    worker.state = 'dead'; worker.emit('exit', code, signal); cluster.emit('exit', worker, code, signal);
  });
  process.nextTick(() => cluster.emit('fork', worker));
  return worker;
};
Worker.prototype.disconnect = function() {
  if (this.exitedAfterDisconnect) return this;
  this.exitedAfterDisconnect = true;
  send(this, { act: 'disconnect' }); removeHandles(this);
  delete cluster.workers[this.id];
  return this;
};
Worker.prototype.destroy = function(signal) { this.process.kill(signal); };
cluster.disconnect = function(callback) {
  const workers = Object.values(cluster.workers).filter(worker => worker.isConnected());
  let remaining = workers.length;
  if (!remaining) { if (typeof callback === 'function') process.nextTick(callback); return; }
  for (const worker of workers) {
    worker.once('disconnect', () => { if (--remaining === 0 && typeof callback === 'function') callback(); });
    worker.disconnect();
  }
};
