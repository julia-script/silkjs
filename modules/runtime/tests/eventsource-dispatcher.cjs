'use strict';

const assert = require('assert');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// This is a real HTTP(S) transport implementing Undici's public Dispatcher
// contract. Every response comes from the peer server, including errors and
// compression; no response/body callback is synthesized for test data.
class HTTPDispatcher {
  constructor(options = {}) {
    this.options = options;
    this.requests = new Set();
    this.calls = [];
    this.aborts = [];
    this.pauses = 0;
    this.resumes = 0;
    this.eventSourceOptions = options.eventSourceOptions;
  }
  dispatch(options, handler) {
    this.calls.push(options);
    assert.strictEqual(options.maxRedirections, 0);
    let completed = false;
    const fail = error => {
      if (completed) return;
      completed = true;
      handler.onError(error);
    };
    const headers = { ...options.headers, 'x-real-dispatcher': 'yes' };
    const transport = String(options.origin).startsWith('https:') ? https : http;
    const request = transport.request(String(options.origin) + options.path, {
      method: options.method, headers, ca: this.options.ca, agent: false,
    });
    this.requests.add(request);
    request.on('close', () => this.requests.delete(request));
    request.on('error', fail);
    request.on('response', response => {
      response.pause();
      handler.onResponseStarted?.();
      response.on('error', fail);
      response.on('aborted', () => fail(new Error('Peer aborted response')));
      response.on('data', chunk => {
        if (handler.onData(chunk) === false) { this.pauses++; response.pause(); }
      });
      response.on('end', () => {
        if (completed) return;
        completed = true;
        handler.onComplete(response.rawTrailers);
      });
      const resume = () => { this.resumes++; response.resume(); };
      if (handler.onHeaders(response.statusCode, response.rawHeaders.map(value => Buffer.from(value, 'latin1')), resume, response.statusMessage) !== false) resume();
    });
    handler.onConnect(reason => { this.aborts.push(reason); request.destroy(reason); });
    (async () => {
      if (options.body) {
        for await (const chunk of options.body) {
          await new Promise((resolve, reject) => request.write(chunk, error => error ? reject(error) : resolve()));
        }
      }
      request.end();
    })().catch(fail);
    return true;
  }
  close() { for (const request of this.requests) request.destroy(); }
}

const reconnects = new Map();
function serve(request, response) {
  const url = new URL(request.url, 'http://localhost');
  if (!url.pathname.startsWith('/dispatcher/')) return false;
  assert.strictEqual(request.headers['x-real-dispatcher'], 'yes');
  if (url.pathname === '/dispatcher/redirect') {
    response.writeHead(302, { location: '/dispatcher/gzip' }); response.end();
  } else if (url.pathname === '/dispatcher/gzip') {
    response.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/plain' });
    const gzip = zlib.createGzip(); gzip.pipe(response);
    gzip.write('compressed '); gzip.end('through a real dispatcher');
  } else if (url.pathname === '/dispatcher/upload') {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ method: request.method, body: Buffer.concat(chunks).toString() }));
    });
  } else if (url.pathname === '/dispatcher/large') {
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    let remaining = 32;
    const chunk = Buffer.alloc(32768, 97);
    function send() {
      while (remaining > 0) { remaining--; if (!response.write(chunk)) { response.once('drain', send); return; } }
      response.end();
    }
    send();
  } else if (url.pathname === '/dispatcher/sse') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' });
    const gzip = zlib.createGzip(); gzip.pipe(response);
    gzip.write('data: hé😀\n'); gzip.flush(zlib.constants.Z_SYNC_FLUSH);
    const timer = setTimeout(() => { gzip.write('\n'); gzip.flush(zlib.constants.Z_SYNC_FLUSH); }, 10);
    response.on('close', () => { clearTimeout(timer); gzip.destroy(); });
  } else if (url.pathname === '/dispatcher/reconnect') {
    const count = (reconnects.get(url.search) || 0) + 1;
    reconnects.set(url.search, count);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (count === 1) response.end('id: abc\nretry: 5\ndata: first\n\n');
    else response.write('data: resumed:' + request.headers['last-event-id'] + '\n\n');
  } else if (url.pathname === '/dispatcher/limit') {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: exceeds-limit\n\n');
  } else if (url.pathname === '/dispatcher/broken') {
    response.writeHead(200); response.write('before-break');
    const timer = setTimeout(() => response.destroy(), 20);
    response.on('close', () => clearTimeout(timer));
  } else if (url.pathname === '/dispatcher/idle') {
    response.writeHead(200); response.flushHeaders();
  } else if (url.pathname !== '/dispatcher/pending') {
    response.writeHead(404); response.end();
  }
  return true;
}

