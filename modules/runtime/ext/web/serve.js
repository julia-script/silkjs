'use strict';

// serve({ fetch, port, hostname, error }): an HTTP/1.1 server for fetch handlers. The runtime reads
// each connection in Silk (silk.http's head parser and body framing over net_native sockets), and
// writes each response head and body with one system call. A handler takes a Request and returns
// a Response, or a promise of one. Responses go out in request order on a connection.

const host = require('internal/host');
const { AsyncResource } = require('async_hooks');
const { Response, readResponse, takeResponseText, responseState, serverRequest } = require('internal/web/fetch/message');
const { headerList } = require('internal/web/fetch/headers');
const { URL } = require('internal/url');
const { _memoryBytes: memoryBytes } = require('internal/web/blob');

// net_native event kinds and statuses.
const READ = 1, ACCEPTED = 2, SHUT = 5, CLOSED = 6, HTTP_REQUEST = 9;
// Request flags.
const KEEP_ALIVE = 1, HAS_BODY = 2;
// Response flags.
const CLOSE = 1, NO_BODY = 2, STREAM = 4, HAS_LENGTH = 8, HAS_DATE = 16;
const httpRespond = host.httpRespond, httpChunk = host.httpChunk, httpRespondText = host.httpRespondText;
// A streamed response waits for the socket above this many unsent bytes.
const STREAM_HIGH_WATER = 1 << 20;
const hooksActive = require('async_hooks')._hooksActive;
// Reports an error as uncaught from within the server's resource.
function rethrow(error) { throw error; }

function codeError(Kind, code, message) { const error = new Kind(message); error.code = code; return error; }
function systemError(status, syscall, address, port) {
  const info = host.net('error', [status]);
  const error = new Error(`${syscall} ${info.code}${address === undefined ? '' : ` ${address}:${port}`}`);
  error.code = info.code; error.errno = status; error.syscall = syscall;
  if (address !== undefined) { error.address = address; error.port = port; }
  return error;
}

// The fields of one response, gathered by addField from a Headers map.
// knownLength: the server writes content-length itself, so the handler's own is dropped.
let fields = [], fieldCount = 0, fieldFlags = 0, knownLength = false;
function addField(values, name) {
  // The server frames the message itself.
  if (name === 'transfer-encoding' || name === 'connection' || name === 'keep-alive') return;
  if (name === 'content-length') { if (knownLength) return; fieldFlags |= HAS_LENGTH; }
  else if (name === 'date') fieldFlags |= HAS_DATE;
  if (name === 'set-cookie') { for (let i = 0; i < values.length; i++) { fields[fieldCount++] = name; fields[fieldCount++] = values[i]; } return; }
  fields[fieldCount++] = name;
  fields[fieldCount++] = values.length === 1 ? values[0] : values.join(name === 'cookie' ? '; ' : ', ');
}

class Connection {
  constructor(server, id) {
    this.server = server; this.id = id;
    // Requests whose responses wait for an earlier one: { flags, head, response, done }.
    this.queue = [];
    // finished: the last response went out and the write side is shut; the peer closes next.
    this.streaming = false; this.ended = false; this.finished = false; this.closing = false; this.closed = false;
    const connection = this;
    // Events come from the loop's poll, which drains microtasks after the whole batch, so a
    // callback does not drain them itself.
    // The handler runs in the server's async scope. With no async hooks to tell, entering that
    // scope is one context switch, or none from the loop's own.
    this.callback = (type, status, payload, extra) => {
      if (hooksActive()) host.invokeResource(server._resource, connectionEvent, connection, [type, status, payload, extra], false);
      else {
        const scope = server._scope, previous = host.getAsyncContext();
        if (previous !== scope) host.setAsyncContext(scope);
        try { if (type === HTTP_REQUEST) request(connection, status, payload, extra); else connectionEvent.call(connection, type, status, payload, extra); }
        catch (error) { host.invokeResource(server._resource, rethrow, undefined, [error], false); }
        finally { if (previous !== scope) host.setAsyncContext(previous); }
      }
    };
  }
  close() {
    if (this.closing || this.closed) return;
    this.closing = true;
    host.net('close', [this.id]);
  }
}

function connectionEvent(type, status, payload, extra) {
  if (type === HTTP_REQUEST) { request(this, status, payload, extra); return; }
  if (type === READ) {
    // The peer ended, or reading failed: close once every request has its response.
    this.ended = true;
    if (this.queue.length === 0 && !this.streaming) this.close();
    return;
  }
  if (type === SHUT) { this.close(); return; }
  if (type === CLOSED) {
    this.closed = true;
    this.server._connections.delete(this.id);
    this.server._drained();
  }
}

