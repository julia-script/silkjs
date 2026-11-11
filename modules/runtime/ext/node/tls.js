'use strict';
// node:tls after Node.js v24 lib/tls.js and lib/internal/tls/wrap.js. A TLSSocket is a
// net.Socket whose transport (internal/tls/transport) carries ciphertext over a
// separate carrier stream: a net.Socket the socket connects, or the stream it wraps.
const net = require('net');
const EE = require('events');
const { Buffer } = require('buffer');
const {
  native, bytes, SecureContext, createSecureContext, ticketKeysBuffer, bundledRootCertificates,
  getCACertificates, setDefaultCACertificates,
} = require('internal/tls/context');
const tlsOptions = require('internal/tls/options');
const {
  codes, invalidArgType, invalidArgValue, outOfRange, validateString, validateFunction, validateBoolean, validateObject,
  validateNumber, validateInt32, validateUint32, validateBuffer,
} = require('internal/tls/errors');
const { ConnResetException } = require('internal/errors');
const { checkServerIdentity } = require('internal/tls/identity');
const { TLSTransport } = require('internal/tls/transport');
const { kTLSServer } = require('internal/tls/server');

const kConnectOptions = Symbol('connect-options');
const kErrorEmitted = Symbol('error-emitted');
const kIsVerified = Symbol('verified');
const kPendingSession = Symbol('pendingSession');
const kHandshakeTimeout = Symbol('handshake-timeout');
const kSNICallback = Symbol('snicallback');
const kEnableTrace = Symbol('enableTrace');
const kPskCallback = Symbol('pskcallback');
const kPskIdentityHint = Symbol('pskidentityhint');
const kALPNCallback = Symbol('alpncallback');
const kDisableRenegotiation = Symbol('disable-renegotiation');

// X509_V_ERR_* names, as ncrypto's X509Pointer::ErrorCode spells them.
const verifyCodes = {
  2: 'UNABLE_TO_GET_ISSUER_CERT', 3: 'UNABLE_TO_GET_CRL', 4: 'UNABLE_TO_DECRYPT_CERT_SIGNATURE',
  5: 'UNABLE_TO_DECRYPT_CRL_SIGNATURE', 6: 'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY', 7: 'CERT_SIGNATURE_FAILURE',
  8: 'CRL_SIGNATURE_FAILURE', 9: 'CERT_NOT_YET_VALID', 10: 'CERT_HAS_EXPIRED', 11: 'CRL_NOT_YET_VALID',
  12: 'CRL_HAS_EXPIRED', 13: 'ERROR_IN_CERT_NOT_BEFORE_FIELD', 14: 'ERROR_IN_CERT_NOT_AFTER_FIELD',
  15: 'ERROR_IN_CRL_LAST_UPDATE_FIELD', 16: 'ERROR_IN_CRL_NEXT_UPDATE_FIELD', 17: 'OUT_OF_MEM',
  18: 'DEPTH_ZERO_SELF_SIGNED_CERT', 19: 'SELF_SIGNED_CERT_IN_CHAIN', 20: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  21: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 22: 'CERT_CHAIN_TOO_LONG', 23: 'CERT_REVOKED', 24: 'INVALID_CA',
  25: 'PATH_LENGTH_EXCEEDED', 26: 'INVALID_PURPOSE', 27: 'CERT_UNTRUSTED', 28: 'CERT_REJECTED', 62: 'HOSTNAME_MISMATCH',
};

let ipServernameWarned = false, tlsTracingWarned = false, warnOnTlsKeylog = true, warnOnTlsKeylogError = true;

