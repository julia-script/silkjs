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
function callback(parser, state, index, ...args) {
  const fn = parser[index];
  if (typeof fn !== 'function') return undefined;
  return state.resource ? state.resource.runInAsyncScope(fn, parser, ...args) : Reflect.apply(fn, parser, args);
}
function resetMessage(state) {
  state.headers = [];
  state.field = '';
  state.value = '';
  state.inField = false;
  state.url = '';
  state.status = '';
  state.flushed = false;
  state.headerPairs = 0;
  state.maxPairs = undefined;
  state.headersComplete = false;
  state.upgrade = false;
  state.eof = false;
}
function flush(parser, state) {
  if (!state.headers.length && !state.url) return;
  const headers = state.headers, url = state.url;
  state.headers = [];
  state.url = '';
  state.flushed = true;
  callback(parser, state, HTTPParser.kOnHeaders, headers, url);
}
function event(parser, state, kind, value, remaining) {
  state.remaining = remaining;
  switch (kind) {
    case 0:
      resetMessage(state);
      callback(parser, state, HTTPParser.kOnMessageBegin);
      break;
    case 1: state.url += value; break;
    case 2: state.status += value; break;
    case 3:
      if (!state.inField) {
        state.inField = true;
        state.headerPairs += 2;
        if (state.type === HTTPParser.REQUEST) {
          if (state.maxPairs === undefined) {
            const maximum = parser.maxHeaderPairs;
            state.maxPairs = typeof maximum === 'number' && maximum > 0 ? maximum : 0;
          }
          if (state.maxPairs > 0 && state.headerPairs > state.maxPairs) {
            native(9, state.id, 1);
            return 24;
          }
        }
        if (state.headers.length >= 62) flush(parser, state);
      }
      state.field += value;
      break;
    case 4: state.value += value; break;
    case 6:
      state.headers.push(state.field, state.value);
      state.field = state.value = '';
      state.inField = false;
      break;
    case 7: {
      const [major, minor, method, statusCode, upgrade, keepAlive, eof] = value;
      let headers = state.headers;
      let url = state.type === HTTPParser.REQUEST ? state.url : undefined;
      if (state.flushed) { flush(parser, state); headers = url = undefined; }
      state.headers = [];
      state.url = '';
      state.headerPairs = 0;
      state.maxPairs = undefined;
      state.headersComplete = true;
      state.upgrade = upgrade;
      state.eof = eof;
      const result = callback(parser, state, HTTPParser.kOnHeadersComplete,
        major, minor, headers, state.type === HTTPParser.REQUEST ? method : undefined,
        url, state.type === HTTPParser.RESPONSE ? statusCode : undefined,
        state.type === HTTPParser.RESPONSE ? state.status : undefined,
        upgrade, keepAlive);
      return state.pauseRequested && !result ? 21 : result | 0;
    }
    case 8: callback(parser, state, HTTPParser.kOnBody, Buffer.from(value)); break;
    case 9:
      if (state.headers.length) flush(parser, state);
      state.headerPairs = 0;
      state.headersComplete = false;
      callback(parser, state, HTTPParser.kOnMessageComplete);
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
    const state = { id: 0, type: HTTPParser.REQUEST, resource: null, provider: 0, frame: undefined, consuming: null,
      currentRead: null, executing: false, pauseRequested: false, remaining: 0, remainder: null };
    resetMessage(state);
    state.callback = (kind, value, remaining) => event(this, state, kind, value, remaining);
    state.id = native(0, new WeakRef(state.callback));
    states.set(this, state);
    finalizers.register(this, state.id, this);
  }
  initialize(type, resource, maxHeaderSize = 0, lenientFlags = 0) {
    const state = live(this);
    if (state.executing) throw error('ERR_INVALID_STATE', 'HTTP parser is already executing');
    if (type !== HTTPParser.REQUEST && type !== HTTPParser.RESPONSE)
      throw error('ERR_INVALID_ARG_VALUE', 'Invalid HTTP parser type');
    if (!Number.isSafeInteger(maxHeaderSize) || maxHeaderSize < 0)
      throw error('ERR_OUT_OF_RANGE', 'maxHeaderSize must be a nonnegative safe integer');
    this.remove();
    this.free();
    state.type = type;
    state.remaining = 0;
    state.remainder = null;
    state.pauseRequested = false;
    resetMessage(state);
    native(2, state.id, type, maxHeaderSize || 16384, lenientFlags >>> 0);
    state.provider = type === HTTPParser.REQUEST ? HTTPINCOMINGMESSAGE : HTTPCLIENTREQUEST;
    resetAsync(state, resource || this);
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
      if (status < 0) { callback(this, state, HTTPParser.kOnExecute, status); return; }
      if (!payload?.byteLength) return;
      const buffer = Buffer.from(payload);
      state.currentRead = buffer;
      try { callback(this, state, HTTPParser.kOnExecute, this.execute(buffer)); }
      finally { state.currentRead = null; }
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
  remove() { this.unconsume(); }
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

function takeRemainder(parser) { const state = stateOf(parser), value = state.remainder; state.remainder = null; return value; }
function remainingBytes(parser) { const state = stateOf(parser); return state.executing ? state.remaining : 0; }
function setUpgrade(parser, value) { const state = live(parser); state.upgrade = !!value; native(10, state.id, Number(!!value)); }
function needsEOF(parser) { return stateOf(parser).eof; }
function isExecuting(parser) { return stateOf(parser).executing; }
module.exports = { HTTPParser, methods, allMethods, takeRemainder, remainingBytes, setUpgrade, needsEOF, isExecuting };
