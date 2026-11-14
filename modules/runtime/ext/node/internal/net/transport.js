'use strict';

const host = require('internal/host');
const { _createResource: createResource, _invokeDispatch: invokeDispatch, asyncWrapProviders } = require('async_hooks');
// The handle's async resource is the runtime's own (no FinalizationRegistry entry and no
// private state): close and asyncReset destroy it, as Node's HandleWrap does.
const { Buffer } = require('buffer');

function error(status, syscall, address, port) {
  const info = host.net('error', [status]);
  const target = address === undefined ? '' : ` ${address}${port === undefined ? '' : `:${port}`}`;
  const err = new Error(`${syscall} ${info.code}${target}`);
  err.code = info.code;
  err.errno = status;
  err.syscall = syscall;
  if (address !== undefined) err.address = address;
  if (port !== undefined) err.port = port;
  return err;
}

// Socket owns stream state; this adapter owns a native handle and request lifetime.
// An adopted handle (accepted TCP/pipe, or a future TLS/stdio adapter) has the
// same read/write/shutdown/close contract as a newly allocated connection.
// Every open transport, for process._getActiveHandles(). Node lists the owner of each
// referenced handle that is not closing.
const live = new Set();

class Transport {
  constructor(kind, owner, onEvent, id, fd) {
    this.kind = kind;
    this.owner = owner;
    this.onEvent = onEvent;
    this.closed = false;
    this.closing = false;
    this.reading = false;
    this.requests = new Map();
    this.sequence = 0;
    this.provider = kind === 5 ? 'TTYWRAP' : kind === 2 ? 'PIPEWRAP' : 'TCPWRAP';
    this.resource = createResource(this.provider);
    const callback = (type, status, payload, extra) => {
      invokeDispatch(this.resource, this, type, status, payload, extra);
      host.checkpoint();
    };
    this.id = id === undefined ? host.net('create', [kind, callback, fd]) : id;
    if (this.id < 0) {
      this.resource.emitDestroy();
      throw error(this.id, 'socket');
    }
    if (id !== undefined) {
      const status = host.net('callback', [id, callback]);
      if (status < 0) {
        host.net('close', [id]);
        this.resource.emitDestroy();
        throw error(status, 'socket');
      }
    }
    live.add(this);
  }
  // The handle id, then the arguments, in a fresh array built by index: no rest array, and
  // no spread (user code may have replaced Array.prototype[Symbol.iterator]).
  call(operation, ...rest) {
    const args = [this.id];
    for (let index = 0; index < rest.length; index++) args.push(rest[index]);
    return host.net(operation, args);
  }
  // A stream handle that an HTTP parser can consume directly (Node's StreamBase).
  get isStreamBase() { return true; }
  getAsyncId() { return this.resource.asyncId(); }
  getProviderType() { return asyncWrapProviders[this.provider]; }
  // As Node's AsyncWrap::AsyncReset when an agent reuses a socket: the old id is destroyed
  // and the handle continues under a new one.
  asyncReset() {
    this.resource.emitDestroy();
    this.resource = createResource(this.provider);
  }
  dispatch(type, status, payload, extra) {
    if (type === 4 || type === 5) {
      const request = this.requests.get(payload);
      if (!request) return;
      this.requests.delete(payload);
      // Like Node's afterShutdown, a finished shutdown request reports no error.
      request.callback(type === 4 && status < 0 ? error(status, 'write') : null);
      return;
    }
    if (type === 1 && status < 0) this.reading = false;
    if (type === 6) {
      this.closed = true;
      live.delete(this);
      this.reading = false;
      try {
        const cancelled = Object.assign(new Error('Cannot call write after a stream was destroyed'), { code: 'ERR_STREAM_DESTROYED' });
        for (const request of this.requests.values()) request.callback(cancelled);
        this.requests.clear();
        this.onEvent(type, status, payload, extra);
      } finally { this.resource.emitDestroy(); }
      return;
    }
    this.onEvent(type, status, payload, extra);
  }
  readStart() {
    if (this.reading || this.closing) return 0;
    const status = this.call('readStart');
    if (status >= 0) this.reading = true;
    return status;
  }
  readStop() {
    if (!this.reading || this.closing) return 0;
    const status = this.call('readStop');
    if (status >= 0) this.reading = false;
    return status;
  }
  // Starts a write: 0 when the kernel took every byte now, a status below 0 when it failed
  // at once, else the request's token, whose completion expect() must register before the
  // turn ends (completions are only dispatched from the event loop).
  writeNow(chunk) {
    const token = ++this.sequence;
    const status = host.net('write', [this.id, chunk.buffer, chunk.byteOffset, chunk.byteLength, token]);
    return status === 1 ? 0 : status < 0 ? status : token;
  }
  expect(token, callback, chunk) { this.requests.set(token, { callback, chunk }); }
  write(chunk, callback) {
    const result = this.writeNow(chunk);
    // The kernel took every byte now: Node completes such a write synchronously too.
    if (result === 0) callback(null);
    else if (result < 0) callback(error(result, 'write'));
    else this.expect(result, callback, chunk);
  }
  // A plaintext write of the TLS session this handle runs (host.secure op 2): 1 when the records
  // left now, 0 when callback(err) follows, a negative status, or SECURE_FAILED / NOT_SECURE
  // when the session must go back to JavaScript (the write did not happen).
  secureWrite(chunk, callback) {
    const token = ++this.sequence;
    const status = host.secure(2, this.id, chunk.buffer, chunk.byteOffset, chunk.byteLength, token);
    if (status === 0) this.requests.set(token, { callback, chunk });
    return status;
  }
  writev(chunks, callback) {
    let pending = chunks.length;
    let failure = null;
    if (pending === 0) return callback(null);
    if (pending === 1) return this.write(chunks[0].chunk, callback);
    // Small corked writes (a frame header and its payload) go out as one copy and one system call.
    let total = 0;
    for (let i = 0; i < pending && total <= 65536; i++) total += chunks[i].chunk.byteLength;
    if (total <= 65536) {
      const joined = Buffer.allocUnsafe(total);
      let offset = 0;
      for (let i = 0; i < pending; i++) { joined.set(chunks[i].chunk, offset); offset += chunks[i].chunk.byteLength; }
      return this.write(joined, callback);
    }
    const done = err => {
      failure ||= err;
      if (--pending === 0) callback(failure);
    };
    // Each buffer is submitted separately, avoiding concatenation and retaining
    // corked write order. The stream callback waits for every native completion.
    for (const entry of chunks) this.write(entry.chunk, done);
  }
  shutdown(callback) {
    const token = ++this.sequence;
    this.requests.set(token, { callback });
    const status = this.call('shutdown', token);
    if (status < 0) {
      this.requests.delete(token);
      const failure = error(status, 'shutdown');
      // libuv refuses submission when its write side is already shut,
      // shutting, closing, or non-writable. This is not a shutdown(2) error.
      // Match Node's synchronous completion contract; queued shutdown and
      // read errors (including a reset that cleared WRITABLE) still dispatch.
      callback(failure.code === 'ENOTCONN' ? null : failure);
    }
  }
  close(reset = false) {
    if (this.closed || this.closing) return 0;
    const status = this.call(reset ? 'reset' : 'close');
    if (status >= 0) this.closing = true;
    return status;
  }
  address(peer = false) { return this.closed ? undefined : this.call('address', peer); }
  ref() { if (!this.closed) this.call('ref'); }
  unref() { if (!this.closed) this.call('unref'); }
  hasRef() { return !this.closed && !!this.call('hasRef'); }
}

function activeOwners() {
  const owners = [];
  for (const transport of live)
    if (!transport.closing && transport.hasRef()) owners.push(transport.owner);
  return owners;
}

module.exports = { Transport, activeOwners, error, native: (operation, args) => host.net(operation, args) };
