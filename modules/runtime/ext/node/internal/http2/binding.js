'use strict';
// The JS side of Node.js v24's internalBinding('http2') (src/node_http2.cc,
// Copyright Node.js contributors, MIT license, see THIRD_PARTY_NOTICES), built on
// the nghttp2 memory session in src/ext/http2_native.silk.
//
// The native session queues one record per nghttp2 callback. Node calls into JS
// from inside those callbacks; this binding drains the records right after each
// native call that can produce them and makes the same calls in the same order,
// with the same receiving/sending guards Node uses to avoid reentering nghttp2.
//
// Records are Int32LE kind, id, flags, a, b, length, then the payload:
//   1 header pair (a: name length, flags: nv flags)
//   2 frame received (a: frame type, b: headers category, promised id, or DATA length)
//   3 DATA chunk          4 stream closed (a: code)       5 frame sent (a: type)
//   6 write chunk taken   7 trailers wanted               8 GOAWAY (id: last stream, a: code)
//   9 frame not sent (a: library code, b: type)          10 too many invalid frames
//  11 ALTSVC (a: origin length)  12 ORIGIN entry  13 ORIGIN end
//  14 invalid frame (a: library code)                    15 library error (a: code)
const host = require('internal/host');
const perfEntries = require('internal/perf_observers');
const { Buffer } = require('buffer');
const { AsyncResource } = require('async_hooks');
const constants = require('internal/http2/constants');

const {
  NGHTTP2_SESSION_SERVER,
  NGHTTP2_NV_FLAG_NO_INDEX,
  STREAM_OPTION_EMPTY_PAYLOAD,
  STREAM_OPTION_GET_TRAILERS,
  NGHTTP2_NO_ERROR,
  NGHTTP2_PROTOCOL_ERROR,
  NGHTTP2_INTERNAL_ERROR,
  NGHTTP2_FLOW_CONTROL_ERROR,
  NGHTTP2_STREAM_CLOSED,
  NGHTTP2_FRAME_SIZE_ERROR,
  NGHTTP2_REFUSED_STREAM,
  NGHTTP2_CANCEL,
  NGHTTP2_COMPRESSION_ERROR,
  NGHTTP2_ENHANCE_YOUR_CALM,
  NGHTTP2_STREAM_STATE_IDLE,
} = constants;

const UV_EOF = -4095;
const UV_ECANCELED = -125;

const NGHTTP2_ERR_INVALID_ARGUMENT = -501;
const NGHTTP2_ERR_PROTO = -505;
const NGHTTP2_ERR_STREAM_CLOSED = -510;
const NGHTTP2_ERR_STREAM_CLOSING = -511;
const NGHTTP2_ERR_FRAME_SIZE_ERROR = -522;
const NGHTTP2_ERR_HEADER_COMP = -523;
const NGHTTP2_ERR_FLOW_CONTROL = -524;
const NGHTTP2_ERR_SESSION_CLOSING = -530;
const NGHTTP2_ERR_HTTP_HEADER = -531;
const NGHTTP2_ERR_HTTP_MESSAGING = -532;
const NGHTTP2_ERR_REFUSED_STREAM = -533;
const NGHTTP2_ERR_SETTINGS_EXPECTED = -536;
const NGHTTP2_ERR_FATAL = -900;

const FRAME_DATA = 0;
const FRAME_HEADERS = 1;
const FRAME_PRIORITY = 2;
const FRAME_RST_STREAM = 3;
const FRAME_SETTINGS = 4;
const FRAME_PUSH_PROMISE = 5;
const FRAME_PING = 6;
const FRAME_GOAWAY = 7;
const FLAG_END_STREAM = 1;
const FLAG_ACK = 1;

// SessionJSFields: bitfield, priority and frameError listener counts, then the
// uint32 invalid frame and rejected stream limits.
const kBitfield = 0;
const kSessionPriorityListenerCount = 1;
const kSessionFrameErrorListenerCount = 2;
const kSessionMaxInvalidFrames = 4;
const kSessionMaxRejectedStreams = 8;
const kSessionUint8FieldCount = 12;
const kSessionHasRemoteSettingsListeners = 0;
const kSessionRemoteSettingsIsUpToDate = 1;
const kSessionHasPingListeners = 2;
const kSessionHasAltsvcListeners = 3;

// IDX_SETTINGS_* order and the nghttp2 identifiers they hold.
const settingIds = [1, 2, 4, 5, 3, 6, 8];
const IDX_SETTINGS_COUNT = 7;
// HTTP2_SETTINGS order in node_http2.h, which packed settings follow.
const packOrder = [0, 1, 4, 2, 3, 5, 6];
const MAX_ADDITIONAL_SETTINGS = 10;
const defaultSettings = [4096, 1, 65535, 16384, 0xffffffff, 65535, 0];

const settingsBuffer = new Uint32Array(IDX_SETTINGS_COUNT + 1 + 1 + 2 * MAX_ADDITIONAL_SETTINGS);
const optionsBuffer = new Uint32Array(14);
const sessionState = new Float64Array(9);
const streamState = new Float64Array(6);

const nameForErrorCode = [
  'NGHTTP2_NO_ERROR', 'NGHTTP2_PROTOCOL_ERROR', 'NGHTTP2_INTERNAL_ERROR',
  'NGHTTP2_FLOW_CONTROL_ERROR', 'NGHTTP2_SETTINGS_TIMEOUT', 'NGHTTP2_STREAM_CLOSED',
  'NGHTTP2_FRAME_SIZE_ERROR', 'NGHTTP2_REFUSED_STREAM', 'NGHTTP2_CANCEL',
  'NGHTTP2_COMPRESSION_ERROR', 'NGHTTP2_CONNECT_ERROR', 'NGHTTP2_ENHANCE_YOUR_CALM',
  'NGHTTP2_INADEQUATE_SECURITY', 'NGHTTP2_HTTP_1_1_REQUIRED',
];

let callbacks;
function setCallbackFunctions(error, priority, settings, ping, headers, frameError,
                              goawayData, altsvc, origin, streamTrailers, streamClose) {
  callbacks = { error, priority, settings, ping, headers, frameError, goawayData, altsvc, origin, streamTrailers, streamClose };
}

