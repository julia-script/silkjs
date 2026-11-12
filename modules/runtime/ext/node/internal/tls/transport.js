'use strict';
const { Buffer } = require('buffer');
const { native, NativeSecureContext } = require('internal/tls/context');
const { codes } = require('internal/errors');

// OpenSSL failures become TLS errors; anything else, such as an exception thrown
// by a 'secure' or 'data' listener, propagates as it does from Node's callbacks.
class Failure { constructor(cause) { this.cause = cause; } }
// TLSWrap cancels the writes it still holds when it closes (UV_ECANCELED).
function canceled() { return Object.assign(new Error('write ECANCELED'), { errno: -125, code: 'ECANCELED', syscall: 'write' }); }
function op(...args) {
  try { return native(...args); } catch (cause) { throw new Failure(cause); }
}

// The carrier is an ordinary net.Socket (or user Duplex). Only ciphertext crosses
// it. Socket._attachTransport keeps stream/backpressure machinery in net.Socket.
// The TLSSocket keeps Node's TLSWrap callbacks: _onHandshakeStart, _finishInit
// (onhandshakedone) and _onTLSError (onerror).
class TLSTransport {
  constructor(socket, carrier, context, options, owned) {
    // As TLSWrap's constructor, a handle made without a socket wraps no session.
    if (socket === undefined) { this.id = 0; this.closed = true; this.closing = true; return; }
    this.socket = socket; this.carrier = carrier; this.options = options;
    this.kind = carrier._transport?.kind || 1; this.closed = false; this.closing = false;
    this.reading = true; this.ready = false; this.selecting = false; this.pumping = false;
    this.writes = []; this.pendingShutdown = null; this.shutdownInFlight = false;
    this.eof = false; this.started = false; this.alert = null;
    // A server answers the peer's ClientHello; a client waits for TLSSocket#_start.
    this.initiated = !!options.isServer;
    this.handshakeStarts = 0; this.handshakeCompletions = 0;
    this.keylog = false; this.sessionCallbacks = false; this.helloWaiting = false;
    this.awaitingSession = false; this.flushWaiters = []; this.currentSession = null;
    // TLSWrap::DoShutdown inside an OpenSSL callback waits for the handshake
    // and any 'newSession' answer (FlushPendingShutdown).
    this.holdShutdown = false;
    this.id = native('create', context.context._id, !!options.isServer);
    try {
      if (options.ALPNProtocols?.length) native(options.isServer ? 'serverALPN' : 'setALPN', this.id, options.ALPNProtocols);
      if (!options.isServer && options.session) native('setSession', this.id, options.session);
    } catch (err) { native('release', this.id); this.id = 0; throw err; }
    carrier.on('data', chunk => {
      if (this.closing || !this.id) return;
      try { native('feed', this.id, chunk); } catch (err) { this.fail(err); return; }
      this.pump();
    });
    // A peer that closes without close_notify still ends the stream, as in Node.
    carrier.on('end', () => { if (!this.closing) this.end(); });
    // An owned carrier is TLSWrap's stream: its write errors once the TLS socket is destroyed
    // or shutting down (EPIPE on the close_notify) reach nothing, as in afterShutdown.
    if (owned) carrier.on('error', err => { if (!this.closing && !this.socket.destroyed && !this.shutdownInFlight) this.socket.destroy(err); });
    carrier.once('close', () => this.finish());
    const start = () => {
      if (this.closing || this.started) return;
      // tls.connect() connects an owned carrier after the transport exists.
      if (carrier.connecting || carrier._connected === false) { carrier.once('connect', start); return; }
      this.started = true;
      this.onEvent?.(3, 0);
      if (this.closing) return;
      this.carrier.resume(); this.pump();
    };
    process.nextTick(start);
  }
  end() {
    if (this.eof) return;
    this.eof = true; this.onEvent?.(1, -4095);
  }
  // OpenSSL queues an alert before it reports a failure: send it to the peer first.
  fail(err) {
    if (this.closing) return;
    if (this.id) {
      try { const data = Buffer.from(op('drain', this.id)); if (data.length) this.alert = data; } catch {}
    }
    this.socket._onTLSError(err);
  }
  flush(callback) {
    // TLSWrap::EncOut: nothing leaves while a server waits for 'newSession'.
    if (this.awaitingSession) { if (callback) this.flushWaiters.push(callback); return; }
    const data = Buffer.from(op('drain', this.id));
    if (data.length) { this.socket._refreshTimeout(); this.carrier.write(data, callback); }
    else if (callback) process.nextTick(callback);
  }
  // Node's loadSNI and TLSWrap::CertCbDone.
  chooseCertificate() {
    if (this.selecting) return;
    this.selecting = true; this.carrier.pause();
    const servername = op('servername', this.id);
    if (servername) this.socket.servername = servername;
    let once = false;
    const done = (err, context) => {
      if (once) { this.socket.destroy(new codes.ERR_MULTIPLE_CALLBACK()); return; }
      once = true;
      // Resume outside the OpenSSL operation, including for synchronous callbacks.
      process.nextTick(() => {
        if (this.closing) return;
        if (err) { this.socket.destroy(err); return; }
        if (!this.id) { this.socket.destroy(new codes.ERR_SOCKET_CLOSED()); return; }
        if (context) context = context.context || context;
        if (context !== null && typeof context === 'object' && !(context instanceof NativeSecureContext)) {
          this.fail(new TypeError('Invalid SNI context')); return;
        }
        try {
          op('select', this.id, context instanceof NativeSecureContext ? context._id : 0);
          this.selectALPN();
        } catch (failure) { if (!(failure instanceof Failure)) throw failure; this.socket.destroy(failure.cause); return; }
        if (this.closing) return;
        this.selecting = false; this.carrier.resume(); this.pump();
      });
    };
    if (servername && this.socket._SNICallback) this.socket._SNICallback(servername, done);
    else done(null, null);
  }
  // Node's SelectALPNCallback with an ALPNCallback: its choice, or a fatal
  // no_application_protocol alert when it returns undefined.
  selectALPN() {
    if (!this.options.isServer || !this.socket._hasALPNCallback()) return;
    const offered = Buffer.from(op('offeredALPN', this.id));
    if (!offered.length) return;
    const selected = this.socket._callALPNCallback(offered);
    if (this.closing) return;
    if (selected === undefined) op('rejectALPN', this.id);
    else op('serverALPN', this.id, Buffer.concat([Buffer.from([selected.length]), Buffer.from(selected, 'latin1')]));
  }
  enableKeylog() { this.keylog = true; op('enableKeylog', this.id); }
  enableSessionCallbacks() { this.sessionCallbacks = true; op('enableSessionCallbacks', this.id); }
  // Node's EmitClientHello, from a fresh stack as TLSWrap schedules it.
  awaitClientHello() {
    if (this.helloWaiting) return;
    this.helloWaiting = true; this.carrier.pause();
    const hello = { sessionId: Buffer.from(op('helloSessionId', this.id)), tlsTicket: !!op('helloTicket', this.id) };
    setImmediate(() => { if (!this.closing && this.id) this.socket._onClientHello(hello); });
  }
  clientHelloDone() {
    if (!this.helloWaiting || this.closing || !this.id) return;
    op('clientHelloDone', this.id);
    this.helloWaiting = false; this.carrier.resume(); this.pump();
  }
  newSessionDone() {
    if (!this.id) return;
    op('newSessionDone', this.id);
    this.awaitingSession = false;
    const waiters = this.flushWaiters.splice(0);
    this.flush(waiters.length ? err => { for (const waiter of waiters) waiter(err); } : undefined);
    this.pump();
  }
  // Keylog lines and new sessions OpenSSL reported during the last operation.
  libraryEvents() {
    if (this.keylog) {
      const lines = Buffer.from(op('keylogLines', this.id));
      let start = 0;
      while (start < lines.length) {
        const end = lines.indexOf(10, start) + 1;
        this.socket.emit('keylog', Buffer.from(lines.subarray(start, end)));
        start = end;
        if (this.closing || !this.id) return false;
      }
    }
    if (this.sessionCallbacks) {
      const queue = Buffer.from(op('newSessions', this.id));
      let offset = 0;
      while (offset < queue.length) {
        const idLength = queue.readUInt32LE(offset);
        const sessionId = Buffer.from(queue.subarray(offset + 4, offset + 4 + idLength));
        const length = queue.readUInt32LE(offset + 4 + idLength);
        const start = offset + 8 + idLength;
        const session = Buffer.from(queue.subarray(start, start + length));
        offset = start + length;
        if (this.options.isServer) this.awaitingSession = true;
        this.currentSession = this.options.isServer ? null : session;
        try { this.socket._onNewSession(sessionId, session); } finally { this.currentSession = null; }
        if (this.closing || !this.id) return false;
      }
    }
    return true;
  }
  handshakeEvents() {
    if (!this.libraryEvents()) return false;
    const starts = op('handshakeStarts', this.id);
    while (this.handshakeStarts < starts) {
      this.handshakeStarts++;
      if (this.options.isServer) this.socket._onHandshakeStart(Date.now());
      if (this.closing) return false;
    }
    if (!this.ready) return true;
    const completions = op('handshakeCompletions', this.id);
    while (this.handshakeCompletions < completions) {
      this.handshakeCompletions++;
      this.socket._onHandshakeDone();
      if (this.closing) return false;
    }
    return true;
  }
  pump() {
    if (this.pumping || this.closing || !this.started || this.selecting || this.helloWaiting || !this.id) return;
    this.pumping = true;
    try {
      if (!this.ready) {
        if (!this.initiated) { this.shutdown_(); return; }
        const status = op('handshake', this.id);
        // As in TLSWrap, the handshake-done callback runs before the final flight is
        // sent: a client that rejects the server's certificate never finishes.
        if (status !== 1) this.flush();
        if (!this.handshakeEvents()) return;
        if (status === 4) { this.chooseCertificate(); return; }
        if (status === 11) { this.awaitClientHello(); return; }
        if (status !== 1) { this.shutdown_(); return; }
        this.ready = true;
        this.handshakeCompletions = op('handshakeCompletions', this.id);
        this.socket._onHandshakeDone();
        if (this.closing) return;
        this.flush();
      }
      if (this.renegotiating) {
        this.renegotiating = false;
        op('handshake', this.id);
        this.flush();
        if (!this.handshakeEvents()) return;
      }
      while (this.reading && !this.closing) {
        const data = Buffer.from(op('read', this.id));
        this.flush();
        if (!this.handshakeEvents()) return;
        if (!data.length) break;
        this.onEvent?.(1, data.length, data);
      }
      if (this.closing) return;
      if (op('receivedShutdown', this.id) & 2) this.end();
      if (this.closing) return;
      const item = this.writes[0];
      if (item && !item.inflight) {
        if (!item.data.length) { this.writes.shift(); process.nextTick(() => { item.callback(); this.pump(); }); }
        else {
          const n = op('write', this.id, item.data.subarray(item.offset));
          if (n > 0) {
            item.offset += n; item.inflight = true;
            this.flush(err => {
              if (this.closing) return;
              item.inflight = false;
              if (err) { this.fail(err); return; }
              if (item.offset === item.data.length) { this.writes.shift(); item.callback(); }
              this.pump();
            });
          } else this.flush();
        }
      } else if (!item) this.shutdown_();
      if (!this.reading && this.ready) this.carrier.pause();
    } catch (err) {
      if (!(err instanceof Failure)) throw err;
      this.fail(err.cause);
    } finally { this.pumping = false; }
  }
  // Node's TLSWrap::DoShutdown: send close_notify when possible, then end the
  // carrier. The result never fails the shutdown (afterShutdown ignores it).
  shutdown_() {
    if (!this.pendingShutdown || this.shutdownInFlight || this.writes.length) return;
    if (this.holdShutdown && (!this.ready || this.awaitingSession)) return;
    this.shutdownInFlight = true;
    try { op('shutdown', this.id); } catch {}
    let data;
    try { data = Buffer.from(op('drain', this.id)); } catch { data = Buffer.alloc(0); }
    const finish = () => {
      const done = this.pendingShutdown; this.pendingShutdown = null;
      if (done) done(null);
    };
    // A carrier its peer already ended takes no more writes; as with TLSWrap's
    // StreamBase write, that failure stays out of the socket's errors.
    if (this.carrier.writable === false) { process.nextTick(finish); return; }
    if (data.length) this.carrier.write(data);
    this.carrier.end(finish);
  }
  initiate() { this.initiated = true; this.pump(); }
  // Node's TLSWrap::DestroySSL: the session goes away before the socket does.
  destroySSL() {
    if (!this.id) return;
    op('release', this.id); this.id = 0;
    for (const item of this.writes.splice(0)) item.callback(canceled());
  }
  write(data, callback) {
    if (this.closing || !this.id) { process.nextTick(() => callback(canceled())); return; }
    this.writes.push({ data, offset: 0, callback, inflight: false }); this.pump();
  }
  writev(chunks, callback) {
    let pending = chunks.length, failure;
    if (!pending) { process.nextTick(callback); return; }
    for (const entry of chunks) this.write(entry.chunk, err => { failure ||= err; if (--pending === 0) callback(failure); });
  }
  shutdown(callback) {
    this.pendingShutdown = callback;
    if (this.pumping || this.selecting || this.helloWaiting) this.holdShutdown = true;
    this.pump();
  }
  readStart() { this.reading = true; this.carrier.resume(); this.pump(); return 0; }
  readStop() { this.reading = false; if (this.ready) this.carrier.pause(); return 0; }
  // The TLS handle is closed: release the session and report the close once.
  finish() {
    if (this.closed) return;
    this.closed = true; this.closing = true;
    if (this.id) { native('release', this.id); this.id = 0; }
    for (const item of this.writes.splice(0)) item.callback(canceled());
    const done = this.pendingShutdown; this.pendingShutdown = null; if (done) done(null);
    this.onEvent?.(6, 0);
  }
  close(reset = false) {
    if (this.closing) return 0;
    this.closing = true;
    const alert = this.alert; this.alert = null;
    if (alert && !reset && !this.carrier.destroyed) {
      // As TLSWrap does, the handle closes without waiting for the alert to be
      // written: a peer that never reads must not hold back 'error' and 'close'.
      this.carrier.end(alert, () => this.carrier.destroy());
      process.nextTick(() => this.finish());
    } else if (reset && this.carrier.resetAndDestroy) this.carrier.resetAndDestroy();
    else this.carrier.destroy();
    return 0;
  }
  address(peer = false) {
    if (this.carrier._transport) return this.carrier._transport.address(peer);
    if (!peer) return this.carrier.address?.();
    return this.carrier.remoteAddress ? { address: this.carrier.remoteAddress, port: this.carrier.remotePort, family: this.carrier.remoteFamily } : undefined;
  }
  call(op, ...args) { return this.carrier._transport?.call(op, ...args) ?? 0; }
  getAsyncId() { return this.carrier._handle?.getAsyncId?.() ?? -1; }
  ref() { this.carrier.ref?.(); }
  unref() { this.carrier.unref?.(); }
  hasRef() { return this.carrier._transport?.hasRef() ?? true; }
}
module.exports = { TLSTransport };