function TLSSocket(socket, opts) {
  const options = { ...opts };
  let enableTrace = options.enableTrace;
  if (enableTrace == null) {
    enableTrace = tlsOptions.getOptionValue('--trace-tls');
    if (enableTrace && !tlsTracingWarned) {
      tlsTracingWarned = true;
      process.emitWarning('Enabling --trace-tls can expose sensitive data in the resulting log.');
    }
  } else validateBoolean(enableTrace, 'options.enableTrace');
  if (options.ALPNProtocols) tlsExports.convertALPNProtocols(options.ALPNProtocols, options);
  if (socket && (typeof socket.write !== 'function' || typeof socket.on !== 'function' || typeof socket.resume !== 'function'))
    throw invalidArgType('socket', ['net.Socket', 'stream.Duplex'], socket);
  this._tlsOptions = options;
  this._secureEstablished = false;
  this._securePending = false;
  this._newSessionPending = false;
  this._controlReleased = false;
  this.secureConnecting = true;
  this._SNICallback = null;
  this[kALPNCallback] = null;
  this.servername = null;
  this.alpnProtocol = null;
  this.authorized = false;
  this.authorizationError = null;
  this[kIsVerified] = false;
  this[kPendingSession] = null;
  this.encrypted = true;
  this.lastHandshakeTime = 0;
  this.handshakes = 0;
  net.Socket.call(this, {
    allowHalfOpen: socket ? socket.allowHalfOpen : options.allowHalfOpen,
    highWaterMark: options.highWaterMark,
    onread: !socket ? options.onread : null,
    signal: options.signal,
    noDelay: options.noDelay,
    keepAlive: options.keepAlive,
    keepAliveInitialDelay: options.keepAliveInitialDelay,
  });
  this.on('error', this._tlsError);
  this._init(socket);
  if (options.pauseOnConnect) this.pause();
  if (enableTrace) this.enableTrace();
}
Object.setPrototypeOf(TLSSocket.prototype, net.Socket.prototype);
Object.setPrototypeOf(TLSSocket, net.Socket);

