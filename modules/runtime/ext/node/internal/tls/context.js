'use strict';
// SecureContext after Node.js v24 lib/internal/tls/common.js and
// lib/internal/tls/secure-context.js. NativeSecureContext stands where Node's
// internalBinding('crypto').SecureContext is, over the memory-BIO TLS handles
// of src/ext/tls_native.silk.
const host = require('internal/host');
const { Buffer } = require('buffer');
const bundled = require('internal/tls/roots');
const tlsOptions = require('internal/tls/options');
const errors = require('internal/tls/errors');
const {
  codes, coded, invalidArgType, invalidArgValue, decorate,
  validateString, validateObject, validateArray, validateBuffer, validateInt32, validateInteger,
} = errors;

function error(code, message, Type = Error) { return coded(Type, code, message); }
function bytes(value, name = 'value') {
  if (typeof value === 'string') return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  throw invalidArgType(name, ['string', 'Buffer', 'TypedArray', 'DataView'], value);
}
function native(op, ...args) {
  args = args.map(value => {
    if (typeof value === 'boolean') return Number(value);
    if (!ArrayBuffer.isView(value)) return value;
    return value.byteOffset === 0 && value.byteLength === value.buffer.byteLength ? value.buffer : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  });
  try { return host.tls(op, args); }
  catch (err) { throw decorate(err); }
}

const TLS1_VERSION = 0x301, TLS1_1_VERSION = 0x302, TLS1_2_VERSION = 0x303, TLS1_3_VERSION = 0x304;
const SSL_OP_CIPHER_SERVER_PREFERENCE = 0x400000;
// SecureContext::Init sets SSL_OP_ALLOW_CLIENT_RENEGOTIATION; OpenSSL's defaults add
// SSL_OP_NO_COMPRESSION. The transport enforces Node's renegotiation limits.
const SSL_OP_DEFAULTS = 0x100 | 0x20000;

// PEM blocks re-encoded the way X509ToPEM prints them: 64 base64 characters a line.
function pemBlocks(text) {
  const result = [];
  const pattern = /-----BEGIN (?:TRUSTED |X509 )?CERTIFICATE-----([\s\S]*?)-----END (?:TRUSTED |X509 )?CERTIFICATE-----/g;
  for (let match; (match = pattern.exec(text)) !== null;) {
    const body = match[1].replace(/[^A-Za-z0-9+/=]/g, '');
    result.push('-----BEGIN CERTIFICATE-----\n' + body.replace(/.{1,64}/g, '$&\n') + '-----END CERTIFICATE-----\n');
  }
  return result;
}
function readCertificates(file) {
  const fs = require('fs');
  return pemBlocks(fs.readFileSync(file, 'latin1'));
}
// OpenSSL's default store: SSL_CERT_FILE / SSL_CERT_DIR or the build's defaults.
function systemCertificates() {
  const fs = require('fs');
  const [fileEnv, defaultFile, dirEnv, defaultDir] = native('defaultCertPaths').split('\n');
  const file = process.env[fileEnv] ?? defaultFile, dir = process.env[dirEnv] ?? defaultDir;
  const result = [];
  if (file) { try { result.push(...readCertificates(file)); } catch {} }
  if (dir) {
    for (const part of dir.split(':')) {
      let names = [];
      try { names = fs.readdirSync(part).sort(); } catch { continue; }
      for (const name of names) {
        const path = part + '/' + name;
        try { if (fs.statSync(path).isFile()) result.push(...readCertificates(path)); } catch {}
      }
    }
  }
  return result;
}
let extraCertificates, systemCache, defaultCache, userRoots;
function extraCACertificates() {
  if (extraCertificates) return extraCertificates;
  const file = process.env.NODE_EXTRA_CA_CERTS, result = [];
  if (file) {
    try {
      const text = require('fs').readFileSync(file, 'latin1');
      result.push(...pemBlocks(text));
    } catch (err) {
      const reason = err.code === 'ENOENT' ? 'No such file or directory' : err.message;
      process.emitWarning(`Ignoring extra certs from \`${file}\`, load failed: ${reason}\n`);
    }
  }
  return extraCertificates = Object.freeze(result);
}
function systemCACertificates() { return systemCache ||= Object.freeze(systemCertificates()); }
function defaultCACertificates() {
  if (defaultCache) return defaultCache;
  if (userRoots) return defaultCache = Object.freeze([...userRoots]);
  const result = [];
  if (!tlsOptions.getOptionValue('--use-openssl-ca')) {
    result.push(...bundled);
    if (tlsOptions.getOptionValue('--use-system-ca')) result.push(...systemCACertificates());
  }
  if (process.env.NODE_EXTRA_CA_CERTS) result.push(...extraCACertificates());
  return defaultCache = Object.freeze(result);
}
// The certificates addRootCerts installs: the store Node builds for the process.
function rootStore() {
  if (userRoots) return userRoots;
  const result = tlsOptions.getOptionValue('--use-openssl-ca') ? [...systemCACertificates()] : [...bundled];
  if (!tlsOptions.getOptionValue('--use-openssl-ca') && tlsOptions.getOptionValue('--use-system-ca')) result.push(...systemCACertificates());
  if (process.env.NODE_EXTRA_CA_CERTS) result.push(...extraCACertificates());
  return result;
}
function getCACertificates(type = 'default') {
  validateString(type, 'type');
  switch (type) {
    case 'default': return defaultCACertificates();
    case 'bundled': return bundled;
    case 'system': return systemCACertificates();
    case 'extra': return extraCACertificates();
    default: throw invalidArgValue('type', type);
  }
}
function setDefaultCACertificates(certs) {
  validateArray(certs, 'certs');
  for (let i = 0; i < certs.length; i++) {
    if (typeof certs[i] !== 'string' && !ArrayBuffer.isView(certs[i]))
      throw invalidArgType(`certs[${i}]`, ['string', 'ArrayBufferView'], certs[i]);
  }
  const next = [];
  for (const cert of certs) next.push(...pemBlocks(bytes(cert).toString('latin1')));
  if (next.length !== certs.length) {
    const context = native('context');
    try { for (const cert of certs) native('ca', context, bytes(cert)); } finally { native('release', context); }
  }
  userRoots = Object.freeze(next);
  defaultCache = undefined;
}

