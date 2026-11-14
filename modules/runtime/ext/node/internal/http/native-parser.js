'use strict';

const host = require('internal/host');
const native = host.httpParserNative;
const { Buffer } = require('buffer');
const asyncHooks = require('async_hooks');
const { HTTPINCOMINGMESSAGE, HTTPCLIENTREQUEST } = asyncHooks.asyncWrapProviders;
const { isArrayBufferView } = require('util').types;
const states = new WeakMap();
const finalizers = new FinalizationRegistry(id => native(1, id));
const allMethods = native(8);
const methods = allMethods.filter((name, index) => index < 34 || index === 46);
const methodIndex = new Map(allMethods.map((name, index) => [name, index]));

// node_http_parser.cc: a parser given 0 takes the process's --max-http-header-size.
// Read at each initialize: the heap image may hold this module from before the options are set.
let options;
function defaultMaxHeaderSize() {
  options ??= require('internal/options');
  return options.getOptionValue('--max-http-header-size');
}
function error(code, message) { return Object.assign(new TypeError(message), { code }); }
function stateOf(parser) {
  const state = states.get(parser);
  if (!state) throw error('ERR_INVALID_THIS', 'Value of this must be an HTTPParser');
  return state;
}
function live(parser) {
  const state = stateOf(parser);
  if (!state.id) throw error('ERR_INVALID_STATE', 'HTTP parser is closed');
  return state;
}
const invoke = asyncHooks._invoke;
const call0 = (fn, self) => fn.call(self);
const call1 = (fn, self, a) => fn.call(self, a);
const call2 = (fn, self, a) => fn.call(self, a[0], a[1]);
// The native head ([major, minor, method, statusCode, upgrade, keepAlive, eof, url or status
// text, fields]) as kOnHeadersComplete's arguments, without an intermediate array.
const callRequestHead = (fn, self, a) => fn.call(self, a[0], a[1], a[8], a[2], a[7], undefined, undefined, a[4], a[5]);
const callResponseHead = (fn, self, a) => fn.call(self, a[0], a[1], a[8], undefined, undefined, a[3], a[7], a[4], a[5]);
// Parser callbacks run in the parser's async scope, with fixed arguments.
// When the parser consumes its socket, Node calls kOnHeaders, kOnBody and kOnExecute
// with MakeCallback, so the nextTick and microtask queues drain after them. Message
// begin, headers complete and message complete run with kSkipTaskQueues: the rest of
// the input (a pipelined request, a parse error) is parsed before any tick runs.
function callback(parser, state, index, call, value) {
  const fn = parser[index];
  if (typeof fn !== 'function') return undefined;
  const result = state.resource ? invoke(state.resource, call, fn, parser, value) : call(fn, parser, value);
  if (state.topLevel && drainsTicks[index]) host.checkpoint();
  return result;
}
// Indexed by callback slot (kOnHeaders 1, kOnBody 3, kOnExecute 5).
const drainsTicks = [false, true, false, true, false, true, false];
function resetMessage(state) {
  state.headersComplete = false;
  state.upgrade = false;
  state.eof = false;
}
// The native side gathers the url and fields of a head and calls once at headers
// complete (kind 7, value [major, minor, method, statusCode, upgrade, keepAlive,
// eof, url or status text, fields]); trailers arrive with message complete (kind 9).
function event(parser, state, kind, value, remaining) {
  state.remaining = remaining;
  // Like Node, a parser removed from its socket (freeParser) runs no more callbacks for
  // the rest of the input it is executing.
  if (state.beingFreed) return 0;
  switch (kind) {
    case 0:
      state.inMessage = true;
      resetMessage(state);
      if (state.connections) state.connections._begin(parser, state);
      callback(parser, state, HTTPParser.kOnMessageBegin, call0);
      break;
    case 7: {
      const request = state.type === HTTPParser.REQUEST;
      state.headersComplete = true;
      state.upgrade = value[4];
      state.eof = value[6];
      const result = callback(parser, state, HTTPParser.kOnHeadersComplete, request ? callRequestHead : callResponseHead, value);
      return state.pauseRequested && !result ? 21 : result | 0;
    }
    case 8: callback(parser, state, HTTPParser.kOnBody, call1, Buffer.from(value)); break;
    case 14: {
      // Like Node's TrackHeaderPair: the first field of a request's header section reads
      // maxHeaderPairs; a number above zero limits the fields to half of it.
      const limit = parser.maxHeaderPairs;
      if (typeof limit !== 'number' || !(limit > 0)) return 0;
      return Math.min(Math.max(1, Math.floor(limit)), 0x7fffffff);
    }
    case 9:
      state.inMessage = false;
      if (value !== undefined) callback(parser, state, HTTPParser.kOnHeaders, call2, [value, '']);
      state.headersComplete = false;
      if (state.connections) state.connections._complete(parser, state);
      callback(parser, state, HTTPParser.kOnMessageComplete, call0);
      break;
  }
  return state.pauseRequested && (kind === 0 || kind === 8 || kind === 9) ? 21 : 0;
}
function normalize(state, result) {
  state.remainder = null;
  if (Array.isArray(result)) {
    state.remainder = Buffer.from(result[1]);
    result = result[0];
  }
  // Like the errors Node's parser binding makes, the message is not enumerable.
  if (result instanceof Error && Object.getOwnPropertyDescriptor(result, 'message')?.enumerable)
    Object.defineProperty(result, 'message', { enumerable: false });
  if (result && typeof result === 'object' && result.code === 'HPE_USER' && typeof result.reason === 'string') {
    const colon = result.reason.indexOf(':');
    if (colon !== -1) {
      result.code = result.reason.slice(0, colon);
      result.reason = result.reason.slice(colon + 1);
    }
  }
  return result;
}
function resetAsync(state, owner, id) {
  state.resource?.emitDestroy();
  state.resource = null;
  state.frame = host.asyncContextFrame !== false ? asyncHooks._captureContext()?.stores : undefined;
  state.resource = asyncHooks._createResource(
    state.type === HTTPParser.REQUEST ? 'HTTPINCOMINGMESSAGE' : 'HTTPCLIENTREQUEST', owner, id);
}
class HTTPParser {
  constructor() {
    const state = { id: 0, type: HTTPParser.REQUEST, resource: null, connections: null, messageStart: 0, beingFreed: false, topLevel: false, provider: 0, frame: undefined, consuming: null,
      currentRead: null, list: null, executing: false, pauseRequested: false, remaining: 0, remainder: null,
      native: null, nativeBegun: false, inMessage: false, nativeLater: 0 };
    resetMessage(state);
    state.callback = (kind, value, remaining) => event(this, state, kind, value, remaining);
    state.id = native(0, new WeakRef(state.callback));
    states.set(this, state);
    finalizers.register(this, state.id, this);
  }
  initialize(type, resource, maxHeaderSize = 0, lenientFlags = 0, connectionsList = undefined) {
    const state = live(this);
    if (state.executing) throw error('ERR_INVALID_STATE', 'HTTP parser is already executing');
    if (type !== HTTPParser.REQUEST && type !== HTTPParser.RESPONSE)
      throw error('ERR_INVALID_ARG_VALUE', 'Invalid HTTP parser type');
    if (!Number.isSafeInteger(maxHeaderSize) || maxHeaderSize < 0)
      throw error('ERR_OUT_OF_RANGE', 'maxHeaderSize must be a nonnegative safe integer');
    HTTPParser.prototype.remove.call(this);
    HTTPParser.prototype.free.call(this);
    state.beingFreed = false;
    state.type = type;
    state.remaining = 0;
    state.remainder = null;
    state.pauseRequested = false;
    state.inMessage = false;
    state.nativeLater = 0;
    resetMessage(state);
    native(2, state.id, type, maxHeaderSize || defaultMaxHeaderSize(), lenientFlags >>> 0);
    state.provider = type === HTTPParser.REQUEST ? HTTPINCOMINGMESSAGE : HTTPCLIENTREQUEST;
    resetAsync(state, resource || this);
    if (connectionsList !== undefined) {
      if (!(connectionsList instanceof ConnectionsList)) throw error('ERR_INVALID_ARG_TYPE', 'connectionsList must be a ConnectionsList');
      state.connections = connectionsList;
      state.list = listOf(connectionsList);
      // Like Node, a connection that never sends a byte still has a deadline.
      connectionsList._begin(this, state);
    }
  }
  getAsyncId() { return stateOf(this).resource?.asyncId() ?? -1; }
  getProviderType() { const state = stateOf(this); return state.id ? state.provider : 0; }
  getAsyncContextFrameForDebuggingOnly() { return stateOf(this).frame; }
  asyncReset(resource, id) {
    const state = live(this);
    if (!state.provider) throw error('ERR_INVALID_STATE', 'HTTP parser is not initialized');
    if (resource === null || (typeof resource !== 'object' && typeof resource !== 'function'))
      throw error('ERR_INVALID_ARG_TYPE', 'resource must be an object');
    resetAsync(state, resource, id);
  }
  execute(buffer) {
    const state = live(this);
    if (!isArrayBufferView(buffer)) throw error('ERR_INVALID_ARG_TYPE', 'buffer must be an ArrayBuffer view');
    // Like Node, a callback may execute the parser again (a socket that pushes its next data
    // synchronously from 'information'); the outer execute then goes on with its own input.
    const executing = state.executing;
    const remaining = state.remaining;
    state.remaining = 0;
    state.executing = true;
    try { return normalize(state, native(3, state.id, buffer)); }
    finally { state.executing = executing; state.remaining = executing ? remaining : 0; }
  }
  finish() {
    const state = live(this);
    if (state.executing) throw error('ERR_INVALID_STATE', 'HTTP parser is already executing');
    state.executing = true;
    try {
      const result = normalize(state, native(4, state.id));
      return typeof result === 'number' ? undefined : result;
    } finally { state.executing = false; }
  }
  pause() {
    const state = live(this);
    state.pauseRequested = true;
    if (!state.executing) native(5, state.id);
  }
  resume() {
    const state = live(this);
    state.pauseRequested = false;
    if (!state.executing) native(6, state.id);
  }
  getCurrentBuffer() {
    const state = live(this);
    return state.currentRead ? Buffer.from(state.currentRead) : Buffer.from(native(7, state.id));
  }
  consume(handle) {
    const state = live(this);
    const binding = require('internal/net/binding');
    if (!binding.isStreamHandle(handle))
      throw error('ERR_INVALID_ARG_TYPE', 'stream must be a native socket handle');
    HTTPParser.prototype.unconsume.call(this);
    const consumer = { parser: this, read: (status, payload) => {
      // Like Node's parser stream listener, read errors and the end of the stream go on to
      // the socket's own read path.
      if (status < 0) return false;
      if (!payload?.byteLength) return true;
      // A plain view: execute only reads it during this event, and getCurrentBuffer copies.
      const buffer = payload instanceof ArrayBuffer ? new Uint8Array(payload) : payload;
      state.currentRead = buffer;
      state.topLevel = true;
      try { callback(this, state, HTTPParser.kOnExecute, call1, HTTPParser.prototype.execute.call(this, buffer)); }
      finally { state.currentRead = null; state.topLevel = false; }
      if (state.nativeLater !== 0) maybeNative(this, state, handle);
      return true;
    } };
    (handle._consumers ||= []).push(consumer);
    state.consuming = { handle, consumer };
    this._consumed = true;
  }
  unconsume() {
    const state = stateOf(this);
    // Requests net_native already read still come; then the head it holds, for execute().
    if (state.native) { state.native.released = true; state.native.handle._releaseHttp(); state.native = null; }
    if (state.consuming) {
      const { handle, consumer } = state.consuming;
      const at = handle._consumers.indexOf(consumer);
      if (at !== -1) handle._consumers.splice(at, 1);
      state.consuming = null;
    }
    this._consumed = false;
  }
  remove() {
    // A freed parser hears nothing more from net_native: the link is dead.
    if (stateOf(this).native) stateOf(this).native.dead = true;
    HTTPParser.prototype.unconsume.call(this);
    const state = stateOf(this);
    state.beingFreed = true;
    if (state.connections) { state.connections._remove(this); state.connections = null; state.list = null; }
  }
  free() {
    const state = stateOf(this);
    state.resource?.emitDestroy();
    state.resource = null;
    // AsyncWrap::EmitDestroy drops the context frame, so a pooled parser keeps no stores alive.
    state.frame = undefined;
  }
  close() {
    const state = stateOf(this);
    if (!state.id) return;
    HTTPParser.prototype.remove.call(this);
    HTTPParser.prototype.free.call(this);
    native(1, state.id);
    finalizers.unregister(this);
    state.id = 0;
    state.remainder = null;
    state.frame = undefined;
    resetMessage(state);
  }
}
for (const [name, value] of Object.entries({
  REQUEST: 1, RESPONSE: 2,
  kOnMessageBegin: 0, kOnHeaders: 1, kOnHeadersComplete: 2, kOnBody: 3,
  kOnMessageComplete: 4, kOnExecute: 5, kOnTimeout: 6,
  kLenientNone: 0, kLenientHeaders: 1, kLenientChunkedLength: 2,
  kLenientKeepAlive: 4, kLenientTransferEncoding: 8, kLenientVersion: 16,
  kLenientDataAfterClose: 32, kLenientOptionalLFAfterCR: 64,
  kLenientOptionalCRLFAfterChunk: 128, kLenientOptionalCRBeforeLF: 256,
  kLenientSpacesAfterChunkSize: 512, kLenientHeaderValueRelaxed: 1024,
  kLenientAll: 1023,
})) Object.defineProperty(HTTPParser, name, { value, enumerable: true });