TLSSocket.prototype._init = function(socket) {
  const options = this._tlsOptions;
  this.server = options.server;
  this._requestCert = !!options.requestCert || !options.isServer;
  this._rejectUnauthorized = !!options.rejectUnauthorized;
  this._secureContext = options.secureContext || options.credentials || tlsExports.createSecureContext(options);
  if (!(this._secureContext instanceof SecureContext) || !this._secureContext.context)
    throw new codes.ERR_TLS_INVALID_CONTEXT('context');
  this._parent = socket || new net.Socket({ allowHalfOpen: true });
  this._tls = new TLSTransport(this, this._parent, this._secureContext, options, !socket);
  this._attachTransport(this._tls);
  if (this._requestCert || this._rejectUnauthorized) native('verifyMode', this._tls.id, this._requestCert, this._rejectUnauthorized);
  if (options.isServer && options.ALPNCallback) {
    validateFunction(options.ALPNCallback, 'options.ALPNCallback');
    this[kALPNCallback] = options.ALPNCallback;
  }
  const keylog = tlsOptions.getOptionValue('--tls-keylog');
  if (keylog) {
    if (warnOnTlsKeylog) {
      warnOnTlsKeylog = false;
      process.emitWarning('Using --tls-keylog makes TLS connections insecure by writing secret key material to file ' + keylog);
    }
    this.on('keylog', line => {
      require('fs').appendFile(keylog, line, { mode: 0o600 }, err => {
        if (err && warnOnTlsKeylogError) {
          warnOnTlsKeylogError = false;
          process.emitWarning('Failed to write TLS keylog (this warning will not be repeated): ' + err);
        }
      });
    });
  }
  if (options.isServer && options.SNICallback && (options.SNICallback !== SNICallback || (options.server && options.server._contexts.length))) {
    validateFunction(options.SNICallback, 'options.SNICallback');
    this._SNICallback = options.SNICallback;
  }
  if (options.pskCallback) validateFunction(options.pskCallback, 'pskCallback');
  if (options.handshakeTimeout > 0) this.setTimeout(options.handshakeTimeout, this._handleTimeout);
  if (socket instanceof net.Socket) {
    this.connecting = socket.connecting || socket._connected === false;
    // Like Node's _tls_wrap: the TLS socket connects when the socket it wraps does.
    socket.once('connect', () => { this.connecting = false; this.emit('connect'); });
  }
  if (socket) socket.on('error', err => this._emitTLSError(err));
  else this.connecting = true;
};
TLSSocket.prototype.connect = function(...args) {
  const [options, cb] = net._normalizeArgs(args);
  if (cb) this.once('connect', cb);
  this.connecting = true;
  // The TLS socket listens to options.signal itself; aborting it destroys the parent too.
  try { this._parent.connect({ ...options, allowHalfOpen: true, signal: undefined }); } catch (err) { this.destroy(); throw err; }
  return this;
};
// A client sends its ClientHello only when told to (tls.connect does).
TLSSocket.prototype._start = function() {
  if (this.connecting) { this.once('connect', this._start); return; }
  if (!this._tls?.id) return;
  this._tls.initiate();
};
TLSSocket.prototype.disableRenegotiation = function() { this[kDisableRenegotiation] = true; };
TLSSocket.prototype._handleTimeout = function() { this._emitTLSError(new codes.ERR_TLS_HANDSHAKE_TIMEOUT()); };
TLSSocket.prototype._emitTLSError = function(err) { const e = this._tlsError(err); if (e) this.emit('error', e); };
TLSSocket.prototype._tlsError = function(err) { this.emit('_tlsError', err); return this._controlReleased ? err : null; };
TLSSocket.prototype._releaseControl = function() {
  if (this._controlReleased) return false;
  this._controlReleased = true;
  this.removeListener('error', this._tlsError);
  return true;
};
// The transport calls this when OpenSSL fails (Node's TLSWrap onerror).
TLSSocket.prototype._onTLSError = function(err) {
  if (this._hadError) return;
  this._hadError = true;
  if (!this._secureEstablished) { this._closeAfterHandlingError = true; this.destroy(err); }
  else if (this._tlsOptions.isServer && this._rejectUnauthorized && /peer did not return a certificate/.test(err.message)) this.destroy();
  else this._emitTLSError(err);
};
TLSSocket.prototype._destroySSL = function() {
  if (!this._tls?.id) return;
  this._tls.destroySSL();
  this[kPendingSession] = null;
  this[kIsVerified] = false;
};
TLSSocket.prototype._hasALPNCallback = function() { return typeof this[kALPNCallback] === 'function'; };
// Node's callALPNCallback: the protocol the callback picks from the client's list.
TLSSocket.prototype._callALPNCallback = function(protocolsBuffer) {
  try {
    const servername = native('servername', this._tls.id) || false;
    const protocols = [];
    for (let offset = 0; offset < protocolsBuffer.length;) {
      const length = protocolsBuffer[offset++];
      protocols.push(protocolsBuffer.subarray(offset, offset + length).toString('ascii'));
      offset += length;
    }
    const selected = this[kALPNCallback]({ servername, protocols });
    if (selected === undefined) return undefined;
    if (!protocols.includes(selected))
      throw new codes.ERR_TLS_ALPN_CALLBACK_INVALID_RESULT(selected, protocols);
    return selected;
  } catch (err) {
    this.destroy(err);
    return undefined;
  }
};
// Node's onhandshakestart: limits how often a client may renegotiate.
TLSSocket.prototype._onHandshakeStart = function(now) {
  const { lastHandshakeTime } = this;
  this.lastHandshakeTime = now;
  if (lastHandshakeTime === 0) return;
  if ((now - lastHandshakeTime) >= tlsExports.CLIENT_RENEG_WINDOW * 1000) this.handshakes = 1;
  else this.handshakes++;
  if (this.handshakes > tlsExports.CLIENT_RENEG_LIMIT) {
    this._emitTLSError(new codes.ERR_TLS_SESSION_ATTACK());
    return;
  }
  if (this[kDisableRenegotiation]) this._emitTLSError(new codes.ERR_TLS_RENEGOTIATION_DISABLED());
};
TLSSocket.prototype._finishInit = function() {
  if (!this._tls?.id) return;
  this.alpnProtocol = native('alpn', this._tls.id) || false;
  if (this.servername === null) this.servername = native('servername', this._tls.id) || false;
  this._secureEstablished = true;
  if (this._tlsOptions.handshakeTimeout > 0) this.setTimeout(0, this._handleTimeout);
  this.emit('secure');
};
TLSSocket.prototype._verifyError = function() {
  const code = native('verify', this._tls.id);
  if (code === 0) return null;
  return Object.assign(new Error(native('verifyMessage', code)), { code: verifyCodes[code] || 'UNSPECIFIED' });
};
TLSSocket.prototype.renegotiate = function(options, callback) {
  validateObject(options, 'options');
  if (callback !== undefined) validateFunction(callback, 'callback');
  if (this.destroyed) return;
  let requestCert = !!this._requestCert, rejectUnauthorized = !!this._rejectUnauthorized;
  if (options.requestCert !== undefined) requestCert = !!options.requestCert;
  if (options.rejectUnauthorized !== undefined) rejectUnauthorized = !!options.rejectUnauthorized;
  if (requestCert !== this._requestCert || rejectUnauthorized !== this._rejectUnauthorized) {
    native('verifyMode', this._tls.id, requestCert, rejectUnauthorized);
    this._requestCert = requestCert; this._rejectUnauthorized = rejectUnauthorized;
  }
  try { native('renegotiate', this._tls.id); }
  catch (err) { if (callback) process.nextTick(callback, err); return false; }
  this._tls.renegotiating = true;
  process.nextTick(() => this._tls.pump());
  if (callback) this.once('secure', () => callback(null));
  return true;
};
TLSSocket.prototype.exportKeyingMaterial = function(length, label, context) {
  validateUint32(length, 'length', true);
  validateString(label, 'label');
  if (context !== undefined) validateBuffer(context, 'context');
  if (!this._secureEstablished) throw new codes.ERR_TLS_INVALID_STATE();
  return Buffer.from(native('export', this._tls.id, length, label, context === undefined ? undefined : bytes(context), context !== undefined));
};
TLSSocket.prototype.setMaxSendFragment = function(size) {
  validateInt32(size, 'size');
  if (size < 512 || size > 16384 || !this._tls?.id) return false;
  native('fragment', this._tls.id, size); return true;
};
TLSSocket.prototype.setServername = function(name) {
  validateString(name, 'name');
  if (this._tlsOptions.isServer) throw new codes.ERR_TLS_SNI_FROM_SERVER();
  if (this._tls?.id) native('setServername', this._tls.id, name);
};
TLSSocket.prototype.setSession = function(session) {
  if (typeof session === 'string') session = Buffer.from(session, 'latin1');
  if (session !== undefined && this._tls?.id) native('setSession', this._tls.id, bytes(session, 'session'));
};
TLSSocket.prototype.getSession = function() {
  if (!this._tls?.id) return null;
  const session = Buffer.from(native('session', this._tls.id));
  return session.length ? session : undefined;
};
TLSSocket.prototype.getTLSTicket = function() {
  if (!this._tls?.id) return null;
  const ticket = Buffer.from(native('ticket', this._tls.id));
  return ticket.length ? ticket : undefined;
};
TLSSocket.prototype.isSessionReused = function() { return this._tls?.id ? !!native('sessionReused', this._tls.id) : null; };
// Node's X509ToObject is X509Certificate#toLegacyObject; the detailed form links
// each certificate to its issuer and ends at a self-signed root.
TLSSocket.prototype.getPeerCertificate = function(detailed = false) {
  if (!this._tls?.id) return null;
  const leaf = Buffer.from(native('peerCertificate', this._tls.id));
  if (!leaf.length) return {};
  const x509 = require('internal/crypto_certificates');
  if (!detailed) return new x509.X509Certificate(leaf).toLegacyObject();
  // Node completes the peer's chain with issuers from the trust store; the chain
  // OpenSSL verified is that same path when verification built one.
  const verified = [];
  for (let i = 0;; i++) {
    const next = Buffer.from(native('verifiedCertificate', this._tls.id, i));
    if (!next.length) break;
    verified.push(next);
  }
  if (verified.length && verified[0].equals(leaf)) return x509._x509FromChain(verified).toLegacyObject();
  return this.getPeerX509Certificate().toLegacyObject();
};
TLSSocket.prototype.getCertificate = function() {
  if (!this._tls?.id) return null;
  const own = this.getX509Certificate();
  return own ? own.toLegacyObject() : {};
};
TLSSocket.prototype.getPeerX509Certificate = function() {
  if (!this._tls?.id) return undefined;
  const leaf = Buffer.from(native('peerCertificate', this._tls.id));
  if (!leaf.length) return undefined;
  const chain = [leaf];
  for (let i = 0;; i++) {
    const next = Buffer.from(native('chainCertificate', this._tls.id, i));
    if (!next.length) break;
    if (!next.equals(leaf)) chain.push(next);
  }
  return require('internal/crypto_certificates')._x509FromChain(chain);
};
TLSSocket.prototype.getX509Certificate = function() {
  if (!this._tls?.id) return undefined;
  const der = Buffer.from(native('certificate', this._tls.id));
  return der.length ? new (require('crypto').X509Certificate)(der) : undefined;
};
TLSSocket.prototype.setKeyCert = function(context) {
  if (!this._tls?.id) return;
  const secureContext = context instanceof SecureContext ? context : tlsExports.createSecureContext(context);
  native('select', this._tls.id, secureContext.context._id);
};
TLSSocket.prototype.getSharedSigalgs = function() {
  if (!this._tls?.id) return null;
  const names = { 6: 'RSA', 912: 'RSA-PSS', 116: 'DSA', 408: 'ECDSA', 1087: 'Ed25519', 1088: 'Ed448' };
  const result = [];
  for (let i = 0;; i++) {
    const sign = native('sharedSigalg', this._tls.id, i, 0);
    if (sign === '') break;
    result.push((names[sign] || native('sharedSigalg', this._tls.id, i, 2)) + '+' + native('sharedSigalg', this._tls.id, i, 1));
  }
  return result;
};
TLSSocket.prototype.getEphemeralKeyInfo = function() {
  if (!this._tls?.id) return null;
  if (this._tlsOptions.isServer) return null;
  const type = native('ephemeralType', this._tls.id);
  if (type === 28 || type === 920) return { type: 'DH', size: native('ephemeralBits', this._tls.id) };
  if (type === 408 || type === 1034 || type === 1035) return { type: 'ECDH', name: native('ephemeralName', this._tls.id), size: native('ephemeralBits', this._tls.id) };
  const name = native('negotiatedGroup', this._tls.id);
  return name ? { type: 'TLSGroup', name } : {};
};
TLSSocket.prototype.enableTrace = function() { if (this._tls?.id) native('trace', this._tls.id); };
TLSSocket.prototype.getProtocol = function() { return this._tls?.id ? native('protocol', this._tls.id) || null : null; };
TLSSocket.prototype.getCipher = function() {
  if (!this._tls?.id) return null;
  const name = native('cipher', this._tls.id);
  if (!name) return {};
  return { name, standardName: native('cipherStandard', this._tls.id), version: native('cipherVersion', this._tls.id) };
};
TLSSocket.prototype.getFinished = function() {
  if (!this._tls?.id) return null;
  const finished = Buffer.from(native('finished', this._tls.id));
  return finished.length ? finished : undefined;
};
TLSSocket.prototype.getPeerFinished = function() {
  if (!this._tls?.id) return null;
  const finished = Buffer.from(native('peerFinished', this._tls.id));
  return finished.length ? finished : undefined;
};
// Client sessions surface after verification (Node's onnewsessionclient).
TLSSocket.prototype._emitSession = function() {
  if (this._tlsOptions.isServer || !this._secureEstablished || !this.listenerCount('session')) return;
  const session = this.getSession();
  if (!session?.length || (this._lastSession && session.equals(this._lastSession))) return;
  this._lastSession = session;
  if (this[kIsVerified]) this.emit('session', session);
  else this[kPendingSession] = session;
};

