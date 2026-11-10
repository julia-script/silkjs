'use strict';
const net = require('net');
const { Buffer } = require('buffer');
const { native, bytes, alpn, error, SecureContext, createSecureContext, DEFAULT_CIPHERS, rootCertificates, getCACertificates, setDefaultCACertificates } = require('internal/tls/context');
const { checkServerIdentity } = require('internal/tls/identity');
const { certificate } = require('internal/tls/certificate');
const { TLSTransport } = require('internal/tls/transport');

const verifyCodes = {
  '-1': 'UNABLE_TO_GET_ISSUER_CERT', 2: 'UNABLE_TO_GET_ISSUER_CERT', 3: 'UNABLE_TO_GET_CRL', 4: 'UNABLE_TO_DECRYPT_CERT_SIGNATURE',
  6: 'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY', 7: 'CERT_SIGNATURE_FAILURE', 9: 'CERT_NOT_YET_VALID', 10: 'CERT_HAS_EXPIRED',
  18: 'DEPTH_ZERO_SELF_SIGNED_CERT', 19: 'SELF_SIGNED_CERT_IN_CHAIN', 20: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 21: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  22: 'CERT_CHAIN_TOO_LONG', 23: 'CERT_REVOKED', 24: 'INVALID_CA', 25: 'PATH_LENGTH_EXCEEDED', 26: 'INVALID_PURPOSE',
  27: 'CERT_UNTRUSTED', 28: 'CERT_REJECTED', 62: 'HOSTNAME_MISMATCH', 66: 'EE_KEY_TOO_SMALL', 67: 'CA_KEY_TOO_SMALL', 68: 'CA_MD_TOO_WEAK',
};
function TLSSocket(socket, options = {}) {
  if (!(this instanceof TLSSocket)) return new TLSSocket(socket, options);
  if (socket && typeof socket.write !== 'function') { options = socket; socket = undefined; }
  const timeout = options.handshakeTimeout === undefined ? (options.isServer ? 120000 : 0) : options.handshakeTimeout;
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout < 0) throw error('ERR_OUT_OF_RANGE', 'handshakeTimeout must be nonnegative', RangeError);
  net.Socket.call(this, { ...options, fd: undefined, onread: options.onread });
  this.encrypted = true; this.authorized = false; this.authorizationError = null;
  this.alpnProtocol = null; this.servername = options.servername || false;
  this._secureEstablished = false; this._tlsOptions = { ...options };
  this._tlsOptions.rejectUnauthorized = options.rejectUnauthorized !== false;
  this._tlsOptions.ALPNProtocols = alpn(options.ALPNProtocols);
  this._tlsOptions._alpnOverride = options.ALPNProtocols !== undefined;
  this._secureContext = options.secureContext || createSecureContext(options);
  if (!(this._secureContext instanceof SecureContext)) throw error('ERR_INVALID_ARG_TYPE', 'secureContext must be a SecureContext', TypeError);
  this._parent = socket || new net.Socket({ ...options, onread: undefined, allowHalfOpen: true });
  this.connecting = !socket || !!socket.connecting;
  this._tls = new TLSTransport(this, this._parent, this._secureContext, this._tlsOptions);
  this._attachTransport(this._tls);
  if (options.enableTrace) this.enableTrace();
  this._handshakeTimer = null;
  if (timeout) { this._handshakeTimer = setTimeout(() => this.destroy(error('ERR_TLS_HANDSHAKE_TIMEOUT', 'TLS handshake timeout')), timeout); this._handshakeTimer.unref?.(); }
  this.once('close', () => { clearTimeout(this._handshakeTimer); this._handshakeTimer = null; });
}
Object.setPrototypeOf(TLSSocket.prototype, net.Socket.prototype);
Object.setPrototypeOf(TLSSocket, net.Socket);
TLSSocket.prototype.connect = function(...args) {
  if (this._tls.started || this._parent.connecting) throw error('ERR_SOCKET_CONNECTING', 'Socket is already connecting');
  this.connecting = true;
  // The adapter was constructed before a new carrier starts connecting.
  this._parent.once('connect', () => {
    if (this._tls.started || this.destroyed) return;
    this._tls.started = true; this._tls.onEvent(3, 0); this._parent.resume(); this._tls.pump();
  });
  try { this._parent.connect(...args); } catch (err) { this.destroy(); throw err; }
  return this;
};
TLSSocket.prototype._authorize = function() {
  this.alpnProtocol = native('alpn', this._tls.id) || false;
  if (this._tlsOptions.isServer) this.servername = native('servername', this._tls.id) || false;
  let failure;
  if (!this._tlsOptions.isServer || this._tlsOptions.requestCert) {
    const code = native('verify', this._tls.id);
    if (code !== 0) failure = error(verifyCodes[code] || 'CERT_VERIFY_FAILED', code === -1 ? 'Peer did not return a certificate' : native('verifyMessage', code));
    else if (!this._tlsOptions.isServer) failure = (this._tlsOptions.checkServerIdentity || checkServerIdentity)(this._tlsOptions.servername || this._tlsOptions.host || this._parent._host || 'localhost', this.getPeerCertificate(true));
    this.authorized = !failure; this.authorizationError = failure ? failure.code || failure.message : null;
    if (failure && this._tlsOptions.rejectUnauthorized) { this.destroy(failure); return false; }
  }
  clearTimeout(this._handshakeTimer); this._handshakeTimer = null;
  return !this.destroyed;
};
TLSSocket.prototype.getPeerCertificate = function(detailed = false) {
  if (!this._tls?.id) return null;
  const leaf = certificate(native('peerCertificate', this._tls.id));
  if (!detailed || !leaf.raw) return leaf;
  const chain = [];
  for (let i = 0;; i++) {
    const next = certificate(native('chainCertificate', this._tls.id, i)); if (!next.raw) break;
    if (next.raw.equals(leaf.raw)) continue;
    chain.push(next);
  }
  let current = leaf;
  for (const next of chain) { current.issuerCertificate = next; current = next; }
  if (JSON.stringify(current.subject) === JSON.stringify(current.issuer)) current.issuerCertificate = current;
  return leaf;
};
TLSSocket.prototype.getCertificate = function() { return this._tls?.id ? certificate(native('certificate', this._tls.id)) : null; };
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
  if (!this._tls?.id || this._tlsOptions.isServer) return null;
  const type = native('ephemeralType', this._tls.id);
  if (type === 28 || type === 920) return { type: 'DH', size: native('ephemeralBits', this._tls.id) };
  if (type === 408 || type === 1034 || type === 1035) return { type: 'ECDH', name: native('ephemeralName', this._tls.id), size: native('ephemeralBits', this._tls.id) };
  const name = native('negotiatedGroup', this._tls.id);
  return name ? { type: 'TLS_GROUP', name } : {};
};
TLSSocket.prototype.enableTrace = function() { if (this._tls?.id) native('trace', this._tls.id); };
TLSSocket.prototype.disableRenegotiation = function() { this._renegotiationDisabled = true; };
TLSSocket.prototype.renegotiate = function(options, callback) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw error('ERR_INVALID_ARG_TYPE', 'options must be an object', TypeError);
  if (callback !== undefined && typeof callback !== 'function') throw error('ERR_INVALID_ARG_TYPE', 'callback must be a function', TypeError);
  if (this.destroyed) return undefined;
  if (options.requestCert !== undefined) this._tlsOptions.requestCert = !!options.requestCert;
  if (options.rejectUnauthorized !== undefined) this._tlsOptions.rejectUnauthorized = !!options.rejectUnauthorized;
  try {
    native('verifyMode', this._tls.id, !!this._tlsOptions.requestCert, this._tlsOptions.rejectUnauthorized);
    native('renegotiate', this._tls.id);
  } catch (err) {
    if (/SSL routines::wrong ssl version/.test(err.message)) err.code = 'ERR_SSL_WRONG_SSL_VERSION';
    if (callback) process.nextTick(callback, err);
    return false;
  }
  if (callback) this.once('secure', () => callback(null));
  this._tls.renegotiating = true;
  process.nextTick(() => this._tls.pump());
  return true;
};
TLSSocket.prototype.getProtocol = function() { return this._tls?.id && this._secureEstablished ? native('protocol', this._tls.id) : null; };
TLSSocket.prototype.getCipher = function() {
  if (!this._tls?.id || !this._secureEstablished) return undefined;
  return { name: native('cipher', this._tls.id), standardName: native('cipherStandard', this._tls.id), version: native('cipherVersion', this._tls.id) };
};
TLSSocket.prototype.getSession = function() { return this._tls?.id && this._secureEstablished ? Buffer.from(native('session', this._tls.id)) : undefined; };
TLSSocket.prototype.setSession = function(session) { if (this._secureEstablished) throw error('ERR_TLS_INVALID_STATE', 'Session must be set before handshake'); native('setSession', this._tls.id, bytes(session, 'session')); };
TLSSocket.prototype.isSessionReused = function() { return !!(this._tls?.id && native('sessionReused', this._tls.id)); };
TLSSocket.prototype.getFinished = function() { return this._tls?.id ? Buffer.from(native('finished', this._tls.id)) : undefined; };
TLSSocket.prototype.getPeerFinished = function() { return this._tls?.id ? Buffer.from(native('peerFinished', this._tls.id)) : undefined; };
TLSSocket.prototype.exportKeyingMaterial = function(length, label, context) {
  if (!Number.isInteger(length) || length < 0 || length > 0x7fffffff) throw error('ERR_OUT_OF_RANGE', 'length must be a nonnegative integer', RangeError);
  if (typeof label !== 'string') throw error('ERR_INVALID_ARG_TYPE', 'label must be a string', TypeError);
  if (!this._secureEstablished || !this._tls?.id) throw error('ERR_TLS_INVALID_STATE', 'TLS handshake is not complete');
  return Buffer.from(native('export', this._tls.id, length, label, context === undefined ? undefined : bytes(context, 'context'), context !== undefined));
};
TLSSocket.prototype.setServername = function(name) {
  if (this._tlsOptions.isServer) throw error('ERR_TLS_SNI_FROM_SERVER', 'Cannot issue SNI from a TLS server');
  if (typeof name !== 'string' || name.includes('\0')) throw error('ERR_INVALID_ARG_VALUE', 'Invalid servername');
  if (this._secureEstablished) throw error('ERR_TLS_INVALID_STATE', 'SNI must be set before handshake');
  native('setServername', this._tls.id, name); this.servername = name; this._tlsOptions.servername = name;
};
TLSSocket.prototype.setMaxSendFragment = function(size) {
  if (!Number.isInteger(size) || size < 512 || size > 16384 || !this._tls?.id) return false;
  native('fragment', this._tls.id, size); return true;
};
TLSSocket.prototype._emitSession = function() {
  if (this._tlsOptions.isServer || !this._secureEstablished || !this.listenerCount('session')) return;
  const session = this.getSession();
  if (session?.length && (!this._lastSession || !session.equals(this._lastSession))) { this._lastSession = session; this.emit('session', session); }
};
function connect(...args) {
  let options = {}, callback;
  if (args[0] && typeof args[0] === 'object') { options = { ...args[0] }; callback = args[1]; }
  else {
    options.port = args[0]; let index = 1;
    if (typeof args[index] === 'string') options.host = args[index++];
    if (args[index] && typeof args[index] === 'object') Object.assign(options, args[index++]);
    callback = args[index];
  }
  if (callback !== undefined && typeof callback !== 'function') throw error('ERR_INVALID_ARG_TYPE', 'callback must be a function', TypeError);
  options = { rejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0', ...options, isServer: false };
  if (options.servername !== undefined && (typeof options.servername !== 'string' || options.servername.includes('\0'))) throw error('ERR_INVALID_ARG_VALUE', 'Invalid servername');
  const socket = new TLSSocket(options.socket, options);
  if (callback) socket.once('secureConnect', callback);
  if (!options.socket) socket.connect({ ...options, allowHalfOpen: true });
  if (options.timeout !== undefined) socket.setTimeout(options.timeout);
  return socket;
}
function Server(options, listener) {
  if (!(this instanceof Server)) return new Server(options, listener);
  if (typeof options === 'function') { listener = options; options = {}; }
  net.Server.call(this, { ...options, allowHalfOpen: true, pauseOnConnect: true });
  require('internal/tls/server').initialize(this, options || {}, listener);
}
Object.setPrototypeOf(Server.prototype, net.Server.prototype);
Object.setPrototypeOf(Server, net.Server);
Server.prototype.setSecureContext = function(options) { require('internal/tls/server').setSecureContext(this, options); };
Server.prototype.addContext = function(servername, context) { require('internal/tls/server').addContext(this, servername, context); };
function createServer(options, listener) { return new Server(options, listener); }
function convertALPNProtocols(protocols, out) { out.ALPNProtocols = alpn(protocols); }
function getCiphers() {
  const context = native('context');
  try { return [...new Set(native('cipherNames', context).trim().split('\n').map(name => name.toLowerCase()))].sort(); }
  finally { native('release', context); }
}
module.exports = { TLSSocket, SecureContext, Server, connect, createServer, createSecureContext, checkServerIdentity, convertALPNProtocols, rootCertificates, getCACertificates, setDefaultCACertificates, getCiphers, DEFAULT_CIPHERS, DEFAULT_ECDH_CURVE: 'auto', DEFAULT_MIN_VERSION: 'TLSv1.2', DEFAULT_MAX_VERSION: 'TLSv1.3', CLIENT_RENEG_LIMIT: 3, CLIENT_RENEG_WINDOW: 600 };
