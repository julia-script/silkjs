'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

async function main() {
  for (const alias of ['rng', 'prng', 'pseudoRandomBytes']) assert.equal(crypto[alias], crypto.randomBytes);
  assert.equal(crypto.Mac, undefined);
  assert.equal(Object.getOwnPropertyDescriptor(crypto, 'fips').enumerable, false);
  assert.equal(crypto.fips, crypto.getFips());
  crypto.fips = crypto.getFips();
  const heap = crypto.secureHeapUsed();
  assert.equal(heap.total, 0);
  assert.equal(heap.used, 0);
  // Node's secureHeapUsed without --secure-heap: all zero.
  assert.equal(heap.utilization, 0);
  assert.equal(heap.min, 0);
  assert.throws(() => crypto.setEngine('silk-nonexistent-engine'), { code: 'ERR_CRYPTO_ENGINE_UNKNOWN' });
  assert.throws(() => crypto.setEngine(1), { code: 'ERR_INVALID_ARG_TYPE' });

  const gcm = crypto.getCipherInfo('aes-128-gcm');
  assert.deepEqual(gcm, { mode: 'gcm', name: 'id-aes128-gcm', nid: 895, blockSize: 1, ivLength: 12, keyLength: 16 });
  assert.equal(crypto.getCipherInfo(gcm.nid).name, gcm.name);
  assert.equal(crypto.getCipherInfo('aes-128-gcm', { keyLength: 15 }), undefined);
  assert.equal(crypto.getCipherInfo('aes-128-gcm', { ivLength: 0 }).ivLength, undefined);
  assert.equal(crypto.getCipherInfo('aes-128-ccm', { ivLength: 6 }), undefined);
  assert.equal(crypto.getCipherInfo('aes-128-ccm', { ivLength: 7 }).ivLength, 7);
  assert.equal(crypto.getCipherInfo('no-such-cipher'), undefined);
  assert.equal(crypto.getCipherInfo('chacha20').blockSize, undefined);
  assert.equal(crypto.getCipherInfo('aes-128-wrap', { keyLength: 16 }).mode, 'wrap');
  assert.equal(crypto.createHash('sha3-256').update('abc').digest('hex'), '3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532');
  const wrappingKey = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
  const wrappedPlaintext = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const wrap = crypto.createCipheriv('id-aes128-wrap', wrappingKey, Buffer.alloc(8, 0xa6));
  const wrapped = Buffer.concat([wrap.update(wrappedPlaintext), wrap.final()]);
  assert.equal(wrapped.toString('hex'), '1fa68b0a8112b447aef34bd8fb5a7b829d3e862371d2cfe5');
  const unwrap = crypto.createDecipheriv('id-aes128-wrap', wrappingKey, Buffer.alloc(8, 0xa6));
  assert.deepEqual(Buffer.concat([unwrap.update(wrapped), unwrap.final()]), wrappedPlaintext);
  for (const [algorithm, key, iv, tag] of [
    ['aes-128-ocb', wrappingKey, Buffer.from('bbaa99887766554433221100', 'hex'), '785407bfffc8ad9edcc5520ac9111ee6'],
    ['chacha20-poly1305', Buffer.alloc(32), Buffer.alloc(12), '4eb972c9a8fb3a1b382bb4d36f5ffad1'],
  ]) {
    const cipher = crypto.createCipheriv(algorithm, key, iv, { authTagLength: 16 });
    assert.equal(Buffer.concat([cipher.update(Buffer.alloc(0)), cipher.final()]).length, 0);
    assert.equal(cipher.getAuthTag().toString('hex'), tag);
    const decipher = crypto.createDecipheriv(algorithm, key, iv, { authTagLength: 16 });
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    assert.equal(Buffer.concat([decipher.update(Buffer.alloc(0)), decipher.final()]).length, 0);
    const corrupted = crypto.createDecipheriv(algorithm, key, iv, { authTagLength: 16 });
    corrupted.setAuthTag(Buffer.alloc(16));
    assert.throws(() => corrupted.final());
  }

  for (const p of [2n, 3n, 17n, 65537n]) assert.equal(crypto.checkPrimeSync(p), true);
  for (const p of [0n, 1n, 4n, 561n, 1105n]) assert.equal(crypto.checkPrimeSync(p), false);
  assert.equal(crypto.checkPrimeSync(new Uint8Array([1, 1]).subarray(1)), false);
  assert.throws(() => crypto.checkPrimeSync(-1n), { code: 'ERR_OUT_OF_RANGE' });
  assert.throws(() => crypto.generatePrimeSync(8, { add: 257n }), { code: 'ERR_OUT_OF_RANGE' });
  assert.throws(() => crypto.generatePrimeSync(8, { add: 12n, rem: 12n }), { code: 'ERR_OUT_OF_RANGE' });
  const prime = crypto.generatePrimeSync(64, { bigint: true, safe: true, add: 12n, rem: 11n });
  assert.equal(prime % 12n, 11n);
  assert.equal(crypto.checkPrimeSync(prime), true);
  assert.equal(crypto.checkPrimeSync((prime - 1n) / 2n), true);
  assert.equal(prime.toString(2).length, 64);
  assert.ok(crypto.generatePrimeSync(16) instanceof ArrayBuffer);
  const input = Buffer.from([17]);
  let returned = false;
  const checked = new Promise((resolve, reject) => crypto.checkPrime(input, (err, yes) => {
    try { assert.equal(returned, true); if (err) throw err; assert.equal(yes, true); resolve(); } catch (e) { reject(e); }
  }));
  input[0] = 18; returned = true;
  await checked;
  await new Promise((resolve, reject) => crypto.generatePrime(32, { bigint: true }, (err, value) => {
    try { if (err) throw err; assert.equal(typeof value, 'bigint'); assert.equal(crypto.checkPrimeSync(value), true); resolve(); } catch (e) { reject(e); }
  }));
  await new Promise((resolve, reject) => crypto.generatePrime(1, (err) => { try { assert.ok(err instanceof Error); resolve(); } catch (e) { reject(e); } }));

  const before = Date.now();
  const ids = Array.from({ length: 128 }, () => crypto.randomUUIDv7());
  const after = Date.now();
  for (const id of ids) {
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const timestamp = parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
    assert.ok(timestamp >= before && timestamp <= after);
  }
  assert.equal(new Set(ids).size, ids.length);
  await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(crypto.randomUUIDv7({ disableEntropyCache: true }) > ids[ids.length - 1]);
  assert.throws(() => crypto.randomUUIDv7({ disableEntropyCache: 1 }), { code: 'ERR_INVALID_ARG_TYPE' });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'silk-crypto-public-'));
  try {
    const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const message = Buffer.from('Silk RSA private-encrypt interoperability');
    const ciphertext = crypto.privateEncrypt(pair.privateKey, message);
    assert.deepEqual(crypto.publicDecrypt(pair.publicKey, ciphertext), message);
    fs.writeFileSync(path.join(dir, 'public.pem'), pair.publicKey.export({ format: 'pem', type: 'spki' }));
    fs.writeFileSync(path.join(dir, 'signature.bin'), ciphertext);
    const recovered = execFileSync(process.env.OPENSSL || '/opt/homebrew/opt/openssl@3/bin/openssl', ['pkeyutl', '-verifyrecover', '-pubin', '-inkey', path.join(dir, 'public.pem'), '-in', path.join(dir, 'signature.bin'), '-pkeyopt', 'rsa_padding_mode:pkcs1']);
    assert.deepEqual(recovered, message);
    assert.throws(() => crypto.privateEncrypt(pair.publicKey, message));
    assert.throws(() => crypto.publicDecrypt(pair.publicKey, Buffer.from([1, 2, 3])));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  console.log('crypto public smoke passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