function onServerSocketSecure() {
  if (this._requestCert) {
    const verifyError = this._verifyError();
    if (verifyError) {
      this.authorizationError = verifyError.code;
      if (this._rejectUnauthorized) this.destroy();
    } else this.authorized = true;
  }
  if (!this.destroyed && this._releaseControl()) {
    this.secureConnecting = false;
    this._tlsOptions.server.emit('secureConnection', this);
  }
}
function onSocketTLSError(err) {
  if (!this._controlReleased && !this[kErrorEmitted]) {
    this[kErrorEmitted] = true;
    this._tlsOptions.server.emit('tlsClientError', err, this);
  }
}
function onSocketKeylog(line) { this._tlsOptions.server.emit('keylog', line, this); }
function onSocketClose(err) {
  if (err) return;
  if (!this._controlReleased && !this[kErrorEmitted]) {
    this[kErrorEmitted] = true;
    this._tlsOptions.server.emit('tlsClientError', new ConnResetException('socket hang up'), this);
  }
}
function tlsConnectionListener(rawSocket) {
  const socket = new TLSSocket(rawSocket, {
    secureContext: this._sharedCreds, isServer: true, server: this,
    requestCert: this.requestCert, rejectUnauthorized: this.rejectUnauthorized,
    handshakeTimeout: this[kHandshakeTimeout], ALPNProtocols: this.ALPNProtocols, ALPNCallback: this.ALPNCallback,
    SNICallback: this[kSNICallback] || SNICallback, enableTrace: this[kEnableTrace], pauseOnConnect: this.pauseOnConnect,
    pskCallback: this[kPskCallback], pskIdentityHint: this[kPskIdentityHint],
  });
  socket.on('secure', onServerSocketSecure);
  if (this.listenerCount('keylog') > 0) socket.on('keylog', onSocketKeylog);
  socket[kErrorEmitted] = false;
  socket.on('close', onSocketClose);
  socket.on('_tlsError', onSocketTLSError);
  socket.on('error', onSocketTLSError);
}

