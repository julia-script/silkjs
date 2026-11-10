'use strict';
// Real TCP frame peers and TLS sessions; no Node/V8 execution dependency.
// Run each mode independently: contracts, headers, memory, rejected, resets,
// invalid, padding, settings, deflate, header-block, reserved, concurrency, extensions.
const assert = require('assert');
const h2 = require('http2');
const net = require('net');
const mode = process.argv[2] || 'contracts';
const sockets = new Set(), sessions = new Set();
let server, directory;
const errors = [];
// Large-header exchanges can take tens of seconds in the Silk-native runtime.
// Memory must reach its real 1MB credit limit, not fail on the generic deadline.
const deadline = setTimeout(() => { console.error('HTTP2 resource timeout: ' + mode); cleanup(); process.exit(1); }, mode === 'memory' ? 90000 : 8000);
function cleanup() {
  clearTimeout(deadline);
  for (const session of sessions) session.destroy();
  for (const socket of sockets) socket.destroy();
  if (server) server.close();
  if (directory) require('fs').rmSync(directory, { recursive: true, force: true });
}
function event(target, name) {
  return new Promise((resolve, reject) => {
    const done = (...args) => { target.removeListener('error', fail); resolve(args); };
    const fail = error => { target.removeListener(name, done); reject(error); };
    target.once(name, done); if (name !== 'error' && name !== 'close') target.once('error', fail);
  });
}
function track(session) { sessions.add(session); session.on('error', error => errors.push(error)); session.once('close', () => sessions.delete(session)); return session; }
async function listen(options = {}, secure = false) {
  server = secure ? h2.createSecureServer({ ...credentials(), ...options }) : h2.createServer(options);
  server.on('session', track); server.on('sessionError', error => errors.push(error));
  server.on('stream', stream => stream.on('error', error => errors.push(error)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}
function frame(type, flags, stream, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(9); header.writeUIntBE(payload.length, 0, 3); header[3] = type; header[4] = flags; header.writeUInt32BE(stream, 5);
  return Buffer.concat([header, payload]);
}
function word(value) { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; }
function setting(id, value) { const b = Buffer.alloc(6); b.writeUInt16BE(id); b.writeUInt32BE(value, 2); return b; }
function text(value) {
  const b = Buffer.from(value); let size = b.length; const prefix = [];
  if (size < 127) prefix.push(size); else { prefix.push(127); size -= 127; while (size >= 128) { prefix.push((size % 128) + 128); size = Math.floor(size / 128); } prefix.push(size); }
  return Buffer.concat([Buffer.from(prefix), b]);
}
function requestHeaders(extra, missingPath = false) {
  const parts = [Buffer.from(missingPath ? [0x82, 0x86, 0x01] : [0x82, 0x86, 0x84, 0x01]), text('localhost')];
  if (extra !== undefined) parts.push(Buffer.from([0]), text('x-test'), text(extra));
  return Buffer.concat(parts);
}
function reader(socket, preface = false) {
  let data = Buffer.alloc(0), skip = preface ? 24 : 0;
  const frames = [], waiters = [];
  socket.on('data', chunk => {
    data = Buffer.concat([data, chunk]);
    if (skip) { if (data.length < skip) return; assert.strictEqual(data.subarray(0, skip).toString(), 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n'); data = data.subarray(skip); skip = 0; }
    while (data.length >= 9) {
      const n = data.readUIntBE(0, 3); if (data.length < n + 9) break;
      frames.push({ type: data[3], flags: data[4], id: data.readUInt32BE(5) & 0x7fffffff, payload: data.subarray(9, n + 9), length: n }); data = data.subarray(n + 9);
    }
    for (let i = waiters.length - 1; i >= 0; i--) { const waiter = waiters[i], found = frames.find(waiter.predicate); if (found) { waiters.splice(i, 1); waiter.resolve(found); } }
  });
  return { frames, wait(predicate) { const found = frames.find(predicate); return found ? Promise.resolve(found) : new Promise(resolve => waiters.push({ predicate, resolve })); } };
}
async function raw(port) {
  const socket = net.connect(port, '127.0.0.1'); sockets.add(socket); socket.on('error', error => errors.push(error));
  const wire = reader(socket); await event(socket, 'connect');
  socket.write(Buffer.concat([Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n'), frame(4, 0, 0)]));
  await wire.wait(f => f.type === 4 && !(f.flags & 1)); socket.write(frame(4, 1, 0));
  return { socket, ...wire };
}
function credentials() {
  const fs = require('fs'), path = require('path'); directory = fs.mkdtempSync(path.join(require('os').tmpdir(), 'silk-h2-resources-'));
  const key = path.join(directory, 'key.pem'), cert = path.join(directory, 'cert.pem');
  const result = require('child_process').spawnSync(process.env.OPENSSL || 'openssl', ['req', '-new', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=localhost'], { encoding: 'utf8' });
  if (result.error) throw result.error; assert.strictEqual(result.status, 0, result.stderr);
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}
async function pingRaw(peer, value) { const payload = Buffer.alloc(8, value); peer.socket.write(frame(6, 0, 0, payload)); await peer.wait(f => f.type === 6 && (f.flags & 1) && f.payload.equals(payload)); }
(async () => {
  if (mode === 'contracts') {
    for (const name of ['maxSessionInvalidFrames', 'maxSessionRejectedStreams']) {
      assert.throws(() => h2.createServer({ [name]: -1 }), { code: 'ERR_OUT_OF_RANGE' });
      assert.throws(() => h2.createServer({ [name]: '1' }), { code: 'ERR_INVALID_ARG_TYPE' });
    }
    assert.throws(() => h2.createServer({ remoteCustomSettings: null }), { code: 'ERR_INVALID_ARG_TYPE' });
    const port = await listen(); server.on('stream', stream => { stream.respond(); stream.end('ok'); });
    const client = track(h2.connect('http://127.0.0.1:' + port));
    const request = client.request(); assert.strictEqual(request.id, undefined); assert.strictEqual(request.pending, true); assert.deepStrictEqual(request.state, {});
    for (const method of ['write', 'end', 'read', 'pause', 'resume', 'emit', 'setEncoding', 'setNoDelay', 'setKeepAlive']) {
      assert.throws(() => client.socket[method], { code: 'ERR_HTTP2_NO_SOCKET_MANIPULATION' });
      assert.throws(() => { client.socket[method] = () => {}; }, { code: 'ERR_HTTP2_NO_SOCKET_MANIPULATION' });
    }
    const ready = event(request, 'ready'), ended = event(request, 'end'); request.resume();
    await ready; assert.strictEqual(request.id, 1); assert.strictEqual(request.pending, false); await ended;
    client.destroy();
    assert.throws(() => client.request(null, null), { code: 'ERR_INVALID_ARG_TYPE' });
    assert.throws(() => client.request({ connection: 'close' }), { code: 'ERR_HTTP2_INVALID_CONNECTION_HEADERS' });
    assert.throws(() => client.request({}, { endStream: 1 }), { code: 'ERR_INVALID_ARG_TYPE' });
    const rejected = client.request(); assert.strictEqual((await event(rejected, 'error'))[0].code, 'ERR_HTTP2_INVALID_SESSION');
  } else if (mode === 'headers') {
    const port = await listen({ maxHeaderListPairs: 4 }); let accepted = 0; server.on('stream', stream => { accepted++; stream.respond(); stream.end(); });
    const peer = await raw(port); peer.socket.write(frame(1, 5, 1, requestHeaders('one too many')));
    assert.strictEqual((await peer.wait(f => f.type === 3 && f.id === 1)).payload.readUInt32BE(), 11); assert.strictEqual(accepted, 0);
    peer.socket.write(frame(1, 5, 3, requestHeaders())); await peer.wait(f => f.type === 1 && f.id === 3); assert.strictEqual(accepted, 1);
  } else if (mode === 'memory') {
    const port = await listen({ maxSessionMemory: 1 });
    server.on('stream', stream => stream.respond()); const peer = await raw(port); const accepted = []; let rejected;
    for (let id = 1; id < 301; id += 2) {
      peer.socket.write(frame(1, 5, id, requestHeaders('x'.repeat(12000))));
      const result = await peer.wait(f => f.id === id && (f.type === 1 || f.type === 3));
      if (result.type === 3) { assert.strictEqual(result.payload.readUInt32BE(), 11); rejected = id; break; } accepted.push(id);
    }
    assert.ok(rejected && accepted.length > 0, 'real retained headers must exhaust the session memory credit');
    for (const id of accepted) peer.socket.write(frame(3, 0, id, word(8)));
    await pingRaw(peer, 41); peer.socket.write(frame(1, 5, 501, requestHeaders('released')));
    await peer.wait(f => f.type === 1 && f.id === 501);
  } else if (mode === 'rejected') {
    const port = await listen({ maxSessionMemory: 1, maxSessionRejectedStreams: 0 });
    server.on('stream', stream => { stream.respond(); stream.write(Buffer.alloc(2000000)); });
    const peer = await raw(port); peer.socket.write(frame(1, 5, 1, requestHeaders()));
    await peer.wait(f => f.type === 0 && f.id === 1);
    peer.socket.write(frame(1, 5, 3, requestHeaders()));
    assert.strictEqual((await peer.wait(f => f.type === 3 && f.id === 3)).payload.readUInt32BE(), 11);
    const closed = event(peer.socket, 'close'); peer.socket.write(frame(1, 5, 5, requestHeaders()));
    await closed; assert.ok(errors.length > 0);
  } else if (mode === 'resets') {
    const port = await listen({ streamResetBurst: 2, streamResetRate: 1 }); server.on('stream', stream => stream.respond());
    const peer = await raw(port), closed = event(peer.socket, 'close');
    for (let id = 1; id < 15; id += 2) peer.socket.write(Buffer.concat([frame(1, 5, id, requestHeaders()), frame(3, 0, id, word(8))]));
    const goaway = await peer.wait(f => f.type === 7); assert.strictEqual(goaway.payload.readUInt32BE(4), h2.constants.NGHTTP2_INTERNAL_ERROR);
    await closed;
  } else if (mode === 'invalid') {
    const port = await listen({ maxSessionInvalidFrames: 0 }); const peer = await raw(port), closed = event(peer.socket, 'close');
    peer.socket.write(Buffer.concat([frame(1, 5, 1, requestHeaders(undefined, true)), frame(1, 5, 3, requestHeaders(undefined, true))]));
    await closed; assert.ok(errors.some(error => error.code === 'ERR_HTTP2_TOO_MANY_INVALID_FRAMES'));
  } else if (mode === 'padding') {
    const port = await listen({ paddingStrategy: h2.constants.PADDING_STRATEGY_ALIGNED }); server.on('stream', stream => { stream.respond(); stream.end('abc'); });
    const peer = await raw(port); peer.socket.write(frame(1, 5, 1, requestHeaders()));
    await peer.wait(f => f.type === 0 && f.id === 1 && (f.flags & 1));
    const chunks = [];
    for (const data of peer.frames.filter(f => f.type === 0 && f.id === 1)) {
      assert.strictEqual((data.length + 9) % 8, 0); assert.ok(data.flags & 8);
      const pad = data.payload[0]; assert.ok(pad < data.length);
      chunks.push(data.payload.subarray(1, data.length - pad));
    }
    assert.strictEqual(Buffer.concat(chunks).toString(), 'abc');
  } else if (mode === 'settings') {
    const port = await listen({ maxSettings: 2 }); const peer = await raw(port);
    peer.socket.write(frame(4, 0, 0, Buffer.concat([setting(1, 4096), setting(3, 10), setting(4, 65535)])));
    assert.strictEqual((await peer.wait(f => f.type === 7)).payload.readUInt32BE(4), 11);
  } else if (mode === 'deflate' || mode === 'header-block') {
    const port = await listen(mode === 'deflate' ? { maxDeflateDynamicTableSize: 0 } : { maxSendHeaderBlockLength: 1 }); let session;
    server.on('session', value => { session = value; }); server.on('stream', stream => { stream.respond({ 'x-indexable': 'persistent-value' }); stream.end('body'); });
    const peer = await raw(port); peer.socket.write(frame(1, 5, 1, requestHeaders()));
    if (mode === 'deflate') { await peer.wait(f => f.type === 0 && f.id === 1); assert.strictEqual(session.state.deflateDynamicTableSize, 0); }
    else assert.strictEqual((await peer.wait(f => f.type === 3 && f.id === 1)).payload.readUInt32BE(), 6);
  } else if (mode === 'reserved') {
    const port = await listen(); const pushed = [];
    server.on('stream', stream => { stream.pushStream({ ':path': '/one' }, (err, push) => { assert.ifError(err); pushed.push(push); push.on('error', () => {}); }); stream.pushStream({ ':path': '/two' }, (err, push) => { assert.ifError(err); pushed.push(push); push.on('error', () => {}); }); stream.respond(); stream.end('ok'); });
    const client = track(h2.connect('http://127.0.0.1:' + port, { maxReservedRemoteStreams: 1 })); const received = [];
    client.on('stream', stream => { received.push(stream); stream.on('error', () => {}); stream.resume(); });
    const request = client.request(), ended = event(request, 'end'); request.resume(); await ended;
    await new Promise((resolve, reject) => client.ping(error => error ? reject(error) : resolve()));
    assert.strictEqual(received.length, 1); assert.strictEqual(pushed.length, 2);
    pushed[0].respond(); pushed[0].end('push');
  } else if (mode === 'concurrency') {
    let accept; const accepted = new Promise(resolve => { accept = resolve; });
    server = net.createServer(socket => { sockets.add(socket); accept({ socket, wire: reader(socket, true) }); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const client = track(h2.connect('http://127.0.0.1:' + server.address().port, { peerMaxConcurrentStreams: 0 }));
    const request = client.request(); request.on('error', () => {}); const peer = await accepted;
    await peer.wire.wait(f => f.type === 4); await new Promise(resolve => setTimeout(resolve, 20));
    assert.strictEqual(peer.wire.frames.filter(f => f.type === 1).length, 0);
    peer.socket.write(frame(4, 0, 0, setting(3, 1))); await peer.wire.wait(f => f.type === 1 && f.id === 1);
  } else if (mode === 'extensions') {
    const port = await listen({ settings: { customSettings: { 42: 987 } } }, true);
    server.on('stream', stream => {
      stream.session.origin('https://example.test/path', new URL('https://other.test/'));
      stream.session.altsvc('h3=":443"; ma=60', 'https://example.test/path');
      stream.respond(); stream.end('ok');
    });
    const client = track(h2.connect('https://127.0.0.1:' + port, { rejectUnauthorized: false, remoteCustomSettings: [42] }));
    const settings = event(client, 'remoteSettings'), origins = event(client, 'origin'), alt = event(client, 'altsvc');
    const request = client.request(), ended = event(request, 'end'); request.resume();
    assert.strictEqual((await settings)[0].customSettings[42], 987);
    assert.deepStrictEqual((await origins)[0], ['https://example.test', 'https://other.test']);
    assert.deepStrictEqual(await alt, ['h3=":443"; ma=60', 'https://example.test', 0]);
    assert.ok(client.originSet.includes('https://example.test')); await ended;
  } else throw new Error('Unknown mode: ' + mode);
  cleanup(); console.log('HTTP2 resource controls passed: ' + mode);
})().catch(error => { console.error(error); cleanup(); process.exitCode = 1; });
