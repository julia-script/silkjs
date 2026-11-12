'use strict';

// fetch's own HTTP/1.1 client, as undici's Client is for Node's fetch: a keep-alive pool
// per origin, the runtime's llhttp parser driven directly, and response bytes handed to
// the caller without node:http's ClientRequest and IncomingMessage. Used when fetch has
// no Undici dispatcher (transport.js); a dispatcher owns its own connections.

const host = require('internal/host');
const native = host.httpParserNative;
const net = require('net');
const dc = require('diagnostics_channel');
const { performance } = require('perf_hooks');

const RESPONSE = 2;
// Undici's defaults (lib/dispatcher/client.js): keep an idle socket 4 s, or what the
// server's Keep-Alive timeout hint says less 2 s, within [1 s, 10 min].
const keepAliveTimeout = 4e3;
const keepAliveTimeoutThreshold = 2e3;
const keepAliveMaxTimeout = 600e3;

// Undici's request lifecycle channels, which Node's inspector (network_undici.js) and
// tracing tools subscribe to.
const channels = {
  create: dc.channel('undici:request:create'),
  bodyChunkSent: dc.channel('undici:request:bodyChunkSent'),
  bodySent: dc.channel('undici:request:bodySent'),
  headers: dc.channel('undici:request:headers'),
  bodyChunkReceived: dc.channel('undici:request:bodyChunkReceived'),
  trailers: dc.channel('undici:request:trailers'),
  error: dc.channel('undici:request:error'),
};
function observed() {
  return channels.create.hasSubscribers || channels.headers.hasSubscribers || channels.trailers.hasSubscribers ||
    channels.error.hasSubscribers || channels.bodySent.hasSubscribers || channels.bodyChunkSent.hasSubscribers ||
    channels.bodyChunkReceived.hasSubscribers;
}
// The fields of undici's Request that channel subscribers read; addHeader lets a
// subscriber of undici:request:create add a header before the request is written.
class ChannelRequest {
  constructor(origin, method, path, headers, body) {
    this.origin = origin; this.method = method; this.path = path; this.headers = headers;
    this.body = body; this.completed = false; this.aborted = false; this.upgrade = null;
    this.idempotent = method === 'GET' || method === 'HEAD';
  }
  addHeader(name, value) { this.headers.push(name, value); return this; }
}

const idle = new Map();
const sessions = new Map();
let maximumHeaderSize;

class Connection {
  constructor(key, socket) {
    this.key = key;
    this.socket = socket;
    this.exchange = null;
    this.used = false;
    this.reused = false;
    this.keepAlive = false;
    this.timeout = keepAliveTimeout;
    this.timer = null;
    this.closed = false;
    // The parser holds its callback weakly; the connection keeps it alive.
    this.callback = (kind, value) => this.event(kind, value);
    this.parser = native(0, new WeakRef(this.callback));
    native(2, this.parser, RESPONSE, maximumHeaderSize ??= require('http').maxHeaderSize, 0);
    socket.on('data', chunk => this.data(chunk));
    socket.on('end', () => this.ended());
    socket.on('error', error => this.close(error));
    socket.on('close', () => this.close());
  }
  data(chunk) {
    const exchange = this.exchange;
    if (exchange === null) { this.close(); return; }
    exchange.received = true;
    const result = native(3, this.parser, chunk);
    if (typeof result !== 'number') {
      const error = Array.isArray(result) ? result[0] : result;
      if (error instanceof Error) this.close(error);
    }
  }
  event(kind, value) {
    const exchange = this.exchange;
    if (exchange === null) return 0;
    switch (kind) {
      case 7: {
        const status = value[3];
        // A 1xx other than 101 is an interim response; the final one follows.
        if (status >= 100 && status < 200 && status !== 101) { exchange.information(); return 1; }
        if (status === 101 || value[4]) { this.close(new Error('Unexpected protocol upgrade')); return 2; }
        this.keepAlive = value[5];
        if (this.keepAlive) this.timeout = hintedTimeout(value[8]);
        exchange.head(status, value[7], value[8]);
        return exchange.skipBody ? 1 : 0;
      }
      case 8: exchange.body(new Uint8Array(value)); return 0;
      case 9:
        // The interim response's completion; the exchange goes on.
        if (!exchange.headed) return 0;
        this.exchange = null;
        exchange.complete(value);
        this.release();
        return 0;
    }
    return 0;
  }
  ended() {
    // A body delimited by the end of the connection completes here.
    if (this.exchange !== null && !this.closed) {
      const result = native(4, this.parser);
      if (result instanceof Error) { this.close(result); return; }
    }
    this.close();
  }
  release() {
    if (this.closed) return;
    if (!this.keepAlive || this.socket.destroyed) { this.close(); return; }
    let list = idle.get(this.key);
    if (list === undefined) idle.set(this.key, list = []);
    list.push(this);
    // An idle socket still reads, so a server that closes it is noticed.
    this.socket.resume();
    this.socket.unref();
    // One timer per connection, re-armed on each release; it does nothing while busy.
    if (this.timer === null || this.timer._idleTimeout !== this.timeout) {
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = setTimeout(() => { if (this.exchange === null) this.close(); }, this.timeout);
      this.timer.unref();
    } else this.timer.refresh();
  }
  take(exchange) {
    this.reused = this.used;
    this.used = true;
    this.exchange = exchange;
    this.socket.ref();
  }
  close(error) {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    const list = idle.get(this.key);
    if (list !== undefined) {
      const at = list.indexOf(this);
      if (at !== -1) list.splice(at, 1);
      if (!list.length) idle.delete(this.key);
    }
    const exchange = this.exchange;
    this.exchange = null;
    if (!this.socket.destroyed) this.socket.destroy();
    native(1, this.parser);
    if (exchange !== null) exchange.closed(error, this.reused);
  }
  // A socket the caller gives up on mid-exchange cannot carry another request.
  abandon() { this.exchange = null; this.close(); }
}
// Keep-Alive: timeout=N, as undici reads it (lib/dispatcher/client-h1.js).
function hintedTimeout(fields) {
  for (let i = 0; i < fields.length; i += 2) {
    if (fields[i].length !== 10 || fields[i].toLowerCase() !== 'keep-alive') continue;
    const match = /timeout=(\d+)/.exec(fields[i + 1]);
    if (match) return Math.max(Math.min(Number(match[1]) * 1000 - keepAliveTimeoutThreshold, keepAliveMaxTimeout), 1000);
  }
  return keepAliveTimeout;
}
function pooled(key) {
  const list = idle.get(key);
  while (list !== undefined && list.length) {
    const connection = list.pop();
    if (!list.length) idle.delete(key);
    if (!connection.closed && !connection.socket.destroyed) return connection;
  }
  return null;
}
function connect(url, key, timing) {
  const secure = url.protocol === 'https:';
  let hostname = url.hostname;
  if (hostname[0] === '[') hostname = hostname.slice(1, -1);
  const port = Number(url.port) || (secure ? 443 : 80);
  const connection = { connectionStartTime: performance.now() };
  timing.finalConnectionTimingInfo = connection;
  let socket;
  if (secure) {
    const tls = require('tls');
    socket = tls.connect({
      host: hostname, port, servername: net.isIP(hostname) ? undefined : hostname,
      ALPNProtocols: ['http/1.1'], session: sessions.get(key),
    });
    socket.on('session', session => sessions.set(key, session));
    socket.once('secureConnect', () => {
      connection.connectionEndTime = performance.now();
      connection.ALPNNegotiatedProtocol = socket.alpnProtocol || 'http/1.1';
    });
  } else socket = net.connect({ host: hostname, port });
  socket.once('lookup', () => { connection.domainLookupEndTime = performance.now(); });
  socket.once('connect', () => {
    if (secure) connection.secureConnectionStartTime = performance.now();
    else { connection.connectionEndTime = performance.now(); connection.ALPNNegotiatedProtocol = 'http/1.1'; }
  });
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 60e3);
  return new Connection(key, socket);
}