// The TLS half of Node's tls.Server constructor, shared with https and http2
// servers that are not tls.Server instances.
function initServer(server, options) {
  server._contexts = [];
  server.requestCert = options.requestCert === true;
  server.rejectUnauthorized = options.rejectUnauthorized !== false;
  server.ALPNCallback = options.ALPNCallback;
  if (server.ALPNCallback && options.ALPNProtocols)
    throw new codes.ERR_TLS_ALPN_CALLBACK_WITH_PROTOCOLS();
  if (options.sessionTimeout) server.sessionTimeout = options.sessionTimeout;
  if (options.ticketKeys) server.ticketKeys = options.ticketKeys;
  if (options.ALPNProtocols) tlsExports.convertALPNProtocols(options.ALPNProtocols, server);
  Server.prototype.setSecureContext.call(server, options);
  server[kHandshakeTimeout] = options.handshakeTimeout || (120 * 1000);
  server[kSNICallback] = options.SNICallback;
  server[kPskCallback] = options.pskCallback;
  server[kPskIdentityHint] = options.pskIdentityHint;
  validateNumber(server[kHandshakeTimeout], 'options.handshakeTimeout');
  if (server[kSNICallback]) validateFunction(server[kSNICallback], 'options.SNICallback');
  if (server[kPskCallback]) validateFunction(server[kPskCallback], 'options.pskCallback');
  if (server[kPskIdentityHint]) validateString(server[kPskIdentityHint], 'options.pskIdentityHint');
  server[kEnableTrace] = options.enableTrace;
}
function Server(options, listener) {
  if (!(this instanceof Server)) return new Server(options, listener);
  if (typeof options === 'function') { listener = options; options = {}; }
  else if (options == null || typeof options === 'object') options ??= {};
  else throw invalidArgType('options', 'Object', options);
  initServer(this, options);
  net.Server.call(this, { ...options, allowHalfOpen: options.allowHalfOpen }, tlsConnectionListener);
  if (listener) this.on('secureConnection', listener);
}
Server[kTLSServer] = { initServer, tlsConnectionListener };
Object.setPrototypeOf(Server.prototype, net.Server.prototype);
Object.setPrototypeOf(Server, net.Server);
Server.prototype.setSecureContext = function(options) {
  validateObject(options, 'options');
  this.pfx = options.pfx || undefined;
  this.key = options.key || undefined;
  this.passphrase = options.passphrase || undefined;
  this.cert = options.cert || undefined;
  this.clientCertEngine = options.clientCertEngine || undefined;
  this.ca = options.ca || undefined;
  this.minVersion = options.minVersion || undefined;
  this.maxVersion = options.maxVersion || undefined;
  this.secureProtocol = options.secureProtocol || undefined;
  this.crl = options.crl || undefined;
  this.sigalgs = options.sigalgs;
  this.ciphers = options.ciphers || undefined;
  this.ecdhCurve = options.ecdhCurve;
  this.dhparam = options.dhparam || undefined;
  this.honorCipherOrder = options.honorCipherOrder !== undefined ? !!options.honorCipherOrder : true;
  this.secureOptions = options.secureOptions || undefined;
  this.sessionIdContext = options.sessionIdContext ||
    require('crypto').createHash('sha1').update(process.argv.join(' ')).digest('hex').slice(0, 32);
  if (options.sessionTimeout) this.sessionTimeout = options.sessionTimeout;
  if (options.ticketKeys) this.ticketKeys = options.ticketKeys;
  this.privateKeyIdentifier = options.privateKeyIdentifier;
  this.privateKeyEngine = options.privateKeyEngine;
  this.certificateCompression = options.certificateCompression;
  this._sharedCreds = tlsExports.createSecureContext({
    pfx: this.pfx, key: this.key, passphrase: this.passphrase, cert: this.cert, clientCertEngine: this.clientCertEngine,
    ca: this.ca, ciphers: this.ciphers, sigalgs: this.sigalgs, ecdhCurve: this.ecdhCurve, dhparam: this.dhparam,
    minVersion: this.minVersion, maxVersion: this.maxVersion, secureProtocol: this.secureProtocol,
    secureOptions: this.secureOptions, honorCipherOrder: this.honorCipherOrder, crl: this.crl,
    sessionIdContext: this.sessionIdContext, ticketKeys: this.ticketKeys, sessionTimeout: this.sessionTimeout,
    privateKeyIdentifier: this.privateKeyIdentifier, privateKeyEngine: this.privateKeyEngine,
    certificateCompression: this.certificateCompression,
  });
};
Server.prototype._getServerData = function() { return { ticketKeys: this.getTicketKeys().toString('hex') }; };
Server.prototype._setServerData = function(data) { this.setTicketKeys(Buffer.from(data.ticketKeys, 'hex')); };
Server.prototype.getTicketKeys = function() { return this._sharedCreds.context.getTicketKeys(); };
Server.prototype.setTicketKeys = function(keys) {
  validateBuffer(keys);
  if (keys.byteLength !== 48) throw Object.assign(new Error('Session ticket keys must be a 48-byte buffer'), { code: 'ERR_ASSERTION' });
  this._sharedCreds.context.setTicketKeys(keys);
};
Server.prototype.addContext = function(servername, context) {
  if (!servername) throw new codes.ERR_TLS_REQUIRED_SERVER_NAME();
  const re = new RegExp(`^${servername.replace(/([.^$+?\-\\[\]{}])/g, '\\$1').replaceAll('*', '[^.]*')}$`, 'i');
  const secureContext = context instanceof SecureContext ? context : tlsExports.createSecureContext(context);
  this._contexts.push([re, secureContext.context]);
};
Server.prototype[EE.captureRejectionSymbol] = function(err, event, sock) {
  if (event === 'secureConnection') { sock.destroy(err); return; }
  net.Server.prototype[Symbol.for('nodejs.rejection')].call(this, err, event, sock);
};
function SNICallback(servername, callback) {
  const contexts = this.server._contexts;
  for (let i = contexts.length - 1; i >= 0; --i) {
    if (contexts[i][0].test(servername)) { callback(null, contexts[i][1]); return; }
  }
  callback(null, undefined);
}