// The connections of an HTTP server, for its header and request deadlines (Node's
// ConnectionsList binding). A parser is active from the start of a message (or from
// initialize) until the message completes.
const listStates = new WeakMap();
function listOf(list) {
  const state = listStates.get(list);
  if (!state) throw error('ERR_INVALID_THIS', 'Value of this must be a ConnectionsList');
  return state;
}
const byStart = (a, b) => {
  const x = states.get(a).messageStart, y = states.get(b).messageStart;
  if (x === 0 || y === 0) return x === y ? 0 : x === 0 ? -1 : 1;
  return x - y;
};
class ConnectionsList {
  constructor() { listStates.set(this, { all: new Set(), active: new Set() }); }
  all() { return [...listOf(this).all].sort(byStart); }
  idle() { return this.all().filter(parser => states.get(parser).messageStart === 0); }
  active() { return [...listOf(this).active].sort(byStart); }
  expired(headersTimeout, requestTimeout) {
    if (typeof headersTimeout !== 'number' || typeof requestTimeout !== 'number')
      throw error('ERR_INVALID_ARG_TYPE', 'timeouts must be numbers');
    headersTimeout >>>= 0; requestTimeout >>>= 0;
    if (headersTimeout === 0 && requestTimeout === 0) return [];
    if (requestTimeout > 0 && headersTimeout > requestTimeout) [headersTimeout, requestTimeout] = [requestTimeout, headersTimeout];
    const now = host.now();
    const headersDeadline = headersTimeout > 0 && now > headersTimeout ? now - headersTimeout : 0;
    const requestDeadline = requestTimeout > 0 && now > requestTimeout ? now - requestTimeout : 0;
    if (headersDeadline === 0 && requestDeadline === 0) return [];
    const list = listOf(this), result = [];
    for (const parser of this.active()) {
      const state = states.get(parser);
      if ((!state.headersComplete && headersDeadline > 0 && state.messageStart < headersDeadline) ||
          (requestDeadline > 0 && state.messageStart < requestDeadline)) {
        result.push(parser);
        list.active.delete(parser);
      }
    }
    return result;
  }
  _begin(parser, state) {
    const list = state.list ?? listOf(this);
    state.messageStart = host.now();
    list.all.add(parser); list.active.add(parser);
  }
  _complete(parser, state) {
    const list = state.list ?? listOf(this);
    list.active.delete(parser);
    state.messageStart = 0;
    list.all.add(parser);
  }
  _remove(parser) {
    const list = listOf(this);
    list.all.delete(parser); list.active.delete(parser);
  }
}

