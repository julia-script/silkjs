'use strict';
// Resolver queries against an in-process DNS server: UDP answers, TCP fallback on truncation,
// response codes, TTLs, parallel queries, timeouts and cancellation.
const assert = require('assert');
const dgram = require("dgram"), net = require("net"), dns = require("dns");
function name(n) { return Buffer.concat([...n.split('.').map(l => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]); }
function rr(type, data) { const h = Buffer.alloc(10); h.writeUInt16BE(type, 0); h.writeUInt16BE(1, 2); h.writeUInt32BE(300, 4); h.writeUInt16BE(data.length, 8); return Buffer.concat([Buffer.from([0xc0, 12]), h, data]); }
function answer(q, tcp) {
  const id = q.readUInt16BE(0); let o = 12; const labels = [];
  while (q[o]) { labels.push(q.slice(o + 1, o + 1 + q[o]).toString()); o += q[o] + 1; }
  const qname = labels.join('.'); const type = q.readUInt16BE(o + 1); const question = q.slice(12, o + 5);
  let answers = [], rcode = 0, tc = 0;
  if (qname.startsWith('nx.')) rcode = 3;
  else if (qname.startsWith('fail.')) rcode = 2;
  else if (qname.startsWith('big.') && !tcp) tc = 1;
  else if (type === 1) answers = [rr(1, Buffer.from([10, 0, 0, 1])), rr(1, Buffer.from([10, 0, 0, 2]))];
  else if (type === 28) answers = [rr(28, Buffer.from('20010db8000000000000000000000001', 'hex'))];
  else if (type === 16) { const t = Buffer.from('hello world'); answers = [rr(16, Buffer.concat([Buffer.from([t.length]), t]))]; }
  else if (type === 15) { const p = Buffer.alloc(2); p.writeUInt16BE(10); answers = [rr(15, Buffer.concat([p, name('mail.test')]))]; }
  const h = Buffer.alloc(12); h.writeUInt16BE(id, 0); h.writeUInt16BE(0x8180 | (tc << 9) | rcode, 2); h.writeUInt16BE(1, 4); h.writeUInt16BE(answers.length, 6);
  return Buffer.concat([h, question, ...answers]);
}
const u = dgram.createSocket('udp4');
const t = net.createServer(s => { let b = Buffer.alloc(0); s.on('data', d => { b = Buffer.concat([b, d]); if (b.length >= 2 && b.length >= 2 + b.readUInt16BE(0)) { const a = answer(b.slice(2), true); const l = Buffer.alloc(2); l.writeUInt16BE(a.length); s.end(Buffer.concat([l, a])); } }); });
u.on('message', (m, r) => u.send(answer(m, false), r.port, r.address));
u.bind(0, '127.0.0.1', () => t.listen(u.address().port, '127.0.0.1', main));
async function code(promise) { try { await promise; return 'none'; } catch (e) { return e.code + ' ' + e.syscall; } }
async function main() {
  const r = new dns.promises.Resolver({ timeout: 1000, tries: 1 }); r.setServers(['127.0.0.1:' + u.address().port]);
  assert.deepStrictEqual(await r.resolve4('a.test'), ['10.0.0.1', '10.0.0.2']);
  assert.deepStrictEqual(await r.resolve6('a.test'), ['2001:db8::1']);
  assert.deepStrictEqual(await r.resolveTxt('a.test'), [['hello world']]);
  assert.deepStrictEqual(await r.resolveMx('a.test'), [{ exchange: 'mail.test', priority: 10, type: 'MX' }]);
  assert.deepStrictEqual(await r.resolve4('big.test'), ['10.0.0.1', '10.0.0.2']);
  assert.deepStrictEqual(await r.resolve4('a.test', { ttl: true }), [{ address: '10.0.0.1', ttl: 300 }, { address: '10.0.0.2', ttl: 300 }]);
  assert.strictEqual(await code(r.resolve4('nx.test')), 'ENOTFOUND queryA');
  assert.strictEqual(await code(r.resolve4('fail.test')), 'ESERVFAIL queryA');
  assert.strictEqual(await code(r.resolveCname('a.test')), 'ENODATA queryCname');
  const all = await Promise.all(Array.from({ length: 20 }, (_, i) => r.resolve4('p' + i + '.test')));
  assert.ok(all.every(a => a.length === 2));
  const silent = new dns.promises.Resolver({ timeout: 200, tries: 1 }); silent.setServers(['192.0.2.1']);
  const started = Date.now(); const failed = await code(silent.resolve4('a.test'));
  assert.ok(/^(ETIMEOUT|ECONNREFUSED) queryA$/.test(failed), failed); assert.ok(Date.now() - started < 3000);
  const cancelled = await new Promise(done => { const c = new dns.Resolver(); c.setServers(['192.0.2.1']); c.resolve4('a.test', e => done(e && e.code)); c.cancel(); });
  assert.strictEqual(cancelled, 'ECANCELLED');
  u.close(); t.close(); console.log('dns resolver smoke ok');
}