function normalizeConnectArgs(listArgs) {
  const args = net._normalizeArgs(listArgs);
  const options = args[0], cb = args[1];
  if (listArgs[1] !== null && typeof listArgs[1] === 'object') Object.assign(options, listArgs[1]);
  else Object.assign(options, listArgs[2]);
  return cb ? [options, cb] : [options];
}
function onConnectSecure() {
  const options = this[kConnectOptions];
  const ekeyinfo = this.getEphemeralKeyInfo();
  if (ekeyinfo.type === 'DH' && ekeyinfo.size < options.minDHSize) {
    const err = new codes.ERR_TLS_DH_PARAM_SIZE(ekeyinfo.size);
    this.emit('error', err);
    this.destroy();
    return;
  }
  let verifyError = this._verifyError();
  if (!verifyError && !this.isSessionReused()) {
    const cert = this.getPeerCertificate(true);
    verifyError = options.checkServerIdentity(options.servername || options.host || 'localhost', cert);
  }
  if (verifyError) {
    this.authorized = false;
    this.authorizationError = verifyError.code || verifyError.message;
    if (options.rejectUnauthorized !== false) { this.destroy(verifyError); return; }
  } else this.authorized = true;
  this.secureConnecting = false;
  this.emit('secureConnect');
  this[kIsVerified] = true;
  const session = this[kPendingSession];
  this[kPendingSession] = null;
  if (session) this.emit('session', session);
  this.removeListener('end', onConnectEnd);
}
function onConnectEnd() {
  if (!this._hadError) {
    const options = this[kConnectOptions];
    this._hadError = true;
    const err = new ConnResetException('Client network socket disconnected before secure TLS connection was established');
    err.path = options.path; err.host = options.host; err.port = options.port; err.localAddress = options.localAddress;
    this.destroy(err);
  }
}
function connect(...args) {
  args = normalizeConnectArgs(args);
  let options = args[0];
  const cb = args[1];
  const allowUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0';
  if (allowUnauthorized && !connect.warned) {
    connect.warned = true;
    process.emitWarning("Setting the NODE_TLS_REJECT_UNAUTHORIZED environment variable to '0' makes TLS connections and HTTPS requests insecure by disabling certificate verification.");
  }
  options = { rejectUnauthorized: !allowUnauthorized, ciphers: tlsExports.DEFAULT_CIPHERS, checkServerIdentity, minDHSize: 1024, ...options };
  if (!options.keepAlive) options.singleUse = true;
  validateFunction(options.checkServerIdentity, 'options.checkServerIdentity');
  validateNumber(options.minDHSize, 'options.minDHSize', 1);
  const context = options.secureContext || tlsExports.createSecureContext(options);
  const tlssock = new TLSSocket(options.socket, {
    allowHalfOpen: options.allowHalfOpen, pipe: !!options.path, secureContext: context, isServer: false,
    requestCert: true, rejectUnauthorized: options.rejectUnauthorized !== false, session: options.session,
    ALPNProtocols: options.ALPNProtocols, requestOCSP: options.requestOCSP, enableTrace: options.enableTrace,
    pskCallback: options.pskCallback, highWaterMark: options.highWaterMark, onread: options.onread,
    signal: options.signal, noDelay: options.noDelay, keepAlive: options.keepAlive,
    keepAliveInitialDelay: options.keepAliveInitialDelay,
  });
  options.rejectUnauthorized = options.rejectUnauthorized !== false;
  tlssock[kConnectOptions] = options;
  if (cb) tlssock.once('secureConnect', cb);
  if (!options.socket) {
    if (options.timeout) tlssock.setTimeout(options.timeout);
    tlssock.connect(options, tlssock._start);
  }
  tlssock._releaseControl();
  if (options.session) tlssock.setSession(options.session);
  if (options.servername) {
    if (!ipServernameWarned && net.isIP(options.servername)) {
      process.emitWarning('Setting the TLS ServerName to an IP address is not permitted by RFC 6066. This will be ignored in a future version.', 'DeprecationWarning', 'DEP0123');
      ipServernameWarned = true;
    }
    tlssock.setServername(options.servername);
  }
  if (options.socket) tlssock._start();
  tlssock.on('secure', onConnectSecure);
  tlssock.prependListener('end', onConnectEnd);
  return tlssock;
}
function createServer(options, listener) { return new Server(options, listener); }

