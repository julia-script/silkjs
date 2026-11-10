'use strict';
const { EventEmitter } = require('events');
const net = require('net');
const { error } = require('internal/http/parser');
class Agent extends EventEmitter {
  constructor(options = {}) {
    super(); this.options = { ...options, noDelay: options.noDelay !== false, path: null };
    this.defaultPort = 80; this.protocol = 'http:';
    this.keepAlive = !!options.keepAlive; this.keepAliveMsecs = options.keepAliveMsecs || 1000;
    this.maxSockets = options.maxSockets === undefined ? Infinity : options.maxSockets;
    this.maxFreeSockets = options.maxFreeSockets === undefined ? 256 : options.maxFreeSockets;
    this.maxTotalSockets = options.maxTotalSockets === undefined ? Infinity : options.maxTotalSockets;
    this.scheduling = options.scheduling || 'lifo';
    if (!['lifo', 'fifo'].includes(this.scheduling)) throw error('ERR_INVALID_ARG_VALUE', 'scheduling must be lifo or fifo');
    for (const name of ['maxSockets', 'maxTotalSockets']) if (!(this[name] > 0)) throw error('ERR_OUT_OF_RANGE', name + ' must be greater than zero');
    if (!(this.maxFreeSockets >= 0)) throw error('ERR_OUT_OF_RANGE', 'maxFreeSockets must be nonnegative');
    this.sockets = Object.create(null); this.freeSockets = Object.create(null); this.requests = Object.create(null);
    this._pendingSockets = Object.create(null);
    this.totalSocketCount = 0;
    this.agentKeepAliveTimeoutBuffer = options.agentKeepAliveTimeoutBuffer === undefined ? 1000 : options.agentKeepAliveTimeoutBuffer;
  }
  createConnection(options, callback) { return net.createConnection(options, callback); }
  getName(options = {}) { return (options.host || 'localhost') + ':' + (options.port || this.defaultPort) + ':' + (options.localAddress || '') + (options.family ? ':' + options.family : '') + (options.socketPath ? ':' + options.socketPath : ''); }
  addRequest(req, options) {
    options = { ...this.options, ...options }; req._agentOptions = options;
    const name = this.getName(options); req._agentKey = name;
    const free = this.freeSockets[name]; let socket;
    while (free && free.length) {
      socket = this.scheduling === 'fifo' ? free.shift() : free.pop();
      if (!socket.destroyed && socket.writable) break; socket = null;
    }
    if (free && !free.length) delete this.freeSockets[name];
    if (socket) {
      socket._httpFree = false; (this.sockets[name] || (this.sockets[name] = [])).push(socket);
      this.reuseSocket(socket, req); req.onSocket(socket); return;
    }
    if ((this.sockets[name]?.length || 0) + (this._pendingSockets[name] || 0) < this.maxSockets && this.totalSocketCount < this.maxTotalSockets) this.createSocket(req, options, (err, created) => { if (err) req.destroy(err); else req.onSocket(created); });
    else {
      (this.requests[name] || (this.requests[name] = [])).push(req);
      if (this.totalSocketCount >= this.maxTotalSockets) {
        for (const key of Object.keys(this.freeSockets)) {
          const idle = this.freeSockets[key].find(candidate => !candidate.destroyed);
          if (idle) { idle.destroy(); break; }
        }
      }
    }
  }
  createSocket(req, options, callback) {
    const name = this.getName(options); let completed = false;
    // Reserve a slot even when a custom connection factory is asynchronous.
    this.totalSocketCount++;
    this._pendingSockets[name] = (this._pendingSockets[name] || 0) + 1;
    const done = (err, socket) => {
      if (completed) return;
      if (!err && !socket) return;
      completed = true;
      if (--this._pendingSockets[name] === 0) delete this._pendingSockets[name];
      if (err) { this.totalSocketCount--; callback(err); this._drain(); return; }
      socket._httpAgent = this; socket._httpAgentKey = name; socket._httpFree = false;
      (this.sockets[name] || (this.sockets[name] = [])).push(socket);
      socket.on('close', () => this.removeSocket(socket, options));
      socket.on('free', () => this.freeSocket(socket, options));
      socket.on('error', () => { if (socket._httpFree) socket.destroy(); });
      socket.on('timeout', () => { if (socket._httpFree) socket.destroy(); });
      socket.on('data', () => { if (socket._httpFree) socket.destroy(); });
      socket.on('agentRemove', () => this.removeSocket(socket, options));
      callback(null, socket);
    };
    try {
      const connectOptions = { ...options }; if (options.socketPath) connectOptions.path = options.socketPath; else delete connectOptions.path;
      const socket = this.createConnection(connectOptions, done); if (socket) done(null, socket);
    } catch (err) { done(err); }
  }
  keepSocketAlive(socket) {
    socket.setKeepAlive(true, this.keepAliveMsecs); socket.unref();
    let timeout = this.options.timeout || 0;
    if (socket._httpKeepAliveTimeout !== undefined) timeout = timeout ? Math.min(timeout, socket._httpKeepAliveTimeout) : socket._httpKeepAliveTimeout;
    if (socket._httpKeepAliveTimeout === 0) return false;
    socket.setTimeout(timeout); return true;
  }
  reuseSocket(socket, req) { socket.ref(); socket.setTimeout(req._agentOptions.timeout || 0); req.reusedSocket = true; }
  freeSocket(socket, options) {
    if (socket._httpAgent !== this || socket._httpFree) return;
    const name = socket._httpAgentKey;
    this._remove(this.sockets, name, socket);
    const queue = this.requests[name]; let req;
    while (queue?.length) { req = queue.shift(); if (!req.destroyed) break; req = null; }
    if (queue && !queue.length) delete this.requests[name];
    if (req && !socket.destroyed && socket.writable) {
      (this.sockets[name] || (this.sockets[name] = [])).push(socket); this.reuseSocket(socket, req); req.onSocket(socket); return;
    }
    if (req) (this.requests[name] || (this.requests[name] = [])).unshift(req);
    if (!this.keepAlive || socket.destroyed || !socket.writable || (this.freeSockets[name]?.length || 0) >= this.maxFreeSockets || (this.sockets[name]?.length || 0) + (this.freeSockets[name]?.length || 0) >= this.maxSockets || !this.keepSocketAlive(socket)) socket.destroy();
    else { socket._httpFree = true; (this.freeSockets[name] || (this.freeSockets[name] = [])).push(socket); this.emit('free', socket, options); }
    // A free connection for another origin must not starve queued origins at
    // maxTotalSockets. Retire it so its close event can allocate the pending slot.
    if (this.totalSocketCount >= this.maxTotalSockets && Object.keys(this.requests).some(key => this.requests[key].some(item => !item.destroyed))) socket.destroy();
  }
  _remove(table, name, item) { const list = table[name]; if (!list) return; const index = list.indexOf(item); if (index >= 0) list.splice(index, 1); if (!list.length) delete table[name]; }
  removeSocket(socket, options) {
    if (socket._httpAgent !== this) return;
    socket._httpAgent = null;
    const name = socket._httpAgentKey; this._remove(this.sockets, name, socket); this._remove(this.freeSockets, name, socket);
    this.totalSocketCount--; this._drain();
  }
  _drain() {
    for (const name of Object.keys(this.requests)) {
      const queue = this.requests[name];
      while (queue.length && (this.sockets[name]?.length || 0) + (this._pendingSockets[name] || 0) < this.maxSockets && this.totalSocketCount < this.maxTotalSockets) {
        const req = queue.shift(); if (!req.destroyed) this.addRequest(req, req._agentOptions);
      }
      if (!queue.length) delete this.requests[name];
    }
  }
  destroy() {
    for (const table of [this.sockets, this.freeSockets]) for (const name of Object.keys(table)) for (const socket of table[name].slice()) socket.destroy();
  }
}
Agent.defaultMaxSockets = Infinity;
const globalAgent = new Agent({ keepAlive: true, scheduling: 'lifo', timeout: 5000 });
module.exports = { Agent, globalAgent };
