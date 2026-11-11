'use strict';
const c = require('internal/crypto_core');
const { Buffer } = c;
const states = new WeakMap();
require('internal/host').types.isX509Certificate = value => states.has(value);
function state(cert) { const value = states.get(cert); if (!value) throw c.error('ERR_INVALID_THIS', 'Value of "this" must be of type X509Certificate', TypeError); return value; }
function cached(cert, name, get) { const values = state(cert); if (!Object.prototype.hasOwnProperty.call(values, name)) values[name] = get(); return values[name]; }
function call(cert, op, ...args) { state(cert); return c.call(op, [c.handle(cert), ...args]); }
function object(value, name) { if (value === null || typeof value !== 'object' || Array.isArray(value)) throw c.invalid(name, 'an object'); }
function flags(options = {}) {
  object(options, 'options');
  const { subject = 'default', wildcards = true, partialWildcards = true, multiLabelWildcards = false, singleLabelSubdomains = false } = { ...options };
  if (typeof subject !== 'string') throw c.invalid('options.subject', 'a string');
  if (!['default', 'always', 'never'].includes(subject)) throw c.error('ERR_INVALID_ARG_VALUE', 'Invalid options.subject', TypeError);
  for (const [key, value] of Object.entries({ wildcards, partialWildcards, multiLabelWildcards, singleLabelSubdomains })) if (typeof value !== 'boolean') throw c.invalid(`options.${key}`, 'a boolean');
  return (subject === 'always' ? 1 : subject === 'never' ? 32 : 0) | (wildcards ? 0 : 2) | (partialWildcards ? 0 : 4) | (multiLabelWildcards ? 8 : 0) | (singleLabelSubdomains ? 16 : 0);
}
function check(cert, op, value, name, options) {
  state(cert);
  if (typeof value !== 'string') throw c.invalid(name, 'a string');
  const bits = flags(options);
  if (value.includes('\0')) throw c.error('ERR_INVALID_ARG_VALUE', 'Invalid name', TypeError);
  const result = call(cert, op, value, bits);
  if (result === -2) throw c.error('ERR_INVALID_ARG_VALUE', 'Invalid name', TypeError);
  return result;
}
function checkKey(cert, op, key, type) {
  state(cert);
  if (!(key instanceof require('crypto').KeyObject)) throw c.invalid('pkey', 'a KeyObject');
  if (c.keyObjectType(key) !== type) throw c.error('ERR_INVALID_ARG_VALUE', 'Invalid pkey', TypeError);
  return !!call(cert, op, c.handle(key));
}
// Decode only inspection data already accepted by OpenSSL. Signature, identity and
// key checks always operate on the native X509, never this mutable JS cache.
function node(bytes, offset = 0) {
  const start = offset;
  if (offset + 2 > bytes.length) throw c.error('ERR_OSSL_ASN1_INVALID_ENCODING', 'Invalid certificate DER');
  const tag = bytes[offset++]; let length = bytes[offset++];
  if (length & 128) { const count = length & 127; if (!count || count > 4 || offset + count > bytes.length) throw c.error('ERR_OSSL_ASN1_INVALID_ENCODING', 'Invalid certificate DER'); length = 0; for (let i = 0; i < count; i++) length = length * 256 + bytes[offset++]; }
  if (offset + length > bytes.length) throw c.error('ERR_OSSL_ASN1_INVALID_ENCODING', 'Invalid certificate DER');
  return { tag, data: bytes.subarray(offset, offset + length), raw: bytes.subarray(start, offset + length), end: offset + length };
}
function children(bytes) { const out = []; for (let i = 0; i < bytes.length;) { const part = node(bytes, i); out.push(part); i = part.end; } return out; }
function oid(bytes) {
  const values = []; let value = 0n;
  for (const byte of bytes) { value = value * 128n + BigInt(byte & 127); if (!(byte & 128)) { values.push(value); value = 0n; } }
  if (!values.length) return '';
  const first = values.shift(); const arc = first < 40n ? 0n : first < 80n ? 1n : 2n;
  return [arc, first - arc * 40n, ...values].join('.');
}
function oidName(id, short = false) { return c.call('x509OID', [id, short ? 1 : 0]); }
function parsed(cert) {
  return cached(cert, 'parsed', () => {
    // Do not derive from public raw: Node permits callers to mutate that Buffer.
    const parts = children(node(Buffer.from(call(cert, 'x509Raw'))).data);
    const tbs = children(parts[0].data); const base = tbs[0].tag === 160 ? 1 : 0;
    const extensions = Object.create(null); const ext = tbs.find(p => p.tag === 163);
    if (ext) for (const item of children(node(ext.data).data)) { const fields = children(item.data); extensions[oid(fields[0].data)] = fields[fields.length - 1].data; }
    return { issuer: tbs[base + 2], subject: tbs[base + 4], spki: tbs[base + 5], extensions };
  });
}
function stringValue(part) {
  if (part.tag === 30) { let out = ''; for (let i = 0; i < part.data.length; i += 2) out += String.fromCharCode(part.data[i] * 256 + part.data[i + 1]); return out; }
  if (part.tag === 28) { let out = ''; for (let i = 0; i < part.data.length; i += 4) out += String.fromCodePoint(part.data.readUInt32BE(i)); return out; }
  return part.data.toString(part.tag === 20 ? 'latin1' : 'utf8');
}
// The universal tags with a tag2nbyte width in OpenSSL's a_strex.c.
const kUtf8Convertible = new Set([12, 18, 19, 20, 22, 23, 24, 26, 28, 30]);
function nameObject(part) {
  const result = Object.create(null);
  for (const rdn of children(part.data)) for (const attr of children(rdn.data)) {
    const pair = children(attr.data);
    // ASN1_STRING_to_UTF8 only converts the string and time types; Node
    // leaves out the entries it cannot convert.
    if (!kUtf8Convertible.has(pair[1].tag)) continue;
    const key = oidName(oid(pair[0].data), true), value = stringValue(pair[1]);
    if (result[key] === undefined) result[key] = value;
    else if (Array.isArray(result[key])) result[key].push(value);
    else result[key] = [result[key], value];
  }
  return result;
}
function altText(bytes, utf8 = false, prefix = '') {
  const value = bytes.toString(utf8 ? 'utf8' : 'latin1');
  if (!(utf8 ? /[\x00-\x1f\x7f"\\,']/ : /[^\x20-\x7e]|["\\,']/).test(value)) return prefix + value;
  return '"' + prefix + value.replace(utf8 ? /[\x00-\x1f\x7f"\\,]/g : /[^\x20-\x7e]|["\\,]/g, ch => ch === '"' ? '\\"' : ch === '\\' ? '\\\\' : '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')) + '"';
}
function generalName(part) {
  const data = part.data;
  switch (part.tag & 31) {
    case 1: return 'email:' + altText(data);
    case 2: return 'DNS:' + altText(data);
    case 6: return 'URI:' + altText(data);
    case 7: return 'IP Address:' + (data.length === 4 ? Array.from(data).join('.') : data.length === 16 ? Array.from({ length: 8 }, (_, i) => data.readUInt16BE(i * 2).toString(16).toUpperCase()).join(':') : `<invalid length=${data.length}>`);
    case 8: return 'Registered ID:' + oid(data);
    case 4: return 'DirName:' + altText(Buffer.from(c.call('x509NameDER', [c.packed(data), 17892113])), true);
    case 3: return 'X400Name:<unsupported>';
    case 5: return 'EdiPartyName:<unsupported>';
    case 0: {
      const fields = children(data), id = oid(fields[0].data), value = node(fields[1].data);
      const prefixes = { '1.3.6.1.5.5.7.8.9': 'SmtpUTF8Mailbox', '1.3.6.1.5.5.7.8.5': 'XmppAddr', '1.3.6.1.5.5.7.8.7': 'SRVName', '1.3.6.1.4.1.311.20.2.3': 'UPN', '1.3.6.1.5.5.7.8.8': 'NAIRealm' };
      const prefix = prefixes[id], utf8 = prefix !== 'SRVName';
      return !prefix || value.tag !== (utf8 ? 12 : 22) ? 'othername:<unsupported>' : 'othername:' + altText(value.data, utf8, prefix + ':');
    }
    default: throw c.error('ERR_OSSL_ASN1_INVALID_ENCODING', 'Invalid general name');
  }
}
function extension(cert, id, convert) { const data = parsed(cert).extensions[id]; return data === undefined ? undefined : convert(children(node(data).data)); }
function dateValue(text) {
  const fields = /^([A-Z][a-z]{2}) +(\d+) (\d\d):(\d\d):(\d\d) (\d+) GMT$/.exec(text);
  if (!fields) return new Date(NaN);
  const date = new Date(0);
  date.setUTCFullYear(Number(fields[6]), ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(fields[1]), Number(fields[2]));
  date.setUTCHours(Number(fields[3]), Number(fields[4]), Number(fields[5]), 0);
  return date;
}
function rsaPublic(bitString) {
  // i2d_RSA_PUBKEY uses rsaEncryption even for an RSA-PSS certificate key.
  const algorithm = Buffer.from('300d06092a864886f70d0101010500', 'hex');
  let size = algorithm.length + bitString.length; const length = [];
  if (size < 128) length.push(size);
  else { while (size) { length.unshift(size & 255); size = Math.floor(size / 256); } length.unshift(128 | length.length); }
  return Buffer.concat([Buffer.from([48, ...length]), algorithm, bitString]);
}
function legacy(cert, seen) {
  if (seen.has(cert)) return seen.get(cert);
  const parts = parsed(cert), key = cert.publicKey;
  const result = {
    subject: nameObject(parts.subject), issuer: nameObject(parts.issuer), subjectaltname: cert.subjectAltName,
    infoAccess: undefined, ca: cert.ca, modulus: undefined, exponent: undefined, pubkey: undefined, bits: undefined,
    valid_from: cert.validFrom, valid_to: cert.validTo, fingerprint: cert.fingerprint, fingerprint256: cert.fingerprint256,
    fingerprint512: cert.fingerprint512, ext_key_usage: extension(cert, '2.5.29.37', usages => usages.map(item => oid(item.data))), serialNumber: cert.serialNumber,
    raw: Buffer.from(call(cert, 'x509Raw')), asn1Curve: undefined, nistCurve: undefined,
  };
  seen.set(cert, result);
  if (cert.infoAccess !== undefined) {
    result.infoAccess = Object.create(null);
    for (const line of cert.infoAccess.split('\n')) { const split = line.indexOf(':'); if (split < 0) continue; const name = line.slice(0, split); let value = line.slice(split + 1); if (value[0] === '"') value = JSON.parse(value); (result.infoAccess[name] || (result.infoAccess[name] = [])).push(value); }
  }
  const spki = children(parts.spki.data), algorithm = children(spki[0].data), algorithmId = oid(algorithm[0].data);
  if (algorithmId === '1.2.840.113549.1.1.1' || algorithmId === '1.2.840.113549.1.1.10') {
    const integers = children(node(spki[1].data.subarray(1)).data);
    let modulus = integers[0].data; while (modulus.length > 1 && modulus[0] === 0) modulus = modulus.subarray(1);
    result.modulus = modulus.toString('hex').toUpperCase();
    let exponent = 0n; for (const byte of integers[1].data) exponent = exponent * 256n + BigInt(byte);
    result.exponent = '0x' + (exponent > 0xffffffffffffffffn ? 0xffffffffffffffffn : exponent).toString(16);
    result.pubkey = rsaPublic(spki[1].raw); result.bits = c.call('keyBits', [c.handle(key)]);
  } else if (algorithmId === '1.2.840.10045.2.1') {
    result.pubkey = Buffer.from(call(cert, 'x509ECPublic')); result.bits = c.call('keyBits', [c.handle(key)]);
    result.asn1Curve = call(cert, 'x509ECCurve', 0);
    result.nistCurve = call(cert, 'x509ECCurve', 1);
  }
  if (cert.issuerCertificate) result.issuerCertificate = legacy(cert.issuerCertificate, seen);
  return result;
}
class X509Certificate {
  constructor(buffer) {
    if (typeof buffer !== 'string' && !ArrayBuffer.isView(buffer)) throw c.invalid('buffer', 'a string, Buffer, TypedArray, or DataView');
    const id = c.call('x509Create', [c.packed(c.bytes(buffer))]);
    c.attach(this, id); states.set(this, Object.create(null));
  }
  get subject() { return cached(this, 'subject', () => call(this, 'x509Name', 0)); }
  get issuer() { return cached(this, 'issuer', () => call(this, 'x509Name', 1)); }
  get issuerCertificate() { return state(this).issuerCertificate; }
  get subjectAltName() { return cached(this, 'subjectAltName', () => extension(this, '2.5.29.17', names => names.map(generalName).join(', '))); }
  get infoAccess() { return cached(this, 'infoAccess', () => extension(this, '1.3.6.1.5.5.7.1.1', entries => entries.map(entry => { const fields = children(entry.data); return oidName(oid(fields[0].data)) + ' - ' + generalName(fields[1]); }).join('\n'))); }
  get validFrom() { return cached(this, 'validFrom', () => call(this, 'x509Time', 0)); }
  get validTo() { return cached(this, 'validTo', () => call(this, 'x509Time', 1)); }
  get validFromDate() { return cached(this, 'validFromDate', () => dateValue(this.validFrom)); }
  get validToDate() { return cached(this, 'validToDate', () => dateValue(this.validTo)); }
  get fingerprint() { return fingerprint(this, 'sha1'); }
  get fingerprint256() { return fingerprint(this, 'sha256'); }
  get fingerprint512() { return fingerprint(this, 'sha512'); }
  get keyUsage() { return cached(this, 'keyUsage', () => extension(this, '2.5.29.37', usages => usages.map(item => oid(item.data)))); }
  get serialNumber() { return cached(this, 'serialNumber', () => call(this, 'x509Serial')); }
  get signatureAlgorithm() { return cached(this, 'signatureAlgorithm', () => call(this, 'x509Signature', 0)); }
  get signatureAlgorithmOid() { return cached(this, 'signatureAlgorithmOid', () => call(this, 'x509Signature', 1)); }
  get raw() { return cached(this, 'raw', () => Buffer.from(call(this, 'x509Raw'))); }
  get publicKey() { return cached(this, 'publicKey', () => c.keyFromHandle('public', call(this, 'x509PublicKey'))); }
  get ca() { return cached(this, 'ca', () => !!call(this, 'x509CA')); }
  toString() { return pem(this); }
  toJSON() { return pem(this); }
  checkHost(name, options) { return check(this, 'x509Host', name, 'name', options); }
  checkEmail(email, options) { return check(this, 'x509Email', email, 'email', options); }
  checkIP(ip, options) { return check(this, 'x509IP', ip, 'ip', options); }
  checkIssued(otherCert) { state(this); if (!states.has(otherCert)) throw c.invalid('otherCert', 'an X509Certificate'); return !!call(this, 'x509Issued', c.handle(otherCert)); }
  checkPrivateKey(pkey) { return checkKey(this, 'x509Private', pkey, 'private'); }
  verify(pkey) { return checkKey(this, 'x509Verify', pkey, 'public'); }
  toLegacyObject() { state(this); return legacy(this, new Map()); }
  [Symbol.for('nodejs.util.inspect.custom')](depth, options) {
    if (depth < 0) return this;
    // Node reads the native slots, never the patchable prototype getters.
    const value = {}; for (const [name, get] of kInspectGetters) value[name] = get.call(this);
    return 'X509Certificate ' + require('util').inspect(value, { ...options, depth: options.depth == null ? null : options.depth - 1 });
  }
}
const kInspectGetters = ['subject', 'subjectAltName', 'issuer', 'infoAccess', 'validFrom', 'validTo', 'validFromDate', 'validToDate', 'fingerprint', 'fingerprint256', 'fingerprint512', 'keyUsage', 'serialNumber', 'signatureAlgorithm', 'signatureAlgorithmOid']
  .map(name => [name, Object.getOwnPropertyDescriptor(X509Certificate.prototype, name).get]);
function pem(cert) { return cached(cert, 'pem', () => call(cert, 'x509PEM')); }
function fingerprint(cert, digest) { return cached(cert, digest, () => { const value = Buffer.from(call(cert, 'x509Fingerprint', digest)); return Array.from(value, byte => byte.toString(16).padStart(2, '0').toUpperCase()).join(':'); }); }
function Certificate() { if (!(this instanceof Certificate)) return new Certificate(); }
function verifySpkac(spkac, encoding) { return !!c.call('spkacVerify', [c.packed(c.bytes(spkac, encoding, 'spkac'))]); }
function exportPublicKey(spkac, encoding) { const value = c.call('spkacPublic', [c.packed(c.bytes(spkac, encoding, 'spkac'))]); return value === undefined ? '' : Buffer.from(value); }
function exportChallenge(spkac, encoding) { const value = c.call('spkacChallenge', [c.packed(c.bytes(spkac, encoding, 'spkac'))]); return value === undefined ? '' : Buffer.from(value); }
Object.assign(Certificate, { verifySpkac, exportPublicKey, exportChallenge });
Object.assign(Certificate.prototype, { verifySpkac, exportPublicKey, exportChallenge });
function parsePKCS12(bundle, options = {}) {
  const data = c.binary(bundle, 'bundle'); object(options, 'options');
  const pass = options.passphrase === undefined ? undefined : c.bytes(options.passphrase, 'utf8', 'options.passphrase');
  if (pass && pass.includes(0)) throw c.error('ERR_INVALID_ARG_VALUE', 'options.passphrase must not contain null bytes', TypeError);
  const frame = Buffer.from(c.call('pkcs12Parse', [c.packed(data), pass === undefined ? undefined : c.packed(pass)]));
  let offset = 0, privateKey = null, certificate = null; const additionalCertificates = [];
  function field() { const length = frame.readUInt32BE(offset); offset += 4; const value = frame.subarray(offset, offset + length); offset += length; return value; }
  try {
    const key = field(); if (key.length) privateKey = require('crypto').createPrivateKey({ key, format: 'der', type: 'pkcs8' });
    const cert = field(); if (cert.length) certificate = new X509Certificate(cert);
    while (offset < frame.length) additionalCertificates.push(new X509Certificate(field()));
    return { privateKey, certificate, additionalCertificates };
  } catch (error) { if (privateKey) c.release(privateKey); if (certificate) c.release(certificate); for (const cert of additionalCertificates) c.release(cert); throw error; }
  finally { frame.fill(0); }
}
function _x509FromChain(chain) {
  if (!chain || !chain.length) return undefined;
  const certificates = [];
  try {
    for (const input of chain) certificates.push(new X509Certificate(input));
    for (let i = 0; i + 1 < certificates.length; i++) state(certificates[i]).issuerCertificate = certificates[i + 1];
    const root = certificates[certificates.length - 1]; if (root.checkIssued(root)) state(root).issuerCertificate = root;
    return certificates[0];
  } catch (error) { for (const cert of certificates) c.release(cert); throw error; }
}
function _cloneData(value) { return states.has(value) ? call(value, 'x509Raw') : undefined; }
function _fromCloneData(value) { return new X509Certificate(new Uint8Array(value)); }
module.exports = { Certificate, X509Certificate, parsePKCS12, _x509FromChain, _cloneData, _fromCloneData };