function convertProtocols(protocols) {
  const lens = new Array(protocols.length);
  const buff = Buffer.allocUnsafe(protocols.reduce((p, c, i) => {
    const len = Buffer.byteLength(c);
    if (len === 0) throw invalidArgValue(`protocols[${i}]`, c, 'must be a non-empty string');
    if (len > 255) throw outOfRange(`The byte length of the protocol at index ${i} exceeds the maximum length.`, '<= 255', len, true);
    lens[i] = len;
    return p + 1 + len;
  }, 0));
  let offset = 0;
  for (let i = 0, c = protocols.length; i < c; i++) {
    buff[offset++] = lens[i];
    buff.write(protocols[i], offset);
    offset += lens[i];
  }
  return buff;
}
function validateALPNBuffer(buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const len = buffer[offset];
    if (len === 0) throw invalidArgValue('ALPNProtocols', buffer, 'must not contain zero-length protocol');
    if (offset + 1 + len > buffer.length) throw invalidArgValue('ALPNProtocols', buffer, 'contains truncated protocol');
    offset += 1 + len;
  }
}
function convertALPNProtocols(protocols, out) {
  if (Array.isArray(protocols)) out.ALPNProtocols = convertProtocols(protocols);
  else if (protocols instanceof Uint8Array) {
    const buf = Buffer.from(protocols);
    validateALPNBuffer(buf);
    out.ALPNProtocols = buf;
  } else if (ArrayBuffer.isView(protocols)) {
    const buf = Buffer.from(protocols.buffer.slice(protocols.byteOffset, protocols.byteOffset + protocols.byteLength));
    validateALPNBuffer(buf);
    out.ALPNProtocols = buf;
  }
}
let ciphers;
function getCiphers() {
  if (ciphers) return ciphers;
  const context = native('context');
  // Node's GetCiphers also lists the TLSv1.3 suites a default context leaves
  // disabled (the CCM ones); lib/tls.js lowercases, dedupes and sorts.
  try {
    const names = [...native('cipherNames', context).trim().split('\n'), 'TLS_AES_128_CCM_8_SHA256', 'TLS_AES_128_CCM_SHA256'];
    ciphers = require('internal/util').filterDuplicateStrings(names, true);
  }
  finally { native('release', context); }
  return ciphers;
}

