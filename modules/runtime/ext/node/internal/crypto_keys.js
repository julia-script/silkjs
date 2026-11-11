'use strict';
const { Buffer, bytes, error } = require('internal/crypto_core');
const fail = () => { throw error('ERR_CRYPTO_INVALID_JWK', 'Invalid key encoding'); };
function length(n) { if (n < 128) return Buffer.from([n]); const out = []; while (n) { out.unshift(n & 255); n = Math.floor(n / 256); } return Buffer.from([128 | out.length, ...out]); }
function tlv(tag, value) { value = Buffer.from(value); return Buffer.concat([Buffer.from([tag]), length(value.length), value]); }
function sequence(...values) { return tlv(48, Buffer.concat(values)); }
function integer(value) { let b = Buffer.from(value); while (b.length > 1 && b[0] === 0) b = b.subarray(1); if (!b.length) b = Buffer.from([0]); if (b[0] & 128) b = Buffer.concat([Buffer.from([0]), b]); return tlv(2, b); }
function parse(bytes, offset = 0) { if (offset + 2 > bytes.length) fail(); const tag = bytes[offset++]; let n = bytes[offset++]; if (n & 128) { const count = n & 127; if (!count || count > 4 || offset + count > bytes.length) fail(); n = 0; for (let i = 0; i < count; i++) n = n * 256 + bytes[offset++]; } if (offset + n > bytes.length) fail(); return { tag, data: bytes.subarray(offset, offset + n), end: offset + n }; }
function children(data) { const result = []; let offset = 0; while (offset < data.length) { const node = parse(data, offset); result.push(node); offset = node.end; } return result; }
function root(data) { const node = parse(data); if (node.tag !== 48 || node.end !== data.length) fail(); return children(node.data); }
function unsigned(node) { if (!node || node.tag !== 2 || !node.data.length || node.data[0] & 128) fail(); let b = node.data; while (b.length > 1 && b[0] === 0) b = b.subarray(1); return b; }
function b64(data) { return Buffer.from(data).toString('base64url'); }
function decode(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) fail(); return Buffer.from(value, 'base64url'); }
const oid = hex => tlv(6, Buffer.from(hex, 'hex'));
const rsaOid = '2a864886f70d010101'; const ecOid = '2a8648ce3d0201';
const curves = { 'P-256': { oid: '2a8648ce3d030107', size: 32 }, 'P-384': { oid: '2b81040022', size: 48 }, 'P-521': { oid: '2b81040023', size: 66 }, secp256k1: { oid: '2b8104000a', size: 32 } };
const okp = { Ed25519: '2b6570', Ed448: '2b6571', X25519: '2b656e', X448: '2b656f' };
function spki(algorithm, key) { return sequence(algorithm, tlv(3, Buffer.concat([Buffer.from([0]), key]))); }
function pkcs8(algorithm, key) { return sequence(integer(Buffer.from([0])), algorithm, tlv(4, key)); }
const jwkCurveAliases = { prime256v1: 'P-256', secp384r1: 'P-384', secp521r1: 'P-521' };
function jwkFail(message) { throw error('ERR_CRYPTO_INVALID_JWK', message, TypeError); }
function jwkDecode(value, message) { if (typeof value !== 'string') jwkFail(message); return Buffer.from(value, 'base64url'); }
// Follows Node's ImportJWK*Key checks: kty first, then the per-type fields.
function encodeJwk(jwk, type) {
  if (!jwk || typeof jwk !== 'object') jwkFail('Invalid JWK format'); const privateKey = type === 'private'; let algorithm, key;
  const kty = jwk.kty; if (typeof kty !== 'string') jwkFail('Invalid JWK format');
  if (kty === 'oct') { if (type !== 'secret' || typeof jwk.k !== 'string') jwkFail('Invalid JWK secret key format'); return Buffer.from(jwk.k, 'base64url'); }
  if (kty === 'RSA') {
    const m = 'Invalid JWK RSA key'; if (typeof jwk.n !== 'string' || typeof jwk.e !== 'string' || jwk.d !== undefined && typeof jwk.d !== 'string') jwkFail(m);
    if (privateKey && jwk.d === undefined) jwkFail(m); if (!privateKey && jwk.d === undefined && jwk.oth !== undefined) jwkFail(m);
    algorithm = sequence(oid(rsaOid), tlv(5, Buffer.alloc(0))); const fields = privateKey ? ['n', 'e', 'd', 'p', 'q', 'dp', 'dq', 'qi'] : ['n', 'e']; const values = fields.map(k => integer(jwkDecode(jwk[k], m))); if (privateKey) values.unshift(integer(Buffer.from([0]))); key = sequence(...values);
  } else if (kty === 'EC') {
    const m = 'Invalid JWK EC key'; if (typeof jwk.crv !== 'string') jwkFail(m);
    const curve = curves[jwkCurveAliases[jwk.crv] || jwk.crv]; if (!curve) throw error('ERR_CRYPTO_INVALID_CURVE', 'Invalid EC curve name', TypeError);
    if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string' || jwk.d !== undefined && typeof jwk.d !== 'string' || privateKey && jwk.d === undefined) jwkFail(m);
    const x = jwkDecode(jwk.x, m), y = jwkDecode(jwk.y, m); if (x.length !== curve.size || y.length !== curve.size) jwkFail(m); const pub = Buffer.concat([Buffer.from([4]), x, y]); algorithm = sequence(oid(ecOid), oid(curve.oid));
    if (privateKey) { const d = jwkDecode(jwk.d, m); if (d.length !== curve.size) jwkFail(m); key = sequence(integer(Buffer.from([1])), tlv(4, d), tlv(161, tlv(3, Buffer.concat([Buffer.from([0]), pub])))); } else key = pub;
  } else if (kty === 'OKP') {
    const m = 'Invalid JWK OKP key'; if (typeof jwk.crv !== 'string' || typeof jwk.x !== 'string' || jwk.d !== undefined && typeof jwk.d !== 'string' || !okp[jwk.crv] || privateKey && jwk.d === undefined) jwkFail(m);
    algorithm = sequence(oid(okp[jwk.crv])); key = privateKey ? tlv(4, jwkDecode(jwk.d, m)) : jwkDecode(jwk.x, m);
  } else jwkFail(`${kty} is not a supported JWK key type`);
  return privateKey ? pkcs8(algorithm, key) : spki(algorithm, key);
}
const jwkMessages = { RSA: 'Invalid JWK RSA key', EC: 'Invalid JWK EC key', OKP: 'Invalid JWK OKP key' };
function importJwk(jwk, type) {
  const crypto = require('crypto'), key = encodeJwk(jwk, type); if (type === 'secret') return crypto.createSecretKey(key);
  try { return type === 'private' ? crypto.createPrivateKey({ key, format: 'der', type: 'pkcs8' }) : crypto.createPublicKey({ key, format: 'der', type: 'spki' }); }
  catch { jwkFail(jwkMessages[jwk.kty]); }
}
function exportJwk(key, encoded, publicEncoded) {
  const real = require('internal/host').types.isKeyObject(key), c = require('internal/crypto_core');
  const privateKey = (real ? c.keyObjectType(key) : key.type) === 'private'; const nodes = root(encoded || c.keyObjectDer(key)); const algorithm = children(nodes[privateKey ? 1 : 0].data); if (!algorithm[0] || algorithm[0].tag !== 6) fail(); const id = algorithm[0].data.toString('hex'); let payload = nodes[privateKey ? 2 : 1].data; if (!privateKey) { if (payload[0] !== 0) fail(); payload = payload.subarray(1); }
  if (id === rsaOid) { const parts = root(payload); const names = privateKey ? ['n', 'e', 'd', 'p', 'q', 'dp', 'dq', 'qi'] : ['n', 'e']; const result = { kty: 'RSA' }; names.forEach((name, i) => { result[name] = b64(unsigned(parts[i + (privateKey ? 1 : 0)])); }); return result; }
  if (id === ecOid) {
    const named = algorithm[1] && algorithm[1].data.toString('hex'), crv = Object.keys(curves).find(k => curves[k].oid === named);
    if (!crv) throw error('ERR_CRYPTO_JWK_UNSUPPORTED_CURVE', 'Unsupported JWK curve');
    let pub = payload, d;
    if (privateKey) { const parts = root(payload); d = parts[1].data; const publicPart = parts.find(p => p.tag === 161); if (publicPart) pub = parse(publicPart.data).data.subarray(1); else { let result; if (publicEncoded) result = exportJwk({ type: 'public' }, publicEncoded); else { const publicKey = require('crypto').createPublicKey(key); try { result = exportJwk(publicKey); } finally { require('internal/crypto_core').release(publicKey); } } result.d = b64(d); return result; } }
    const size = curves[crv].size; if (pub[0] !== 4 || pub.length !== size * 2 + 1) fail();
    const result = { kty: 'EC', x: b64(pub.subarray(1, size + 1)), y: b64(pub.subarray(size + 1)), crv }; if (privateKey) result.d = b64(d); return result;
  }
  const crv = Object.keys(okp).find(k => okp[k] === id);
  if (crv) { let x = payload, d; if (privateKey) { d = parse(payload).data; if (publicEncoded) x = decode(exportJwk({ type: 'public' }, publicEncoded).x); else { const publicKey = require('crypto').createPublicKey(key); try { x = decode(exportJwk(publicKey).x); } finally { require('internal/crypto_core').release(publicKey); } } } const result = { crv, x: b64(x), kty: 'OKP' }; if (privateKey) result.d = b64(d); return result; }
  throw error('ERR_CRYPTO_JWK_UNSUPPORTED_KEY_TYPE', 'Unsupported JWK key type');
}
function signature(data, size, toDer) { data = bytes(data); if (toDer) { if (data.length !== size * 2) throw error('ERR_CRYPTO_INVALID_SIGNATURE', 'Invalid P1363 signature length'); return sequence(integer(data.subarray(0, size)), integer(data.subarray(size))); } const parts = root(data); if (parts.length !== 2) fail(); const result = Buffer.alloc(size * 2); parts.forEach((part, i) => { const b = unsigned(part); if (b.length > size) fail(); result.set(b, (i + 1) * size - b.length); }); return result; }
module.exports = { importJwk, encodeJwk, exportJwk, signature };
