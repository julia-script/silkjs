'use strict';
// Run with either runtime: cluster-transport-smoke.cjs udp|tls [rr|none].
// TLS credentials default to the adjacent Node reference checkout; override with
// CLUSTER_TLS_KEY and CLUSTER_TLS_CERT when running outside that checkout.
const assert = require('assert');
const cluster = require('cluster');
const dgram = require('dgram');
const mode = process.argv[2] || 'udp';
const policy = process.argv[3] || 'rr';
const deadline = setTimeout(() => { console.error('cluster transport timeout'); if (cluster.isPrimary) for (const w of Object.values(cluster.workers)) w.kill(); process.exit(1); }, 12000);
function credentials() {
  const fs = require('fs'), path = require('path');
  const base = path.resolve(__dirname, '../../node-reference/test/fixtures/keys');
  return { key: fs.readFileSync(process.env.CLUSTER_TLS_KEY || path.join(base, 'agent1-key.pem')), cert: fs.readFileSync(process.env.CLUSTER_TLS_CERT || path.join(base, 'agent1-cert.pem')) };
}
if (cluster.isWorker) {
  const sockets = [];
  process.on('message', async message => {
    const { id, action } = message;
    try {
      if (action === 'bind') {
        const socket = dgram.createSocket('udp4');
        sockets.push(socket);
        socket.on('message', (data, peer) => socket.send(`${process.pid}:${data}`, peer.port, peer.address));
        await new Promise((resolve, reject) => { socket.once('error', error => { socket.close(); reject(error); }); socket.bind({ address: '127.0.0.1', port: message.port || 0, exclusive: !!message.exclusive }, resolve); });
        process.send({ id, port: socket.address().port, pid: process.pid });
      } else if (action === 'close') {
        await new Promise(resolve => sockets[message.index].close(resolve));
        process.send({ id });
      } else if (action === 'tls') {
        const tls = require('tls');
        const context = tls.createSecureContext(credentials());
        let sni = false;
        const server = tls.createServer({ ...credentials(), SNICallback(name, done) { assert.strictEqual(name, 'cluster.example'); sni = true; done(null, context); } }, socket => {
          assert.strictEqual(sni, true);
          socket.end(`${process.pid}:${socket.getProtocol()}`);
        });
        sockets.push(server);
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        process.send({ id, port: server.address().port, pid: process.pid });
      } else if (action === 'disconnect') {
        clearTimeout(deadline);
        cluster.worker.disconnect();
      }
    } catch (error) { process.send({ id, error: error.code || error.message }); }
  });
  process.once('disconnect', () => clearTimeout(deadline));
} else {
  cluster.schedulingPolicy = policy === 'none' ? cluster.SCHED_NONE : cluster.SCHED_RR;
  let sequence = 0;
  const workers = [];
  function fork() { const worker = cluster.fork(); workers.push(worker); return worker; }
  function rpc(worker, action, args = {}) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const listener = message => { if (message.id !== id) return; worker.removeListener('message', listener); resolve(message); };
      worker.on('message', listener); worker.send({ id, action, ...args }, error => { if (error) reject(error); });
    });
  }
  function exit(worker, action) {
    return new Promise(resolve => { worker.once('exit', resolve); if (action === 'kill') worker.kill(); else worker.send({ action: 'disconnect' }); });
  }
  async function packet(port, text) {
    const socket = dgram.createSocket('udp4');
    try {
      return await new Promise((resolve, reject) => { socket.once('error', reject); socket.once('message', data => resolve(data.toString())); socket.send(text, port, '127.0.0.1'); });
    } finally { socket.close(); }
  }
  async function tlsRequest(port) {
    const tls = require('tls');
    return new Promise((resolve, reject) => {
      let body = '';
      const socket = tls.connect({ host: '127.0.0.1', port, servername: 'cluster.example', rejectUnauthorized: false });
      socket.on('error', reject); socket.on('data', data => { body += data; }); socket.on('end', () => resolve(body));
    });
  }
  (async () => {
    const a = fork(), b = fork();
    if (mode === 'udp') {
      const a0 = await rpc(a, 'bind'), b0 = await rpc(b, 'bind');
      assert.ok(a0.port > 0); assert.strictEqual(b0.port, a0.port);
      const a1 = await rpc(a, 'bind'), b1 = await rpc(b, 'bind');
      assert.ok(a1.port > 0); assert.notStrictEqual(a1.port, a0.port); assert.strictEqual(b1.port, a1.port);
      const ax = await rpc(a, 'bind', { exclusive: true }), bx = await rpc(b, 'bind', { exclusive: true });
      assert.ok(ax.port > 0); assert.ok(bx.port > 0); assert.notStrictEqual(ax.port, bx.port);
      const conflict = await rpc(b, 'bind', { exclusive: true, port: a0.port });
      assert.strictEqual(conflict.error, 'EADDRINUSE');
      await rpc(a, 'close', { index: 2 });
      const fixedA = await rpc(a, 'bind', { port: ax.port }), fixedB = await rpc(b, 'bind', { port: ax.port });
      assert.strictEqual(fixedA.port, ax.port); assert.strictEqual(fixedB.port, ax.port);
      // A second listen by the same worker is a different handle group, even
      // for a fixed port; absent reuseAddr it must report a real bind failure.
      assert.strictEqual((await rpc(a, 'bind', { port: ax.port })).error, 'EADDRINUSE');
      assert.strictEqual((await rpc(b, 'bind', { port: ax.port })).error, 'EADDRINUSE');
      // The primary must not consume packets, and closing one duplicate must
      // not shut down the same kernel socket in another worker.
      await rpc(a, 'close', { index: 0 });
      assert.strictEqual(await packet(a0.port, 'after-close'), `${b0.pid}:after-close`);
      await exit(a, 'kill');
      assert.strictEqual(await packet(b1.port, 'after-exit'), `${b1.pid}:after-exit`);
      assert.strictEqual(await packet(fixedB.port, 'fixed'), `${fixedB.pid}:fixed`);
      const c = fork(), c0 = await rpc(c, 'bind'), c1 = await rpc(c, 'bind');
      assert.strictEqual(c0.port, b0.port); assert.strictEqual(c1.port, b1.port);
      await rpc(b, 'close', { index: 2 });
      await exit(b, 'disconnect');
      assert.strictEqual(await packet(c1.port, 'after-disconnect'), `${c1.pid}:after-disconnect`);
      await exit(c, 'disconnect');
      const local = dgram.createSocket('udp4');
      await new Promise((resolve, reject) => { local.once('error', reject); local.bind({ address: '127.0.0.1', port: c1.port, exclusive: true }, resolve); });
      await new Promise(resolve => local.close(resolve));
      console.log(`cluster UDP ${policy}: ephemeral/fixed groups, exclusive collision, close/exit/disconnect ownership OK`);
    } else {
      const first = await rpc(a, 'tls'), second = await rpc(b, 'tls');
      assert.ok(first.port > 0); assert.strictEqual(first.port, second.port);
      const reply = await tlsRequest(first.port);
      assert.ok(reply === `${first.pid}:TLSv1.3` || reply === `${second.pid}:TLSv1.3`);
      await exit(a, 'disconnect');
      assert.strictEqual(await tlsRequest(second.port), `${second.pid}:TLSv1.3`);
      await exit(b, 'disconnect');
      console.log(`cluster TLS ${policy}: worker SNI/handshake and surviving listener OK`);
    }
    clearTimeout(deadline);
  })().catch(error => { console.error(error); clearTimeout(deadline); for (const worker of workers) if (!worker.isDead()) worker.kill(); process.exitCode = 1; });
}
