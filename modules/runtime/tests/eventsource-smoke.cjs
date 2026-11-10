'use strict';
// Run with Node 24 as the HTTP(S) peer:
// node tests/eventsource-smoke.cjs /path/to/runtime [another/runtime]
// Each client is launched with --experimental-eventsource; HTTPS verifies a
// temporary localhost CA through NODE_EXTRA_CA_CERTS (never disables verification).
const assert = require('assert');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function client() {
  const [mode, plain, secure, refused] = process.argv.slice(2);
  const sources = new Set();
  const watchdog = setTimeout(() => { console.error('EventSource client timeout:', mode); process.exit(1); }, 12000);
  const warnings = [];
  process.on('warning', warning => { if (warning.code === 'UNDICI-ES') warnings.push(warning); });
  function source(url, options) {
    const value = new EventSource(url, options);
    sources.add(value);
    return value;
  }
  async function failure(url, expectedState, expectedOpen = false) {
    const value = source(url, { node: { reconnectionTime: 10 } });
    let opened = false;
    value.onopen = () => { opened = true; };
    await new Promise((resolve, reject) => {
      value.onerror = event => {
        try {
          assert.strictEqual(value.readyState, expectedState);
          assert.strictEqual(event.constructor, Event);
          assert.strictEqual(event.target, value);
          assert.strictEqual(event.isTrusted, false);
          value.close();
          resolve();
        } catch (error) { reject(error); }
      };
    });
    assert.strictEqual(opened, expectedOpen);
    assert.strictEqual(value.readyState, EventSource.CLOSED);
  }
  async function stream(url) {
    const value = source(url, { withCredentials: true });
    const received = [];
    let opened = false;
    await new Promise((resolve, reject) => {
      value.onerror = () => reject(new Error('Unexpected streaming error'));
      value.onopen = event => {
        try {
          assert.strictEqual(value.readyState, EventSource.OPEN);
          assert.strictEqual(event.target, value);
          assert.strictEqual(event.isTrusted, false);
          assert.strictEqual(value.withCredentials, true);
          opened = true;
        } catch (error) { reject(error); }
      };
      function message(event) {
        try {
          assert.ok(opened);
          assert.ok(event instanceof MessageEvent);
          assert.strictEqual(event.origin, new URL(url).origin);
          assert.strictEqual(event.source, null);
          assert.deepStrictEqual(event.ports, []);
          assert.strictEqual(event.target, value);
          assert.strictEqual(event.currentTarget, value);
          assert.strictEqual(event.bubbles, false);
          assert.strictEqual(event.cancelable, false);
          assert.strictEqual(event.isTrusted, false);
          received.push([event.type, event.data, event.lastEventId]);
          if (event.data === 'final') { value.close(); resolve(); }
        } catch (error) { reject(error); }
      }
      value.addEventListener('custom', message);
      value.onmessage = message;
    });
    await delay(20);
    assert.deepStrictEqual(received, [
      ['custom', 'hé😀\nsecond', 'alpha'], ['message', '', 'alpha'],
      ['message', '\ufeffinner', ''], ['message', '\ufffd', ''], ['message', 'final', ''],
    ]);
    assert.strictEqual(value.readyState, EventSource.CLOSED);
  }
  try {
    if (mode === '--untrusted') {
      await failure(secure + '/stream', EventSource.CONNECTING);
      console.log('eventsource untrusted HTTPS: ok');
      return;
    }
    assert.strictEqual(typeof EventSource, 'function');
    assert.strictEqual(EventSource.length, 1);
    assert.throws(() => new EventSource(), TypeError);
    assert.throws(() => new EventSource(Symbol()), TypeError);
    assert.throws(() => new EventSource('/relative'), { name: 'SyntaxError' });
    assert.throws(() => new EventSource(plain, 1), TypeError);
    assert.throws(() => new EventSource(plain, { node: 1 }), TypeError);
    assert.throws(() => new EventSource(plain, { node: { reconnectionTime: Symbol() } }), TypeError);
    const branded = source(plain + '/unused', null);
    assert.ok(branded instanceof EventTarget);
    assert.strictEqual(Object.prototype.toString.call(branded), '[object EventTarget]');
    assert.strictEqual(branded.url, plain + '/unused');
    assert.strictEqual(branded.readyState, EventSource.CONNECTING);
    assert.strictEqual(branded.withCredentials, false);
    for (const name of ['url', 'readyState', 'withCredentials', 'onmessage', 'onopen', 'onerror']) {
      const descriptor = Object.getOwnPropertyDescriptor(EventSource.prototype, name);
      assert.strictEqual(descriptor.enumerable, true);
      assert.throws(() => descriptor.get.call({}), TypeError);
    }
    assert.throws(() => EventSource.prototype.close.call({}), TypeError);
    assert.throws(() => structuredClone(branded), { name: 'DataCloneError' });
    for (const [name, number] of [['CONNECTING', 0], ['OPEN', 1], ['CLOSED', 2]]) {
      assert.strictEqual(EventSource[name], number);
      assert.strictEqual(branded[name], number);
      assert.deepStrictEqual(Object.getOwnPropertyDescriptor(EventSource, name), {
        value: number, writable: false, enumerable: true, configurable: false,
      });
    }
    branded.close(); branded.close();
    const order = [];
    function first() { assert.strictEqual(this, branded); order.push('attribute'); }
    branded.onmessage = first;
    branded.addEventListener('message', () => order.push('listener'));
    branded.onmessage = first;
    branded.dispatchEvent(new MessageEvent('message'));
    assert.deepStrictEqual(order, ['listener', 'attribute']);
    const object = { handleEvent() { throw new Error('Attribute objects are not called'); } };
    branded.onmessage = object;
    assert.strictEqual(branded.onmessage, object);
    branded.dispatchEvent(new MessageEvent('message'));
    branded.onmessage = 1;
    assert.strictEqual(branded.onmessage, null);

    await stream(plain + '/stream');
    await stream(secure + '/stream');
    await require('./eventsource-dispatcher.cjs').exercise(plain, secure, refused);
    const token = String(Date.now()) + '-' + Math.random();
    const url = plain + '/reconnect-start?' + token;
    const value = source(url);
    const states = [];
    await new Promise((resolve, reject) => {
      value.onopen = () => states.push('open:' + value.readyState);
      value.onerror = () => {
        states.push('error:' + value.readyState);
        if (states.length > 8) reject(new Error('Too many reconnect attempts'));
      };
      value.onmessage = event => {
        try {
          assert.strictEqual(value.url, url);
          if (event.data === 'first') {
            assert.strictEqual(event.lastEventId, 'saved');
          } else if (event.data === 'second:saved') {
            assert.strictEqual(event.lastEventId, '');
          } else {
            assert.strictEqual(event.data, 'third:saved:redirects=1');
            assert.strictEqual(event.lastEventId, '');
            value.close(); resolve();
          }
        } catch (error) { reject(error); }
      };
    });
    assert.deepStrictEqual(states, ['open:1', 'error:0', 'open:1', 'error:0', 'open:1']);

    for (const route of ['/status/204', '/status/401', '/status/500', '/mime/missing', '/mime/wrong', '/mime/suffix']) {
      await failure(plain + route, EventSource.CLOSED);
    }
    await failure(plain + '/redirect-loop', EventSource.CONNECTING);
    await failure(refused, EventSource.CONNECTING);
    await failure('ftp://127.0.0.1/events', EventSource.CONNECTING);
    await failure(plain + '/empty', EventSource.CONNECTING, true);

    const broken = source(plain + '/broken');
    const brokenOrder = [];
    await new Promise((resolve, reject) => {
      broken.onopen = () => brokenOrder.push('open');
      broken.onmessage = event => brokenOrder.push(event.data);
      broken.onerror = () => {
        try { assert.strictEqual(broken.readyState, EventSource.CONNECTING); broken.close(); resolve(); }
        catch (error) { reject(error); }
      };
    });
    assert.deepStrictEqual(brokenOrder, ['open', 'before-abort']);

    const idle = source(plain + '/idle');
    const afterClose = [];
    idle.onerror = idle.onmessage = event => afterClose.push(['idle', event.type, idle.readyState]);
    await new Promise(resolve => { idle.onopen = () => { idle.close(); resolve(); }; });
    const pending = source(plain + '/pending');
    const pendingClosed = new Promise(resolve => {
      pending.onerror = event => { afterClose.push(['pending', event.type, pending.readyState]); resolve(); };
    });
    pending.onopen = pending.onmessage = event => afterClose.push(['pending', event.type, pending.readyState]);
    await delay(20);
    pending.close();
    const immediate = source(plain + '/unused');
    const immediateClosed = new Promise(resolve => {
      immediate.onerror = event => { afterClose.push(['immediate', event.type, immediate.readyState]); resolve(); };
    });
    immediate.onopen = immediate.onmessage = event => afterClose.push(['immediate', event.type, immediate.readyState]);
    immediate.close();
    await Promise.all([pendingClosed, immediateClosed]);
    assert.deepStrictEqual(afterClose.sort(), [['immediate', 'error', 2], ['pending', 'error', 2]]);
    assert.strictEqual(warnings.length, 1);
    assert.strictEqual(warnings[0].name, 'Warning');
    console.log('eventsource HTTP/HTTPS streaming, reconnect, lifecycle, failure and Web IDL contracts: ok');
  } finally {
    for (const value of sources) value.close();
    clearTimeout(watchdog);
  }
}