// Buffer::Copy: a buffer with its own memory.
function copy(view) {
  const out = Buffer.allocUnsafeSlow(view.length);
  out.set(view);
  return out;
}

function bytes(value) {
  if (!ArrayBuffer.isView(value)) return value;
  if (value.byteOffset === 0 && value.byteLength === value.buffer.byteLength) return value.buffer;
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
}
// Native failures throw an ERR_HTTP2_ERROR carrying the nghttp2 code; the binding
// returns the code, as Node's binding does.
function call(op, ...args) {
  for (let i = 0; i < args.length; i++) args[i] = bytes(args[i]);
  try { return host.http2(op, args); } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ERR_HTTP2_ERROR' && typeof error.errno === 'number') return error.errno;
    throw error;
  }
}

function nghttp2ErrorString(code) {
  return Buffer.from(call('strerror', code >>> 0 === code ? code | 0 : code)).toString('latin1');
}

function translateNghttp2ErrorCode(code) {
  switch (code) {
    case NGHTTP2_ERR_STREAM_CLOSED: return NGHTTP2_STREAM_CLOSED;
    case NGHTTP2_ERR_HEADER_COMP: return NGHTTP2_COMPRESSION_ERROR;
    case NGHTTP2_ERR_FRAME_SIZE_ERROR: return NGHTTP2_FRAME_SIZE_ERROR;
    case NGHTTP2_ERR_FLOW_CONTROL: return NGHTTP2_FLOW_CONTROL_ERROR;
    case NGHTTP2_ERR_REFUSED_STREAM: return NGHTTP2_REFUSED_STREAM;
    case NGHTTP2_ERR_PROTO:
    case NGHTTP2_ERR_HTTP_HEADER:
    case NGHTTP2_ERR_HTTP_MESSAGING:
      return NGHTTP2_PROTOCOL_ERROR;
    default: return NGHTTP2_INTERNAL_ERROR;
  }
}

// Http2Headers: Node's NgHeaders string is name\0value\0flags per header, in latin1.
function packHeaders(list) {
  const text = list[0];
  const count = list[1];
  const parts = new Array(count);
  let size = 0;
  let at = 0;
  for (let i = 0; i < count; i++) {
    const nameEnd = text.indexOf('\0', at);
    const valueEnd = text.indexOf('\0', nameEnd + 1);
    const name = text.slice(at, nameEnd);
    const value = text.slice(nameEnd + 1, valueEnd);
    const flags = text.charCodeAt(valueEnd + 1);
    at = valueEnd + 2;
    parts[i] = [name, value, flags & NGHTTP2_NV_FLAG_NO_INDEX];
    size += 12 + name.length + value.length;
  }
  const out = Buffer.allocUnsafe(size);
  let offset = 0;
  for (const [name, value, flags] of parts) {
    out.writeUInt32LE(name.length, offset);
    out.writeUInt32LE(value.length, offset + 4);
    out.writeUInt32LE(flags, offset + 8);
    offset += 12;
    offset += out.write(name, offset, 'latin1');
    offset += out.write(value, offset, 'latin1');
  }
  return out;
}

// Http2Settings::Init: the entries the settings buffer selects.
function settingsEntries() {
  const flags = settingsBuffer[IDX_SETTINGS_COUNT];
  const entries = [];
  for (const i of packOrder) {
    if (flags & (1 << i)) entries.push([settingIds[i], settingsBuffer[i]]);
  }
  const extra = settingsBuffer[IDX_SETTINGS_COUNT + 1];
  for (let i = 0; i < extra; i++) {
    entries.push([settingsBuffer[IDX_SETTINGS_COUNT + 2 + i * 2], settingsBuffer[IDX_SETTINGS_COUNT + 3 + i * 2]]);
  }
  return entries;
}

function packSettings() {
  const entries = settingsEntries();
  const out = Buffer.allocUnsafe(entries.length * 6);
  for (let i = 0; i < entries.length; i++) {
    out.writeUInt16BE(entries[i][0] & 0xffff, i * 6);
    out.writeUInt32BE(entries[i][1] >>> 0, i * 6 + 2);
  }
  return out;
}

function refreshDefaultSettings() {
  let flags = 0;
  for (let i = 0; i < IDX_SETTINGS_COUNT; i++) {
    settingsBuffer[i] = defaultSettings[i];
    flags |= 1 << i;
  }
  settingsBuffer[IDX_SETTINGS_COUNT] = flags;
  settingsBuffer[IDX_SETTINGS_COUNT + 1] = 0;
}

let hrtimeBase;
function hrtimeNs() {
  hrtimeBase ??= process.hrtime.bigint;
  return hrtimeBase();
}

// Node's MakeCallback: the callback runs in the handle's async context, an
// exception is reported as uncaught, and when no JS is below on the stack the
// next-tick and microtask queues drain afterwards.
let outermost = false;
function makeCallback(resource, fn, receiver, args) {
  if (typeof fn !== 'function') return undefined;
  let result;
  const drain = outermost;
  outermost = false;
  try {
    result = resource.runInAsyncScope(fn, receiver, ...args);
  } catch (error) {
    require('internal/startup_controls').handleUncaught(error, 'uncaughtException');
  }
  if (drain) host.checkpoint();
  outermost = drain;
  return result;
}
// Entry points that Node reaches from libuv rather than from JS.
function fromLoop(fn) {
  const previous = outermost;
  outermost = true;
  try { return fn(); } finally { outermost = previous; }
}

class Http2Ping {
  constructor(session, callback) {
    this.session = session;
    this.callback = callback;
    this.start = hrtimeNs();
    this.resource = new AsyncResource('HTTP2PING');
  }
  send(payload) {
    let data = payload;
    if (data === undefined) {
      data = Buffer.allocUnsafe(8);
      data.writeBigUInt64LE(this.start);
    }
    this.session.scope(() => { call('ping', this.session.id, data); });
  }
  done(ack, payload) {
    const rtt = hrtimeNs() - this.start;
    const duration = Number(rtt) / 1e6;
    if (ack) this.session.stats.pingRTT = Number(rtt);
    makeCallback(this.resource, this.callback, this, [ack, duration, payload === undefined ? undefined : copy(payload)]);
    this.resource.emitDestroy();
  }
}