const finalizer = typeof FinalizationRegistry === 'function' ? new FinalizationRegistry(id => { try { native('release', id); } catch {} }) : null;
function ticketKeysBuffer(keys) {
  if (!ArrayBuffer.isView(keys)) throw invalidArgType('keys', ['Buffer', 'TypedArray', 'DataView'], keys);
  if (keys.byteLength !== 48) throw error('ERR_INVALID_ARG_VALUE', 'Session ticket keys must be a 48-byte buffer', TypeError);
  return Buffer.from(Buffer.from(keys.buffer, keys.byteOffset, keys.byteLength));
}
let idOf;
class NativeSecureContext {
  #id = 0;
  // Like a V8 binding's receiver check: a method moved to another object
  // throws instead of reaching the native context.
  static {
    idOf = (self) => {
      if (self === null || typeof self !== 'object' || !(#id in self)) throw new TypeError('Illegal invocation');
      return self.#id;
    };
  }
  constructor() {
    this.#id = native('context');
    this._minProto = 0; this._maxProto = 0; this._ticketKeys = null; this._alpn = Buffer.alloc(0);
    finalizer?.register(this, this.#id, this);
  }
  get _id() { return idOf(this); }
  get _external() { return idOf(this); }
  init(secureProtocol, min, max) {
    if (max === 0) max = TLS1_3_VERSION;
    if (secureProtocol) {
      const method = String(secureProtocol);
      if (/^SSLv2_(?:server_|client_)?method$/.test(method)) throw error('ERR_TLS_INVALID_PROTOCOL_METHOD', 'SSLv2 methods disabled', TypeError);
      if (/^SSLv3_(?:server_|client_)?method$/.test(method)) throw error('ERR_TLS_INVALID_PROTOCOL_METHOD', 'SSLv3 methods disabled', TypeError);
      const fixed = /^(SSLv23|TLS|TLSv1|TLSv1_1|TLSv1_2)_(?:server_|client_)?method$/.exec(method);
      if (!fixed) throw error('ERR_TLS_INVALID_PROTOCOL_METHOD', `Unknown method: ${method}`, TypeError);
      switch (fixed[1]) {
        case 'SSLv23': max = TLS1_2_VERSION; break;
        case 'TLS': min = 0; max = TLS1_3_VERSION; break;
        case 'TLSv1': min = max = TLS1_VERSION; break;
        case 'TLSv1_1': min = max = TLS1_1_VERSION; break;
        case 'TLSv1_2': min = max = TLS1_2_VERSION; break;
      }
    }
    native('options', idOf(this), SSL_OP_DEFAULTS);
    this.setMinProto(min); this.setMaxProto(max);
    this.setTicketKeys(require('crypto').randomBytes(48));
  }
  setMinProto(version) { native('versions', idOf(this), version, this._maxProto || TLS1_3_VERSION); this._minProto = version; }
  setMaxProto(version) { native('versions', idOf(this), this._minProto, version); this._maxProto = version; }
  getMinProto() { return this._minProto; }
  // The linked OpenSSL is built without zlib, brotli and zstd (OPENSSL_NO_COMP_ALG),
  // which Node reports the same way.
  setCertificateCompression(packed) {
    if (this._maxProto !== 0 && this._maxProto < TLS1_3_VERSION)
      throw error('ERR_INVALID_ARG_VALUE', 'certificateCompression requires a TLS protocol range that includes TLSv1.3', TypeError);
    throw error('ERR_CRYPTO_UNSUPPORTED_OPERATION', 'Certificate compression is not supported by this OpenSSL build');
  }
  getMaxProto() { return this._maxProto || TLS1_3_VERSION; }
  setOptions(options) { native('options', idOf(this), options >>> 0); }
  setCipherSuites(suites) { native('suites', idOf(this), suites); }
  setCiphers(ciphers) {
    try { native('ciphers', idOf(this), ciphers); }
    catch (err) {
      // An empty TLSv1.2 list is valid when TLSv1.3 suites remain (Node's SetCiphers).
      if (ciphers !== '' || !/no cipher match/.test(err.message)) throw err;
    }
  }
  setSigalgs(sigalgs) { native('sigalgs', idOf(this), sigalgs); }
  setECDHCurve(curve) {
    if (curve === 'auto') return;
    try { native('groups', idOf(this), curve); }
    catch { throw error('ERR_CRYPTO_OPERATION_FAILED', 'Failed to set ECDH curve', TypeError); }
  }
  setDHParam(value) {
    if (value === true) { native('dhAuto', idOf(this)); return; }
    const size = native('dhparam', idOf(this), bytes(value));
    if (size === 0) return;
    if (size < 1024) throw error('ERR_INVALID_ARG_VALUE', 'DH parameter is less than 1024 bits', TypeError);
    if (size < 2048) return 'DH parameter is less than 2048 bits';
  }
  setKey(key, passphrase) { native('key', idOf(this), bytes(key), passphrase == null ? '' : String(passphrase)); }
  setCert(cert) { native('cert', idOf(this), bytes(cert)); }
  addCACert(cert) { native('ca', idOf(this), bytes(cert)); }
  addRootCerts() { for (const cert of rootStore()) native('ca', idOf(this), cert); }
  setAllowPartialTrustChain() { native('trustFlags', idOf(this), 0x80000); }
  addCRL(crl) {
    try { native('crl', idOf(this), bytes(crl)); }
    catch { throw error('ERR_CRYPTO_OPERATION_FAILED', 'Failed to parse CRL'); }
  }
  setSessionIdContext(id) { native('sessionId', idOf(this), id); }
  setSessionTimeout(seconds) { native('sessionTimeout', idOf(this), seconds); }
  setTicketKeys(keys) {
    const copy = ticketKeysBuffer(keys);
    native('ticketKeys', idOf(this), copy); this._ticketKeys = copy;
  }
  getTicketKeys() { return Buffer.from(this._ticketKeys); }
  loadPKCS12(pfx, passphrase) {
    let status;
    try { status = native('pfx', idOf(this), bytes(pfx), passphrase === undefined ? '' : bytes(passphrase)); }
    catch (err) {
      if (err.reason === 'unsupported') throw error('ERR_CRYPTO_UNSUPPORTED_OPERATION', 'Unsupported PKCS12 PFX data');
      throw new Error(err.reason || 'Unknown error');
    }
    if (status === 1) throw error('ERR_CRYPTO_OPERATION_FAILED', 'Unable to load private key from PFX data');
    if (status === 2) throw error('ERR_CRYPTO_OPERATION_FAILED', 'Unable to load certificate from PFX data');
  }
  setALPN(protocols) { this._alpn = protocols; native('contextALPN', idOf(this), protocols); }
  close() {}
}

function toV(which, v, def) {
  v ??= def;
  if (v === 'TLSv1') return TLS1_VERSION;
  if (v === 'TLSv1.1') return TLS1_1_VERSION;
  if (v === 'TLSv1.2') return TLS1_2_VERSION;
  if (v === 'TLSv1.3') return TLS1_3_VERSION;
  throw new codes.ERR_TLS_INVALID_PROTOCOL_VERSION(v, which);
}
function SecureContext(secureProtocol, secureOptions, minVersion, maxVersion) {
  if (!(this instanceof SecureContext)) return new SecureContext(secureProtocol, secureOptions, minVersion, maxVersion);
  if (secureProtocol) {
    if (minVersion != null) throw new codes.ERR_TLS_PROTOCOL_VERSION_CONFLICT(minVersion, secureProtocol);
    if (maxVersion != null) throw new codes.ERR_TLS_PROTOCOL_VERSION_CONFLICT(maxVersion, secureProtocol);
  }
  const tls = require('tls');
  this.context = new NativeSecureContext();
  this.context.init(secureProtocol, toV('minimum', minVersion, tls.DEFAULT_MIN_VERSION), toV('maximum', maxVersion, tls.DEFAULT_MAX_VERSION));
  if (secureOptions) {
    validateInteger(secureOptions, 'secureOptions');
    this.context.setOptions(secureOptions);
  }
}

function validateKeyOrCertOption(name, value) {
  if (typeof value !== 'string' && !ArrayBuffer.isView(value)) throw invalidArgType(name, ['string', 'Buffer', 'TypedArray', 'DataView'], value);
}
function setKey(context, key, passphrase, name) {
  validateKeyOrCertOption(`${name}.key`, key);
  if (passphrase !== undefined && passphrase !== null) validateString(passphrase, `${name}.passphrase`);
  context.setKey(key, passphrase);
}
function processCiphers(ciphers, name) {
  ciphers = (ciphers || require('tls').DEFAULT_CIPHERS).split(':');
  const cipherList = ciphers.filter(c => c.length && !c.startsWith('TLS_') && !c.startsWith('!TLS_')).join(':');
  const cipherSuites = ciphers.filter(c => c.length && (c.startsWith('TLS_') || c.startsWith('!TLS_'))).join(':');
  if (cipherSuites === '' && cipherList === '') throw invalidArgValue(name, ciphers);
  return { cipherList, cipherSuites };
}
function configSecureContext(context, options = {}, name = 'options') {
  validateObject(options, name);
  const tls = require('tls');
  const {
    allowPartialTrustChain, ca, cert, certificateCompression, ciphers = tls.DEFAULT_CIPHERS, clientCertEngine, crl, dhparam,
    ecdhCurve = tls.DEFAULT_ECDH_CURVE || 'auto', key, passphrase, pfx, privateKeyIdentifier, privateKeyEngine,
    sessionIdContext, sessionTimeout, sigalgs, ticketKeys,
  } = options;
  if (ciphers !== undefined && ciphers !== null) validateString(ciphers, `${name}.ciphers`);
  const { cipherList, cipherSuites } = processCiphers(ciphers, `${name}.ciphers`);
  if (cipherSuites !== '') context.setCipherSuites(cipherSuites);
  context.setCiphers(cipherList);
  if (cipherList === '' && context.getMinProto() < TLS1_3_VERSION && context.getMaxProto() > TLS1_2_VERSION) context.setMinProto(TLS1_3_VERSION);
  if (ca) { for (const value of Array.isArray(ca) ? ca : [ca]) { validateKeyOrCertOption(`${name}.ca`, value); context.addCACert(value); } }
  else context.addRootCerts();
  if (allowPartialTrustChain) context.setAllowPartialTrustChain();
  if (cert) { for (const value of Array.isArray(cert) ? cert : [cert]) { validateKeyOrCertOption(`${name}.cert`, value); context.setCert(value); } }
  if (key) {
    if (Array.isArray(key)) {
      for (const value of key) setKey(context, value?.pem !== undefined ? value.pem : value, value?.passphrase !== undefined ? value.passphrase : passphrase, name);
    } else setKey(context, key, passphrase, name);
  }
  if (certificateCompression != null) {
    validateArray(certificateCompression, `${name}.certificateCompression`);
    if (certificateCompression.length > 3) throw invalidArgValue(`${name}.certificateCompression`, certificateCompression, 'can specify at most 3 algorithms');
    if (certificateCompression.length > 0) {
      let packed = certificateCompression.length;
      certificateCompression.forEach((algorithm, i) => {
        const id = { zlib: 1, brotli: 2, zstd: 3 }[algorithm];
        if (typeof algorithm !== 'string' || id === undefined)
          throw invalidArgValue(`${name}.certificateCompression[${i}]`, algorithm, "must be 'zlib', 'brotli', or 'zstd'");
        packed |= id << (8 * (i + 1));
      });
      context.setCertificateCompression(packed);
    }
  }
  if (sigalgs !== undefined && sigalgs !== null) {
    validateString(sigalgs, `${name}.sigalgs`);
    if (sigalgs === '') throw invalidArgValue(`${name}.sigalgs`, sigalgs);
    context.setSigalgs(sigalgs);
  }
  if (privateKeyIdentifier !== undefined && privateKeyIdentifier !== null) {
    if (privateKeyEngine === undefined || privateKeyEngine === null) throw invalidArgValue(`${name}.privateKeyEngine`, privateKeyEngine);
    if (key) throw invalidArgValue(`${name}.privateKeyIdentifier`, privateKeyIdentifier);
    if (typeof privateKeyIdentifier === 'string' && typeof privateKeyEngine === 'string')
      throw new codes.ERR_CRYPTO_CUSTOM_ENGINE_NOT_SUPPORTED();
    if (typeof privateKeyIdentifier !== 'string') throw invalidArgType(`${name}.privateKeyIdentifier`, ['string', 'null', 'undefined'], privateKeyIdentifier);
    throw invalidArgType(`${name}.privateKeyEngine`, ['string', 'null', 'undefined'], privateKeyEngine);
  }
  validateString(ecdhCurve, `${name}.ecdhCurve`);
  context.setECDHCurve(ecdhCurve);
  if (dhparam !== undefined && dhparam !== null) {
    validateKeyOrCertOption(`${name}.dhparam`, dhparam);
    const warning = context.setDHParam(dhparam === 'auto' || dhparam);
    if (warning) process.emitWarning(warning, 'SecurityWarning');
  }
  if (crl !== undefined && crl !== null) {
    for (const value of Array.isArray(crl) ? crl : [crl]) { validateKeyOrCertOption(`${name}.crl`, value); context.addCRL(value); }
  }
  if (sessionIdContext !== undefined && sessionIdContext !== null) {
    validateString(sessionIdContext, `${name}.sessionIdContext`);
    context.setSessionIdContext(sessionIdContext);
  }
  if (pfx !== undefined && pfx !== null) {
    for (const value of Array.isArray(pfx) ? pfx : [pfx]) {
      const raw = value.buf || value, pass = value.passphrase || passphrase;
      context.loadPKCS12(raw, pass !== undefined && pass !== null ? pass : undefined);
    }
  }
  if (typeof clientCertEngine === 'string') throw new codes.ERR_CRYPTO_CUSTOM_ENGINE_NOT_SUPPORTED();
  if (clientCertEngine !== undefined && clientCertEngine !== null)
    throw invalidArgType(`${name}.clientCertEngine`, ['string', 'null', 'undefined'], clientCertEngine);
  if (ticketKeys !== undefined && ticketKeys !== null) {
    validateBuffer(ticketKeys, `${name}.ticketKeys`);
    if (ticketKeys.byteLength !== 48) throw invalidArgValue(`${name}.ticketKeys`, ticketKeys.byteLength, 'must be exactly 48 bytes');
    context.setTicketKeys(ticketKeys);
  }
  if (sessionTimeout !== undefined && sessionTimeout !== null) {
    validateInt32(sessionTimeout, `${name}.sessionTimeout`, 0);
    context.setSessionTimeout(sessionTimeout);
  }
}
function createSecureContext(options) {
  options ||= {};
  const { honorCipherOrder, minVersion, maxVersion, secureProtocol, singleUse } = options;
  let { secureOptions } = options;
  if (honorCipherOrder) secureOptions |= SSL_OP_CIPHER_SERVER_PREFERENCE;
  const c = new SecureContext(secureProtocol, secureOptions, minVersion, maxVersion);
  configSecureContext(c.context, options);
  if (singleUse) c.singleUse = true;
  return c;
}

function alpn(value) {
  if (value === undefined) return Buffer.alloc(0);
  const out = {};
  require('tls').convertALPNProtocols(value, out);
  if (out.ALPNProtocols === undefined) throw invalidArgType('ALPNProtocols', ['Array', 'Buffer', 'TypedArray', 'DataView'], value);
  return out.ALPNProtocols;
}
module.exports = {
  SecureContext, createSecureContext, configSecureContext, NativeSecureContext, ticketKeysBuffer, native, bytes, alpn, error,
  bundledRootCertificates: bundled, getCACertificates, setDefaultCACertificates,
};
