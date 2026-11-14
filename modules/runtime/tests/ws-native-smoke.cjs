'use strict';
// An installed `ws` package gives internal/ws, whose frames net_native reads and writes.
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'silk-ws-'));
const pkg = path.join(root, 'node_modules', 'ws');
fs.mkdirSync(pkg, { recursive: true });
fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({
  name: 'ws', main: 'index.js', exports: { '.': { import: './wrapper.mjs', require: './index.js' }, './package.json': './package.json' },
}));
fs.writeFileSync(path.join(pkg, 'index.js'), "throw new Error('the package itself was loaded');\n");
fs.writeFileSync(path.join(pkg, 'wrapper.mjs'), "throw new Error('the package itself was loaded');\n");
fs.writeFileSync(path.join(root, 'esm.mjs'), "import WebSocket, { WebSocketServer, createWebSocketStream } from 'ws';\nexport default [WebSocket, WebSocketServer, createWebSocketStream];\n");
const WebSocket = createRequire(path.join(root, 'entry.js'))('ws');
const { WebSocketServer } = WebSocket;
assert.strictEqual(WebSocket.Server, WebSocketServer);
assert.strictEqual(WebSocket.OPEN, 1);

function once(emitter, event) { return new Promise(resolve => emitter.once(event, (...args) => resolve(args))); }
function listen(options) {
  return new Promise((resolve, reject) => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1', ...options }, () => resolve(server));
    server.on('error', reject);
  });
}
function mask(opcode, payload, { fin = true, masked = true } = {}) {
  const header = [(fin ? 0x80 : 0) | opcode];
  const size = payload.length;
  if (size < 126) header.push((masked ? 0x80 : 0) | size);
  else { header.push((masked ? 0x80 : 0) | 126, size >> 8, size & 255); }
  const key = masked ? [1, 2, 3, 4] : [];
  const body = Buffer.from(payload).map((byte, i) => masked ? byte ^ key[i & 3] : byte);
  return Buffer.concat([Buffer.from(header), Buffer.from(key), body]);
}
// A raw client: the handshake, then frames; resolves with the bytes the server sent after it.
function raw(port, frames) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = Buffer.alloc(0);
    socket.on('connect', () => {
      socket.write('GET /chat HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
      socket.write(Buffer.concat(frames));
    });
    socket.on('data', chunk => { data = Buffer.concat([data, chunk]); });
    socket.on('error', reject);
    socket.on('close', () => {
      const end = data.indexOf('\r\n\r\n');
      resolve({ head: data.subarray(0, end).toString(), frames: data.subarray(end + 4) });
    });
  });
}

