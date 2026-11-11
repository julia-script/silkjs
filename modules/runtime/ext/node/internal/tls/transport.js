'use strict';
const { Buffer } = require('buffer');
const { native, error } = require('internal/tls/context');

// The carrier is an ordinary net.Socket (or user Duplex). Only ciphertext crosses
// it. Socket._attachTransport keeps stream/backpressure machinery in net.Socket.
class TLSTransport {
  constructor(socket, carrier, context, options) {
    this.socket = socket; this.carrier = carrier; this.context = context; this.options = options;
    this.kind = carrier._transport?.kind || 1; this.closed = false; this.closing = false;
    this.reading = true; this.ready = false; this.selecting = false; this.pumping = false;
    this.writes = []; this.pendingShutdown = null; this.eof = false; this.started = false;
    this.id = native('create', context._id, !!options.isServer, !!options.requestCert, options.rejectUnauthorized !== false);
    try {
      if (!options.isServer && options.servername) native('setServername', this.id, options.servername);
      if (!options.isServer && options.ALPNProtocols?.length) native('setALPN', this.id, options.ALPNProtocols);
      if (options.isServer && options._alpnOverride) native('serverALPN', this.id, options.ALPNProtocols);
      if (options.session) native('setSession', this.id, options.session);
    } catch (err) { native('release', this.id); this.id = 0; throw err; }
    carrier.on('data', chunk => {
      if (this.closing) return;
      try { native('feed', this.id, chunk); this.pump(); } catch (err) { this.fail(err); }
    });
    carrier.on('end', () => {
      if (this.closing) return;
      if (!this.ready) this.fail(error('ECONNRESET', 'Client network socket disconnected before secure TLS connection was established'));
      else if (!this.eof) this.fail(error('ERR_SSL_UNEXPECTED_EOF_WHILE_READING', 'TLS peer closed without close_notify'));
    });
    carrier.on('error', err => this.fail(err));
    carrier.once('close', () => {
      this.closed = true; this.closing = true;
      if (this.id) { native('release', this.id); this.id = 0; }
      const err = error('ERR_STREAM_DESTROYED', 'TLS socket was destroyed');
      for (const item of this.writes.splice(0)) item.callback(err);
      const done = this.pendingShutdown; this.pendingShutdown = null; if (done) done(err);
      this.onEvent?.(6, 0);
    });
    const start = () => {
      if (this.closing || this.started || carrier.connecting || carrier._connected === false) return;
      this.started = true;
      this.onEvent?.(3, 0);
      if (this.closing) return;
      this.carrier.resume(); this.pump();
    };
    if (carrier.connecting) carrier.once('connect', start);
    else process.nextTick(start);
  }
  fail(err) { if (!this.closing) this.socket.destroy(err); }
  flush(callback) {
    const data = Buffer.from(native('drain', this.id));
    if (data.length) { this.socket._refreshTimeout(); this.carrier.write(data, callback); }
    else if (callback) process.nextTick(callback);
  }
  chooseCertificate() {
    if (this.selecting) return;
    this.selecting = true; this.carrier.pause();
    const servername = native('servername', this.id); this.socket.servername = servername || false;
    let called = false;
    const done = (err, context) => {
      if (called) return; called = true;
      // Always resume outside the OpenSSL operation, including synchronous user callbacks.
      process.nextTick(() => {
        if (this.closing) return;
        if (err) { this.fail(err); return; }
        try {
          if (context && !Number.isInteger(context._id)) throw error('ERR_INVALID_ARG_TYPE', 'SNICallback must supply a SecureContext', TypeError);
          if (context) this.selectedContext = context;
          native('select', this.id, context?._id || 0); this.selecting = false; this.carrier.resume(); this.pump();
        } catch (failure) { this.fail(failure); }
      });
    };
    try {
      if (servername && this.options.SNICallback) this.options.SNICallback.call(this.socket, servername, done);
      else done(null, null);
    } catch (err) { done(err); }
  }
  handshakeEvents() {
    const starts = native('handshakeStarts', this.id);
    if (this.options.isServer && starts > this.handshakeStarts) {
      const now = Date.now(), tls = require('tls');
      this.renegotiations = now - this.lastHandshake >= tls.CLIENT_RENEG_WINDOW * 1000 ? starts - this.handshakeStarts : this.renegotiations + starts - this.handshakeStarts;
      this.lastHandshake = now;
      if (this.renegotiations > tls.CLIENT_RENEG_LIMIT) { this.fail(error('ERR_TLS_SESSION_ATTACK', 'TLS session renegotiation attack detected')); return false; }
      if (this.socket._renegotiationDisabled) { this.fail(error('ERR_TLS_RENEGOTIATION_DISABLED', 'TLS session renegotiation disabled for this socket')); return false; }
    }
    this.handshakeStarts = starts;
    const completions = native('handshakeCompletions', this.id);
    if (completions > this.handshakeCompletions) {
      this.handshakeCompletions = completions;
      if (!this.socket._authorize()) return false;
      this.socket.emit('secure');
    }
    return !this.closing;
  }
  pump() {
    if (this.pumping || this.closing || !this.started || this.selecting) return;
    this.pumping = true;
    try {
      if (!this.ready) {
        const status = native('handshake', this.id); this.flush();
        if (status === 4) { this.chooseCertificate(); return; }
        if (status !== 1) return;
        if (!this.socket._authorize()) return;
        this.ready = true;
        this.handshakeStarts = native('handshakeStarts', this.id);
        this.handshakeCompletions = native('handshakeCompletions', this.id);
        this.lastHandshake = Date.now(); this.renegotiations = 0;
        this.socket._secureEstablished = true;
        this.socket.emit('secure');
        if (!this.options.isServer) this.socket.emit('secureConnect');
        if (this.closing) return;
        this.socket._emitSession();
      }
      if (this.renegotiating) {
        this.renegotiating = false;
        native('handshake', this.id);
        if (!this.handshakeEvents()) return;
        this.flush();
      }
      while (this.reading && !this.closing) {
        const data = Buffer.from(native('read', this.id));
        if (!this.handshakeEvents()) return;
        this.flush();
        if (!data.length) break;
        this.onEvent?.(1, data.length, data);
      }
      if (!this.eof && (native('receivedShutdown', this.id) & 2)) { this.eof = true; this.onEvent?.(1, -4095); }
      if (this.closing) return;
      this.socket._emitSession();
      const item = this.writes[0];
      if (item && !item.inflight) {
        if (!item.data.length) { this.writes.shift(); process.nextTick(() => { item.callback(); this.pump(); }); }
        else {
          const n = native('write', this.id, item.data.subarray(item.offset));
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
      } else if (!item && this.pendingShutdown && !this.shutdownInFlight) {
        this.shutdownInFlight = true;
        native('shutdown', this.id);
        this.flush(err => {
          if (this.closing) return;
          const finish = failure => {
            const done = this.pendingShutdown; this.pendingShutdown = null;
            if (done) done(failure);
          };
          if (err) finish(err); else this.carrier.end(finish);
        });
      }
      if (!this.reading) this.carrier.pause();
    } catch (err) { this.fail(err); }
    finally { this.pumping = false; }
  }
  write(data, callback) {
    if (this.closing) { process.nextTick(() => callback(error('ERR_STREAM_DESTROYED', 'TLS socket is closed'))); return; }
    this.writes.push({ data, offset: 0, callback, inflight: false }); this.pump();
  }
  writev(chunks, callback) {
    let pending = chunks.length, failure;
    if (!pending) { process.nextTick(callback); return; }
    for (const entry of chunks) this.write(entry.chunk, err => { failure ||= err; if (--pending === 0) callback(failure); });
  }
  shutdown(callback) { this.pendingShutdown = callback; this.pump(); }
  readStart() { this.reading = true; this.carrier.resume(); this.pump(); return 0; }
  readStop() { this.reading = false; if (this.ready) this.carrier.pause(); return 0; }
  close(reset = false) {
    if (this.closing) return 0;
    this.closing = true;
    if (reset && this.carrier.resetAndDestroy) this.carrier.resetAndDestroy(); else this.carrier.destroy();
    return 0;
  }
  address(peer = false) {
    if (this.carrier._transport) return this.carrier._transport.address(peer);
    if (!peer) return this.carrier.address?.();
    return this.carrier.remoteAddress ? { address: this.carrier.remoteAddress, port: this.carrier.remotePort, family: this.carrier.remoteFamily } : undefined;
  }
  call(op, ...args) { return this.carrier._transport?.call(op, ...args) ?? 0; }
  ref() { this.carrier.ref?.(); }
  unref() { this.carrier.unref?.(); }
  hasRef() { return this.carrier._transport?.hasRef() ?? true; }
}
module.exports = { TLSTransport };
