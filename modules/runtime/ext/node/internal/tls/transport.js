'use strict';
const { Buffer } = require('buffer');
const { native, NativeSecureContext, answerFor, answering } = require('internal/tls/context');
const { codes } = require('internal/errors');
const { FastBuffer } = require('internal/buffer');
const { isStreamHandle } = require('internal/net/binding');
// The native ops answer read and drain with a fresh ArrayBuffer of the exact size: a
// Buffer over it, as Buffer.from(arrayBuffer) makes, without Buffer.from's dispatch.
const bytesOf = arrayBuffer => new FastBuffer(arrayBuffer);

// OpenSSL failures become TLS errors; anything else, such as an exception thrown
// by a 'secure' or 'data' listener, propagates as it does from Node's callbacks.
class Failure { constructor(cause) { this.cause = cause; } }
// TLSWrap cancels the writes it still holds when it closes (UV_ECANCELED).
function canceled() { return Object.assign(new Error('write ECANCELED'), { errno: -125, code: 'ECANCELED', syscall: 'write' }); }
// The record pump calls this several times a request: a rest array (no arguments
// object), handed on by index without a spread.
function op(name, ...args) {
  try {
    switch (args.length) {
      case 0: return native(name);
      case 1: return native(name, args[0]);
      case 2: return native(name, args[0], args[1]);
      case 3: return native(name, args[0], args[1], args[2]);
      default: {
        const list = [name];
        for (let index = 0; index < args.length; index++) list.push(args[index]);
        return Reflect.apply(native, undefined, list);
      }
    }
  } catch (cause) { throw new Failure(cause); }
}

