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
const callHead = (fn, self, a) => fn.call(self, a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8]);
// Parser callbacks run in the parser's async scope, with fixed arguments.
function callback(parser, state, index, call, value) {
  const fn = parser[index];
  if (typeof fn !== 'function') return undefined;
  return state.resource ? invoke(state.resource, call, fn, parser, value) : call(fn, parser, value);
}
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
      resetMessage(state);
      if (state.connections) state.connections._begin(parser, state);
      callback(parser, state, HTTPParser.kOnMessageBegin, call0);
      break;
    case 7: {
      const request = state.type === HTTPParser.REQUEST;
      state.headersComplete = true;
      state.upgrade = value[4];
      state.eof = value[6];
      const result = callback(parser, state, HTTPParser.kOnHeadersComplete, callHead,
        [value[0], value[1], value[8], request ? value[2] : undefined, request ? value[7] : undefined,
          request ? undefined : value[3], request ? undefined : value[7], value[4], value[5]]);
      return state.pauseRequested && !result ? 21 : result | 0;
    }
    case 8: callback(parser, state, HTTPParser.kOnBody, call1, Buffer.from(value)); break;
    case 9:
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
    const state = { id: 0, type: HTTPParser.REQUEST, resource: null, connections: null, messageStart: 0, beingFreed: false, provider: 0, frame: undefined, consuming: null,
      currentRead: null, executing: false, pauseRequested: false, remaining: 0, remainder: null, maxHeaderPairs: undefined };
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
    this.remove();
    this.free();
    state.beingFreed = false;
    state.type = type;
    state.remaining = 0;
    state.remainder = null;
    state.pauseRequested = false;
    resetMessage(state);
    native(2, state.id, type, maxHeaderSize || 16384, lenientFlags >>> 0);
    state.provider = type === HTTPParser.REQUEST ? HTTPINCOMINGMESSAGE : HTTPCLIENTREQUEST;
    resetAsync(state, resource || this);
    if (connectionsList !== undefined) {
      if (!(connectionsList instanceof ConnectionsList)) throw error('ERR_INVALID_ARG_TYPE', 'connectionsList must be a ConnectionsList');
      state.connections = connectionsList;
      // Like Node, a connection that never sends a byte still has a deadline.
      connectionsList._begin(this, state);
    }
  }
  get maxHeaderPairs() { return states.get(this)?.maxHeaderPairs; }
  set maxHeaderPairs(value) {
    const state = stateOf(this);
    state.maxHeaderPairs = value;
    if (state.id) native(11, state.id, typeof value === 'number' && value > 0 ? value : 0);
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
    if (state.executing) throw error('ERR_INVALID_STATE', 'HTTP parser is already executing');
    if (!isArrayBufferView(buffer)) throw error('ERR_INVALID_ARG_TYPE', 'buffer must be an ArrayBuffer view');
    state.remaining = 0;
    state.executing = true;
    try { return normalize(state, native(3, state.id, buffer)); }
    finally { state.executing = false; state.remaining = 0; }
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
    const socket = handle?.owner;
    if (!socket || socket._transport !== handle || typeof handle.readStop !== 'function')
      throw error('ERR_INVALID_ARG_TYPE', 'stream must be a native socket handle');
    this.unconsume();
    const consumer = { parser: this, read: (status, payload) => {
      // Like Node's parser stream listener, read errors and the end of the stream go on to
      // the socket's own read path.
      if (status < 0) return false;
      if (!payload?.byteLength) return true;
      const buffer = Buffer.from(payload);
      state.currentRead = buffer;
      try { callback(this, state, HTTPParser.kOnExecute, call1, this.execute(buffer)); }
      finally { state.currentRead = null; }
      return true;
    } };
    (socket._streamConsumers ||= []).push(consumer);
    state.consuming = { socket, consumer };
    this._consumed = true;
  }
  unconsume() {
    const state = stateOf(this);
    if (state.consuming) {
      const { socket, consumer } = state.consuming;
      const at = socket._streamConsumers.indexOf(consumer);
      if (at !== -1) socket._streamConsumers.splice(at, 1);
      state.consuming = null;
    }
    this._consumed = false;
  }
  remove() {
    this.unconsume();
    const state = stateOf(this);
    state.beingFreed = true;
    if (state.connections) { state.connections._remove(this); state.connections = null; }
  }
  free() {
    const state = stateOf(this);
    state.resource?.emitDestroy();
    state.resource = null;
  }
  close() {
    const state = stateOf(this);
    if (!state.id) return;
    this.remove();
    this.free();
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
    const list = listOf(this);
    state.messageStart = host.now();
    list.all.add(parser); list.active.add(parser);
  }
  _complete(parser, state) {
    const list = listOf(this);
    list.active.delete(parser);
    state.messageStart = 0;
    list.all.add(parser);
  }
  _remove(parser) {
    const list = listOf(this);
    list.all.delete(parser); list.active.delete(parser);
  }
}

function takeRemainder(parser) { const state = stateOf(parser), value = state.remainder; state.remainder = null; return value; }
function remainingBytes(parser) { const state = stateOf(parser); return state.executing ? state.remaining : 0; }
function setUpgrade(parser, value) { const state = live(parser); state.upgrade = !!value; native(10, state.id, Number(!!value)); }
function needsEOF(parser) { return stateOf(parser).eof; }
function isExecuting(parser) { return stateOf(parser).executing; }
module.exports = { HTTPParser, ConnectionsList, methods, allMethods, takeRemainder, remainingBytes, setUpgrade, needsEOF, isExecuting };