function request(connection, flags, payload, bytes) {
  const server = connection.server;
  const req = serverRequest(payload, server._authority, (flags & HAS_BODY) !== 0 ? bytes : undefined);
  const head = payload[0] === 'HEAD';
  server._pending++;
  let result;
  // A method call: the handler sees the server as `this`, as Bun's does.
  try { result = server._fetch(req, server); }
  catch (error) { result = server._failure(error); }
  // The common case: a kept-alive GET answered at once with a Response made from text alone.
  if ((flags & KEEP_ALIVE) !== 0 && !head && connection.queue.length === 0 && !connection.streaming && !server._stopping) {
    const text = takeResponseText(result);
    if (text !== undefined) {
      server._pending--;
      if (connection.closed || connection.closing || connection.finished) return;
      if (httpRespondText(connection.id, 200, '', 'text/plain;charset=UTF-8', text) < 0) connection.close();
      return;
    }
  }
  if (result instanceof Response && connection.queue.length === 0 && !connection.streaming) { send(connection, flags, head, result); return; }
  const slot = { flags, head, response: result, done: result instanceof Response };
  connection.queue.push(slot);
  if (slot.done) return;
  Promise.resolve(result).then(
    response => settle(connection, slot, response),
    error => settle(connection, slot, server._failure(error)));
}

function settle(connection, slot, response) {
  slot.response = response; slot.done = true;
  flush(connection);
}

function flush(connection) {
  const queue = connection.queue;
  while (queue.length !== 0 && queue[0].done && !connection.streaming) {
    const slot = queue.shift();
    send(connection, slot.flags, slot.head, slot.response);
  }
  if (queue.length === 0 && !connection.streaming && connection.ended) connection.close();
}

function send(connection, requestFlags, head, response) {
  const server = connection.server;
  server._pending--;
  if (connection.closed || connection.closing || connection.finished) return;
  // The common case: a kept-alive GET answered with text and no headers of its own.
  if ((requestFlags & KEEP_ALIVE) !== 0 && !head && !server._stopping) {
    const text = takeResponseText(response);
    if (text !== undefined) {
      if (httpRespondText(connection.id, 200, '', 'text/plain;charset=UTF-8', text) < 0) connection.close();
      return;
    }
  }
  const fast = readResponse(response);
  if (fast !== undefined && fast.fields === null && (requestFlags & KEEP_ALIVE) !== 0 && !head && !server._stopping) {
    const payload = fast.body;
    if (payload !== null && payload.text !== null && payload.current === null && payload.encoded === null) {
      payload.used = true;
      if (httpRespondText(connection.id, fast.status, fast.statusText, fast.contentType, payload.text) < 0) connection.close();
      return;
    }
  }
  if (!(response instanceof Response)) response = server._failure(new TypeError(`Expected a Response object, but received '${response}'`));
  let record;
  try { record = responseState(response); }
  catch (error) { response = server._failure(error); record = responseState(response); }
  const close = (requestFlags & KEEP_ALIVE) === 0 || server._stopping;
  let flags = close ? CLOSE : 0;
  if (head) flags |= NO_BODY;
  const payload = record.body;
  // Text, bytes, or a Blob in memory: a body of known length. The server encodes text itself.
  let data = null;
  if (payload !== null && payload.current === null) {
    data = payload.encoded !== null ? payload.encoded : payload.text !== null ? payload.text : memoryBytes(payload.source);
    if (data === undefined) data = null;
  }
  fieldCount = 0; fieldFlags = 0; knownLength = data !== null;
  // A Response made without headers has at most its body's content-type.
  if (record.fields === null) {
    if (record.contentType !== null) { fields[0] = 'content-type'; fields[1] = record.contentType; fieldCount = 2; }
  } else headerList(record.headers).forEach(addField);
  let status;
  if (payload === null) {
    status = httpRespond(connection.id, record.status, record.statusText, fields, fieldCount, undefined, 0, 0, flags | fieldFlags);
  } else if (data !== null) {
    payload.used = true;
    status = typeof data === 'string'
      ? httpRespond(connection.id, record.status, record.statusText, fields, fieldCount, data, 0, 0, flags | (fieldFlags & HAS_DATE))
      : httpRespond(connection.id, record.status, record.statusText, fields, fieldCount, data.buffer, data.byteOffset, data.length, flags | (fieldFlags & HAS_DATE));
  } else {
    stream(connection, record, flags | (fieldFlags & HAS_DATE), payload);
    return;
  }
  fieldCount = 0;
  if (status < 0) { connection.close(); return; }
  if (close) { connection.finished = true; host.net('shutdown', [connection.id, 0]); }
}

