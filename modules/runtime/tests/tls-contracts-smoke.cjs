'use strict';
// Node 24 / silkjsruntime differential probes. Requires openssl on PATH (or OPENSSL).
// Every certificate, revocation list and DH parameter is generated in a temporary directory.
const assert = require('assert');
const tls = require('tls');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const mode = process.argv[2] || 'all';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'silk-tls-contracts-'));
const sockets = new Set(), servers = new Set();
const timer = setTimeout(() => { console.error('TLS contract timeout:', mode); process.exit(1); }, 25000);
function openssl(...args) {
  const result = spawnSync(process.env.OPENSSL || 'openssl', args, { cwd: directory, encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.strictEqual(result.status, 0, result.stderr);
}
function read(name) { return fs.readFileSync(path.join(directory, name)); }
function write(name, data) { fs.writeFileSync(path.join(directory, name), data); }
function event(target, name) {
  return new Promise((resolve, reject) => {
    const failed = err => { target.removeListener(name, done); reject(err); };
    const done = (...args) => { target.removeListener('error', failed); resolve(args); };
    target.once(name, done); if (name !== 'error') target.once('error', failed);
  });
}
function fixtures() {
  write('index', ''); write('serial', '1000\n'); write('crlnumber', '1000\n');
  write('ca.cnf', '[ca]\ndefault_ca=local\n[local]\ndatabase=index\nserial=serial\ncrlnumber=crlnumber\nnew_certs_dir=.\ncertificate=ca.pem\nprivate_key=ca.key\ndefault_md=sha256\ndefault_days=2\ndefault_crl_days=2\npolicy=policy\nx509_extensions=leaf\n[policy]\ncommonName=supplied\n[leaf]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth,clientAuth\nsubjectAltName=DNS:localhost\n');
  openssl('req', '-new', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=TLS Contract CA', '-addext', 'basicConstraints=critical,CA:true', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
  openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=localhost');
  openssl('ca', '-batch', '-config', 'ca.cnf', '-in', 'leaf.csr', '-out', 'leaf.pem', '-notext');
  openssl('ca', '-gencrl', '-config', 'ca.cnf', '-out', 'clean.crl');
  openssl('ca', '-config', 'ca.cnf', '-revoke', 'leaf.pem');
  openssl('ca', '-gencrl', '-config', 'ca.cnf', '-out', 'revoked.crl');
  openssl('genpkey', '-genparam', '-algorithm', 'DH', '-pkeyopt', 'group:ffdhe2048', '-out', 'dh.pem');
  return { key: read('leaf.key'), cert: Buffer.concat([read('leaf.pem'), read('ca.pem')]) };
}
let credentials;
async function listen(options = {}, listener) {
  const server = tls.createServer({ ...credentials, ...options }, socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    if (listener) listener(socket);
  });
  servers.add(server);
  server.on('tlsClientError', err => { server.lastHandshakeError = err; });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server;
}
function connect(server, options = {}) {
  const socket = tls.connect({ host: '127.0.0.1', port: server.address().port, servername: 'localhost', ca: read('ca.pem'), ...options });
  sockets.add(socket); socket.on('close', () => sockets.delete(socket));
  return socket;
}
async function pair(options = {}, clientOptions = {}) {
  const server = await listen(options);
  const accepted = event(server, 'secureConnection');
  const client = connect(server, clientOptions);
  await event(client, 'secureConnect');
  const [peer] = await accepted;
  return { server, client, peer };
}
async function stop(server, ...connections) {
  for (const socket of connections) socket.destroy();
  await new Promise(resolve => server.close(resolve)); servers.delete(server);
}
async function rejected(serverOptions, clientOptions) {
  const server = await listen(serverOptions);
  const socket = connect(server, clientOptions);
  const [failure] = await event(socket, 'error');
  await stop(server, socket);
  return failure;
}
async function scenario(name) {
  if (name === 'context') {
    for (const [options, code] of [[{ sigalgs: '' }, 'ERR_INVALID_ARG_VALUE'], [{ sigalgs: 1 }, 'ERR_INVALID_ARG_TYPE'], [{ crl: 'bad' }, 'ERR_CRYPTO_OPERATION_FAILED'], [{ ticketKeys: Buffer.alloc(47) }, 'ERR_INVALID_ARG_VALUE'], [{ ticketKeys: 'bad' }, 'ERR_INVALID_ARG_TYPE'], [{ sessionTimeout: -1 }, 'ERR_OUT_OF_RANGE'], [{ ecdhCurve: 1 }, 'ERR_INVALID_ARG_TYPE'], [{ secureOptions: 'bad' }, 'ERR_INVALID_ARG_TYPE']]) {
      assert.throws(() => tls.createSecureContext(options), { code });
    }
    assert.throws(() => tls.createSecureContext({ sigalgs: 'not-a-signature' }));
    tls.createSecureContext({ ticketKeys: new Uint8Array(48), dhparam: 'auto' });
    // Node 24 deliberately treats malformed DH PEM as absent; DHE must not work.
    tls.createSecureContext({ dhparam: 'invalid' });
  } else if (name === 'revoked') {
    const { server, client, peer } = await pair({}, { crl: read('clean.crl') });
    assert.strictEqual(client.authorized, true); await stop(server, client, peer);
    const failure = await rejected({}, { crl: [read('revoked.crl')] });
    assert.strictEqual(failure.code, 'CERT_REVOKED');
  } else if (name === 'signatures') {
    const sigalgs = 'rsa_pss_rsae_sha256';
    const { server, client, peer } = await pair({ sigalgs, maxVersion: 'TLSv1.2' }, { sigalgs, maxVersion: 'TLSv1.2' });
    assert.ok(peer.getSharedSigalgs().includes('RSA-PSS+SHA256'));
    await stop(server, client, peer);
    await rejected({ sigalgs: 'rsa_pss_rsae_sha256' }, { sigalgs: 'ecdsa_secp256r1_sha256' });
  } else if (name === 'versions') {
    const { server, client, peer } = await pair({ maxVersion: 'TLSv1.2' }, { maxVersion: 'TLSv1.2' });
    assert.strictEqual(client.getProtocol(), 'TLSv1.2'); await stop(server, client, peer);
    await rejected({ maxVersion: 'TLSv1.2' }, { minVersion: 'TLSv1.3' });
  } else if (name === 'dh') {
    const options = { maxVersion: 'TLSv1.2', ciphers: 'DHE-RSA-AES128-GCM-SHA256' };
    for (const dhparam of ['auto', read('dh.pem')]) {
      const { server, client, peer } = await pair({ ...options, dhparam }, options);
      assert.strictEqual(client.getCipher().name, options.ciphers);
      assert.strictEqual(client.getEphemeralKeyInfo().type, 'DH');
      assert.ok(client.getEphemeralKeyInfo().size >= 2048); await stop(server, client, peer);
    }
    await rejected({ ...options, dhparam: 'invalid' }, options);
  } else if (name === 'tickets') {
    const ticketKeys = Buffer.alloc(48, 37), options = { maxVersion: 'TLSv1.2', ticketKeys, sessionIdContext: 'ticket-contract' };
    let p = await pair(options, { maxVersion: 'TLSv1.2' });
    const session = p.client.getSession(); assert.ok(session.length); assert.strictEqual(p.client.isSessionReused(), false);
    await stop(p.server, p.client, p.peer);
    p = await pair(options, { maxVersion: 'TLSv1.2', session });
    assert.strictEqual(p.client.isSessionReused(), true); await stop(p.server, p.client, p.peer);
    p = await pair({ ...options, ticketKeys: Buffer.alloc(48, 38) }, { maxVersion: 'TLSv1.2', session });
    assert.strictEqual(p.client.isSessionReused(), false); await stop(p.server, p.client, p.peer);
  } else if (name === 'info') {
    const { server, client, peer } = await pair({ ecdhCurve: 'P-256' }, { ecdhCurve: 'P-256' });
    const x509 = client.getPeerX509Certificate(), local = peer.getX509Certificate();
    assert.ok(x509 instanceof require('crypto').X509Certificate);
    assert.ok(local.raw.equals(x509.raw)); assert.ok(x509.raw.equals(client.getPeerCertificate().raw));
    assert.ok(x509.issuerCertificate); assert.strictEqual(x509.issuerCertificate.subject, 'CN=TLS Contract CA');
    assert.deepStrictEqual(client.getEphemeralKeyInfo(), { type: 'ECDH', name: 'prime256v1', size: 256 });
    assert.strictEqual(peer.getEphemeralKeyInfo(), null);
    assert.ok(peer.getSharedSigalgs().length > 0);
    await stop(server, client, peer);
    assert.ok(x509.raw.length); assert.strictEqual(x509.checkHost('localhost'), 'localhost');
  } else if (name === 'renegotiate-server') {
    const { server, client, peer } = await pair({ maxVersion: 'TLSv1.2', ca: read('ca.pem'), requestCert: true }, { maxVersion: 'TLSv1.2', ...credentials });
    client.resume(); peer.resume();
    assert.strictEqual(peer.authorized, true);
    await new Promise((resolve, reject) => { assert.strictEqual(peer.renegotiate({ requestCert: true, rejectUnauthorized: true }, err => err ? reject(err) : resolve()), true); });
    assert.strictEqual(peer.authorized, true);
    assert.ok(peer.getPeerX509Certificate().raw.equals(client.getX509Certificate().raw));
    await stop(server, client, peer);
  } else if (name === 'renegotiate' || name === 'disable' || name === 'abuse') {
    const p = await pair({ maxVersion: 'TLSv1.2' }, { maxVersion: 'TLSv1.2' });
    p.client.resume(); p.peer.resume();
    if (name === 'renegotiate') {
      await new Promise((resolve, reject) => { assert.strictEqual(p.client.renegotiate({}, err => err ? reject(err) : resolve()), true); });
      const data = event(p.peer, 'data'); p.client.write('after-renegotiation');
      assert.strictEqual((await data)[0].toString(), 'after-renegotiation');
    } else {
      if (name === 'disable') p.peer.disableRenegotiation();
      const failure = event(p.peer, 'error');
      // Node emits the abuse/refusal error; the application owns disconnecting.
      p.peer.once('error', () => p.peer.destroy());
      const clientErrors = []; p.client.on('error', err => clientErrors.push(err));
      if (name === 'abuse') for (let i = 0; i < tls.CLIENT_RENEG_LIMIT; i++) {
        await new Promise((resolve, reject) => p.client.renegotiate({}, err => err ? reject(err) : resolve()));
      }
      assert.strictEqual(p.client.renegotiate({}), true);
      assert.strictEqual((await failure)[0].code, name === 'disable' ? 'ERR_TLS_RENEGOTIATION_DISABLED' : 'ERR_TLS_SESSION_ATTACK');
    }
    await stop(p.server, p.client, p.peer);
  } else if (name === 'tls13') {
    const { server, client, peer } = await pair({ minVersion: 'TLSv1.3' }, { minVersion: 'TLSv1.3' });
    await new Promise(resolve => { assert.strictEqual(client.renegotiate({}, err => { assert.ok(err); assert.strictEqual(err.code, 'ERR_SSL_WRONG_SSL_VERSION'); resolve(); }), false); });
    await stop(server, client, peer);
  } else if (name === 'trace') {
    const result = spawnSync(process.execPath, [__filename, 'trace-child'], { encoding: 'utf8', timeout: 20000 });
    if (result.error) throw result.error;
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /ClientHello/); assert.match(result.stderr, /ServerHello/);
  } else if (name === 'trace-child') {
    const { server, client, peer } = await pair({}, { enableTrace: true });
    peer.enableTrace(); const data = event(client, 'data'); peer.write('traced'); await data;
    await stop(server, client, peer);
  } else if (name === 'shutdown') {
    for (let i = 0; i < 12; i++) {
      const { server, client, peer } = await pair();
      const errors = []; client.on('error', err => errors.push(err)); peer.on('error', err => errors.push(err));
      const closed = Promise.all([event(client, 'close'), event(peer, 'close')]);
      client.resume(); peer.resume(); client.end('client-last'); peer.end('server-last');
      await closed; assert.deepStrictEqual(errors, []); await stop(server);
    }
  } else throw new Error('Unknown TLS contract scenario: ' + name);
  console.log('TLS contract passed:', name);
}
(async () => {
  credentials = fixtures();
  const scenarios = mode === 'all' ? ['context', 'revoked', 'signatures', 'versions', 'dh', 'tickets', 'info', 'renegotiate', 'renegotiate-server', 'disable', 'abuse', 'tls13', 'trace', 'shutdown'] : [mode];
  for (const name of scenarios) await scenario(name);
})().catch(err => { console.error(err); process.exitCode = 1; }).finally(() => {
  clearTimeout(timer);
  for (const socket of sockets) socket.destroy();
  for (const server of servers) server.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
