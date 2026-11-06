'use strict';
const { Buffer } = require('buffer');
const types = { A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28, SRV: 33, NAPTR: 35, TLSA: 52, CAA: 257, ANY: 255 };
function malformed() { const e = new Error('Malformed DNS response'); e.code = 'EBADRESP'; return e; }
function ipv6(bytes) {
  const words = [];
  for (let i = 0; i < 16; i += 2) words.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  let best = -1, length = 1;
  for (let i = 0; i < 8;) { if (words[i] !== '0') { i++; continue; } let end = i; while (end < 8 && words[end] === '0') end++; if (end - i > length) { best = i; length = end - i; } i = end; }
  if (best < 0) return words.join(':');
  return words.slice(0, best).join(':') + '::' + words.slice(best + length).join(':');
}
function decode(data, requested, ttl) {
  const packet = Buffer.from(data);
  function need(at, n, end = packet.length) { if (!Number.isInteger(at) || at < 0 || n < 0 || at + n > end) throw malformed(); }
  function u16(at) { need(at, 2); return packet[at] * 256 + packet[at + 1]; }
  function u32(at) { need(at, 4); return packet[at] * 0x1000000 + packet[at + 1] * 65536 + packet[at + 2] * 256 + packet[at + 3]; }
  function name(at) {
    const labels = []; let next, hops = 0, total = 0;
    while (true) {
      need(at, 1); if (++hops > 128) throw malformed();
      const n = packet[at++];
      if ((n & 0xc0) === 0xc0) { need(at, 1); const target = ((n & 63) << 8) | packet[at++]; if (next === undefined) next = at; at = target; continue; }
      if (n & 0xc0) throw malformed();
      if (!n) return { value: labels.join('.'), next: next === undefined ? at : next };
      need(at, n); total += n + 1; if (total > 255) throw malformed();
      let label = ''; for (let i = 0; i < n; i++) { const c = packet[at + i]; label += c === 46 || c === 92 ? '\\' + String.fromCharCode(c) : c < 33 || c > 126 ? '\\' + String(c).padStart(3, '0') : String.fromCharCode(c); }
      labels.push(label); at += n;
    }
  }
  need(0, 12); if (!(packet[2] & 0x80) || (packet[2] & 2)) throw malformed();
  let at = 12;
  for (let i = 0; i < u16(4); i++) { at = name(at).next; need(at, 4); at += 4; }
  const result = [];
  for (let i = 0; i < u16(6); i++) {
    at = name(at).next; need(at, 10);
    const kind = u16(at), dnsclass = u16(at + 2), seconds = u32(at + 4), size = u16(at + 8); at += 10;
    const end = at + size; need(at, size);
    if (dnsclass !== 1 || (requested !== 'ANY' && kind !== types[requested])) { at = end; continue; }
    let cursor = at;
    function takeName() { const n = name(cursor); need(cursor, n.next - cursor, end); cursor = n.next; return n.value; }
    function charString() { need(cursor, 1, end); const length = packet[cursor++]; need(cursor, length, end); const text = packet.toString('utf8', cursor, cursor + length); cursor += length; return text; }
    let value, type;
    switch (kind) {
      case 1: need(at, 4, end); if (size !== 4) throw malformed(); type = 'A'; value = { address: Array.from(packet.subarray(at, end)).join('.'), ttl: seconds }; break;
      case 28: if (size !== 16) throw malformed(); type = 'AAAA'; value = { address: ipv6(packet.subarray(at, end)), ttl: seconds }; break;
      case 2: case 5: case 12: type = kind === 2 ? 'NS' : kind === 5 ? 'CNAME' : 'PTR'; value = takeName(); break;
      case 15: type = 'MX'; need(at, 2, end); cursor += 2; value = { exchange: takeName(), priority: u16(at) }; break;
      case 16: type = 'TXT'; value = []; while (cursor < end) value.push(charString()); break;
      case 6: {
        type = 'SOA'; const nsname = takeName(), hostmaster = takeName(); need(cursor, 20, end);
        value = { nsname, hostmaster, serial: u32(cursor), refresh: u32(cursor + 4), retry: u32(cursor + 8), expire: u32(cursor + 12), minttl: u32(cursor + 16) }; break;
      }
      case 33: type = 'SRV'; need(at, 6, end); cursor += 6; value = { name: takeName(), port: u16(at + 4), priority: u16(at), weight: u16(at + 2) }; break;
      case 35: {
        type = 'NAPTR'; need(at, 4, end); cursor += 4;
        const flags = charString(), service = charString(), regexp = charString(), replacement = takeName();
        value = { flags, service, regexp, replacement, order: u16(at), preference: u16(at + 2) }; break;
      }
      case 257: {
        type = 'CAA'; need(at, 2, end); const critical = packet[at], length = packet[at + 1]; need(at + 2, length, end);
        const tag = packet.toString('ascii', at + 2, at + 2 + length); value = { critical, [tag]: packet.toString('utf8', at + 2 + length, end) }; break;
      }
      case 52: type = 'TLSA'; need(at, 3, end); value = { certUsage: packet[at], selector: packet[at + 1], match: packet[at + 2], data: Buffer.from(packet.subarray(at + 3, end)) }; break;
      default: at = end; continue;
    }
    if (requested === 'ANY') {
      if (type === 'NS' || type === 'CNAME' || type === 'PTR') value = { value, type };
      else if (type === 'TXT') value = { entries: value, type };
      else value = Object.assign({ type }, value);
    } else if ((type === 'A' || type === 'AAAA') && !ttl) value = value.address;
    else if (type === 'MX') value.type = 'MX'; // Node 24 tags MX records even outside ANY.
    result.push(value); at = end;
  }
  if (!result.length) { const e = new Error('No DNS records'); e.code = 'ENODATA'; throw e; }
  return requested === 'SOA' ? result[0] : result;
}
function reverseName(address, family) {
  if (family === 4) return address.split('.').reverse().join('.') + '.in-addr.arpa';
  let text = address.split('%')[0];
  if (text.includes('.')) { const end = text.lastIndexOf(':'); const octets = text.slice(end + 1).split('.').map(Number); text = text.slice(0, end + 1) + ((octets[0] << 8) | octets[1]).toString(16) + ':' + ((octets[2] << 8) | octets[3]).toString(16); }
  const halves = text.split('::'), left = halves[0] ? halves[0].split(':') : [], right = halves[1] ? halves[1].split(':') : [];
  const words = halves.length === 2 ? left.concat(Array(8 - left.length - right.length).fill('0'), right) : left;
  return words.map(w => w.padStart(4, '0')).join('').split('').reverse().join('.') + '.ip6.arpa';
}
module.exports = { types, decode, reverseName };