async function peers() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'silk-eventsource-'));
  const cert = path.join(directory, 'cert.pem');
  const key = path.join(directory, 'key.pem');
  const sockets = new Set();
  const servers = [];
  const sessions = new Map();
  const streamBytes = Buffer.concat([
    Buffer.from('\ufeff: comment\r\nid: alpha\r\nretry: 15\r\nevent: custom\r\nevent:\r\ndata: hé😀\r\ndata: second\r\n\r\nid: bad\0\rdata\r\rid:\ndata: \ufeffinner\n\ndata: '),
    Buffer.from([255]), Buffer.from('\n\ndata: final\n\ndata: forbidden\n\n'),
  ]);
  function handler(request, response) {
    if (require('./eventsource-dispatcher.cjs').serve(request, response)) return;
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/redirect-loop') { response.writeHead(302, { location: '/redirect-loop' }); response.end(); return; }
    if (url.pathname === '/reconnect-start') {
      const session = sessions.get(url.search) || { redirects: 0, count: 0 };
      session.redirects++;
      sessions.set(url.search, session);
      response.writeHead(301, { location: '/reconnect-final' + url.search }); response.end(); return;
    }
    if (url.pathname.startsWith('/status/')) { response.writeHead(Number(url.pathname.slice(8))); response.end(); return; }
    if (url.pathname.startsWith('/mime/')) {
      if (url.pathname === '/mime/wrong') response.setHeader('content-type', 'text/plain');
      if (url.pathname === '/mime/suffix') response.setHeader('content-type', 'text/event-streamx');
      response.end('data: should-not-arrive\n\n'); return;
    }
    if (url.pathname === '/pending' || url.pathname === '/unused') return;
    assert.strictEqual(request.headers.accept, 'text/event-stream');
    assert.strictEqual(request.headers['cache-control'], 'no-cache');
    response.writeHead(200, { 'content-type': 'Text/Event-Stream; charset=windows-1252' });
    response.flushHeaders();
    if (url.pathname === '/stream') {
      let offset = 0;
      // Every UTF-8 code point, BOM, field name, and CRLF can straddle reads.
      const timer = setInterval(() => {
        if (offset === streamBytes.length) { clearInterval(timer); return; }
        response.write(streamBytes.subarray(offset, ++offset));
      }, 1);
      response.on('close', () => clearInterval(timer));
    } else if (url.pathname === '/reconnect-final') {
      const session = sessions.get(url.search);
      session.count++;
      if (session.count === 1) response.end('retry: 10\nid: saved\ndata: first\n\nid: uncommitted\nretry: 10000\n');
      else if (session.count === 2) response.end('id:\ndata: second:' + request.headers['last-event-id'] + '\n\n');
      else response.write('data: third:' + request.headers['last-event-id'] + ':redirects=' + session.redirects + '\n\n');
    } else if (url.pathname === '/empty') response.end();
    else if (url.pathname === '/broken') {
      response.write('data: before-abort\n\n');
      const timer = setTimeout(() => response.destroy(), 30);
      response.on('close', () => clearTimeout(timer));
    } else if (url.pathname !== '/idle') response.end();
  }
  async function listen(server) {
    servers.push(server);
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return server.address().port;
  }
  try {
    execFileSync(process.env.OPENSSL || 'openssl', ['req', '-new', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-addext', 'basicConstraints=critical,CA:true'], { stdio: 'ignore' });
    const plain = 'http://127.0.0.1:' + await listen(require('http').createServer(handler));
    const secure = 'https://127.0.0.1:' + await listen(require('https').createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, handler));
    const reservation = require('net').createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const refused = 'http://127.0.0.1:' + reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    for (const runtime of process.argv.length > 2 ? process.argv.slice(2) : [process.execPath]) {
      for (const mode of ['--client', '--untrusted']) {
        const env = { ...process.env };
        delete env.NODE_TLS_REJECT_UNAUTHORIZED;
        delete env.NODE_EXTRA_CA_CERTS;
        if (mode === '--client') env.NODE_EXTRA_CA_CERTS = cert;
        await new Promise((resolve, reject) => {
          const child = spawn(runtime, ['--experimental-eventsource', __filename, mode, plain, secure, refused], { env, stdio: 'inherit' });
          const timer = setTimeout(() => { child.kill('SIGKILL'); }, 15000);
          child.once('error', error => { clearTimeout(timer); reject(error); });
          child.once('exit', (code, signal) => {
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new Error(runtime + ' ' + mode + ' exited with ' + (signal || code)));
          });
        });
      }
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
(process.argv[2] === '--client' || process.argv[2] === '--untrusted' ? client() : peers()).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
