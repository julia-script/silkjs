'use strict';

// A JavaScript emulation of the internalBinding('tcp_wrap'), ('pipe_wrap'), ('stream_wrap')
// and ('uv') objects that Node.js v24 lib/net.js and lib/internal/stream_base_commons.js use.
// It follows src/tcp_wrap.cc, src/pipe_wrap.cc, src/stream_wrap.cc, src/stream_base.cc and
// src/handle_wrap.cc: the same methods, return values, request objects and callbacks.
//
// Each handle drives one transport: a native socket from internal/net/transport, or any
// object with the same contract (readStart, readStop, write, writev, shutdown, close and an
// onEvent(type, status, payload) callback), such as the TLS transport.

const { Buffer } = require('buffer');
const kNetTraceCategory = 'node,node.net,node.net.native';
let traceEventsModule;
// Loaded on first connect: this module is in the heap image.
const traceEvents = () => (traceEventsModule ??= require('internal/trace_events'));
const host = require('internal/host');
const { Transport } = require('internal/net/transport');
const {
  symbols: { owner_symbol },
} = require('internal/async_hooks');

const errno = require('os').constants.errno;

// libuv error numbers are negated errno values on Unix.
const uv = {
  UV_EOF: -4095,
  UV_EADDRINUSE: -errno.EADDRINUSE,
  UV_EBADF: -errno.EBADF,
  UV_EPROTO: -errno.EPROTO,
  UV_ECANCELED: -errno.ECANCELED,
  UV_EINVAL: -errno.EINVAL,
  UV_ENOTCONN: -errno.ENOTCONN,
  UV_ENOTSUP: -errno.ENOTSUP,
  UV_ENOTSOCK: -errno.ENOTSOCK,
  UV_ETIMEDOUT: -errno.ETIMEDOUT,
  errname(err) { return host.net('error', [err]).code; },
};

// Native event types of internal/net/transport.
const READ = 1;
const CONNECTION = 2;
const CONNECT = 3;
const CLOSED = 6;
const WS_CLOSE = 7;
const WS_FRAME = 8;

// src/stream_base.h StreamBaseStateFields.
const kReadBytesOrError = 0;
const kArrayBufferOffset = 1;
const kBytesWritten = 2;
const kLastWriteWasAsync = 3;
const kLastWriteErr = 4;
const streamBaseState = new Int32Array(5);

// Small corked writes (a frame header and its payload) go out as one copy and one system call.
const kJoinLimit = 65536;

// Node's stream and request wraps are BaseObjects, so V8's serializer hands them
// to _writeHostObject: the emulated ones are branded for the same check.
const bindingObjects = new WeakSet();
host.types.isStreamBindingObject = value => bindingObjects.has(value);

class WriteWrap {
  constructor() {
    bindingObjects.add(this);
    this.handle = null;
    this.oncomplete = null;
    this.callback = null;
    this.async = false;
    this.bytes = 0;
    this.buffer = null;
    this.error = undefined;
    this.writeStatus = null;
  }
}

class ShutdownWrap {
  constructor() {
    bindingObjects.add(this);
    this.handle = null;
    this.oncomplete = null;
    this.callback = null;
  }
}

class TCPConnectWrap {
  constructor() {
    bindingObjects.add(this);
    this.oncomplete = null;
    this.address = undefined;
    this.port = undefined;
    this.localAddress = undefined;
    this.localPort = undefined;
  }
}

class PipeConnectWrap {
  constructor() {
    bindingObjects.add(this);
    this.oncomplete = null;
    this.address = undefined;
  }
}

function statusOf(error) {
  if (error === null || error === undefined) return 0;
  return typeof error.errno === 'number' ? error.errno : uv.UV_ECANCELED;
}

// The binding's own bookkeeping, which Node keeps in C++: writable but not enumerable, so the
// handle shows only the properties Node's handles have (util.inspect, v8 serialize errors).
function internalFields(handle, fields) {
  const keys = Object.keys(fields);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    Object.defineProperty(handle, key, { __proto__: null, value: fields[key], writable: true, configurable: true, enumerable: false });
  }
}
// LibuvStreamWrap's own properties (JSStream has none of them).
function libuvFields(handle) {
  handle.reading = false;
  handle.onconnection = null;
  handle.writeQueueSize = 0;
}