// Writes a body of unknown length as chunks, then the requests behind it.
function stream(connection, record, flags, payload) {
  connection.streaming = true;
  const id = connection.id;
  const close = (flags & CLOSE) !== 0;
  let status = httpRespond(id, record.status, record.statusText, fields, fieldCount, undefined, 0, 0, flags | STREAM);
  fieldCount = 0;
  const reader = payload.stream.getReader();
  payload.used = true;
  const finish = failed => {
    connection.streaming = false;
    if (failed || connection.closed) { connection.close(); return; }
    if (close) { connection.finished = true; host.net('shutdown', [id, 0]); return; }
    flush(connection);
  };
  const pump = () => {
    if (status < 0 || connection.closed) { reader.cancel().catch(() => {}); finish(true); return; }
    reader.read().then(({ done, value }) => {
      if (done) {
        status = (flags & NO_BODY) !== 0 ? 1 : httpChunk(id, undefined, 0, 0);
        finish(status < 0);
        return;
      }
      if (!(value instanceof Uint8Array)) { reader.cancel(new TypeError('Received non-Uint8Array chunk')).catch(() => {}); finish(true); return; }
      if ((flags & NO_BODY) === 0 && value.byteLength !== 0) status = httpChunk(id, value.buffer, value.byteOffset, value.byteLength);
      if (status === 0 && host.net('httpPending', [id]) > STREAM_HIGH_WATER) setTimeout(pump, 1);
      else pump();
    }, () => finish(true));
  };
  pump();
}

class Server {
  constructor(options) {
    this._fetch = options.fetch;
    this._error = options.error;
    this._resource = new AsyncResource('HTTPSERVER');
    // The async context handlers run in: the resource's own scope.
    host.invokeResource(this._resource, () => { this._scope = host.getAsyncContext(); }, undefined, [], false);
    this._connections = new Map();
    this._pending = 0;
    this._stopping = false;
    this._stopped = false;
    this._waiters = [];
    let hostname = options.hostname === undefined ? '0.0.0.0' : String(options.hostname);
    const address = hostname === 'localhost' ? '127.0.0.1' : hostname;
    const port = options.port === undefined ? 3000 : +options.port;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw codeError(RangeError, 'ERR_SOCKET_BAD_PORT', `Invalid port: ${options.port}`);
    if (host.net('isIP', [address]) === 0) throw codeError(TypeError, 'ERR_INVALID_ARG_VALUE', `serve() needs an IP address or localhost as hostname, received '${hostname}'`);
    const server = this;
    const callback = (type, status, child) => {
      host.invokeResource(server._resource, serverEvent, server, [type, status, child], false);
      host.checkpoint();
    };
    const id = host.net('create', [1, callback]);
    if (id < 0) throw systemError(id, 'socket');
    let code = host.net('bind', [id, address, port, 0]);
    if (code >= 0) code = host.net('listen', [id, options.backlog === undefined ? 511 : options.backlog, 0]);
    if (code < 0) { host.net('close', [id]); throw systemError(code, 'listen', address, port); }
    this._id = id;
    const bound = host.net('address', [id, 0]);
    this.port = bound && bound.port !== undefined ? bound.port : port;
    this.hostname = hostname;
    this._authority = (address.includes(':') ? `[${address}]` : address === '0.0.0.0' ? 'localhost' : hostname) + ':' + this.port;
  }
  get url() { return new URL(`http://${this._authority}/`); }
  get pendingRequests() { return this._pending; }
  get development() { return false; }
  ref() { if (!this._stopped) host.net('ref', [this._id]); return this; }
  unref() { if (!this._stopped) host.net('unref', [this._id]); return this; }
  // Stops accepting connections. Connections close after their responses, or at once with
  // closeActiveConnections. The promise settles when every connection has closed.
  stop(closeActiveConnections = false) {
    if (!this._stopped) { this._stopped = true; this._stopping = true; host.net('close', [this._id]); }
    for (const connection of this._connections.values()) {
      if (closeActiveConnections || (connection.queue.length === 0 && !connection.streaming)) connection.close();
    }
    return new Promise(resolve => { this._waiters.push(resolve); this._drained(); });
  }
  _drained() {
    if (!this._stopped || this._connections.size !== 0) return;
    const waiters = this._waiters; this._waiters = [];
    for (const resolve of waiters) resolve();
  }
  _failure(error) {
    if (typeof this._error === 'function') {
      try {
        const handled = this._error.call(this, error);
        if (handled instanceof Response) return handled;
      } catch (nested) { error = nested; }
    }
    // Like an uncaught handler error in Bun: reported, and answered with a 500.
    console.error(error);
    return new Response('Internal Server Error', { status: 500, headers: { 'content-type': 'text/plain;charset=utf-8' } });
  }
}

function serverEvent(type, status, child) {
  if (type !== ACCEPTED) return;
  if (status < 0) return;
  if (this._stopped) { host.net('close', [child]); return; }
  const connection = new Connection(this, child);
  this._connections.set(child, connection);
  host.net('callback', [child, connection.callback]);
  host.net('noDelay', [child, 1, 0]);
  if (host.net('httpAdopt', [child]) < 0) connection.close();
}

function serve(options, handler) {
  if (typeof options === 'function') { const fetch = options; options = handler === undefined ? {} : handler; options = { ...options, fetch }; }
  if (options === null || typeof options !== 'object') throw codeError(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "options" argument must be an object');
  if (typeof options.fetch !== 'function') throw codeError(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "options.fetch" property must be a function');
  return new Server(options);
}

module.exports = { serve, Server };