const tlsExports = module.exports = {
  CLIENT_RENEG_LIMIT: 3,
  CLIENT_RENEG_WINDOW: 600,
  DEFAULT_CIPHERS: tlsOptions.getOptionValue('--tls-cipher-list'),
  DEFAULT_ECDH_CURVE: 'auto',
  DEFAULT_MIN_VERSION: tlsOptions.getOptionValue('--tls-min-v1.0') ? 'TLSv1' : tlsOptions.getOptionValue('--tls-min-v1.1') ? 'TLSv1.1' :
    tlsOptions.getOptionValue('--tls-min-v1.2') ? 'TLSv1.2' : tlsOptions.getOptionValue('--tls-min-v1.3') ? 'TLSv1.3' : 'TLSv1.2',
  DEFAULT_MAX_VERSION: tlsOptions.getOptionValue('--tls-max-v1.3') ? 'TLSv1.3' : tlsOptions.getOptionValue('--tls-max-v1.2') ? 'TLSv1.2' : 'TLSv1.3',
  getCiphers, getCACertificates, setDefaultCACertificates, convertALPNProtocols, checkServerIdentity,
  createSecureContext, SecureContext, TLSSocket, Server, createServer, connect,
};
Object.defineProperty(tlsExports, 'rootCertificates', { configurable: false, enumerable: true, get: () => bundledRootCertificates });
