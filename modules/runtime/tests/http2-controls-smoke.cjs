'use strict';
// Run with Node 24 or silkjsruntime: http2-controls-smoke.cjs
// modes: controls, cancel, settings-limit, goaway, exchange, tls, unknown-protocol.
// Uses real TCP/TLS peers and temporary OpenSSL-generated keys unless overridden.
const assert = require('assert');
const h2 = require('http2');
const mode = process.argv[2] || 'controls';
const sessions = new Set();
let server, client, fixtureDirectory;
const sessionErrors = [];
const deadline = setTimeout(() => { console.error('HTTP2 scenario timed out: ' + mode); cleanup(); process.exit(1); }, 5000);
function cleanup() {
  clearTimeout(deadline);
  if (client) client.destroy();
  for (const session of sessions) session.destroy();
  if (server) server.close();
  if (fixtureDirectory) { require('fs').rmSync(fixtureDirectory, { recursive: true, force: true }); fixtureDirectory = undefined; }
}
function event(target, name) { return new Promise((resolve, reject) => { target.once(name, (...args) => resolve(args)); if (name !== 'error') target.once('error', reject); }); }
function credentials() {
  const fs = require('fs'), path = require('path');
  if (process.env.HTTP2_TLS_KEY && process.env.HTTP2_TLS_CERT) return { key: fs.readFileSync(process.env.HTTP2_TLS_KEY), cert: fs.readFileSync(process.env.HTTP2_TLS_CERT) };
  fixtureDirectory = fs.mkdtempSync(path.join(require('os').tmpdir(), 'silk-http2-tls-'));
  const key = path.join(fixtureDirectory, 'key.pem'), cert = path.join(fixtureDirectory, 'cert.pem');
  const result = require('child_process').spawnSync(process.env.OPENSSL || 'openssl', ['req', '-new', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=localhost'], { encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.strictEqual(result.status, 0, result.stderr);
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}
(async () => {
  const secure = mode === 'tls' || mode === 'unknown-protocol';
  server = secure ? h2.createSecureServer(credentials()) : h2.createServer();
  server.on('session', session => { sessions.add(session); session.on('error', err => sessionErrors.push(err)); session.on('close', () => sessions.delete(session)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  if (mode === 'unknown-protocol') {
    client = require('tls').connect({ host: '127.0.0.1', port, rejectUnauthorized: false });
    let response = '';
    client.on('data', data => { response += data; });
    await event(client, 'end');
    assert.ok(response.startsWith('HTTP/1.0 403 Forbidden\r\n'));
    assert.ok(response.includes('Missing ALPN Protocol'));
  } else {
    client = h2.connect((secure ? 'https' : 'http') + '://127.0.0.1:' + port, { rejectUnauthorized: false, maxOutstandingSettings: mode === 'settings-limit' ? 1 : 10 });
    if (mode === 'settings-limit') {
      const failure = event(client, 'error');
      const closed = new Promise(resolve => client.once('close', resolve));
      const cancelled = new Promise(resolve => client.once('connect', () => client.settings({}, error => resolve(error))));
      assert.strictEqual((await cancelled).code, 'ERR_HTTP2_SETTINGS_CANCEL');
      assert.strictEqual((await failure)[0].code, 'ERR_HTTP2_MAX_PENDING_SETTINGS_ACK');
      await closed;
    } else if (mode === 'controls') {
      const early = new Promise(resolve => { assert.strictEqual(client.ping(Buffer.alloc(8), error => resolve(error)), undefined); });
      assert.strictEqual((await early).code, 'ERR_HTTP2_PING_CANCEL');
      if (client.connecting) await event(client, 'connect');
      if (client.pendingSettingsAck) await event(client, 'localSettings');
      const order = [];
      const ack = event(client, 'localSettings');
      client.once('localSettings', () => order.push('event'));
      client.settings({ initialWindowSize: 131072 }, (error, settings) => { assert.ifError(error); assert.strictEqual(settings.initialWindowSize, 131072); order.push('callback'); });
      await ack;
      assert.deepStrictEqual(order, ['callback', 'event']);
      const payload = Buffer.from('12345678');
      await new Promise((resolve, reject) => { assert.strictEqual(client.ping(payload, (error, duration, received) => { if (error) return reject(error); assert.ok(duration >= 0); assert.ok(received.equals(payload)); resolve(); }), true); });
      client.setLocalWindowSize(131072);
      assert.strictEqual(client.state.effectiveLocalWindowSize, 131072);
      assert.strictEqual(typeof client.state.effectiveRecvDataLength, 'number');
      client.setNextStreamID(9);
      const accepted = new Promise(resolve => server.once('stream', stream => { stream.respond(); stream.end('done'); resolve(stream.id); }));
      const request = client.request();
      request.priority({ parent: request.id, weight: 999 });
      request.resume();
      await event(request, 'end');
      assert.strictEqual(await accepted, 9);
    } else if (mode === 'cancel') {
      const accepted = new Promise(resolve => server.once('stream', stream => resolve(stream)));
      await event(client, 'connect');
      const request = client.request({ ':method': 'POST' });
      request.resume();
      const peer = await accepted;
      peer.resume();
      const peerClosed = event(peer, 'close');
      const localClosed = event(request, 'close');
      request.close(h2.constants.NGHTTP2_CANCEL);
      await localClosed;
      await peerClosed;
      assert.strictEqual(request.rstCode, h2.constants.NGHTTP2_CANCEL);
      assert.strictEqual(peer.rstCode, h2.constants.NGHTTP2_CANCEL);
    } else if (mode === 'goaway') {
      const remote = new Promise(resolve => server.once('session', resolve));
      await event(client, 'connect');
      const peer = await remote;
      const failure = event(client, 'error');
      const closed = new Promise(resolve => client.once('close', resolve));
      const notice = new Promise(resolve => client.once('goaway', (code, last, data) => { assert.strictEqual(client.goawayCode, code); assert.strictEqual(client.goawayLastStreamID, last); resolve([code, last, data.toString()]); }));
      peer.goaway(11, 0, Buffer.from('why'));
      assert.deepStrictEqual(await notice, [11, 0, 'why']);
      assert.strictEqual((await failure)[0].code, 'ERR_HTTP2_SESSION_ERROR');
      await closed;
    } else if (mode === 'exchange' || mode === 'tls') {
      const pushed = new Promise(resolve => client.once('stream', stream => { let body = ''; stream.on('data', data => { body += data; }); stream.on('end', () => resolve(body)); }));
      server.on('stream', stream => {
        stream.pushStream({ ':path': '/push' }, (error, push) => { assert.ifError(error); push.respond(); push.end('pushed'); });
        let size = 0;
        stream.on('data', data => { size += data.length; });
        stream.on('end', () => { stream.respond({ ':status': 201 }, { waitForTrailers: true }); stream.on('wantTrailers', () => stream.sendTrailers({ 'x-bytes': String(size) })); stream.end(Buffer.alloc(size, 42)); });
      });
      const request = client.request({ ':method': 'POST' });
      const body = [];
      let status, trailers;
      request.on('response', headers => { status = headers[':status']; });
      request.on('trailers', headers => { trailers = headers; });
      request.on('data', data => body.push(data));
      const ended = event(request, 'end');
      request.end(Buffer.alloc(150000, 42));
      await ended;
      assert.strictEqual(status, 201);
      assert.ok(Buffer.concat(body).equals(Buffer.alloc(150000, 42)));
      assert.strictEqual(trailers['x-bytes'], '150000');
      assert.strictEqual(await pushed, 'pushed');
      assert.strictEqual(client.alpnProtocol, secure ? 'h2' : 'h2c');
      const closed = event(client, 'close');
      const peerClosed = Promise.all([...sessions].map(session => event(session, 'close')));
      client.close();
      await closed;
      await peerClosed;
      assert.deepStrictEqual(sessionErrors, []);
    } else throw new Error('Unknown scenario: ' + mode);
  }
  cleanup();
  console.log('HTTP2 ' + mode + ': OK');
})().catch(error => { console.error(error); cleanup(); process.exitCode = 1; });