(async () => {
  {
    const server = await listen({ path: '/chat' });
    const { port } = server.address();
    const serverMessages = [];
    let serverClose;
    let pings = 0;
    server.on('connection', (ws, req) => {
      assert.strictEqual(new URL(req.url, 'http://x').searchParams.get('name'), 'a');
      assert.strictEqual(ws.readyState, WebSocket.OPEN);
      ws.on('ping', data => { pings++; assert.strictEqual(data.toString(), 'p'); });
      // binaryType shapes binary messages only: text stays a Buffer, as in ws.
      ws.binaryType = 'arraybuffer';
      ws.on('message', (data, isBinary) => {
        assert(isBinary ? data instanceof ArrayBuffer : Buffer.isBuffer(data));
        if (isBinary) data = Buffer.from(data);
        serverMessages.push([data, isBinary]);
        if (!isBinary) ws.send(`echo: ${data}`);
        else ws.send(data);
      });
      ws.on('close', (code, reason) => { serverClose = [code, reason.toString()]; });
    });
    const client = new WebSocket(`ws://127.0.0.1:${port}/chat?name=a`);
    await once(client, 'open');
    const replies = [];
    client.on('message', (data, isBinary) => replies.push([isBinary ? data : data.toString(), isBinary]));
    const sent = new Promise(resolve => client.send('hello', resolve));
    assert.strictEqual(await sent, null);
    client.send(Buffer.from([1, 2, 3]));
    const big = 'x'.repeat(300000);
    client.send(big);
    client.send('frag-', { fin: false });
    client.send('ment', { fin: true });
    client.send('café 😀 \ud800!');
    const pong = once(client, 'pong');
    client.ping('p');
    assert.strictEqual((await pong)[0].toString(), 'p');
    while (replies.length < 5) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepStrictEqual(replies[0], ['echo: hello', false]);
    assert.deepStrictEqual([...replies[1][0]], [1, 2, 3]);
    assert.strictEqual(replies[1][1], true);
    assert.strictEqual(replies[2][0], 'echo: ' + big);
    assert.strictEqual(replies[3][0], 'echo: frag-ment');
    assert.strictEqual(replies[4][0], 'echo: café 😀 �!');
    assert.strictEqual(serverMessages.length, 5);
    assert.strictEqual(pings, 1);
    const closed = once(client, 'close');
    client.close(4000, 'bye');
    const [code, reason] = await closed;
    // The answering Close repeats the code (silk.http.websocket sends no reason with it).
    assert.strictEqual(code, 4000);
    assert.strictEqual(reason.toString(), '');
    assert.strictEqual(client.readyState, WebSocket.CLOSED);
    while (!serverClose) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepStrictEqual(serverClose, [4000, 'bye']);
    assert.strictEqual(server.clients.size, 0);
    // A send after the close fails through its callback.
    const late = await new Promise(resolve => client.send('late', resolve));
    assert.match(late.message, /not open/);

    // Rule breaks: an unmasked frame, invalid UTF-8, a reserved opcode.
    const errors = [];
    server.removeAllListeners('connection');
    server.on('connection', ws => ws.on('error', error => errors.push(error.code)));
    const unmasked = await raw(port, [mask(1, 'hi', { masked: false })]);
    assert.match(unmasked.head, /^HTTP\/1.1 101 Switching Protocols/);
    assert.match(unmasked.head, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/);
    assert.deepStrictEqual([...unmasked.frames], [0x88, 2, 0x03, 0xea]);
    const utf8 = await raw(port, [mask(1, [0xc3, 0x28])]);
    assert.deepStrictEqual([...utf8.frames], [0x88, 2, 0x03, 0xef]);
    // A peer Close is answered with the same code.
    const peerClose = await raw(port, [mask(1, 'm'), mask(8, [0x0f, 0xa0])]);
    assert.deepStrictEqual([...peerClose.frames], [0x88, 2, 0x0f, 0xa0]);
    assert.deepStrictEqual(errors, ['WS_ERR_INVALID_FRAME', 'WS_ERR_INVALID_UTF8']);

    // A handshake without a key is refused.
    const refused = await new Promise(resolve => {
      const socket = net.connect(port, '127.0.0.1', () => socket.write('GET /chat HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'));
      let text = '';
      socket.on('data', chunk => { text += chunk; });
      socket.on('close', () => resolve(text));
    });
    assert.match(refused, /^HTTP\/1.1 400 Bad Request/);
    await new Promise(resolve => server.close(resolve));
  }
  {
    const server = await listen({ maxPayload: 10 });
    const failed = new Promise(resolve => server.on('connection', ws => ws.on('error', error => resolve(error.code))));
    const tooLarge = await raw(server.address().port, [mask(2, Buffer.alloc(20))]);
    assert.strictEqual(await failed, 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH');
    assert.deepStrictEqual([...tooLarge.frames], [0x88, 2, 0x03, 0xf1]);
    await new Promise(resolve => server.close(resolve));
  }
  {
    // Fan-out from one callback, as a chat server does: every client gets every message in order.
    const server = await listen();
    const peers = [];
    server.on('connection', ws => {
      peers.push(ws);
      ws.on('message', message => { for (const peer of peers) peer.send(`m:${message}`); });
    });
    const clients = [];
    for (let i = 0; i < 4; i++) {
      const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
      client.received = [];
      client.on('message', data => client.received.push(data.toString()));
      await once(client, 'open');
      clients.push(client);
    }
    while (peers.length < 4) await new Promise(resolve => setTimeout(resolve, 5));
    for (let n = 0; n < 50; n++) clients[n % 4].send(String(n));
    while (clients.some(client => client.received.length < 50)) await new Promise(resolve => setTimeout(resolve, 5));
    for (const client of clients) {
      assert.deepStrictEqual(client.received.slice().sort(), Array.from({ length: 50 }, (_, n) => `m:${n}`).sort());
      client.terminate();
    }
    await new Promise(resolve => server.close(resolve));
  }
  {
    const [ESMWebSocket, ESMServer, stream] = (await import(path.join(root, 'esm.mjs'))).default;
    assert.strictEqual(ESMWebSocket, WebSocket);
    assert.strictEqual(ESMServer, WebSocketServer);
    assert.strictEqual(typeof stream, 'function');
  }
  fs.rmSync(root, { recursive: true, force: true });
  console.log('ws native smoke passed');
})().catch(error => { console.error(error); process.exit(1); });
