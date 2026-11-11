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

class WriteWrap {
  constructor() {
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
    this.handle = null;
    this.oncomplete = null;
    this.callback = null;
  }
}

class TCPConnectWrap {
  constructor() {
    this.oncomplete = null;
    this.address = undefined;
    this.port = undefined;
    this.localAddress = undefined;
    this.localPort = undefined;
  }
}

class PipeConnectWrap {
  constructor() {
    this.oncomplete = null;
    this.address = undefined;
  }
}

function statusOf(error) {
  if (error === null || error === undefined) return 0;
  return typeof error.errno === 'number' ? error.errno : uv.UV_ECANCELED;
}

// src/handle_wrap.cc and src/stream_wrap.cc (LibuvStreamWrap) over one transport.
class StreamHandle {
  #owner = undefined;
  constructor(transport) {
    this.reading = false;
    this.onread = null;
    this.onconnection = null;
    this.writeQueueSize = 0;
    this.bytesRead = 0;
    this.bytesWritten = 0;
    this._closeCallback = null;
    this._closeReported = false;
    this._userBuffer = null;
    // Reads a stopped user-buffer stream holds, in order, until it reads again.
    this._pendingReads = [];
    this._flushScheduled = false;
    this._connectRequest = null;
    this._consumers = null;
    if (transport !== undefined) this._adopt(transport);
  }
  // Node's StreamBase: an HTTP parser can consume the handle directly (parser.consume).
  get isStreamBase() { return true; }
  _adopt(transport) {
    this._transport = transport;
    transport.onEvent = (type, status, payload) => this._dispatch(type, status, payload);
    if (this.#owner !== undefined) transport.owner = this.#owner;
  }
  get [owner_symbol]() { return this.#owner; }
  set [owner_symbol](owner) {
    this.#owner = owner;
    if (this._transport) this._transport.owner = owner;
  }
  get fd() {
    const fd = this._transport?.call?.('fileno');
    return typeof fd === 'number' && fd >= 0 ? fd : -1;
  }
  get _externalStream() { return this._transport; }
  getAsyncId() { return this._transport?.resource?.asyncId() ?? -1; }
  getProviderType() { return 0; }
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
  shutdown(req) {
    if (!this._transport || this._transport.closing || this._transport.closed) return uv.UV_ENOTCONN;
    let sync = true;
    let result = 0;
    req.handle = this;
    this._transport.shutdown(error => {
      const status = statusOf(error);
      if (sync) { result = status === 0 ? 1 : status; return; }
      if (typeof req.oncomplete === 'function') req.oncomplete(status);
    });
    sync = false;
    // 1 tells net.js that the shutdown already finished, like UV_ENOTCONN.
    return result === 1 ? uv.UV_ENOTCONN : result;
  }
  writeBuffer(req, buffer) { return this._write(req, [buffer]); }
  writev(req, chunks, allBuffers) {
    let buffers = chunks;
    if (!allBuffers) {
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
      if (typeof wrap.oncomplete === 'function') wrap.oncomplete(status);
      else wrap.writeStatus = status;
    };
    const done = error => {
      failure ||= statusOf(error);
      if (--pending !== 0) return;
      if (sync || completed) return;
      if (!this._transport) { completed = true; this._pendingWrites?.delete(complete); return; }
      complete(failure);
    };
    for (let i = 0; i < target.length; i++) {
      const chunk = target[i];
      this._transport.write(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), done);
    }
    sync = false;
    this.bytesWritten += bytes;
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
  _dispatch(type, status, payload) {
    switch (type) {
      case READ: {
        const owner = this.#owner;
        // A WebSocket peer (internal/ws) owns the frames of this socket after its upgrade.
        if (owner?._wsPeer && status >= 0) {
          if (payload?.byteLength) {
            this.bytesRead += payload.byteLength;
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
  _readForConsumer(status, payload) {
    const consumer = this._consumers?.[this._consumers.length - 1];
    if (consumer && consumer.read(status, payload) !== false) return;
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
      const [payload, nread, consumed] = pending[i];
      if (consumed) this._readForConsumer(nread, payload);
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
        this.bytesRead += count;
        streamBaseState[kReadBytesOrError] = count;
        streamBaseState[kArrayBufferOffset] = 0;
        const next = this.onread(undefined);
        if (next instanceof Uint8Array) this._userBuffer = next;
      }
      return;
    }
    this.bytesRead += bytes.byteLength;
    streamBaseState[kReadBytesOrError] = bytes.byteLength;
    streamBaseState[kArrayBufferOffset] = bytes.byteOffset;
    this.onread(bytes.buffer);
  }
}

// The native handles of internal/net/transport: kind 1 is TCP, 2 is a Unix pipe.
class NativeStreamHandle extends StreamHandle {
  constructor(kind, id) {
    super();
    this._kind = kind;
    this._adopt(new Transport(kind, undefined, () => {}, id));
  }
  _call(operation, ...args) {
    if (!this._transport || this._transport.closed) return uv.UV_EBADF;
    return this._transport.call(operation, ...args);
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
    this._type = type;
    this._tos = undefined;
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
    this._type = type;
    this._mode = 0;
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
    this.bytesWritten += bytes;
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
    this._pendingWrites = new Set();
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
  isStreamHandle,
  guessHandleType,
};
