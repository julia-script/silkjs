'use strict';
// serve() from silk:serve: request parsing, bodies, framing, pipelining and errors over raw sockets.
const assert = require('assert');
const net = require('net');
const { serve } = require('silk:serve');
const handler = async (req, server) => {
  const url = new URL(req.url);
  switch (url.pathname) {
    case '/': return new Response('Hello');
    case '/echo': {
      const text = await req.text();
      return new Response(JSON.stringify({ method: req.method, url: req.url.replace(/:\d+\//, ':PORT/'), ct: req.headers.get('content-type'), x: req.headers.get('x-test'), body: text, used: req.bodyUsed }), { headers: { 'content-type': 'application/json' } });
    }
    case '/json': return Response.json({ a: 1, b: [true, null] }, { status: 201 });
    case '/headers': return new Response('h', { status: 404, statusText: 'Nope', headers: [['x-one', '1'], ['set-cookie', 'a=1'], ['set-cookie', 'b=2'], ['X-Upper', 'V']] });
    case '/async': await new Promise(r => setTimeout(r, 20)); return new Response('late');
    case '/stream': return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('ab')); c.enqueue(new TextEncoder().encode('cd')); c.close(); } }));
    case '/empty': return new Response(null, { status: 204 });
    case '/blob': return new Response(new Blob(['blob!'], { type: 'text/x-blob' }));
    case '/bytes': return new Response(new Uint8Array([104, 105]));
    case '/throw': throw new Error('boom');
    case '/notresponse': return 'nope';
    case '/len': return new Response('12345', { headers: { 'content-length': '5' } });
    case '/utf8': return new Response('héllo ☃');
    case '/redirect': return Response.redirect('http://example.com/x', 302);
    case '/form': { const f = await req.formData(); return new Response([...f.entries()].map(e => e.join('=')).join('&')); }
  }
  return new Response('missing ' + url.pathname + url.search, { status: 404 });
};
const server = serve({ port: 0, hostname: '127.0.0.1', fetch: handler, error(e) { return new Response('error: ' + e.message, { status: 500 }); } });
assert.ok(server.port > 0);
assert.strictEqual(server.url.href, `http://127.0.0.1:${server.port}/`);

function exchange(raw) {
  return new Promise(resolve => {
    const socket = net.connect(server.port, '127.0.0.1');
    let data = '';
    const timer = setTimeout(() => { socket.destroy(); resolve(data + '[timeout]'); }, 3000);
    socket.setEncoding('latin1');
    socket.on('data', d => { data += d; });
    socket.on('close', () => { clearTimeout(timer); resolve(data.replace(/^date: .*\r\n/gim, '')); });
    socket.on('error', () => {});
    socket.write(raw);
  });
}
const get = path => exchange(`GET ${path} HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n`);
const count = (text, part) => text.split(part).length - 1;

(async () => {
  let out = await get('/');
  assert.strictEqual(out, 'HTTP/1.1 200 OK\r\ncontent-type: text/plain;charset=UTF-8\r\ncontent-length: 5\r\nconnection: close\r\n\r\nHello');
  out = await exchange('HEAD / HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n');
  assert.match(out, /content-length: 5\r\n/); assert.ok(out.endsWith('\r\n\r\n'));
  out = await exchange('POST /echo?q=1 HTTP/1.1\r\nHost: t\r\nContent-Type: text/plain\r\nX-Test: yes\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello');
  assert.ok(out.endsWith('{"method":"POST","url":"http://t/echo?q=1","ct":"text/plain","x":"yes","body":"hello","used":true}'), out);
  out = await exchange('POST /echo HTTP/1.1\r\nHost: t\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n');
  assert.match(out, /"body":"abcde"/);
  out = await get('/json');
  assert.match(out, /^HTTP\/1.1 201 Created\r\n/); assert.ok(out.endsWith('{"a":1,"b":[true,null]}'));
  out = await get('/headers');
  assert.match(out, /^HTTP\/1.1 404 Nope\r\n/); assert.strictEqual(count(out, 'set-cookie: '), 2); assert.match(out, /x-upper: V\r\n/);
  assert.ok((await get('/async')).endsWith('late'));
  out = await get('/stream');
  assert.match(out, /transfer-encoding: chunked\r\n/); assert.ok(out.endsWith('\r\n\r\n2\r\nab\r\n2\r\ncd\r\n0\r\n\r\n'), out);
  out = await get('/empty');
  assert.match(out, /^HTTP\/1.1 204 No Content\r\n/); assert.doesNotMatch(out, /content-length/);
  out = await get('/blob');
  assert.match(out, /content-type: text\/x-blob\r\ncontent-length: 5\r\n/); assert.ok(out.endsWith('blob!'));
  assert.ok((await get('/bytes')).endsWith('\r\n\r\nhi'));
  out = await get('/throw');
  assert.match(out, /^HTTP\/1.1 500 /); assert.ok(out.endsWith('error: boom'));
  out = await get('/len');
  assert.strictEqual(count(out, 'content-length: '), 1);
  out = await get('/utf8');
  assert.match(out, /content-length: 10\r\n/); assert.ok(Buffer.from(out, 'latin1').toString().endsWith('héllo ☃'));
  assert.match(await get('/redirect'), /^HTTP\/1.1 302 Found\r\nlocation: http:\/\/example.com\/x\r\n/);
  assert.ok((await get('/nope?x=%20')).endsWith('missing /nope?x=%20'));
  // Responses go out in request order, even when an earlier one is late.
  out = await exchange('GET /async HTTP/1.1\r\nHost: t\r\n\r\nGET / HTTP/1.1\r\nHost: t\r\n\r\nGET /json HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n');
  assert.ok(out.indexOf('late') < out.indexOf('Hello') && out.indexOf('Hello') < out.indexOf('{"a":1'), out);
  assert.strictEqual(count(out, 'HTTP/1.1 '), 3);
  out = await exchange('GET / HTTP/1.0\r\nConnection: keep-alive\r\n\r\nGET /json HTTP/1.0\r\n\r\n');
  assert.strictEqual(count(out, 'HTTP/1.1 '), 2);
  assert.match(await exchange('GARBAGE\r\n\r\n'), /^HTTP\/1.1 400 Bad Request\r\n/);
  assert.ok((await exchange('POST /form HTTP/1.1\r\nHost: t\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 7\r\nConnection: close\r\n\r\na=1&b=2')).endsWith('a=1&b=2'));
  out = await exchange('POST /echo HTTP/1.1\r\nHost: t\r\nExpect: 100-continue\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
  assert.match(out, /^HTTP\/1.1 100 Continue\r\n\r\nHTTP\/1.1 200 OK\r\n/); assert.match(out, /"body":"ok"/);
  // fetch() as the client, over a kept-alive connection.
  const response = await fetch(server.url + 'echo', { method: 'POST', body: 'via fetch', headers: { 'x-test': 'f' } });
  assert.strictEqual(response.status, 200);
  assert.strictEqual((await response.json()).body, 'via fetch');
  assert.strictEqual(server.pendingRequests, 0);
  await server.stop(true);
  console.log('serve smoke ok');
})().catch(error => { console.error(error); process.exit(1); });