// src/handle_wrap.cc and src/stream_wrap.cc (LibuvStreamWrap) over one transport.
class StreamHandle {
  #owner = undefined;
  #onread = null;
  #bytesRead = 0;
  #bytesWritten = 0;
  constructor(transport) {
    bindingObjects.add(this);
    internalFields(this, {
      _transport: undefined,
      _closeCallback: null,
      _closeReported: false,
      _userBuffer: null,
      // Reads a stopped user-buffer stream holds, in order, until it reads again.
      _pendingReads: [],
      _flushScheduled: false,
      _connectRequest: null,
      _consumers: null,
    });
    if (transport !== undefined) this._adopt(transport);
  }
  // StreamBase's prototype accessors: onread can be set, the byte counts are read-only.
  get onread() { return this.#onread; }
  set onread(value) { this.#onread = value; }
  get bytesRead() { return this.#bytesRead; }
  get bytesWritten() { return this.#bytesWritten; }
  _countRead(bytes) { this.#bytesRead += bytes; }
  _countWritten(bytes) { this.#bytesWritten += bytes; }
  // Node's StreamBase: an HTTP parser can consume the handle directly (parser.consume).
  get isStreamBase() { return true; }
  _adopt(transport) {
    this._transport = transport;
    transport.onEvent = (type, status, payload, extra) => this._dispatch(type, status, payload, extra);
    if (this.#owner !== undefined) transport.owner = this.#owner;
  }
  get [owner_symbol]() { return this.#owner; }
  set [owner_symbol](owner) {
    this.#owner = owner;
    if (this._transport) this._transport.owner = owner;
  }
  // Like StreamBase's accessors, these throw for a receiver that is no handle.
  get fd() {
    if (!(#onread in this)) throw new TypeError('Illegal invocation');
    const fd = this._transport?.call?.('fileno');
    return typeof fd === 'number' && fd >= 0 ? fd : -1;
  }
  get _externalStream() {
    if (!(#onread in this)) throw new TypeError('Illegal invocation');
    return this._transport;
  }
  getAsyncId() { return this._transport?.resource?.asyncId() ?? -1; }
  getProviderType() { return this._transport?.getProviderType?.() ?? 0; }
  // AsyncWrap::AsyncReset: the handle's callbacks run in a new async resource, reported to
  // async_hooks with `resource` as its resource object (the http agent's ReusedHandle).
  asyncReset(resource) {
    const transport = this._transport;
    if (!transport?.resource) return;
    transport.resource.emitDestroy();
    transport.resource = require('async_hooks')._createResource(transport.provider ?? 'TCPWRAP', resource);
  }
  // HandleWrap
  close(callback) {
    if (this._closeCallback !== null) return;
    // The transport closed first (its peer or carrier went away) and destroyed the
    // owner, whose _destroy closes the handle: it is closed, so the callback runs.
    if (!this._transport) {
      if (!this._closeReported && typeof callback === 'function') {
        this._closeReported = true;
        process.nextTick(() => callback.call(this));
      }
      return;
    }
    this._closeCallback = typeof callback === 'function' ? callback : () => {};
    this.reading = false;
    if (this._transport.closed) { process.nextTick(() => this._closed()); return; }
    this._transport.close();
  }
  ref() { this._transport?.ref?.(); }
  unref() { this._transport?.unref?.(); }
  hasRef() { return !!this._transport?.hasRef?.(); }
  // StreamBase
  readStart() {
    if (!this._transport || this._transport.closing || this._transport.closed) return uv.UV_EINVAL;
    const status = this._transport.readStart();
    if (status === 0 && this._pendingReads.length && !this._flushScheduled) {
      this._flushScheduled = true;
      // libuv delivers reads after uv_read_start on a later loop turn, never inside it.
      setImmediate(() => this._flushPending());
    }
    return status;
  }
  readStop() {
    if (!this._transport || this._transport.closing || this._transport.closed) return uv.UV_EINVAL;
    return this._transport.readStop();
  }
  useUserBuffer(buffer) { this._userBuffer = buffer; }
  // LibuvStreamWrap::HasPendingRead: a read held for JavaScript, queued by the native side, or
  // still in the kernel buffer, that no 'data' listener has seen yet.
  hasPendingRead() {
    if (this._pendingReads.length) return true;
    if (!this._transport || this._transport.closed) return false;
    return this._transport.call?.('pendingRead') === 1;
  }
  shutdown(req) {
    if (!this._transport || this._transport.closing || this._transport.closed) return uv.UV_ENOTCONN;
    let sync = true;
    let result = 0;
    req.handle = this;
    this._transport.shutdown(error => {
      const status = statusOf(error);
      if (sync) { result = status === 0 ? 1 : status; return; }
      // StreamBase AfterShutdown: oncomplete(status, handle, error).
      if (typeof req.oncomplete === 'function') req.oncomplete(status, this, undefined);
    });
    sync = false;
    // 1 tells net.js that the shutdown already finished, like UV_ENOTCONN.
    return result === 1 ? uv.UV_ENOTCONN : result;
  }
  writeBuffer(req, buffer) { return this._write(req, [buffer]); }
  writev(req, chunks, allBuffers) {
    let buffers = chunks;
    if (!allBuffers) {
      // Small mixed writes (HTTP headers then body) are joined anyway: encode the
      // strings straight into the joined buffer, without a Buffer per string.
      let bytes = 0;
      for (let i = 0; i < chunks.length && bytes <= kJoinLimit; i += 2) {
        const chunk = chunks[i];
        if (typeof chunk !== 'string') { bytes += chunk.byteLength; continue; }
        const encoding = chunks[i + 1];
        if (encoding !== 'latin1' && encoding !== 'utf8' && encoding !== 'utf-8' && encoding !== 'ascii' && encoding !== 'binary') { bytes = kJoinLimit + 1; break; }
        bytes += Buffer.byteLength(chunk, encoding);
      }
      if (bytes <= kJoinLimit && chunks.length > 2) {
        const joined = Buffer.allocUnsafe(bytes);
        let offset = 0;
        for (let i = 0; i < chunks.length; i += 2) {
          const chunk = chunks[i];
          if (typeof chunk === 'string') offset += joined.write(chunk, offset, chunks[i + 1]);
          else { joined.set(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), offset); offset += chunk.byteLength; }
        }
        return this._write(req, [joined]);
      }
      buffers = new Array(chunks.length >> 1);
      for (let i = 0; i < chunks.length; i += 2) {
        const chunk = chunks[i];
        buffers[i >> 1] = typeof chunk === 'string' ? Buffer.from(chunk, chunks[i + 1]) : chunk;
      }
    }
    return this._write(req, buffers);
  }
  writeUtf8String(req, string) { return this._write(req, [Buffer.from(string, 'utf8')]); }
  writeAsciiString(req, string) { return this._write(req, [Buffer.from(string, 'latin1')]); }
  writeLatin1String(req, string) { return this._write(req, [Buffer.from(string, 'latin1')]); }
  writeUcs2String(req, string) { return this._write(req, [Buffer.from(string, 'utf16le')]); }
  // StreamBase::Write: a write the kernel takes at once completes synchronously
  // (kLastWriteWasAsync 0); otherwise a WriteWrap completes later through oncomplete.
  _write(req, buffers) {
    let bytes = 0;
    for (let i = 0; i < buffers.length; i++) bytes += buffers[i].byteLength;
    streamBaseState[kBytesWritten] = bytes;
    streamBaseState[kLastWriteErr] = 0;
    if (!this._transport || this._transport.closing || this._transport.closed) {
      streamBaseState[kLastWriteWasAsync] = 0;
      return uv.UV_EBADF;
    }
    let target = buffers;
    if (buffers.length > 1 && bytes <= kJoinLimit) {
      const joined = Buffer.allocUnsafe(bytes);
      let offset = 0;
      for (let i = 0; i < buffers.length; i++) { joined.set(buffers[i], offset); offset += buffers[i].byteLength; }
      target = [joined];
    }
    // One buffer the kernel takes at once (the usual HTTP response): no WriteWrap, no
    // completion closures and no request entry.
    const transport = this._transport;
    let token = 0;
    if (target.length === 1 && typeof transport.writeNow === 'function') {
      const chunk = target[0];
      token = transport.writeNow(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      if (token <= 0) {
        this._countWritten(bytes);
        streamBaseState[kLastWriteWasAsync] = 0;
        return token;
      }
    }
    let pending = target.length;
    let failure = 0;
    let sync = true;
    const wrap = req ?? new WriteWrap();
    let completed = false;
    const complete = status => {
      if (completed) return;
      completed = true;
      this._pendingWrites?.delete(complete);
      this.writeQueueSize -= bytes;
      if (typeof wrap.oncomplete === 'function') wrap.oncomplete(status, this, undefined);
      else wrap.writeStatus = status;
    };
    const done = error => {
      failure ||= statusOf(error);
      if (--pending !== 0) return;
      if (sync || completed) return;
      if (!this._transport) { completed = true; this._pendingWrites?.delete(complete); return; }
      complete(failure);
    };
    if (token > 0) transport.expect(token, done, target[0]);
    else for (let i = 0; i < target.length; i++) {
      const chunk = target[i];
      transport.write(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), done);
    }
    sync = false;
    this._countWritten(bytes);
    if (pending === 0) {
      streamBaseState[kLastWriteWasAsync] = 0;
      if (req) return failure;
      return failure;
    }
    streamBaseState[kLastWriteWasAsync] = 1;
    this.writeQueueSize += bytes;
    this._pendingWrites?.add(complete);
    if (failure !== 0) streamBaseState[kLastWriteErr] = failure;
    wrap.async = true;
    return req ? 0 : wrap;
  }
  // `extra` marks a read of a TLS session the native handle runs (internal/tls/transport):
  // 1 plaintext, 2 the session is back with JavaScript. Only the session's consumer takes them.
  _dispatch(type, status, payload, extra) {
    switch (type) {
      case READ: {
        if (extra !== undefined && typeof extra === 'number') {
          if (!this._consumers?.length) return;
          if (!this.reading || this._pendingReads.length) {
            this._pendingReads.push([payload ? payload.slice(0) : payload, status, true, extra]);
            return;
          }
          this._readForConsumer(status, payload, extra);
          return;
        }
        const owner = this.#owner;
        // A WebSocket peer (internal/ws) owns the frames of this socket after its upgrade.
        if (owner?._wsPeer && status >= 0) {
          if (payload?.byteLength) {
            this._countRead(payload.byteLength);
            host.net('wsFeed', [this._transport.id, payload, 0, payload.byteLength]);
          }
          return;
        }
        // An http parser that consumed this stream (parser.consume) reads its bytes instead.
        if (this._consumers?.length) {
          // Reads the transport queued before a readStop wait while the stream is stopped
          // (a paused HTTP parser sees no data, as with libuv). The payload is only lent for
          // the event, so a held read keeps a copy.
          if (!this.reading || this._pendingReads.length) {
            this._pendingReads.push([payload ? payload.slice(0) : payload, status, true]);
            return;
          }
          this._readForConsumer(status, payload);
          return;
        }
        if (status < 0) {
          this.reading = false;
          this._deliver(null, status);
          return;
        }
        if (!payload || payload.byteLength === 0) return;
        this._deliver(payload, 0);
        return;
      }
      case CONNECTION: {
        if (typeof this.onconnection !== 'function') return;
        if (status < 0) { this.onconnection(status); return; }
        let client;
        try { client = this._accept(payload); } catch (err) { this.onconnection(statusOf(err)); return; }
        this.onconnection(0, client);
        return;
      }
      case CONNECT: {
        this._endConnectTrace?.();
        const req = this._connectRequest;
        this._connectRequest = null;
        if (req && typeof req.oncomplete === 'function') req.oncomplete(status, this, req, true, true);
        return;
      }
      case CLOSED: {
        this.reading = false;
        this._closed();
        return;
      }
      case WS_CLOSE:
      case WS_FRAME:
        this.#owner?._wsPeer?._frame(type, status, payload);
        return;
    }
  }
  _closed() {
    this._endConnectTrace?.();
    const callback = this._closeCallback;
    this._closeCallback = null;
    const owner = this.#owner;
    this._transport = null;
    if (callback) { this._closeReported = true; callback.call(this); }
    else if (owner && !owner.destroyed && typeof owner.destroy === 'function') owner.destroy();
  }
  // A read for the stream's consumer, which hands read errors and the end of the stream
  // back to onread (returns false).
  _readForConsumer(status, payload, extra) {
    const consumer = this._consumers?.[this._consumers.length - 1];
    if (consumer && consumer.read(status, payload, extra) !== false) return;
    if (extra !== undefined) return;
    if (status < 0) {
      this.reading = false;
      this._deliver(null, status);
      return;
    }
    if (payload?.byteLength) this._deliver(payload, 0);
  }
  // Hands nread and the bytes to onread like LibuvStreamWrap::OnUvRead.
  _flushPending() {
    this._flushScheduled = false;
    const pending = this._pendingReads;
    this._pendingReads = [];
    for (let i = 0; i < pending.length; i++) {
      // A read stopped again: the rest waits, after anything it held back.
      // So does one that came while the stream was stopped (net clears handle.reading).
      if (this._pendingReads.length || (pending[i][2] && !this.reading)) {
        this._pendingReads.push(...pending.slice(i));
        return;
      }
      const [payload, nread, consumed, extra] = pending[i];
      if (consumed) this._readForConsumer(nread, payload, extra);
      else this._deliver(payload, nread);
    }
  }
  _deliver(payload, nread) {
    if (typeof this.onread !== 'function') return;
    if (this._pendingReads.length) { this._pendingReads.push([payload, nread]); return; }
    if (payload === null) {
      streamBaseState[kReadBytesOrError] = nread;
      streamBaseState[kArrayBufferOffset] = 0;
      this.onread(undefined);
      return;
    }
    const bytes = payload instanceof ArrayBuffer ? new Uint8Array(payload) : payload;
    if (this._userBuffer) {
      // A user buffer takes at most its length per read, as libuv reads into it.
      let offset = 0;
      while (offset < bytes.byteLength) {
        if (!this._transport || this._transport.closed) return;
        if (!this._transport.reading && offset > 0) {
          this._pendingReads.push([bytes.subarray(offset), 0]);
          return;
        }
        const target = this._userBuffer;
        const count = Math.min(target.byteLength, bytes.byteLength - offset);
        target.set(bytes.subarray(offset, offset + count));
        offset += count;
        this._countRead(count);
        streamBaseState[kReadBytesOrError] = count;
        streamBaseState[kArrayBufferOffset] = 0;
        const next = this.onread(undefined);
        if (next instanceof Uint8Array) this._userBuffer = next;
      }
      return;
    }
    this._countRead(bytes.byteLength);
    streamBaseState[kReadBytesOrError] = bytes.byteLength;
    streamBaseState[kArrayBufferOffset] = bytes.byteOffset;
    this.onread(bytes.buffer);
  }
}

// The native handles of internal/net/transport: kind 1 is TCP, 2 is a Unix pipe.
class NativeStreamHandle extends StreamHandle {
  constructor(kind, id) {
    super();
    libuvFields(this);
    internalFields(this, { _kind: kind, _connectTraceId: undefined });
    this._adopt(new Transport(kind, undefined, () => {}, id));
  }
  _call(operation, ...args) {
    if (!this._transport || this._transport.closed) return uv.UV_EBADF;
    // No spread: it would run a user's Array.prototype[Symbol.iterator].
    return Reflect.apply(this._transport.call, this._transport, [operation].concat(args));
  }
  open(fd) { return this._call('open', fd); }
  listen(backlog) { return this._call('listen', backlog); }
  setBlocking(blocking) { return this._call('setBlocking', blocking ? 1 : 0); }
  _address(out, peer) {
    const result = this._transport && !this._transport.closed ? this._transport.address(peer) : uv.UV_EBADF;
    if (typeof result === 'number') return result;
    if (result === undefined) return uv.UV_EBADF;
    if (typeof result === 'string') return result;
    out.address = result.address;
    out.family = result.family;
    out.port = result.port;
    return 0;
  }
  // A writev with strings, or of several buffers, is encoded and written by one native call
  // (host.secure op 4) instead of a join here and a write per buffer.
  writev(req, chunks, allBuffers) {
    if (chunks.length > (allBuffers ? 1 : 2)) {
      const status = this._writeChunks(req, chunks, allBuffers);
      if (status !== undefined) return status;
    }
    return super.writev(req, chunks, allBuffers);
  }
  writeUtf8String(req, string) { return this._writeChunks(req, [string, 'utf8'], false) ?? super.writeUtf8String(req, string); }
  writeLatin1String(req, string) { return this._writeChunks(req, [string, 'latin1'], false) ?? super.writeLatin1String(req, string); }
  writeAsciiString(req, string) { return this._writeChunks(req, [string, 'latin1'], false) ?? super.writeAsciiString(req, string); }
  // StreamBase::Write over host.secure op 4: undefined leaves the write to StreamHandle._write.
  _writeChunks(req, chunks, allBuffers) {
    const transport = this._transport;
    if (!transport || transport.closing || transport.closed) return undefined;
    if (!allBuffers) {
      for (let i = 0; i < chunks.length; i += 2) {
        if (typeof chunks[i] !== 'string') continue;
        const encoding = chunks[i + 1];
        if (encoding !== 'latin1' && encoding !== 'utf8' && encoding !== 'ascii' && encoding !== 'utf-8' && encoding !== 'binary') return undefined;
      }
    }
    const token = ++transport.sequence;
    const result = host.secure(4, transport.id, chunks, chunks.length, allBuffers ? 1 : 0, token);
    if (result <= -100000) return undefined;
    streamBaseState[kLastWriteErr] = 0;
    if (result < 0) {
      streamBaseState[kBytesWritten] = 0;
      streamBaseState[kLastWriteWasAsync] = 0;
      return result;
    }
    const bytes = Math.floor(result / 2);
    streamBaseState[kBytesWritten] = bytes;
    this._countWritten(bytes);
    if (result % 2 === 1) {
      streamBaseState[kLastWriteWasAsync] = 0;
      return 0;
    }
    streamBaseState[kLastWriteWasAsync] = 1;
    const wrap = req ?? new WriteWrap();
    this.writeQueueSize += bytes;
    let completed = false;
    const complete = status => {
      if (completed) return;
      completed = true;
      this._pendingWrites?.delete(complete);
      this.writeQueueSize -= bytes;
      if (typeof wrap.oncomplete === 'function') wrap.oncomplete(status, this, undefined);
      else wrap.writeStatus = status;
    };
    transport.requests.set(token, { callback: error => {
      if (!this._transport) { completed = true; this._pendingWrites?.delete(complete); return; }
      complete(statusOf(error));
    } });
    this._pendingWrites?.add(complete);
    wrap.async = true;
    return req ? 0 : wrap;
  }
  _accept(id) { return new this.constructor(this.constructor.SOCKET, id); }
  // ConnectWrap: a node.net.native "connect" span lasts from the native connect to its result.
  _connect(req, address, port, traceArgs) {
    const traceId = traceEvents().begin(kNetTraceCategory, 'connect', traceArgs);
    const status = this._call('connect', address, port);
    if (status < 0) { traceEvents().end(kNetTraceCategory, 'connect', traceId); return status; }
    this._connectRequest = req;
    this._connectTraceId = traceId;
    return 0;
  }
  _endConnectTrace() {
    const id = this._connectTraceId;
    if (id === undefined) return;
    this._connectTraceId = undefined;
    traceEvents().end(kNetTraceCategory, 'connect', id);
  }
}

// src/tcp_wrap.cc
class TCP extends NativeStreamHandle {
  constructor(type, id) {
    super(1, id);
    internalFields(this, { _type: type, _tos: undefined });
  }
  // libuv makes and binds the socket in uv_tcp_bind; the native socket binds when it
  // listens, so a server handle listens passively (bound, not accepting) right away. Its
  // errors (EAFNOSUPPORT on a host without IPv6, EADDRINUSE) then come from bind as in Node,
  // and a cluster primary can pass the bound descriptor on.
  bind(address, port, flags = 0) {
    const status = this._call('bind', address, port, flags);
    if (status !== 0 || this._type !== TCP.SERVER) return status;
    return this._call('listen', 511, 1);
  }
  bind6(address, port, flags = 0) { return this.bind(address, port, flags); }
  connect(req, address, port) { return this._connect(req, address, port); }
  connect6(req, address, port) { return this.connect(req, address, port); }
  getsockname(out) { const r = this._address(out, false); return typeof r === 'string' ? uv.UV_EINVAL : r; }
  getpeername(out) { const r = this._address(out, true); return typeof r === 'string' ? uv.UV_EINVAL : r; }
  setNoDelay(enable) { return this._call('noDelay', enable ? 1 : 0, 0); }
  setKeepAlive(enable, delay) { return this._call('keepAlive', enable ? 1 : 0, delay >>> 0); }
  setTypeOfService(tos) {
    const status = this._call('typeOfService', tos);
    if (status === 0) this._tos = tos;
    return status;
  }
  getTypeOfService() {
    const tos = this._call('typeOfService', -1);
    return tos;
  }
  // TCPWrap::TransferForMessaging: the receiving thread gets a duplicate of the descriptor, and
  // this handle closes once the message is posted (the duplicate keeps the socket open).
  _duplicateForTransfer() {
    const fd = this.fd;
    if (fd < 0) return uv.UV_EBADF;
    return host.net('duplicateFd', [fd]);
  }
  _finishTransfer() {
    this.reading = false;
    this.close(() => {});
  }
  reset(callback) {
    if (this._closeCallback !== null || !this._transport) return 0;
    this._closeCallback = typeof callback === 'function' ? callback : () => {};
    this.reading = false;
    return this._transport.close(true);
  }
}
TCP.SOCKET = 0;
TCP.SERVER = 1;

// src/pipe_wrap.cc
class Pipe extends NativeStreamHandle {
  constructor(type, id) {
    if (type === Pipe.IPC) throw new Error('IPC pipes are made by child_process');
    super(2, id);
    internalFields(this, { _type: type, _mode: 0 });
  }
  bind(path) { return this._call('bind', path, 0, 0); }
  connect(req, path) {
    // pipe_wrap's span names the path and whether it is a Linux abstract socket.
    const abstract = path[0] === '\0';
    return this._connect(req, path, 0, { path_type: abstract ? 'abstract socket' : 'file', pipe_path: abstract ? path.slice(1) : path });
  }
  fchmod(mode) {
    return this._call('chmod', (mode & PipeConstants.UV_READABLE) !== 0, (mode & PipeConstants.UV_WRITABLE) !== 0);
  }
  setPendingInstances() {}
}
Pipe.SOCKET = 0;
Pipe.SERVER = 1;
Pipe.IPC = 2;

const TCPConstants = { SOCKET: TCP.SOCKET, SERVER: TCP.SERVER, UV_TCP_IPV6ONLY: 1, UV_TCP_REUSEPORT: 2 };
const PipeConstants = { SOCKET: Pipe.SOCKET, SERVER: Pipe.SERVER, IPC: Pipe.IPC, UV_READABLE: 1, UV_WRITABLE: 2 };

// src/tty_wrap.cc. libuv reopens a slave terminal to isolate O_NONBLOCK from the caller's
// descriptor; on its fallback path it adopts the duplicate it was given.
class TTY extends StreamHandle {
  constructor(fd, ctx) {
    super();
    libuvFields(this);
    // As uv_tty_init: a regular file, or a descriptor it cannot tell, is EINVAL.
    const kind = host.net('guessHandleType', [fd]);
    if (kind < 0 || kind === 6) { fillContext(ctx, uv.UV_EINVAL, 'uv_tty_init'); return; }
    const owned = host.net('duplicateFd', [fd]);
    if (owned < 0) { fillContext(ctx, owned, 'uv_tty_init'); return; }
    let transport;
    try { transport = new Transport(5, undefined, () => {}, undefined, owned); }
    catch (err) {
      require('fs').closeSync(owned);
      fillContext(ctx, statusOf(err), 'uv_tty_init');
      return;
    }
    if (transport.call('fileno') !== owned) require('fs').closeSync(owned);
    this._adopt(transport);
  }
  _call(operation, ...args) {
    if (!this._transport || this._transport.closed) return uv.UV_EBADF;
    return this._transport.call(operation, ...args);
  }
  setBlocking(blocking) { return this._call('setBlocking', blocking ? 1 : 0); }
  setRawMode(mode) { return this._call('ttyMode', mode); }
  getWindowSize(size) {
    const result = this._call('ttyWindowSize');
    if (typeof result === 'number') return result;
    size[0] = result.columns;
    size[1] = result.rows;
    return 0;
  }
  // POSIX terminals are blocking stdio destinations (setBlocking), so a write completes at once.
  _write(req, buffers) {
    let bytes = 0;
    for (let i = 0; i < buffers.length; i++) bytes += buffers[i].byteLength;
    streamBaseState[kBytesWritten] = bytes;
    streamBaseState[kLastWriteErr] = 0;
    streamBaseState[kLastWriteWasAsync] = 0;
    const fd = this.fd;
    if (fd < 0) return uv.UV_EBADF;
    try {
      const { writeAll } = require('internal/tty/write');
      for (let i = 0; i < buffers.length; i++) writeAll(fd, buffers[i]);
    } catch (err) {
      return statusOf(err);
    }
    this._countWritten(bytes);
    return 0;
  }
}

function fillContext(ctx, status, syscall) {
  ctx.errno = status;
  ctx.code = uv.errname(status);
  ctx.message = require('internal/errors').uvErrmapGet(status)?.[1] ?? 'unknown error';
  ctx.syscall = syscall;
}


// A handle for a transport that is not a native socket (the TLS transport): addresses and
// socket options come from what the transport reports, such as its carrier socket.
class JSTransportHandle extends StreamHandle {
  constructor(transport) {
    super(transport);
    libuvFields(this);
    internalFields(this, { _pendingWrites: new Set() });
  }
  // TLSWrap's writes while its session runs natively (internal/tls/transport writeChunks): one
  // call encodes, encrypts and sends them. Like every TLSWrap write they complete
  // asynchronously, after the tick that made them or when the carrier wrote them.
  writev(req, chunks, allBuffers) {
    if (this._transport?.native === true) {
      const status = this._secureWrite(req, chunks, allBuffers);
      if (status !== undefined) return status;
    }
    return super.writev(req, chunks, allBuffers);
  }
  writeBuffer(req, buffer) {
    if (this._transport?.native === true) {
      const status = this._secureWrite(req, [buffer], true);
      if (status !== undefined) return status;
    }
    return super.writeBuffer(req, buffer);
  }
  writeUtf8String(req, string) {
    if (this._transport?.native === true) {
      const status = this._secureWrite(req, [string, 'utf8'], false);
      if (status !== undefined) return status;
    }
    return super.writeUtf8String(req, string);
  }
  writeLatin1String(req, string) {
    if (this._transport?.native === true) {
      const status = this._secureWrite(req, [string, 'latin1'], false);
      if (status !== undefined) return status;
    }
    return super.writeLatin1String(req, string);
  }
  writeAsciiString(req, string) {
    if (this._transport?.native === true) {
      const status = this._secureWrite(req, [string, 'latin1'], false);
      if (status !== undefined) return status;
    }
    return super.writeAsciiString(req, string);
  }
  _secureWrite(req, chunks, allBuffers) {
    if (this._transport.closing || this._transport.closed) return undefined;
    let complete = null;
    const result = this._transport.writeChunks(chunks, allBuffers, status => complete(status));
    if (result === undefined) return undefined;
    const bytes = Math.floor(result / 2);
    streamBaseState[kBytesWritten] = bytes;
    streamBaseState[kLastWriteErr] = 0;
    streamBaseState[kLastWriteWasAsync] = 1;
    this._countWritten(bytes);
    const wrap = req ?? new WriteWrap();
    wrap.async = true;
    this.writeQueueSize += bytes;
    let completed = false;
    complete = status => {
      if (completed) return;
      completed = true;
      this._pendingWrites.delete(complete);
      this.writeQueueSize -= bytes;
      if (typeof wrap.oncomplete === 'function') wrap.oncomplete(status, this, undefined);
      else wrap.writeStatus = status;
    };
    this._pendingWrites.add(complete);
    if (result % 2 === 1) process.nextTick(complete, 0);
    return req ? 0 : wrap;
  }
  // TLSWrap cancels its queued writes as it closes (InvokeQueued(UV_ECANCELED)), before
  // the close or any error of its owner surfaces.
  close(callback) {
    if (this._closeCallback === null && this._pendingWrites.size) {
      for (const complete of [...this._pendingWrites]) complete(uv.UV_ECANCELED);
    }
    super.close(callback);
  }
  _address(out, peer) {
    const result = this._transport?.address?.(peer);
    if (typeof result === 'number') return result;
    if (!result || typeof result !== 'object') return uv.UV_EBADF;
    out.address = result.address;
    out.family = result.family;
    out.port = result.port;
    return 0;
  }
  getsockname(out) { return this._address(out, false); }
  getpeername(out) { return this._address(out, true); }
  setNoDelay(enable) { return this._transport?.call?.('noDelay', enable ? 1 : 0, 0) ?? 0; }
  setKeepAlive(enable, delay) { return this._transport?.call?.('keepAlive', enable ? 1 : 0, delay >>> 0) ?? 0; }
}

// src/js_stream.cc: a StreamBase whose reads, writes and shutdowns are calls into JS
// (internal/js_stream_socket sets onreadstart, onreadstop, onshutdown, onwrite and close).
// Its callbacks run in its own async resource, as JSStream's MakeCallback calls do.
class JSStream extends StreamHandle {
  constructor() {
    super();
    // internal/js_stream_socket assigns onreadstart, onreadstop, onshutdown and onwrite.
    internalFields(this, { _resource: require('async_hooks')._createResource('JSSTREAM', this) });
  }
  getAsyncId() { return this._resource.asyncId(); }
  getProviderType() { return require('async_hooks').asyncWrapProviders.JSSTREAM; }
  asyncReset(resource) {
    this._resource.emitDestroy();
    this._resource = require('async_hooks')._createResource('JSSTREAM', resource);
  }
  // A MakeCallback: an exception is reported as uncaught, and the call fails with
  // UV_EPROTO (JSStream's DoWrite, DoShutdown, ReadStart and ReadStop).
  _callback(fn, args, receiver = this) {
    // AsyncWrap::MakeCallback calls nothing when the property is not a function.
    if (typeof fn !== 'function') return uv.UV_EPROTO;
    let result;
    const threw = host.invokeTimer(this._resource, function callback() {
      result = Reflect.apply(fn, receiver, args);
    }, undefined, []);
    return threw ? uv.UV_EPROTO : result;
  }
  ref() {}
  unref() {}
  hasRef() { return false; }
  readStart() { return this._callback(this.onreadstart, []) ?? 0; }
  readStop() { return this._callback(this.onreadstop, []) ?? 0; }
  shutdown(req) {
    req.handle = this;
    return this._callback(this.onshutdown, [req]) ?? 0;
  }
  // JSStream has no synchronous write: every write completes through finishWrite.
  _write(req, buffers) {
    let bytes = 0;
    for (let i = 0; i < buffers.length; i++) bytes += buffers[i].byteLength;
    const wrap = req ?? new WriteWrap();
    wrap.handle = this;
    wrap.async = true;
    streamBaseState[kBytesWritten] = bytes;
    streamBaseState[kLastWriteWasAsync] = 1;
    streamBaseState[kLastWriteErr] = 0;
    this._countWritten(bytes);
    const status = this._callback(this.onwrite, [wrap, buffers]) ?? 0;
    // StreamBase::Write: a failed write is not async, and its error is the result.
    if (status !== 0) {
      streamBaseState[kLastWriteWasAsync] = 0;
      return status;
    }
    return req ? 0 : wrap;
  }
  finishWrite(req, status) {
    if (typeof req.oncomplete === 'function') this._callback(req.oncomplete, [status], req);
    else req.writeStatus = status;
  }
  finishShutdown(req, status) {
    if (typeof req.oncomplete === 'function') this._callback(req.oncomplete, [status], req);
  }
  readBuffer(chunk) { this._callback(this._deliver, [chunk, 0]); }
  emitEOF() { this._callback(this._deliver, [null, uv.UV_EOF]); }
}

function isStreamHandle(value) { return value instanceof StreamHandle; }

// src/node_util.cc GuessHandleType over the native type numbers.
function guessHandleType(fd) {
  const type = host.net('guessHandleType', [fd]);
  switch (type) {
    case 1: return 'TCP';
    case 2: return 'PIPE';
    case 3: return 'UDP';
    case 5: return 'TTY';
    default: return type < 0 ? 'UNKNOWN' : 'FILE';
  }
}

module.exports = {
  uv,
  tcp_wrap: { TCP, TCPConnectWrap, constants: TCPConstants },
  pipe_wrap: { Pipe, PipeConnectWrap, constants: PipeConstants },
  tty_wrap: {
    TTY,
    isTTY(fd) { return host.net('guessHandleType', [fd]) === 5; },
    UV_TTY_MODE_NORMAL: 0, UV_TTY_MODE_RAW: 1, UV_TTY_MODE_IO: 2, UV_TTY_MODE_RAW_VT: 3,
  },
  stream_wrap: {
    ShutdownWrap, WriteWrap, LibuvStreamWrap: StreamHandle, streamBaseState,
    kReadBytesOrError, kArrayBufferOffset, kBytesWritten, kLastWriteWasAsync, kLastWriteErr,
  },
  JSTransportHandle,
  js_stream: { JSStream },
  isStreamHandle,
  guessHandleType,
};