// The carrier is an ordinary net.Socket (or user Duplex). Only ciphertext crosses
// it. Socket._attachTransport keeps stream/backpressure machinery in net.Socket.
// The TLSSocket keeps Node's TLSWrap callbacks: _onHandshakeStart, _finishInit
// (onhandshakedone) and _onTLSError (onerror).
class TLSTransport {
  constructor(socket, carrier, context, options, owned) {
    // As TLSWrap's constructor, a handle made without a socket wraps no session.
    if (socket === undefined) { this.id = 0; this.closed = true; this.closing = true; return; }
    this.socket = socket; this.carrier = carrier; this.options = options; this.owned = !!owned;
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
      if (!options.isServer && options.requestOCSP) native('requestOCSP', this.id);
    } catch (err) { native('release', this.id); this.id = 0; throw err; }
    carrier.on('data', chunk => {
      if (this.closing || !this.id) return;
      try { native('feed', this.id, chunk); } catch (err) { this.fail(err); return; }
      this.pump();
    });
    // As TLSWrap reads its parent's StreamBase, an owned carrier's native handle hands the
    // ciphertext to the session directly (the handle's consumer, as an HTTP parser that
    // consumes a socket): no Readable push and 'data' emit for each record. The end of the
    // stream and read errors still take the carrier's read path ('end', 'error'), and so
    // does anything the carrier read before this. A paused carrier stops the handle, which
    // holds what it reads until it reads again.
    const handle = owned ? carrier._handle : undefined;
    if (handle && isStreamHandle(handle)) {
      this.consumer = { read: (status, payload) => {
        if (status < 0) return false;
        if (!payload?.byteLength) return true;
        handle._countRead(payload.byteLength);
        if (this.closing || !this.id) return true;
        const bytes = payload instanceof ArrayBuffer ? new Uint8Array(payload) : payload;
        try { native('feed', this.id, bytes); } catch (err) { this.fail(err); return true; }
        this.pump();
        return true;
      } };
      this.consumed = handle;
      (handle._consumers ||= []).push(this.consumer);
    }
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
      try { const data = bytesOf(op('drain', this.id)); if (data.length) this.alert = data; } catch {}
      // As TLSWrap::ClearOut, an established session flushes the alert before onerror:
      // the socket may stay open (a server whose 'error' listener keeps it) and the peer
      // must still learn why.
      if (this.alert && this.ready && this.carrier.writable && !this.carrier.writableEnded) { this.carrier.write(this.alert); this.alert = null; }
    }
    this.socket._onTLSError(err);
  }
  flush(callback) {
    // TLSWrap::EncOut: nothing leaves while a server waits for 'newSession'.
    if (this.awaitingSession) { if (callback) this.flushWaiters.push(callback); return; }
    const data = bytesOf(op('drain', this.id));
    // After DoShutdown the carrier's write side is shut: like TLSWrap's EncOut, what OpenSSL
    // still makes (a client's Finished after an early end()) goes nowhere, and the read
    // side stays open so the peer's answer and end still arrive.
    if (data.length && this.carrier.writableEnded) { if (callback) process.nextTick(callback); return; }
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
        this.requestOCSP(context instanceof NativeSecureContext ? context : null);
      });
    };
    // As Node's loadSNI, a throwing SNICallback destroys the socket.
    try {
      if (servername && this.socket._SNICallback) this.socket._SNICallback(servername, done);
      else done(null, null);
    } catch (err) { this.socket.destroy(err); }
  }
  // Node's requestOCSP: a server with 'OCSPRequest' listeners answers a client's
  // status_request before the certificate callback returns; the staple is sent by
  // the status callback OpenSSL runs after it.
  requestOCSP(context) {
    const server = this.socket.server;
    if (!server || server.listenerCount('OCSPRequest') === 0 || !op('ocspRequested', this.id)) { this.certificateDone(context); return; }
    const ctx = context || this.socket._secureContext.context;
    let once = false;
    const onOCSP = (err, response) => {
      if (once) { this.socket.destroy(new codes.ERR_MULTIPLE_CALLBACK()); return; }
      once = true;
      if (err) { this.socket.destroy(err); return; }
      if (this.closing || !this.id) { this.socket.destroy(new codes.ERR_SOCKET_CLOSED()); return; }
      if (response) op('setOCSPResponse', this.id, response);
      this.certificateDone(context);
    };
    try { server.emit('OCSPRequest', ctx.getCertificate(), ctx.getIssuer(), onOCSP); }
    catch (err) { this.socket.destroy(err); }
  }
  // TLSWrap::CertCbDone.
  certificateDone(context) {
    if (this.closing) return;
    try {
      op('select', this.id, context ? context._id : 0);
      this.selectALPN();
    } catch (failure) { if (!(failure instanceof Failure)) throw failure; this.socket.destroy(failure.cause); return; }
    if (this.closing) return;
    this.selecting = false; this.carrier.resume(); this.pump();
  }
  // Node's SelectALPNCallback with an ALPNCallback: its choice, or a fatal
  // no_application_protocol alert when it returns undefined.
  selectALPN() {
    if (!this.options.isServer || !this.socket._hasALPNCallback() || this.alpnSelected) return;
    this.alpnSelected = true;
    const offered = Buffer.from(op('offeredALPN', this.id));
    if (!offered.length) return;
    const selected = this.socket._callALPNCallback(offered);
    if (this.closing) return;
    if (selected === undefined) op('rejectALPN', this.id);
    else op('serverALPN', this.id, Buffer.concat([Buffer.from([selected.length]), Buffer.from(selected, 'latin1')]));
  }
  // With an ALPNCallback, a TLS 1.3 ClientHello waits until JS chose (see clientHelloDone).
  enableALPNCallback() { if (this.id) op('enableALPNCallback', this.id); }
  // TLSWrap::EnablePskCallback: handler is onPskServerCallback(identity, maxPskLen) or
  // onPskClientCallback(hint, maxPskLen, maxIdentityLen).
  enablePsk(handler) {
    this.pskHandler = handler; answerFor(this.id, this);
    op('enablePsk', this.id);
  }
  setPskIdentityHint(hint) {
    try { op('pskHint', this.id, hint); return true; } catch (failure) { if (!(failure instanceof Failure)) throw failure; return false; }
  }
  answer(kind, text, a, b) {
    if (this.closing || !this.pskHandler) return null;
    if (kind === 1) {
      const psk = this.pskHandler(text, a);
      return psk == null ? null : Buffer.from(psk.buffer, psk.byteOffset, psk.byteLength);
    }
    const ret = this.pskHandler(text, a, b);
    if (ret == null) return null;
    const identity = Buffer.from(ret.identity), psk = Buffer.from(ret.psk.buffer, ret.psk.byteOffset, ret.psk.byteLength);
    const out = Buffer.alloc(2 + identity.length + psk.length);
    out.writeUInt16BE(identity.length, 0); identity.copy(out, 2); psk.copy(out, 2 + identity.length);
    return out;
  }
  enableKeylog() { this.keylog = true; op('enableKeylog', this.id); }
  enableSessionCallbacks() { this.sessionCallbacks = true; op('enableSessionCallbacks', this.id); }
  // Node's EmitClientHello, from a fresh stack as TLSWrap schedules it.
  awaitClientHello() {
    if (this.helloWaiting) return;
    this.helloWaiting = true; this.carrier.pause();
    if (!this.sessionCallbacks) {
      setImmediate(() => { if (!this.closing && this.id) this.clientHelloDone(); });
      return;
    }
    const hello = { sessionId: Buffer.from(op('helloSessionId', this.id)), tlsTicket: !!op('helloTicket', this.id) };
    setImmediate(() => { if (!this.closing && this.id) this.socket._onClientHello(hello); });
  }
  clientHelloDone() {
    if (!this.helloWaiting || this.closing || !this.id) return;
    // SelectALPNCallback runs as OpenSSL parses a TLS 1.3 hello, before SNI's certificate step.
    if (op('helloALPN', this.id)) {
      this.selectALPN();
      if (this.closing || !this.id) return;
    }
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
    const counts = op('handshakeCounts', this.id);
    const starts = Math.floor(counts / 67108864);
    while (this.handshakeStarts < starts) {
      this.handshakeStarts++;
      if (this.options.isServer) this.socket._onHandshakeStart(Date.now());
      if (this.closing) return false;
    }
    if (!this.ready) return true;
    const completions = counts % 67108864;
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
        // A client that writes before TLSSocket#_start (a bare new TLSSocket() that
        // connects) starts its handshake, as SSL_write does inside TLSWrap::DoWrite.
        if (!this.initiated && this.writes.some(item => item.data.length)) this.initiated = true;
        if (!this.initiated) { this.shutdown_(); return; }
        const status = op('handshake', this.id);
        // As in TLSWrap, the handshake-done callback runs before the final flight is
        // sent: a client that rejects the server's certificate never finishes.
        if (status !== 1) this.flush();
        if (!this.handshakeEvents()) return;
        if (status === 4) { this.chooseCertificate(); return; }
        if (status === 11) { this.awaitClientHello(); return; }
        if (status !== 1) { this.shutdown_(); return; }
        // Node's client status callback runs while OpenSSL reads the server's flight,
        // before the client's Finished leaves: 'OCSPResponse' may still destroy it.
        if (!this.options.isServer && this.options.requestOCSP && !this.ocspEmitted) {
          this.ocspEmitted = true;
          const response = Buffer.from(op('ocspResponse', this.id));
          this.socket.emit('OCSPResponse', response.length ? response : null);
          if (this.closing || !this.id) return;
        }
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
        const data = bytesOf(op('read', this.id));
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
          const n = op('write', this.id, item.offset === 0 ? item.data : item.data.subarray(item.offset));
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
    try { data = bytesOf(op('drain', this.id)); } catch { data = Buffer.alloc(0); }
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
    answering.delete(this.id); op('release', this.id); this.id = 0;
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
  unconsume() {
    const handle = this.consumed;
    if (!handle) return;
    this.consumed = null;
    const at = handle._consumers ? handle._consumers.indexOf(this.consumer) : -1;
    if (at !== -1) handle._consumers.splice(at, 1);
  }
  // The TLS handle is closed: release the session and report the close once.
  finish() {
    if (this.closed) return;
    this.closed = true; this.closing = true;
    this.unconsume();
    if (this.id) { answering.delete(this.id); native('release', this.id); this.id = 0; }
    for (const item of this.writes.splice(0)) item.callback(canceled());
    const done = this.pendingShutdown; this.pendingShutdown = null; if (done) done(null);
    // HandleWrap::OnClose for a TLS socket that owns its TCP handle runs from libuv's close
    // callback, after the ticks queued so far (a socket destroyed with an error emits 'error'
    // before 'close'); a wrapped stream closes it as its own 'close' is emitted.
    if (this.owned) process.nextTick(() => this.onEvent?.(6, 0));
    else this.onEvent?.(6, 0);
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
  // A closed carrier has no descriptor (TLSWrap's fd is then -1, as libuv's).
  call(op, ...args) { return this.carrier._transport?.call(op, ...args) ?? (op === 'fileno' ? -1 : 0); }
  getAsyncId() { return this.carrier._handle?.getAsyncId?.() ?? -1; }
  ref() { this.carrier.ref?.(); }
  unref() { this.carrier.unref?.(); }
  hasRef() { return this.carrier._transport?.hasRef() ?? true; }
}
module.exports = { TLSTransport };