class Http2Settings {
  constructor(session, callback) {
    this.session = session;
    this.callback = callback;
    this.entries = settingsEntries();
    this.resource = new AsyncResource('HTTP2SETTINGS');
  }
  send() {
    const session = this.session;
    session.updateLocalCustomSettings(this.entries);
    const packed = Buffer.allocUnsafe(this.entries.length * 8);
    for (let i = 0; i < this.entries.length; i++) {
      packed.writeInt32LE(this.entries[i][0] | 0, i * 8);
      packed.writeUInt32LE(this.entries[i][1] >>> 0, i * 8 + 4);
    }
    session.scope(() => { call('settings', session.id, packed); });
  }
  done(ack) {
    // Like Node, the start time of a settings round trip is not recorded.
    const duration = Number(hrtimeNs()) / 1e6;
    makeCallback(this.resource, this.callback, this, [ack, duration]);
    this.resource.emitDestroy();
  }
}

class Http2Stream {
  constructor(session, id, options = 0) {
    this.session = session;
    this.streamId = id;
    this.resource = new AsyncResource('HTTP2STREAM');
    // Http2Stream statistics: hrtime values in ns, start also as a host.now() time.
    this.stats = { start: hrtimeNs(), startTime: host.now(), firstHeader: 0n, firstByte: 0n, firstByteSent: 0n, sentBytes: 0, receivedBytes: 0 };
    this.destroyed = false;
    this.closed = false;
    this.writable = true;
    this.reading = false;
    this.peerReset = false;
    this.hasTrailers = !!(options & STREAM_OPTION_GET_TRAILERS);
    this.hasProvider = false;
    this.code = NGHTTP2_NO_ERROR;
    this.consumedWhilePaused = 0;
    // Queued chunks: the write request completes with the last chunk of its write.
    this.queue = [];
    this.onread = undefined;
    if (options & STREAM_OPTION_EMPTY_PAYLOAD) this.writable = false;
    session.streams.set(id, this);
    const stats = session.stats;
    stats.streamCount++;
    if (session.streams.size > stats.maxConcurrentStreams) stats.maxConcurrentStreams = session.streams.size;
  }
  emitStatistics() {
    const session = this.session;
    const stats = this.stats;
    const end = hrtimeNs();
    session.stats.streamAverageDuration = Number(end - stats.start) / session.stats.streamCount / 1e6;
    if (!perfEntries.observing('http2')) return;
    const since = (value) => Number(value - stats.start) / 1e6;
    const detail = {
      bytesRead: stats.receivedBytes,
      bytesWritten: stats.sentBytes,
      id: this.streamId,
      timeToFirstByte: since(stats.firstByte),
      timeToFirstByteSent: since(stats.firstByteSent),
      timeToFirstHeader: since(stats.firstHeader),
    };
    const duration = Number(end - stats.start) / 1e6;
    setImmediate(() => {
      if (perfEntries.observing('http2')) perfEntries.emit('Http2Stream', 'http2', stats.startTime, duration, detail);
    });
  }
  id() { return this.streamId; }
  getAsyncId() { return this.resource.asyncId(); }
  get isStreamBase() { return true; }

  readStart() {
    const session = this.session;
    session.scope(() => {
      this.reading = true;
      if (this.consumedWhilePaused && session.alive()) call('consume', session.id, this.streamId, this.consumedWhilePaused);
      this.consumedWhilePaused = 0;
    });
    return 0;
  }
  readStop() {
    this.reading = false;
    return 0;
  }
  shutdown(req) {
    if (this.destroyed) return UV_EOF;
    this.session.scope(() => {
      this.writable = false;
      if (this.hasProvider && this.session.alive()) call('end', this.session.id, this.streamId, this.hasTrailers ? 1 : 0);
    });
    return 1;
  }
  write(req, buffers) {
    const session = this.session;
    if (!this.writable || this.destroyed) return UV_EOF;
    session.scope(() => {
      let last = -1;
      for (let i = 0; i < buffers.length; i++) if (buffers[i].length) last = i;
      // Empty chunks send nothing; a write of only empty chunks completes with the next send.
      if (last === -1) {
        session.outgoing.push(req);
        return;
      }
      for (let i = 0; i <= last; i++) {
        if (!buffers[i].length) continue;
        this.queue.push({ req: i === last ? req : null, length: buffers[i].length });
        if (session.alive()) call('write', session.id, this.streamId, buffers[i]);
      }
    });
    return 0;
  }
  respond(headers, options) {
    const session = this.session;
    let result = 0;
    session.scope(() => {
      if (options & STREAM_OPTION_GET_TRAILERS) this.hasTrailers = true;
      if (!this.writable) options |= STREAM_OPTION_EMPTY_PAYLOAD;
      result = call('respond', session.id, this.streamId, packHeaders(headers), options & STREAM_OPTION_EMPTY_PAYLOAD ? 1 : 0);
      if (result >= 0 && !(options & STREAM_OPTION_EMPTY_PAYLOAD)) this.hasProvider = true;
    });
    return result;
  }
  info(headers) {
    let result = 0;
    this.session.scope(() => { result = call('info', this.session.id, this.streamId, packHeaders(headers), 0); });
    return result;
  }
  trailers(headers) {
    let result = 0;
    // Like Node, empty trailers end the stream with an empty DATA frame instead.
    this.session.scope(() => {
      result = headers[1] === 0 ? call('finish', this.session.id, this.streamId) :
        call('trailers', this.session.id, this.streamId, packHeaders(headers), 0);
    });
    return result;
  }
  pushPromise(headers, options) {
    const session = this.session;
    let result = 0;
    session.scope(() => { result = call('push', session.id, this.streamId, packHeaders(headers), 0); });
    if (result <= 0) return result;
    const stream = new Http2Stream(session, result, options);
    stream.hasProvider = false;
    return stream;
  }
  rstStream(code) {
    if (this.destroyed) return;
    this.submitRstStream(code >>> 0);
  }
  submitRstStream(code) {
    const session = this.session;
    this.code = code;
    if (session.receiving) {
      if (code === NGHTTP2_ENHANCE_YOUR_CALM || code === NGHTTP2_REFUSED_STREAM) this.flushRstStream();
      else session.addPendingRstStream(this.streamId);
      return;
    }
    if (session.inScope && code === NGHTTP2_CANCEL) {
      session.addPendingRstStream(this.streamId);
      return;
    }
    if (session.inScope && code === NGHTTP2_REFUSED_STREAM) {
      this.flushRstStream();
      return;
    }
    if (session.sendPendingData() !== 0) {
      session.addPendingRstStream(this.streamId);
      return;
    }
    this.flushRstStream();
  }
  flushRstStream() {
    const session = this.session;
    if (!session) return;
    session.removePendingRstStream(this.streamId);
    session.scope(() => { if (session.alive()) call('rst', session.id, this.streamId, this.code); });
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    const session = this.session;
    if (session.receiving) {
      setImmediate(() => this.completeDestroy());
      return;
    }
    if (session.pendingRstStreams.includes(this.streamId)) this.flushRstStream();
    this.completeDestroy();
  }
  completeDestroy() {
    const session = this.session;
    if (session.pendingRstStreams.includes(this.streamId)) this.flushRstStream();
    if (session.streams.get(this.streamId) === this) session.streams.delete(this.streamId);
    this.emitStatistics();
    setImmediate(() => {
      // Writes still queued when the stream goes away never complete.
      const queue = this.queue;
      this.queue = [];
      for (const { req } of queue) if (req) session.completeWrite(req, UV_ECANCELED);
      this.resource.emitDestroy();
    });
  }
  refreshState() {
    const session = this.session;
    const state = session.alive() ? call('streamState', session.id, this.streamId) : 0;
    if (state <= 0) {
      streamState[0] = NGHTTP2_STREAM_STATE_IDLE;
      streamState[1] = streamState[2] = streamState[3] = streamState[4] = streamState[5] = 0;
      return;
    }
    streamState[0] = state;
    streamState[1] = call('weight', session.id, this.streamId);
    streamState[2] = call('sumWeight', session.id, this.streamId);
    streamState[3] = call('localClose', session.id, this.streamId);
    streamState[4] = call('remoteClose', session.id, this.streamId);
    streamState[5] = call('localWindow', session.id, this.streamId);
  }
}