// node:http connections whose requests net_native reads (its node mode): simple heads arrive as
// [method, url, name, value, ...] and run the callbacks llhttp would run for them, in the same
// order and async scope as parser.consume; any other head comes back as bytes for llhttp
// (fallback), which then consumes the socket as usual. A parser that unconsumed its socket
// still gets the requests already read, then executes the bytes of the head held natively.
function consumeNative(parser, handle, maxHeaderSize) {
  const state = live(parser);
  if (state.type !== HTTPParser.REQUEST || state.consuming || typeof handle?._adoptHttp !== 'function') return false;
  const link = { handle, dead: false, released: false, begin: null, request: null, fallback: null };
  link.begin = first => { if (!link.dead && !link.released) nativeBegin(parser, state, first); };
  link.request = (flags, record) => { if (!link.dead) nativeRequest(parser, state, link, flags, record); };
  link.fallback = bytes => { if (!link.dead) nativeFallback(parser, state, link, bytes); };
  link.stray = bytes => { if (!link.dead) nativeStray(parser, state, link, bytes); };
  if (!handle._adoptHttp(link, maxHeaderSize || defaultMaxHeaderSize())) return false;
  state.native = link;
  state.nativeBegun = false;
  parser._consumed = true;
  return true;
}
// A read that ends inside a head: message begin for its first bytes, and kOnExecute for the
// read, as llhttp's execute of it would.
function nativeBegin(parser, state, first) {
  if (!state.id) return;
  if (first && !state.nativeBegun) {
    state.nativeBegun = true;
    event(parser, state, 0, undefined, 0);
  }
  state.topLevel = true;
  try { callback(parser, state, HTTPParser.kOnExecute, call1, 0); }
  finally { state.topLevel = false; }
}
// The bytes of a request net_native read: llhttp gets them when the parser no longer takes
// net_native's requests.
function requestBytes(flags, record) {
  let text = `${record[0]} ${record[1]} HTTP/1.${(flags & 4) !== 0 ? 0 : 1}\r\n`;
  for (let i = 2; i < record.length; i += 2) text += `${record[i]}: ${record[i + 1]}\r\n`;
  return Buffer.from(text + '\r\n', 'latin1');
}
let incoming;
function nativeRequest(parser, state, link, flags, record) {
  if (link.released) { HTTPParser.prototype.execute.call(parser, requestBytes(flags, record)); return; }
  if (!state.id) return;
  state.topLevel = true;
  state.executing = true;
  try {
    if (!state.nativeBegun) event(parser, state, 0, undefined, 0);
    state.nativeBegun = false;
    // [major, minor, method, statusCode, upgrade, keepAlive, eof, url, fields]
    const head = [1, (flags & 4) !== 0 ? 0 : 1, methodIndex.get(record[0]), 0, false, true, false, record[1], record.slice(2)];
    // The request's stream starts lean (_http_incoming kLean).
    incoming ??= require('_http_incoming');
    incoming.makeLeanNext(true);
    try { event(parser, state, 7, head, 0); }
    finally { incoming.makeLeanNext(false); }
    event(parser, state, 9, undefined, 0);
  } finally { state.executing = false; }
  // The last request of a read ends its execute (HTTP_MORE, 16, marks the others).
  try { if ((flags & 16) === 0) callback(parser, state, HTTPParser.kOnExecute, call1, 0); }
  finally { state.topLevel = false; }
}
function nativeFallback(parser, state, link, bytes) {
  if (state.native === link) state.native = null;
  const buffer = bytes?.byteLength ? new Uint8Array(bytes) : null;
  if (link.released) {
    if (buffer && state.id) HTTPParser.prototype.execute.call(parser, buffer);
    return;
  }
  // A head net_native does not read: llhttp reads the connection from its first byte on.
  // The bytes came with this read, which llhttp executes whole even when an earlier request
  // in it paused the socket.
  HTTPParser.prototype.consume.call(parser, link.handle);
  if (buffer) {
    if (link.handle._pendingReads.length) link.handle._dispatch(1, buffer.byteLength, bytes);
    else link.handle._readForConsumer(buffer.byteLength, bytes);
  }
}
// Bytes the handle got around net_native (a TLS session's plaintext from JavaScript's record
// pump, from before net_native took its records): they come first, so llhttp reads them and
// the connection, as after a fallback.
function nativeStray(parser, state, link, bytes) {
  if (!link.released) {
    link.released = true;
    if (state.native === link) state.native = null;
    link.handle._releaseHttp();
    HTTPParser.prototype.consume.call(parser, link.handle);
  }
  if (state.consuming) link.handle._readForConsumer(bytes.byteLength, bytes);
  else if (state.id) HTTPParser.prototype.execute.call(parser, new Uint8Array(bytes));
}
// A TLS connection of a node:http server starts with llhttp: its session goes native after the
// handshake, when the first request is read already (internal/tls/transport attachNative). Once
// llhttp is between messages and the session runs natively, net_native reads the requests.
function consumeNativeLater(parser, handle, maxHeaderSize) {
  const state = live(parser);
  if (state.type !== HTTPParser.REQUEST || typeof handle?._adoptHttp !== 'function') return;
  state.nativeLater = maxHeaderSize || defaultMaxHeaderSize();
}
function maybeNative(parser, state, handle) {
  if (state.inMessage || state.executing || state.pauseRequested || state.upgrade || state.remainder !== null ||
      !state.id || state.beingFreed || state.consuming?.handle !== handle || handle._transport?.native !== true) return;
  const maxHeaderSize = state.nativeLater;
  const { consumer } = state.consuming;
  const at = handle._consumers.indexOf(consumer);
  if (at !== -1) handle._consumers.splice(at, 1);
  state.consuming = null;
  if (consumeNative(parser, handle, maxHeaderSize)) { state.nativeLater = 0; return; }
  // Not now (the carrier holds reads, the session went back): llhttp goes on reading.
  (handle._consumers ||= []).push(consumer);
  state.consuming = { handle, consumer };
  parser._consumed = true;
}
function takeRemainder(parser) { const state = stateOf(parser), value = state.remainder; state.remainder = null; return value; }
function remainingBytes(parser) { const state = stateOf(parser); return state.executing ? state.remaining : 0; }
function setUpgrade(parser, value) { const state = live(parser); state.upgrade = !!value; native(10, state.id, Number(!!value)); }
function needsEOF(parser) { return stateOf(parser).eof; }
function isExecuting(parser) { return stateOf(parser).executing; }
module.exports = { HTTPParser, ConnectionsList, methods, allMethods, consumeNative, consumeNativeLater, takeRemainder, remainingBytes, setUpgrade, needsEOF, isExecuting };
