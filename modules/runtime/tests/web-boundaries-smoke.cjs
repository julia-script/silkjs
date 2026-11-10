'use strict';
// Run with Node 24 as the real HTTP/TLS peer: node tests/web-boundaries-smoke.cjs /path/to/runtime [...].
// Generates a short-lived localhost certificate using openssl; clients verify it via NODE_EXTRA_CA_CERTS.
const assert = require('assert');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
if (process.argv[2] === '--client') {
  const [http, https] = process.argv.slice(3);
  const rows = [];
  async function probe(name, fn) {
    let actual;
    try { actual = await fn(); }
    catch (error) { actual = { error: error.name, message: error.message }; }
    let expected;
    if (name.startsWith('protocol:') && name !== 'protocol:data' || ['redirect-stream307', 'redirect-data'].includes(name)) expected = { error: 'TypeError', message: 'fetch failed' };
    else if (['gzip-corrupt', 'wire-truncated'].includes(name)) expected = { error: 'TypeError', message: 'terminated' };
    else if (name === 'protocol:data') expected = 'hello';
    else if (name === 'br-truncated') expected = '';
    else if (name.startsWith('gzip') || name.startsWith('deflate') || name === 'br') expected = 'compressed';
    else if (name === 'abort-before') expected = true;
    else if (name.startsWith('abort-')) expected = ['Error', true];
    else if (name === 'redirect-empty') expected = 'POST:';
    else if (name === 'redirect-replay') expected = 'POST:replayed';
    else if (name === 'redirect-stream303') expected = 'GET:';
    else if (name === 'https') expected = 'secure-ok';
    else if (name.endsWith(':valid')) expected = [['open', 1], ['close', 3, 1000, true]];
    else if (name.endsWith(':abrupt')) expected = [['open', 1], ['error', 3], ['close', 3, 1006, false]];
    else expected = [['error', 3], ['close', 3, 1006, false]];
    rows.push(name);
    assert.deepStrictEqual(actual, expected, name);
    console.log('ok ' + name);
  }
  async function ws(url, protocols) { return new Promise(resolve => { const events = []; const socket = new WebSocket(url, protocols); const timer = setTimeout(() => { resolve(['timeout', ...events]); process.exitCode = 1; }, 2500); socket.onopen = () => events.push(['open', socket.readyState]); socket.onerror = () => events.push(['error', socket.readyState]); socket.onclose = e => { clearTimeout(timer); events.push(['close', socket.readyState, e.code, e.wasClean]); resolve(events); }; }); }
  (async () => {
    for (const url of ['file:///tmp/test', 'ftp://127.0.0.1/a', 'ws://127.0.0.1/a', 'data:,hello']) await probe('protocol:' + url.split(':')[0], async () => (await fetch(url)).text());
    await probe('gzip', async () => (await fetch(http + '/gzip')).text());
    await probe('gzip-truncated', async () => (await fetch(http + '/gzip-truncated')).text());
    for (const coding of ['deflate','br']) for (const suffix of ['', '-truncated']) await probe(coding + suffix, async () => (await fetch(http + '/' + coding + suffix)).text());
    await probe('gzip-corrupt', async () => (await fetch(http + '/gzip-corrupt')).text());
    await probe('wire-truncated', async () => (await fetch(http + '/wire-truncated')).text());
    await probe('abort-before', async () => { const c = new AbortController(); const reason = new Error('custom'); c.abort(reason); try { await fetch(http, { signal: c.signal }); } catch(e) { return e === reason; } });
    await probe('abort-body', async () => { const c = new AbortController(); const r = await fetch(http + '/slow', {signal: c.signal}); const reader = r.body.getReader(); await reader.read(); const reason = new Error('custom'); c.abort(reason); try { await reader.read(); } catch(e) { return [e.name, e === reason]; } });
    await probe('abort-unread', async () => { const c = new AbortController(); const r = await fetch(http + '/slow', {signal: c.signal}); const reason = new Error('custom'); c.abort(reason); try { await r.text(); } catch(e) { return [e.name, e === reason]; } });
    await probe('redirect-replay', async () => (await fetch(http + '/redirect307', {method:'POST', body:'replayed'})).text());
    await probe('redirect-empty', async () => (await fetch(http + '/redirect307', {method:'POST', body:''})).text());
    await probe('redirect-stream307', async () => (await fetch(http + '/redirect307', {method:'POST', duplex:'half', body:new ReadableStream({start(c) { c.enqueue(new Uint8Array([120])); c.close(); }})})).text());
    await probe('redirect-stream303', async () => (await fetch(http + '/redirect303', {method:'POST', duplex:'half', body:new ReadableStream({start(c) { c.enqueue(new Uint8Array([120])); c.close(); }})})).text());
    await probe('redirect-data', async () => (await fetch(http + '/redirect-data')).text());
    await probe('https', async () => (await fetch(https + '/ok')).text());
    for (const [name, url] of [['ws',http], ['wss',https]]) {
      for (const mode of ['valid','accept','duplicate','protocol','connection','abrupt']) await probe(name + ':' + mode, () => ws(url.replace('http','ws') + '/' + mode));
    }
    await probe('wss:untrusted', () => { require('tls').setDefaultCACertificates([]); return ws(https.replace('http','ws') + '/valid'); });
    console.log('web boundaries: ' + rows.length + ' actual-peer scenarios passed');
    process.exit(process.exitCode || 0);
  })().catch(e => { console.error(e); process.exit(1); });
} else {
  (async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'silk-web-'));
    const key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem');
    execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'], {stdio:'ignore'});
    const zlib = require('zlib');
    function serve(req, res) {
      req.resume();
      if (req.url.startsWith('/redirect')) { res.writeHead(req.url === '/redirect303' ? 303 : 307, {location:req.url === '/redirect-data' ? 'data:,redirected' : '/echo'}); res.end(); return; }
      if (req.url === '/echo') { let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => res.end(req.method + ':' + body)); return; }
      if (req.url === '/slow') { res.writeHead(200); res.write('first'); const timer = setTimeout(() => res.end('last'), 5000); res.on('close', () => clearTimeout(timer)); return; }
      if (req.url === '/wire-truncated') { res.writeHead(200, {'Content-Length':'20'}); res.flushHeaders(); res.write('short'); setTimeout(() => res.socket?.destroy(), 20); return; }
      for (const coding of ['deflate','br']) if (req.url.startsWith('/' + coding)) { let data = coding === 'br' ? zlib.brotliCompressSync(Buffer.from('compressed')) : zlib.deflateSync('compressed'); if (req.url.endsWith('-truncated')) data = data.subarray(0, data.length - 2); res.writeHead(200, {'Content-Encoding':coding}); res.end(data); return; }
      if (req.url.startsWith('/gzip')) { let data = zlib.gzipSync('compressed'); if (req.url === '/gzip-truncated') data = data.subarray(0, data.length - 8); if (req.url === '/gzip-corrupt') data = Buffer.from('invalid'); res.writeHead(200, {'Content-Encoding':'gzip'}); res.end(data); return; }
      res.end('secure-ok');
    }
    function upgrade(req, socket) {
      socket.on('error', () => {});
      const mode = req.url.slice(1);
      const accept = require('crypto').createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: ' + (mode === 'connection' ? 'upgrade, keep-alive' : 'Upgrade') + '\r\nSec-WebSocket-Accept: ' + (mode === 'accept' ? 'bad' : accept) + '\r\n' + (mode === 'duplicate' ? 'Sec-WebSocket-Accept: ' + accept + '\r\n' : '') + (mode === 'protocol' ? 'Sec-WebSocket-Protocol: unsolicited\r\n' : '') + '\r\n');
      if (['accept','duplicate','protocol'].includes(mode)) { socket.end(); return; }
      if (mode === 'abrupt') { socket.end(); return; }
      socket.write(Buffer.from([0x88, 2, 3, 232])); socket.once('data', () => socket.end());
    }
    const http = require('http').createServer(serve), https = require('https').createServer({key:fs.readFileSync(key), cert:fs.readFileSync(cert), ALPNProtocols:['http/1.1']}, serve);
    const sockets = new Set();
    for (const server of [http,https]) { server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); }); server.on('upgrade', upgrade); await new Promise(r => server.listen(0, '127.0.0.1', r)); }
    try {
      for (const runtime of process.argv.length > 2 ? process.argv.slice(2) : [process.execPath]) await new Promise(resolve => {
        const child = spawn(runtime, [__filename, '--client', 'http://127.0.0.1:' + http.address().port, 'https://127.0.0.1:' + https.address().port], {env:{...process.env,NODE_EXTRA_CA_CERTS:cert}, stdio:['ignore','pipe','pipe']});
        const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
        child.stdout.on('data', b => process.stdout.write(runtime + ' ' + b)); child.stderr.on('data', b => process.stderr.write(b)); child.on('error', error => { clearTimeout(timer); console.error(error); process.exitCode = 1; resolve(); }); child.on('exit', code => { clearTimeout(timer); if (code !== 0) process.exitCode = 1; resolve(); });
      });
    } finally { for (const s of sockets) s.destroy(); http.close(); https.close(); fs.rmSync(dir, {recursive:true, force:true}); }
  })().catch(e => { console.error(e); process.exitCode = 1; });
}