function packOptions(type) {
  const flags = optionsBuffer[13];
  const packed = Buffer.alloc(64);
  let nativeFlags = 0;
  // IDX_OPTIONS_* slots the native session applies, with their native flag bits.
  const slots = [[0, 1, 4], [1, 2, 8], [2, 4, 12], [3, 8, 16], [9, 16, 20]];
  for (const [index, bit, offset] of slots) {
    if (!(flags & (1 << index))) continue;
    nativeFlags |= bit;
    packed.writeUInt32LE(optionsBuffer[index], offset);
  }
  if (flags & (1 << 12)) {
    nativeFlags |= 32;
    packed.writeUInt32LE(optionsBuffer[12], 60);
  }
  packed.writeUInt32LE(nativeFlags, 0);
  const memory = flags & (1 << 8) ? optionsBuffer[8] * 1000000 : 10000000;
  packed.writeUInt32LE(memory % 4294967296, 24);
  packed.writeUInt32LE(Math.floor(memory / 4294967296), 56);
  let pairs = flags & (1 << 5) ? optionsBuffer[5] : 128;
  pairs = Math.max(pairs, type === NGHTTP2_SESSION_SERVER ? 4 : 1);
  packed.writeUInt32LE(pairs, 28);
  packed.writeUInt32LE(flags & (1 << 4) ? optionsBuffer[4] : 0, 32);
  if ((flags & (1 << 10)) && (flags & (1 << 11))) {
    packed.writeUInt32LE(optionsBuffer[11], 44);
    packed.writeUInt32LE(optionsBuffer[10], 48);
    packed.writeUInt32LE(1, 52);
  }
  return packed;
}

class Http2Session {
  constructor(type) {
    const flags = optionsBuffer[13];
    this.type = type;
    this.resource = new AsyncResource('HTTP2SESSION');
    this.fields = new Uint8Array(kSessionUint8FieldCount);
    const limits = new Uint32Array(this.fields.buffer, 4, 2);
    limits[0] = 1000;
    limits[1] = 100;
    this.limits = limits;
    this.pushedLimits = [-1, -1];
    this.maxOutstandingPings = flags & (1 << 6) ? optionsBuffer[6] : 10;
    this.maxOutstandingSettings = flags & (1 << 7) ? optionsBuffer[7] : 10;
    this.id = call('create', type === NGHTTP2_SESSION_SERVER ? 1 : 0, packOptions(type));
    if (this.id < 0) throw Object.assign(new Error(nghttp2ErrorString(this.id)), { code: 'ERR_HTTP2_ERROR', errno: this.id });
    this.released = false;
    // Settings as JS sees them: nghttp2 applies a whole received chunk before the
    // records are dispatched, so each SETTINGS frame and ACK is applied here in turn.
    this.localMirror = new Array(IDX_SETTINGS_COUNT);
    this.remoteMirror = new Array(IDX_SETTINGS_COUNT);
    for (let i = 0; i < IDX_SETTINGS_COUNT; i++) {
      this.localMirror[i] = call('localSetting', this.id, settingIds[i]);
      this.remoteMirror[i] = call('remoteSetting', this.id, settingIds[i]);
    }
    this.remoteSettingsSeen = false;
    this.stats = { start: host.now(), bytesWritten: 0, bytesRead: 0, framesReceived: 0, framesSent: 0, maxConcurrentStreams: 0, pingRTT: 0, streamAverageDuration: 0, streamCount: 0 };
    this.streams = new Map();
    this.localCustomSettings = [];
    // FetchAllowedRemoteCustomSettings: ids the peer may set, without values yet.
    this.remoteCustomSettings = [];
    const allowed = settingsBuffer[IDX_SETTINGS_COUNT + 1];
    for (let i = 0; i < allowed; i++) this.remoteCustomSettings.push({ id: settingsBuffer[IDX_SETTINGS_COUNT + 2 + i * 2] & 0xffff, value: 0, set: false });
    this.pings = [];
    this.outstandingSettings = [];
    this.pendingRstStreams = [];
    this.outgoing = [];
    this.headers = new Map();
    this.origins = [];
    this.socket = null;
    this.onSocketData = null;
    this.closing = false;
    this.destroyed = false;
    this.closePending = false;
    this.pendingCloseCode = 0;
    this.pendingCloseSocketClosed = false;
    this.receiving = false;
    this.sending = false;
    this.writeInProgress = false;
    this.writeScheduled = false;
    this.inScope = false;
    this.readingStopped = false;
    this.gracefulClose = false;
    this.goawayInitiated = false;
    this.internalGoawaySent = false;
    this.customRecvErrorCode = null;
    this.chunksSent = 0;
    this.ondone = null;
    this.ongracefulclosecomplete = null;
  }
  alive() { return !this.released; }
  getAsyncId() { return this.resource.asyncId(); }