async function exercise(plain, secure, refused) {
  const ca = require('fs').readFileSync(process.env.NODE_EXTRA_CA_CERTS);
  const dispatcher = new HTTPDispatcher({ ca });
  const limited = new HTTPDispatcher({ eventSourceOptions: { maxEventSize: 4 } });
  const sources = new Set();
  function source(url, options) { const value = new EventSource(url, options); sources.add(value); return value; }
  try {
    const redirected = await fetch(plain + '/dispatcher/redirect', { dispatcher });
    assert.strictEqual(redirected.redirected, true);
    assert.strictEqual(await redirected.text(), 'compressed through a real dispatcher');
    assert.deepStrictEqual(dispatcher.calls.slice(0, 2).map(call => call.path), ['/dispatcher/redirect', '/dispatcher/gzip']);
    const encrypted = await fetch(new Request(secure + '/dispatcher/gzip', { dispatcher }).clone());
    assert.strictEqual(await encrypted.text(), 'compressed through a real dispatcher');
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('streamed ')); controller.enqueue(new TextEncoder().encode('upload')); controller.close(); } });
    const uploaded = await fetch(plain + '/dispatcher/upload', { method: 'POST', body, duplex: 'half', dispatcher });
    assert.deepStrictEqual(await uploaded.json(), { method: 'POST', body: 'streamed upload' });
    const bytes = await fetch(plain + '/dispatcher/large', { dispatcher });
    await delay(30);
    assert.ok(dispatcher.pauses > 0, 'Unread response must pause the dispatcher');
    const payload = new Uint8Array(await bytes.arrayBuffer());
    assert.strictEqual(payload.length, 1048576);
    assert.ok(payload.every(value => value === 97));
    assert.ok(dispatcher.resumes > 0);

    for (const options of [{ dispatcher }, { dispatcher: {}, node: { dispatcher } }]) {
      const value = source(secure + '/dispatcher/sse', options);
      const before = dispatcher.aborts.length;
      await new Promise((resolve, reject) => {
        value.onerror = () => reject(new Error('Custom dispatcher SSE failed'));
        value.onmessage = event => {
          try { assert.strictEqual(event.data, 'hé😀'); assert.strictEqual(value.readyState, 1); value.close(); resolve(); }
          catch (error) { reject(error); }
        };
      });
      assert.ok(dispatcher.aborts.length > before, 'EventSource.close must abort the dispatcher');
    }
    const reconnect = source(plain + '/dispatcher/reconnect?' + Date.now(), { dispatcher });
    const events = [];
    await new Promise((resolve, reject) => {
      reconnect.onopen = () => events.push('open');
      reconnect.onerror = () => events.push('error:' + reconnect.readyState);
      reconnect.onmessage = event => {
        events.push(event.data);
        if (event.data !== 'first') {
          try { assert.strictEqual(event.data, 'resumed:abc'); reconnect.close(); resolve(); }
          catch (error) { reject(error); }
        }
      };
    });
    assert.deepStrictEqual(events, ['open', 'first', 'error:0', 'open', 'resumed:abc']);
    const limit = source(plain + '/dispatcher/limit', { dispatcher: limited });
    await new Promise((resolve, reject) => {
      limit.onmessage = () => reject(new Error('Dispatcher event size limit was ignored'));
      limit.onerror = () => { try { assert.strictEqual(limit.readyState, 2); resolve(); } catch (error) { reject(error); } };
    });
    assert.ok(limited.aborts.length > 0);

    const controller = new AbortController();
    const reason = new Error('cancel real dispatcher');
    const pending = fetch(plain + '/dispatcher/pending', { dispatcher, signal: controller.signal });
    await delay(10); controller.abort(reason);
    await assert.rejects(pending, error => error === reason);
    assert.ok(dispatcher.aborts.includes(reason));
    const idle = await fetch(plain + '/dispatcher/idle', { dispatcher });
    const cancellations = dispatcher.aborts.length;
    await idle.body.cancel();
    assert.ok(dispatcher.aborts.length > cancellations);
    await assert.rejects(fetch(refused, { dispatcher }), TypeError);
    const broken = await fetch(plain + '/dispatcher/broken', { dispatcher });
    await assert.rejects(broken.text(), TypeError);
    await assert.rejects(fetch(plain, { dispatcher: {} }), TypeError);
    assert.throws(() => fetch(plain, { dispatcher: null }), { code: 'ERR_ASSERTION' });
    assert.throws(() => fetch(new Request(plain, { dispatcher: null }).clone()), { code: 'ERR_ASSERTION' });
    assert.throws(() => new EventSource(plain, { dispatcher: null }), { code: 'ERR_ASSERTION' });
    const invalid = source(plain, { dispatcher: {} });
    await new Promise((resolve, reject) => {
      invalid.onerror = () => { try { assert.strictEqual(invalid.readyState, 0); invalid.close(); resolve(); } catch (error) { reject(error); } };
    });
    console.log('eventsource/fetch real custom dispatcher, streaming upload, TLS, redirects, codecs, limits, backpressure and cancellation: ok');
  } finally {
    for (const value of sources) value.close();
    dispatcher.close(); limited.close();
  }
}

module.exports = { serve, exercise };
