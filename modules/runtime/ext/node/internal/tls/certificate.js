'use strict';
const { Buffer } = require('buffer');
const { createHash } = require('crypto');
const { URL } = require('url');

// OpenSSL supplies validated DER. Keep certificate presentation independent of
// verification: verification is always X509_verify_cert in the native layer.
function node(buffer, offset = 0) {
  const start = offset, tag = buffer[offset++];
  let size = buffer[offset++];
  if (size & 128) {
    const count = size & 127;
    if (!count || count > 4 || offset + count > buffer.length) throw new Error('Invalid certificate DER length');
    size = 0; for (let i = 0; i < count; i++) size = size * 256 + buffer[offset++];
  }
  const end = offset + size;
  if (end > buffer.length) throw new Error('Truncated certificate DER');
  return { buffer, tag, start, offset, end, data: buffer.subarray(offset, end) };
}
function children(parent) {
  const result = []; let offset = parent.offset;
  while (offset < parent.end) { const item = node(parent.buffer, offset); if (item.end > parent.end || item.end <= offset) throw new Error('Invalid certificate DER'); result.push(item); offset = item.end; }
  return result;
}
function oid(item) {
  const data = item.data; const out = []; let value = 0;
  for (const byte of data) { value = value * 128 + (byte & 127); if (!(byte & 128)) { if (!out.length) { const first = value < 40 ? 0 : value < 80 ? 1 : 2; out.push(first, value - first * 40); } else out.push(value); value = 0; } }
  return out.join('.');
}
function string(item) {
  if (item.tag === 30) { let text = ''; for (let i = 0; i < item.data.length; i += 2) text += String.fromCharCode(item.data[i] * 256 + item.data[i + 1]); return text; }
  return item.data.toString(item.tag === 20 ? 'latin1' : 'utf8');
}
const names = { '2.5.4.3': 'CN', '2.5.4.6': 'C', '2.5.4.7': 'L', '2.5.4.8': 'ST', '2.5.4.10': 'O', '2.5.4.11': 'OU', '2.5.4.5': 'serialNumber', '1.2.840.113549.1.9.1': 'emailAddress', '0.9.2342.19200300.100.1.25': 'DC' };
const kUtf8Convertible = new Set([12, 18, 19, 20, 22, 23, 24, 26, 28, 30]);
function distinguishedName(item) {
  const result = Object.create(null);
  for (const rdn of children(item)) for (const pair of children(rdn)) {
    const [type, value] = children(pair);
    // ASN1_STRING_to_UTF8 only converts the string and time types (the
    // tag2nbyte table in OpenSSL's a_strex.c); Node leaves out the others.
    if (!kUtf8Convertible.has(value.tag)) continue;
    const key = names[oid(type)] || oid(type), text = string(value);
    if (result[key] === undefined) result[key] = text;
    else if (Array.isArray(result[key])) result[key].push(text);
    else result[key] = [result[key], text];
  }
  return result;
}
function time(item) {
  const text = item.data.toString('ascii'); const short = item.tag === 23;
  const year = short ? (Number(text.slice(0, 2)) >= 50 ? 1900 : 2000) + Number(text.slice(0, 2)) : Number(text.slice(0, 4));
  const p = short ? 2 : 4;
  const date = new Date(Date.UTC(year, Number(text.slice(p, p + 2)) - 1, Number(text.slice(p + 2, p + 4)), Number(text.slice(p + 4, p + 6)), Number(text.slice(p + 6, p + 8)), Number(text.slice(p + 8, p + 10))));
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return months[date.getUTCMonth()] + ' ' + String(date.getUTCDate()).padStart(2, ' ') + ' ' + date.toISOString().slice(11, 19) + ' ' + year + ' GMT';
}
function ip(data) {
  if (data.length === 4) return Array.from(data).join('.');
  if (data.length !== 16) throw new Error('Invalid certificate IP SAN');
  const parts = []; for (let i = 0; i < 16; i += 2) parts.push((data[i] * 256 + data[i + 1]).toString(16));
  return new URL('http://[' + parts.join(':') + ']/').hostname.slice(1, -1);
}
function safeName(text) { return /[,"\\\x00-\x1f\x7f-\xff]/.test(text) ? JSON.stringify(text) : text; }
function certificate(input) {
  const raw = Buffer.from(input); if (!raw.length) return {};
  const outer = children(node(raw)); const tbs = children(outer[0]); let index = tbs[0].tag === 160 ? 1 : 0;
  const serial = tbs[index++]; index++; const issuer = tbs[index++], validity = children(tbs[index++]), subject = tbs[index++], publicKey = tbs[index++];
  const result = { subject: distinguishedName(subject), issuer: distinguishedName(issuer), valid_from: time(validity[0]), valid_to: time(validity[1]), serialNumber: serial.data.toString('hex').replace(/^00(?=..)/, '').toUpperCase(), raw };
  for (const [field, algorithm] of [['fingerprint', 'sha1'], ['fingerprint256', 'sha256'], ['fingerprint512', 'sha512']]) result[field] = createHash(algorithm).update(raw).digest('hex').toUpperCase().match(/../g).join(':');
  const key = children(publicKey), algorithm = children(key[0]);
  result.pubkey = Buffer.from(raw.subarray(publicKey.start, publicKey.end));
  if (oid(algorithm[0]) === '1.2.840.113549.1.1.1') {
    const rsa = children(node(key[1].data.subarray(1))); let modulus = rsa[0].data; if (modulus[0] === 0) modulus = modulus.subarray(1);
    result.modulus = modulus.toString('hex').toUpperCase(); result.bits = modulus.length * 8 - Math.clz32(modulus[0]) + 24;
    result.exponent = '0x' + (rsa[1].data.toString('hex').replace(/^0+/, '') || '0');
  }
  for (; index < tbs.length; index++) {
    if (tbs[index].tag !== 163) continue;
    for (const extension of children(children(tbs[index])[0])) {
      const fields = children(extension), id = oid(fields[0]), value = node(fields[fields.length - 1].data);
      if (id === '2.5.29.17') {
        const alt = [];
        for (const entry of children(value)) {
          if (entry.tag === 130) alt.push('DNS:' + safeName(entry.data.toString('latin1')));
          else if (entry.tag === 135) alt.push('IP Address:' + ip(entry.data));
          else if (entry.tag === 129) alt.push('email:' + safeName(entry.data.toString('latin1')));
          else if (entry.tag === 134) alt.push('URI:' + safeName(entry.data.toString('latin1')));
        }
        result.subjectaltname = alt.join(', ');
      } else if (id === '2.5.29.19') result.ca = children(value).some(entry => entry.tag === 1 && entry.data[0] !== 0);
      else if (id === '2.5.29.37') result.ext_key_usage = children(value).map(oid);
      else if (id === '1.3.6.1.5.5.7.1.1') {
        result.infoAccess = Object.create(null);
        for (const item of children(value)) {
          const [method, location] = children(item); if (location.tag !== 134) continue;
          const name = ({ '1.3.6.1.5.5.7.48.1': 'OCSP', '1.3.6.1.5.5.7.48.2': 'CA Issuers' }[oid(method)] || oid(method)) + ' - URI';
          (result.infoAccess[name] ||= []).push(location.data.toString('latin1'));
        }
      }
    }
  }
  return result;
}
module.exports = { certificate };