  // Http2Scope: operations from JS schedule a write for the next loop turn.
  scope(fn) {
    if (this.inScope || this.writeScheduled) return fn();
    this.inScope = true;
    try { return fn(); } finally {
      this.inScope = false;
      if (!this.writeScheduled) this.maybeScheduleWrite();
    }
  }
  maybeScheduleWrite() {
    if (!this.alive()) return;
    if (!call('wantWrite', this.id) && !this.outgoing.length) return;
    this.writeScheduled = true;
    setImmediate(() => {
      if (!this.alive() || !this.writeScheduled) return;
      fromLoop(() => this.sendPendingData());
    });
  }

  consume(socket) {
    this.socket = socket;
    this.onSocketData = (chunk) => {
      if (this.destroyed || this.socket !== socket) return;
      fromLoop(() => this.onStreamRead(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
    };
    socket.on('data', this.onSocketData);
    // Node's session reads from the socket handle whether or not the JS socket was paused.
    socket.resume();
  }
  onStreamRead(buffer) {
    if (buffer.length === 0 || !this.alive() || this.destroyed) return;
    this.stats.bytesRead += buffer.length;
    this.scope(() => this.consumeData(buffer));
    this.maybeStopReading();
    // Node notifies only after a write. Data from a socket the user paused (for
    // example one passed through createConnection after a 'readable' listener)
    // can arrive after the last write, so a read that leaves nothing to do
    // completes a graceful close too.
    if (!this.writeInProgress) this.maybeNotifyGracefulCloseComplete();
  }
  consumeData(buffer) {
    const limits = this.limits;
    if (limits[0] !== this.pushedLimits[0] || limits[1] !== this.pushedLimits[1]) {
      call('limits', this.id, limits[0], limits[1]);
      this.pushedLimits = [limits[0], limits[1]];
    }
    this.customRecvErrorCode = null;
    this.receiving = true;
    let ret;
    try {
      ret = call('recv', this.id, buffer);
      this.drain();
    } finally {
      this.receiving = false;
    }
    this.maybeFinishPendingClose();
    if (ret >= 0 && !this.destroyed) this.sendPendingData();
    if (ret < 0) makeCallback(this.resource, callbacks.error, this, [ret, this.customRecvErrorCode]);
  }
  maybeStopReading() {
    if (this.readingStopped || this.closing || !this.alive() || !this.socket) return;
    if (!this.wantRead()) {
      this.readingStopped = true;
      this.socket.pause();
    }
  }
  wantRead() {
    // nghttp2 wants to read unless it has finished both directions; wantIO
    // includes pending output, which is handled by the write path.
    return call('wantIO', this.id) !== 0;
  }

  // Dispatches every queued record.
  drain() {
    while (this.alive()) {
      const data = call('poll', this.id);
      if (data.byteLength === 0) return;
      this.dispatch(Buffer.from(data));
    }
  }
  dispatch(record) {
    const kind = record.readInt32LE(0);
    const id = record.readInt32LE(4);
    const flags = record.readInt32LE(8);
    const a = record.readInt32LE(12);
    const b = record.readInt32LE(16);
    const payload = record.subarray(24, 24 + record.readInt32LE(20));
    // A deferred close drops what is still coming in, like Node's callbacks do
    // while Close() waits for nghttp2_session_mem_recv() to return.
    if (this.closePending && (kind === 1 || kind === 2 || kind === 3)) return;
    switch (kind) {
      case 1: {
        let block = this.headers.get(id);
        if (block === undefined) this.headers.set(id, block = { names: [], sensitive: [] });
        const name = payload.toString('latin1', 0, a);
        block.names.push(name, payload.toString('latin1', a, payload.length));
        const target = this.streams.get(id);
        if (target !== undefined && target.stats.firstHeader === 0n) target.stats.firstHeader = hrtimeNs();
        if (flags & NGHTTP2_NV_FLAG_NO_INDEX) block.sensitive.push(name);
        return;
      }
      case 2:
        this.stats.framesReceived++;
        return this.onFrame(id, flags, a, b, payload);
      case 3: return this.onData(id, payload);
      case 4: return this.onStreamClose(id, a >>> 0);
      case 5: {
        this.stats.framesSent++;
        if (a === FRAME_GOAWAY && !this.closing && !this.destroyed && !this.gracefulClose && !this.goawayInitiated) {
          this.internalGoawaySent = true;
        }
        return;
      }
      case 6: {
        const stream = this.streams.get(id);
        if (stream === undefined || stream.queue.length === 0) return;
        const { req, length } = stream.queue.shift();
        if (stream.stats.firstByteSent === 0n) stream.stats.firstByteSent = hrtimeNs();
        stream.stats.sentBytes += length;
        if (req) this.outgoing.push(req);
        return;
      }
      case 7: {
        const stream = this.streams.get(id);
        if (stream === undefined || stream.destroyed) return;
        stream.hasTrailers = false;
        makeCallback(stream.resource, callbacks.streamTrailers, stream, []);
        return;
      }
      case 8: {
        makeCallback(this.resource, callbacks.goawayData, this, [a >>> 0, id, payload.length ? copy(payload) : undefined]);
        return;
      }
      case 9: return this.onFrameNotSent(id, a, b);
      case 10: this.customRecvErrorCode = 'ERR_HTTP2_TOO_MANY_INVALID_FRAMES'; return;
      case 11: {
        if (!(this.fields[kBitfield] & (1 << kSessionHasAltsvcListeners))) return;
        makeCallback(this.resource, callbacks.altsvc, this, [id, payload.toString('latin1', 0, a), payload.toString('latin1', a, payload.length)]);
        return;
      }
      case 12: this.origins.push(payload.toString('latin1', 0, payload.length)); return;
      case 13: {
        const origins = this.origins;
        this.origins = [];
        makeCallback(this.resource, callbacks.origin, this, [origins]);
        return;
      }
      case 14: {
        if (a < NGHTTP2_ERR_FATAL || a === NGHTTP2_ERR_STREAM_CLOSED || a === NGHTTP2_ERR_FLOW_CONTROL || a === NGHTTP2_ERR_PROTO) {
          makeCallback(this.resource, callbacks.error, this, [a]);
        }
        return;
      }
      case 15: {
        if (a === NGHTTP2_ERR_SETTINGS_EXPECTED) makeCallback(this.resource, callbacks.error, this, [NGHTTP2_ERR_PROTO]);
        return;
      }
    }
  }
  onFrame(id, flags, type, extra, payload) {
    switch (type) {
      case FRAME_DATA: {
        const stream = this.streams.get(id);
        if (stream !== undefined && !stream.destroyed && (flags & FLAG_END_STREAM)) {
          makeCallback(stream.resource, stream.onread, stream, [UV_EOF, undefined]);
        }
        return;
      }
      case FRAME_PUSH_PROMISE:
        return this.onHeaders(extra, flags, 0);
      case FRAME_HEADERS:
        return this.onHeaders(id, flags, extra);
      case FRAME_RST_STREAM: {
        const stream = this.streams.get(id);
        if (stream !== undefined) stream.peerReset = true;
        return;
      }
      case FRAME_SETTINGS:
        return this.onSettings(flags, payload);
      case FRAME_PRIORITY: {
        if (this.fields[kSessionPriorityListenerCount] === 0) return;
        makeCallback(this.resource, callbacks.priority, this,
                     [id, payload.readInt32LE(0), payload.readInt32LE(4), payload[8] !== 0]);
        return;
      }
      case FRAME_PING: {
        if (flags & FLAG_ACK) {
          const ping = this.pings.shift();
          if (ping === undefined) {
            makeCallback(this.resource, callbacks.error, this, [NGHTTP2_ERR_PROTO]);
            return;
          }
          ping.done(true, payload);
          return;
        }
        if (!(this.fields[kBitfield] & (1 << kSessionHasPingListeners))) return;
        makeCallback(this.resource, callbacks.ping, this, [copy(payload)]);
      }
    }
  }
  // Http2Session::HandleHeadersFrame, with OnBeginHeadersCallback's stream creation.
  onHeaders(id, flags, category) {
    const block = this.headers.get(id) || { names: [], sensitive: [] };
    this.headers.delete(id);
    let stream = this.streams.get(id);
    if (stream === undefined) {
      if (this.closing) {
        call('rst', this.id, id, NGHTTP2_REFUSED_STREAM);
        return;
      }
      stream = new Http2Stream(this, id, 0);
    } else if (stream.destroyed) {
      return;
    }
    makeCallback(this.resource, callbacks.headers, this, [stream, id, category, flags, block.names, block.sensitive]);
  }
  onSettings(flags, payload) {
    if (!(flags & FLAG_ACK)) {
      this.fields[kBitfield] &= ~(1 << kSessionRemoteSettingsIsUpToDate);
      // nghttp2 lifts its initial limit of 100 streams when the first SETTINGS
      // frame does not set one.
      if (!this.remoteSettingsSeen) {
        this.remoteSettingsSeen = true;
        this.remoteMirror[settingIds.indexOf(3)] = 0xffffffff;
      }
      for (let at = 0; at + 8 <= payload.length; at += 8) {
        const settingId = payload.readInt32LE(at);
        const index = settingIds.indexOf(settingId);
        if (index !== -1) {
          this.remoteMirror[index] = payload.readUInt32LE(at + 4);
          continue;
        }
        for (const entry of this.remoteCustomSettings) {
          if (entry.id === settingId) { entry.value = payload.readUInt32LE(at + 4); entry.set = true; break; }
        }
      }
      if (!(this.fields[kBitfield] & (1 << kSessionHasRemoteSettingsListeners))) return;
      makeCallback(this.resource, callbacks.settings, this, []);
      return;
    }
    const settings = this.outstandingSettings.shift();
    if (settings !== undefined) {
      for (const [id, value] of settings.entries) {
        const index = settingIds.indexOf(id);
        if (index !== -1) this.localMirror[index] = value;
      }
      settings.done(true);
      return;
    }
    makeCallback(this.resource, callbacks.error, this, [NGHTTP2_ERR_PROTO]);
  }
  onData(id, payload) {
    const stream = this.streams.get(id);
    if (stream === undefined || stream.destroyed || payload.length === 0) return;
    // Each chunk is its own buffer, so later reads cannot overwrite it.
    stream.stats.receivedBytes += payload.length;
    if (stream.stats.firstByte === 0n) stream.stats.firstByte = hrtimeNs();
    makeCallback(stream.resource, stream.onread, stream, [payload.length, Buffer.from(payload)]);
    if (stream.destroyed || !this.alive()) return;
    if (stream.reading) call('consume', this.id, id, payload.length);
    else stream.consumedWhilePaused += payload.length;
  }
  onStreamClose(id, code) {
    const stream = this.streams.get(id);
    if (stream === undefined || stream.destroyed) return;
    stream.closed = true;
    stream.code = code;
    const answer = makeCallback(stream.resource, callbacks.streamClose, stream, [code, stream.peerReset]);
    if (answer === undefined || answer === false) stream.destroy();
  }
  onFrameNotSent(id, code, type) {
    if ((code === NGHTTP2_ERR_SESSION_CLOSING || code === NGHTTP2_ERR_STREAM_CLOSED || code === NGHTTP2_ERR_STREAM_CLOSING) &&
        type !== FRAME_GOAWAY) {
      this.headers.delete(id);
      return;
    }
    makeCallback(this.resource, callbacks.frameError, this, [id, type, translateNghttp2ErrorCode(code)]);
  }

  // Http2Session::SendPendingData: returns 1 when a send cannot start now.
  sendPendingData() {
    if (this.destroyed || !this.alive()) return 0;
    this.writeScheduled = false;
    if (this.sending) return 1;
    if (this.receiving) return 1;
    this.sending = true;
    const chunks = [];
    while (this.alive()) {
      const out = call('send', this.id);
      if (typeof out === 'number') break;
      this.drain();
      if (out.byteLength === 0) break;
      chunks.push(Buffer.from(out));
    }
    const socket = this.socket;
    if (socket === null) {
      this.clearOutgoing(UV_ECANCELED);
      return 0;
    }
    // A socket whose writable side has ended drops the data, as a failed libuv
    // write does in Node, without an error on the JS socket.
    if (chunks.length === 0 || !socket.writable) {
      this.clearOutgoing(0);
      return 0;
    }
    this.chunksSent++;
    for (const chunk of chunks) this.stats.bytesWritten += chunk.length;
    this.writeInProgress = true;
    let finished = false;
    let async = false;
    const done = (error) => {
      if (finished) return;
      finished = true;
      if (async) fromLoop(() => this.onStreamAfterWrite(error ? -1 : 0));
    };
    // Like Node's writev of the outgoing buffers: one chunk per nghttp2 output,
    // corked together. A write the socket buffers without backpressure completes
    // now, like a libuv write that finished synchronously.
    const corked = chunks.length > 1 && typeof socket.cork === 'function';
    if (corked) socket.cork();
    let flushed = true;
    for (let i = 0; i < chunks.length; i++) flushed = socket.write(chunks[i], i === chunks.length - 1 ? done : undefined);
    if (corked) socket.uncork();
    if (this.alive()) call('socketMemory', this.id, socket.writableLength || 0);
    if (flushed || finished) {
      finished = true;
      this.writeInProgress = false;
      this.clearOutgoing(0);
      this.maybeNotifyGracefulCloseComplete();
    } else {
      async = true;
    }
    this.maybeStopReading();
    if (this.internalGoawaySent) {
      this.internalGoawaySent = false;
      if (!this.closing && !this.destroyed) makeCallback(this.resource, callbacks.error, this, [NGHTTP2_ERR_PROTO]);
    }
    return 0;
  }
  onStreamAfterWrite(status) {
    this.maybeNotifyGracefulCloseComplete();
    this.writeInProgress = false;
    this.clearOutgoing(status);
    if (this.alive() && this.socket) call('socketMemory', this.id, this.socket.writableLength || 0);
    if (this.readingStopped && !this.writeInProgress && this.alive() && this.wantRead()) {
      this.readingStopped = false;
      this.socket?.resume();
    }
    if (this.destroyed) {
      this.finishDone();
      return;
    }
    if (!this.writeScheduled) this.maybeScheduleWrite();
  }
  clearOutgoing(status) {
    this.sending = false;
    const outgoing = this.outgoing;
    this.outgoing = [];
    // Like Node, completed writes report success even when the socket write failed.
    for (const req of outgoing) this.completeWrite(req, 0);
    if (this.pendingRstStreams.length) {
      const pending = this.pendingRstStreams;
      this.pendingRstStreams = [];
      this.sendPendingData();
      for (const id of pending) this.streams.get(id)?.flushRstStream();
    }
  }
  completeWrite(req, status) {
    const stream = req.handle;
    makeCallback(stream ? stream.resource : this.resource, req.oncomplete, req, [status]);
  }
  addPendingRstStream(id) { if (!this.pendingRstStreams.includes(id)) this.pendingRstStreams.push(id); }
  removePendingRstStream(id) {
    const at = this.pendingRstStreams.indexOf(id);
    if (at !== -1) this.pendingRstStreams.splice(at, 1);
  }

  hasPendingData() { return this.alive() && call('wantIO', this.id) !== 0; }
  setGracefulClose() { this.gracefulClose = true; }
  maybeNotifyGracefulCloseComplete() {
    if (!this.gracefulClose || !this.alive()) return;
    if (call('wantIO', this.id) === 0) makeCallback(this.resource, this.ongracefulclosecomplete, this, []);
  }

  // Http2Session::Close.
  destroy(code, socketClosed) {
    if (this.closing) return;
    this.closing = true;
    if (this.receiving) {
      this.closePending = true;
      this.pendingCloseCode = code >>> 0;
      this.pendingCloseSocketClosed = !!socketClosed;
      return;
    }
    this.finishClose(code >>> 0, !!socketClosed);
  }
  maybeFinishPendingClose() {
    if (!this.closePending || this.destroyed) return;
    this.closePending = false;
    this.finishClose(this.pendingCloseCode, this.pendingCloseSocketClosed);
  }
  finishClose(code, socketClosed) {
    const socket = this.socket;
    if (socket !== null) {
      this.readingStopped = true;
      socket.pause();
    }
    if (!socketClosed) {
      if (this.alive()) call('terminate', this.id, code);
      this.sendPendingData();
    } else if (socket !== null) {
      socket.removeListener('data', this.onSocketData);
    }
    this.destroyed = true;
    if (!this.writeInProgress || socket === null) this.finishDone();
    const pings = this.pings;
    this.pings = [];
    for (const ping of pings) setImmediate(() => ping.done(false));
    this.emitStatistics();
  }
  // The ondone callback, after which nothing reaches the native session again.
  finishDone() {
    makeCallback(this.resource, this.ondone, this, []);
    if (this.socket !== null && !this.socket.destroyed) {
      this.readingStopped = false;
      this.socket.resume();
    }
    this.release();
  }
  emitStatistics() {
    if (!perfEntries.observing('http2')) return;
    const stats = this.stats;
    const detail = {
      bytesWritten: stats.bytesWritten,
      bytesRead: stats.bytesRead,
      framesReceived: stats.framesReceived,
      framesSent: stats.framesSent,
      maxConcurrentStreams: stats.maxConcurrentStreams,
      pingRTT: stats.pingRTT,
      streamAverageDuration: stats.streamAverageDuration,
      streamCount: stats.streamCount,
      type: this.type === NGHTTP2_SESSION_SERVER ? 'server' : 'client',
    };
    const duration = host.now() - stats.start;
    setImmediate(() => {
      if (perfEntries.observing('http2')) perfEntries.emit('Http2Session', 'http2', stats.start, duration, detail);
    });
  }
  release() {
    if (this.released) return;
    this.released = true;
    if (this.socket !== null && this.onSocketData) this.socket.removeListener('data', this.onSocketData);
    call('release', this.id);
    this.resource.emitDestroy();
  }

  ping(payload, callback) {
    const ping = new Http2Ping(this, callback);
    if (this.pings.length === this.maxOutstandingPings) {
      ping.done(false);
      return false;
    }
    ping.send(payload);
    this.pings.push(ping);
    return true;
  }
  settings(callback) {
    const settings = new Http2Settings(this, callback);
    if (this.outstandingSettings.length === this.maxOutstandingSettings) {
      settings.done(false);
      return false;
    }
    settings.send();
    this.outstandingSettings.push(settings);
    return true;
  }
  updateLocalCustomSettings(entries) {
    for (const [id, value] of entries) {
      if (settingIds.includes(id)) continue;
      const entry = this.localCustomSettings.find((setting) => setting.id === id);
      if (entry) entry.value = value;
      else if (this.localCustomSettings.length < MAX_ADDITIONAL_SETTINGS) this.localCustomSettings.push({ id, value, set: true });
    }
  }
  goaway(code, lastStreamID, opaqueData) {
    if (this.destroyed || !this.alive()) return;
    this.goawayInitiated = true;
    this.scope(() => {
      let last = lastStreamID | 0;
      if (last <= 0) last = call('lastStream', this.id);
      call('goaway', this.id, last, code >>> 0, opaqueData === undefined ? undefined : opaqueData);
    });
  }
  request(headers, options, parent, weight, exclusive) {
    let result = 0;
    this.scope(() => {
      result = call('request', this.id, 0, packHeaders(headers), options & STREAM_OPTION_EMPTY_PAYLOAD ? 1 : 0);
    });
    if (result <= 0) return result;
    const stream = new Http2Stream(this, result, options);
    stream.hasProvider = !(options & STREAM_OPTION_EMPTY_PAYLOAD);
    return stream;
  }
  altsvc(id, origin, value) {
    this.scope(() => { call('altsvc', this.id, id, Buffer.from(origin, 'latin1'), Buffer.from(value, 'latin1')); });
  }
  origin(origins, count) {
    const parts = count === 0 ? [] : origins.split('\0').slice(0, count);
    const packed = [];
    for (const origin of parts) {
      const length = Buffer.allocUnsafe(4);
      length.writeUInt32LE(Buffer.byteLength(origin, 'latin1'));
      packed.push(length, Buffer.from(origin, 'latin1'));
    }
    this.scope(() => { call('origin', this.id, Buffer.concat(packed)); });
  }
  setNextStreamID(id) {
    if (!this.alive()) return false;
    return call('setNextStream', this.id, id | 0) >= 0;
  }
  setLocalWindowSize(size) {
    return call('window', this.id, 0, size | 0);
  }
  updateChunksSent() {
    this.chunksSentSinceLastWrite = this.chunksSent;
    return this.chunksSent;
  }
  refreshState() {
    const id = this.id;
    sessionState[0] = call('effectiveLocalWindow', id);
    sessionState[1] = call('effectiveRecvLength', id);
    sessionState[2] = call('nextStream', id);
    sessionState[3] = call('localWindow', id, 0);
    sessionState[4] = call('lastStream', id);
    sessionState[5] = call('remoteWindow', id, 0);
    sessionState[6] = call('outboundSize', id);
    sessionState[7] = call('deflateSize', id);
    sessionState[8] = call('inflateSize', id);
  }
  // Http2Settings::Update for the local or remote settings.
  refreshSettings(remote) {
    const mirror = remote ? this.remoteMirror : this.localMirror;
    for (let i = 0; i < IDX_SETTINGS_COUNT; i++) settingsBuffer[i] = mirror[i];
    const custom = remote ? this.remoteCustomSettings : this.localCustomSettings;
    let count = 0;
    for (const entry of custom) {
      if (!entry.set) continue;
      settingsBuffer[IDX_SETTINGS_COUNT + 2 + count * 2] = entry.id;
      settingsBuffer[IDX_SETTINGS_COUNT + 3 + count * 2] = entry.value;
      count++;
    }
    settingsBuffer[IDX_SETTINGS_COUNT + 1] = count;
  }
  localSettings() { this.refreshSettings(false); }
  remoteSettings() { this.refreshSettings(true); }
}

module.exports = {
  constants,
  nameForErrorCode,
  settingsBuffer,
  optionsBuffer,
  sessionState,
  streamState,
  kBitfield,
  kSessionPriorityListenerCount,
  kSessionFrameErrorListenerCount,
  kSessionMaxInvalidFrames,
  kSessionMaxRejectedStreams,
  kSessionUint8FieldCount,
  kSessionHasRemoteSettingsListeners,
  kSessionRemoteSettingsIsUpToDate,
  kSessionHasPingListeners,
  kSessionHasAltsvcListeners,
  nghttp2ErrorString,
  refreshDefaultSettings,
  packSettings,
  setCallbackFunctions,
  Http2Session,
  Http2Stream,
  UV_EOF,
};
