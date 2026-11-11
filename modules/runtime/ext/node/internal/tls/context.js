'use strict';
const host = require('internal/host');
const { Buffer } = require('buffer');
const roots = require('internal/tls/roots');
function error(code, message, Type = Error) { return Object.assign(new Type(message), { code }); }
function bytes(value, name = 'value') {
  if (typeof value === 'string') return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  throw error('ERR_INVALID_ARG_TYPE', name + ' must be a string, Buffer, or ArrayBuffer view', TypeError);
}
function native(op, ...args) {
  args = args.map(value => {
    if (typeof value === 'boolean') return Number(value);
    if (!ArrayBuffer.isView(value)) return value;
    return value.byteOffset === 0 && value.byteLength === value.buffer.byteLength ? value.buffer : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  });
  try { return host.tls(op, args); }
  catch (err) { if (!err.code) err.code = /^([A-Z][A-Z0-9_]+):/.exec(err.message)?.[1] || 'ERR_SSL_TLS_OPERATION_FAILED'; throw err; }
}
const extra = [];
if (process.env.NODE_EXTRA_CA_CERTS) {
  try {
    const pem = require('fs').readFileSync(process.env.NODE_EXTRA_CA_CERTS, 'utf8');
    const candidates = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
    if (!candidates.length) throw new Error('No certificates found');
    const context = native('context');
    try { for (const cert of candidates) native('ca', context, cert); } finally { native('release', context); }
    extra.push(...candidates);
  } catch (err) { process.emitWarning('Ignoring extra certs from ' + process.env.NODE_EXTRA_CA_CERTS + ': ' + err.message); }
}
Object.freeze(extra);
let defaults = Object.freeze([...roots, ...extra]);
function getCACertificates(type = 'default') {
  if (type === 'default') return defaults;
  if (type === 'bundled') return roots;
  if (type === 'extra') return extra;
  throw error('ERR_INVALID_ARG_VALUE', 'Unknown or unavailable CA certificate source: ' + type);
}
function list(value) { return Array.isArray(value) ? value : [value]; }
function alpn(value) {
  if (value === undefined) return Buffer.alloc(0);
  let result;
  if (Array.isArray(value)) {
    const parts = value.map(item => {
      if (typeof item !== 'string') throw error('ERR_INVALID_ARG_TYPE', 'ALPNProtocols entries must be strings', TypeError);
      const data = Buffer.from(item); if (!data.length || data.length > 255) throw error('ERR_OUT_OF_RANGE', 'ALPN protocol must contain 1 to 255 bytes', RangeError);
      return Buffer.concat([Buffer.from([data.length]), data]);
    });
    result = Buffer.concat(parts);
  } else result = Buffer.from(bytes(value, 'ALPNProtocols'));
  for (let i = 0; i < result.length;) { const n = result[i++]; if (!n || i + n > result.length) throw error('ERR_INVALID_ARG_VALUE', 'Malformed ALPN protocol list'); i += n; }
  return result;
}
const versions = { TLSv1: 0x301, 'TLSv1.1': 0x302, 'TLSv1.2': 0x303, 'TLSv1.3': 0x304 };
const DEFAULT_CIPHERS = 'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-SHA256:DHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA384:DHE-RSA-AES256-SHA384:ECDHE-RSA-AES256-SHA256:DHE-RSA-AES256-SHA256:HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA';
const finalizer = typeof FinalizationRegistry === 'function' ? new FinalizationRegistry(id => native('release', id)) : null;
function SecureContext(secureProtocol, secureOptions, minVersion, maxVersion) {
  if (!(this instanceof SecureContext)) return new SecureContext(secureProtocol, secureOptions, minVersion, maxVersion);
  this._id = native('context'); this.context = this;
  try { this._configure({ secureProtocol, secureOptions, minVersion, maxVersion }); }
  catch (err) { native('release', this._id); throw err; }
  finalizer?.register(this, this._id);
}
SecureContext.prototype._configure = function(options) {
  let min = options.minVersion || 'TLSv1.2', max = options.maxVersion || 'TLSv1.3';
  if (options.secureProtocol) {
    if (options.minVersion || options.maxVersion) throw error('ERR_TLS_PROTOCOL_VERSION_CONFLICT', 'secureProtocol conflicts with minVersion/maxVersion');
    const method = options.secureProtocol.replace(/_(?:client|server)_method$/, '_method');
    const fixed = { TLSv1_method: 'TLSv1', TLSv1_1_method: 'TLSv1.1', TLSv1_2_method: 'TLSv1.2' }[method];
    if (fixed) min = max = fixed;
    else if (!['TLS_method', 'SSLv23_method'].includes(method)) throw error('ERR_TLS_INVALID_PROTOCOL_METHOD', 'Unknown secureProtocol: ' + options.secureProtocol);
  }
  if (!versions[min] || !versions[max] || versions[min] > versions[max]) throw error('ERR_TLS_INVALID_PROTOCOL_VERSION', 'Invalid TLS version range');
  native('versions', this._id, versions[min], versions[max]);
  // OpenSSL 3 requires explicit client renegotiation opt-in. The transport
  // accounts for every native handshake and enforces Node's abuse limits.
  if (options.secureOptions !== undefined && typeof options.secureOptions !== 'number') throw error('ERR_INVALID_ARG_TYPE', 'secureOptions must be a number', TypeError);
  native('options', this._id, ((options.secureOptions || 0) | 0x100 | 0x20000 | (options.honorCipherOrder ? 0x400000 : 0)) >>> 0);
  const ciphers = options.ciphers === undefined ? DEFAULT_CIPHERS : options.ciphers;
  if (typeof ciphers !== 'string') throw error('ERR_INVALID_ARG_TYPE', 'ciphers must be a string', TypeError);
  const parts = ciphers.split(':'); const suites = parts.filter(item => item.startsWith('TLS_'));
  const legacy = parts.filter(item => !item.startsWith('TLS_'));
  native('suites', this._id, suites.join(':'));
  if (legacy.length) native('ciphers', this._id, legacy.join(':'));
  else if (versions[min] < 0x304) native('versions', this._id, 0x304, versions[max]);
  if (options.ecdhCurve !== undefined && typeof options.ecdhCurve !== 'string') throw error('ERR_INVALID_ARG_TYPE', 'ecdhCurve must be a string', TypeError);
  if (options.ecdhCurve && options.ecdhCurve !== 'auto') native('groups', this._id, options.ecdhCurve);
  if (options.sigalgs != null) {
    if (typeof options.sigalgs !== 'string') throw error('ERR_INVALID_ARG_TYPE', 'sigalgs must be a string', TypeError);
    if (!options.sigalgs) throw error('ERR_INVALID_ARG_VALUE', 'sigalgs must not be empty', TypeError);
    native('sigalgs', this._id, options.sigalgs);
  }
  if (options.dhparam != null) {
    if (options.dhparam === 'auto') native('dhAuto', this._id);
    else {
      const size = native('dhparam', this._id, bytes(options.dhparam, 'dhparam'));
      if (size && size < 1024) throw error('ERR_INVALID_ARG_VALUE', 'DH parameter is less than 1024 bits', TypeError);
      if (size && size < 2048) process.emitWarning('DH parameter is less than 2048 bits', 'SecurityWarning');
    }
  }
  const cas = options.ca === undefined ? defaults : list(options.ca);
  for (const ca of cas) native('ca', this._id, bytes(ca, 'ca'));
  if (options.allowPartialTrustChain) native('trustFlags', this._id, 0x80000);
  if (options.crl != null) for (const crl of list(options.crl)) {
    const data = bytes(crl, 'crl');
    try { native('crl', this._id, data); }
    catch (cause) { throw Object.assign(error('ERR_CRYPTO_OPERATION_FAILED', 'Failed to parse CRL'), { cause }); }
  }
  if (options.cert !== undefined) for (const cert of list(options.cert)) native('cert', this._id, bytes(cert, 'cert'));
  if (options.key !== undefined) for (const item of list(options.key)) {
    const keyed = item && typeof item === 'object' && !ArrayBuffer.isView(item) && !(item instanceof ArrayBuffer) && 'pem' in item;
    const passphrase = keyed ? item.passphrase ?? options.passphrase ?? '' : options.passphrase ?? '';
    if (typeof passphrase !== 'string') throw error('ERR_INVALID_ARG_TYPE', 'passphrase must be a string', TypeError);
    native('key', this._id, bytes(keyed ? item.pem : item, 'key'), passphrase);
  }
  if (options.pfx !== undefined) for (const item of list(options.pfx)) {
    const keyed = item && typeof item === 'object' && !ArrayBuffer.isView(item) && !(item instanceof ArrayBuffer) && 'buf' in item;
    native('pfx', this._id, bytes(keyed ? item.buf : item, 'pfx'), keyed ? item.passphrase ?? options.passphrase ?? '' : options.passphrase ?? '');
  }
  if (options.key !== undefined || options.pfx !== undefined) native('checkKey', this._id);
  if (options.sessionIdContext != null) {
    if (typeof options.sessionIdContext !== 'string') throw error('ERR_INVALID_ARG_TYPE', 'sessionIdContext must be a string', TypeError);
    native('sessionId', this._id, options.sessionIdContext);
  } else native('sessionId', this._id, Buffer.from('silk-node-tls'));
  if (options.sessionTimeout != null) {
    if (typeof options.sessionTimeout !== 'number') throw error('ERR_INVALID_ARG_TYPE', 'sessionTimeout must be a number', TypeError);
    if (!Number.isInteger(options.sessionTimeout) || options.sessionTimeout < 0 || options.sessionTimeout > 0x7fffffff) throw error('ERR_OUT_OF_RANGE', 'sessionTimeout must be a nonnegative int32', RangeError);
    native('sessionTimeout', this._id, options.sessionTimeout);
  }
  if (options.ticketKeys != null) {
    if (!ArrayBuffer.isView(options.ticketKeys)) throw error('ERR_INVALID_ARG_TYPE', 'ticketKeys must be an ArrayBuffer view', TypeError);
    if (options.ticketKeys.byteLength !== 48) throw error('ERR_INVALID_ARG_VALUE', 'ticketKeys must be exactly 48 bytes', TypeError);
    native('ticketKeys', this._id, options.ticketKeys);
  }
  this._alpn = alpn(options.ALPNProtocols); native('contextALPN', this._id, this._alpn);
};
function createSecureContext(options = {}) {
  const context = Object.create(SecureContext.prototype); context._id = native('context'); context.context = context;
  try { context._configure(options); } catch (err) { native('release', context._id); throw err; }
  finalizer?.register(context, context._id); return context;
}
function setDefaultCACertificates(certs) {
  if (!Array.isArray(certs)) throw error('ERR_INVALID_ARG_TYPE', 'certs must be an array', TypeError);
  const next = certs.map(cert => bytes(cert, 'cert').toString());
  const context = native('context'); try { for (const cert of next) native('ca', context, cert); } finally { native('release', context); }
  defaults = Object.freeze(next);
}
module.exports = { SecureContext, createSecureContext, native, bytes, alpn, error, DEFAULT_CIPHERS, rootCertificates: roots, getCACertificates, setDefaultCACertificates };