// One request and its response over a pooled connection. send(socket) writes the
// request; handler receives the response: information(), head(status, text, fields),
// body(bytes), complete(), fail(error).
class Exchange {
  constructor(url, skipBody, replayable, request, send, handler, timing) {
    this.url = url; this.skipBody = skipBody; this.replayable = replayable; this.request = request;
    this.send = send; this.handler = handler; this.timing = timing;
    this.connection = null; this.received = false; this.headed = false; this.done = false; this.retried = false;
    this.key = url.protocol + '//' + url.host;
  }
  start(fresh = false) {
    let connection = fresh ? null : pooled(this.key);
    if (connection === null) connection = connect(this.url, this.key, this.timing);
    else this.timing.finalConnectionTimingInfo = undefined;
    this.connection = connection;
    connection.take(this);
    this.send(connection.socket);
  }
  information() { this.handler.information(); }
  head(status, text, fields) {
    this.headed = true;
    if (this.request !== null && channels.headers.hasSubscribers) {
      const { Buffer } = require('buffer');
      channels.headers.publish({ request: this.request, response: { statusCode: status, statusText: text, headers: fields.map(field => Buffer.from(field, 'latin1')) } });
    }
    this.handler.head(status, text, fields);
  }
  body(bytes) {
    if (this.request !== null && channels.bodyChunkReceived.hasSubscribers) channels.bodyChunkReceived.publish({ request: this.request, chunk: bytes });
    this.handler.body(bytes);
  }
  complete(trailers) {
    this.done = true;
    if (this.request !== null) {
      this.request.completed = true;
      if (channels.trailers.hasSubscribers) channels.trailers.publish({ request: this.request, trailers: trailers || [] });
    }
    this.handler.complete();
  }
  closed(error, reused) {
    if (this.done) return;
    // An idle connection the server closed before this request's response began: send
    // it again on a new one, as long as nothing of its body is gone.
    if (reused && !this.received && this.replayable && !this.retried) {
      this.retried = true;
      this.start(true);
      return;
    }
    this.done = true;
    const failure = error || new Error('other side closed');
    if (this.request !== null) {
      this.request.aborted = true;
      if (channels.error.hasSubscribers) channels.error.publish({ request: this.request, error: failure });
    }
    this.handler.fail(failure);
  }
  // The caller is done with the response before its end.
  abort() {
    if (this.done) return;
    this.done = true;
    if (this.connection !== null) this.connection.abandon();
  }
  // Backpressure from the response body; once the response is done, the connection may
  // carry another exchange.
  pause() { if (!this.done) this.connection.socket.pause(); }
  resume() { if (!this.done) this.connection.socket.resume(); }
}

module.exports = { Exchange, ChannelRequest, channels, observed };
