'use strict';
// Node 24.22.2 reference: node tests/crypto-webcrypto-modern-smoke.cjs --fixtures
// Cross-runtime: run without flags, then --emit <file> and --consume <file> on the other runtime.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const s = crypto.webcrypto.subtle;
const hex = value => Buffer.from(value).toString('hex');
const bytes = value => Buffer.from(value, 'hex');
const message = Buffer.from('abc');
const context = Buffer.from('silk-node24');
const fixturesPath = path.join(__dirname, 'fixtures', 'webcrypto-modern.json');
const names = ['ML-DSA-44', 'ML-DSA-65', 'ML-DSA-87', 'ML-KEM-512', 'ML-KEM-768', 'ML-KEM-1024'];
async function fixture(name) {
  const kem = name.startsWith('ML-KEM');
  const seed = Buffer.alloc(kem ? 64 : 32, 7);
  const privateKey = await s.importKey('raw-seed', seed, name, true, kem ? ['decapsulateBits', 'decapsulateKey'] : ['sign']);
  const publicKey = await s.getPublicKey(privateKey, kem ? ['encapsulateBits', 'encapsulateKey'] : ['verify']);
  const value = { name, seed: hex(seed), publicKey: hex(await s.exportKey('raw-public', publicKey)), spki: hex(await s.exportKey('spki', publicKey)), pkcs8: hex(await s.exportKey('pkcs8', privateKey)) };
  if (kem) { const result = await s.encapsulateBits(name, publicKey); value.ciphertext = hex(result.ciphertext); value.sharedKey = hex(result.sharedKey); }
  else value.signature = hex(await s.sign({ name, context }, privateKey, message));
  return value;
}
async function checkFixture(f) {
  const kem = f.name.startsWith('ML-KEM');
  const privateKey = await s.importKey('raw-seed', bytes(f.seed), f.name, false, kem ? ['decapsulateBits', 'decapsulateKey'] : ['sign']);
  const publicKey = await s.getPublicKey(privateKey, kem ? ['encapsulateBits', 'encapsulateKey'] : ['verify']);
  assert.equal(hex(await s.exportKey('raw-public', publicKey)), f.publicKey);
  assert.equal(hex(await s.exportKey('spki', publicKey)), f.spki);
  assert.equal(publicKey.extractable, true);
  await assert.rejects(s.exportKey('pkcs8', privateKey), { name: 'InvalidAccessError' });
  const imported = await s.importKey('spki', bytes(f.spki), f.name, true, publicKey.usages);
  const importedPrivate = await s.importKey('pkcs8', bytes(f.pkcs8), f.name, true, privateKey.usages);
  assert.equal(hex(await s.exportKey('raw-seed', importedPrivate)), f.seed);
  if (kem) {
    assert.equal(hex(await s.decapsulateBits(f.name, privateKey, bytes(f.ciphertext))), f.sharedKey);
    const result = await s.encapsulateBits(f.name, imported);
    assert.equal(hex(await s.decapsulateBits(f.name, privateKey, result.ciphertext)), hex(result.sharedKey));
    const keyed = await s.encapsulateKey(f.name, imported, 'AES-GCM', true, ['encrypt']);
    const recovered = await s.decapsulateKey(f.name, privateKey, keyed.ciphertext, 'AES-GCM', true, ['decrypt']);
    assert.equal(hex(await s.exportKey('raw-secret', keyed.sharedKey)), hex(await s.exportKey('raw-secret', recovered)));
    await assert.rejects(s.decapsulateBits(f.name, privateKey, new Uint8Array(1)), { name: 'OperationError' });
    await assert.rejects(s.encapsulateBits(f.name, privateKey), { name: 'InvalidAccessError' });
  } else {
    assert.equal(await s.verify({ name: f.name, context }, imported, bytes(f.signature), message), true);
    assert.equal(await s.verify({ name: f.name, context: Buffer.from('wrong') }, imported, bytes(f.signature), message), false);
    const signature = await s.sign({ name: f.name, context }, privateKey, message);
    assert.equal(await s.verify({ name: f.name, context }, publicKey, signature, message), true);
    assert.equal(await s.verify({ name: f.name, context }, publicKey, signature, Buffer.from('bad')), false);
    await assert.rejects(s.sign(f.name, publicKey, message), { name: 'InvalidAccessError' });
  }
  const converted = crypto.KeyObject.from(privateKey).toCryptoKey(f.name, false, privateKey.usages);
  assert.equal(converted.algorithm.name, f.name);
  assert.equal(converted.extractable, false);
  assert.deepEqual(converted.usages, privateKey.usages);
  assert.throws(() => crypto.KeyObject.from(privateKey).toCryptoKey(f.name, true, ['encrypt']), { name: 'SyntaxError' });
}
async function main() {
  if (process.argv[2] === '--fixtures' || process.argv[2] === '--emit') {
    const values = [];
    for (const name of names) values.push(await fixture(name));
    const output = process.argv[2] === '--fixtures' ? fixturesPath : process.argv[3];
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify({ reference: process.version, values }, null, 2) + '\n');
    console.log('webcrypto interoperability fixtures written');
    return;
  }
  const reference = JSON.parse(fs.readFileSync(process.argv[2] === '--consume' ? process.argv[3] : fixturesPath, 'utf8'));
  for (const value of reference.values) await checkFixture(value);
  for (const name of ['ML-DSA-44', 'ML-KEM-512']) {
    const kem = name.startsWith('ML-KEM'), pair = await s.generateKey(name, false, kem ? ['encapsulateBits', 'decapsulateBits'] : ['sign', 'verify']);
    assert.equal(pair.privateKey.extractable, false);
    assert.equal(pair.publicKey.extractable, true);
    if (kem) { const result = await s.encapsulateBits(name, pair.publicKey); assert.equal(hex(await s.decapsulateBits(name, pair.privateKey, result.ciphertext)), hex(result.sharedKey)); }
    else assert.equal(await s.verify(name, pair.publicKey, await s.sign(name, pair.privateKey, message), message), true);
  }
  const vectors = {
    'SHA3-256': '3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532',
    'SHA3-384': 'ec01498288516fc926459f58e2c6ad8df9b473cb0fc08c2596da7cf0e49be4b298d88cea927ac7f539f1edf228376d25',
    'SHA3-512': 'b751850b1a57168a5693cd924b6b096e08f621827444f70d884f5d0240d2712e10e116e9192af3c91a7ec57647e3934057340b4cf408d5a56592f8274eec53f0',
    cSHAKE128: 'd7a9b8839577422dbe3ef0bdd0cc835090552f62a53d4f354b6ba618c6c22b2b',
    cSHAKE256: '5582a53550e5a311b65d012336439a011df1185437766283adb2bc7d73ad0d80',
  };
  for (const name of Object.keys(vectors)) assert.equal(hex(await s.digest(name.startsWith('cSHAKE') ? { name, outputLength: 256, customization: Buffer.from('Email Signature') } : name, message)), vectors[name]);
  await assert.rejects(s.generateKey({ name: 'HMAC', hash: 'SHA3-256' }, true, ['sign']), { name: 'NotSupportedError' });
  const sha3Hmac = await s.generateKey({ name: 'HMAC', hash: 'SHA3-256', length: 256 }, true, ['sign', 'verify']);
  assert.equal(Object.hasOwn(await s.exportKey('jwk', sha3Hmac), 'alg'), false);
  assert.equal(await s.verify('HMAC', sha3Hmac, await s.sign('HMAC', sha3Hmac, message), message), true);
  for (const [name, expected, odd] of [['KMAC128', '8793ba829fb0fc632bacca5b9e8f663a9ab8759c4c566f0d11d84b50c0fd5fe5', '4a80'], ['KMAC256', '8f560136ade62633cbdee5468e22269f145c3d844813e57e5fceaab99abd43db', '1980']]) {
    const key = await s.importKey('raw-secret', Buffer.alloc(32, 7), name, false, ['sign', 'verify']);
    const alg = { name, outputLength: 256, customization: Buffer.from('test') };
    const signature = await s.sign(alg, key, message);
    assert.equal(hex(signature), expected);
    assert.equal(await s.verify(alg, key, signature, message), true);
    const input = Buffer.from(message), custom = Buffer.from('test'), pending = s.sign({ name, outputLength: 256, customization: custom }, key, input);
    input.fill(0); custom.fill(0);
    assert.equal(hex(await pending), expected);
    assert.equal(hex(await s.sign({ ...alg, outputLength: 9 }, key, message)), odd);
  }
  for (const [name, expected] of [['Argon2d', 'fb01125e708a166563559445402e7307ad53c8b6bb76dc3c6f611245cc2ddea7'], ['Argon2i', 'e154f779bab74eda8e4b96489ff38b595652419a30c1614ffbbef22763604e08'], ['Argon2id', '31111cc053ba0a799c0884148fd7ec9dc3631f3e8cf476cca9521d4ccc5136e8']]) {
    const key = await s.importKey('raw-secret', Buffer.from('password'), name, false, ['deriveBits', 'deriveKey']);
    const alg = { name, nonce: Buffer.from('somesalt'), parallelism: 1, memory: 32, passes: 2 };
    assert.equal(hex(await s.deriveBits(alg, key, 256)), expected);
    const derived = await s.deriveKey(alg, key, { name: 'AES-GCM', length: 256 }, true, ['encrypt']);
    assert.equal(hex(await s.exportKey('raw-secret', derived)), expected);
    await assert.rejects(s.deriveBits({ ...alg, memory: 1 }, key, 256), { name: 'OperationError' });
    await assert.rejects(s.importKey('raw-secret', message, name, true, ['deriveBits']), { name: 'SyntaxError' });
  }
  for (const [name, expected] of [['AES-OCB', 'e00a8a515b7179d424d0bc391edce2fd187126'], ['ChaCha20-Poly1305', '8ac42e11f1d5644b134c5ae241633488927b74']]) {
    const key = await s.importKey('raw-secret', Buffer.alloc(32, 7), name, true, ['encrypt', 'decrypt']);
    const alg = { name, iv: Buffer.alloc(12, 3), additionalData: Buffer.from('aad') };
    const ciphertext = await s.encrypt(alg, key, message);
    assert.equal(hex(ciphertext), expected);
    assert.equal(hex(await s.decrypt(alg, key, ciphertext)), hex(message));
    const corrupt = Buffer.from(ciphertext); corrupt[corrupt.length - 1] ^= 1;
    await assert.rejects(s.decrypt(alg, key, corrupt), { name: 'OperationError' });
    await assert.rejects(s.encrypt({ ...alg, tagLength: 32 }, key, message), { name: 'OperationError' });
  }
  const wrappingKey = await s.importKey('raw', bytes('000102030405060708090a0b0c0d0e0f'), 'AES-KW', true, ['wrapKey', 'unwrapKey']);
  const wrappedKey = await s.importKey('raw', bytes('00112233445566778899aabbccddeeff'), 'AES-GCM', true, ['encrypt']);
  const wrapped = await s.wrapKey('raw', wrappedKey, wrappingKey, 'AES-KW');
  assert.equal(hex(wrapped), '1fa68b0a8112b447aef34bd8fb5a7b829d3e862371d2cfe5');
  const unwrapped = await s.unwrapKey('raw', wrapped, wrappingKey, 'AES-KW', 'AES-GCM', true, ['encrypt']);
  assert.equal(hex(await s.exportKey('raw', unwrapped)), '00112233445566778899aabbccddeeff');
  await assert.rejects(s.encrypt('AES-KW', wrappingKey, message), { name: 'NotSupportedError' });
  const supports = s.constructor.supports.bind(s.constructor);
  assert.equal(supports('digest', 'SHA3-256'), true);
  assert.equal(supports('digest', { name: 'cSHAKE128', outputLength: 256 }), true);
  assert.equal(supports('digest', 'cSHAKE128'), false);
  assert.equal(supports('generateKey', { name: 'AES-OCB', length: 7 }), false);
  assert.equal(supports('encrypt', 'AES-KW'), false);
  assert.equal(supports('encapsulateKey', 'ML-KEM-512', 'AES-GCM'), true);
  assert.equal(supports('encapsulateKey', 'ML-KEM-512', { name: 'HMAC', hash: 'SHA-256', length: 128 }), false);
  assert.throws(() => s.constructor.supports.call({}, 'digest', 'SHA-256'), { code: 'ERR_INVALID_THIS' });
  assert.throws(() => crypto.KeyObject.prototype.toCryptoKey.call({}, 'AES-GCM', true, ['encrypt']), { code: 'ERR_INVALID_THIS' });
  await assert.rejects(s.digest.call({}, 'SHA-256', message), { code: 'ERR_INVALID_THIS' });
  const detached = new DataView(new ArrayBuffer(3)); structuredClone(detached.buffer, { transfer: [detached.buffer] });
  await assert.rejects(s.digest('SHA-256', detached), { name: 'TypeError' });
  for (const typed of [false, true]) {
    const buffer = new ArrayBuffer(3), input = typed ? new Uint8Array(buffer) : buffer;
    structuredClone(buffer, { transfer: [buffer] });
    assert.equal(hex(await s.digest('SHA-256', input)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  }
  const protectedKey = await s.importKey('raw-secret', Buffer.alloc(32, 7), 'KMAC128', false, ['sign']);
  const cloned = structuredClone(protectedKey);
  assert.equal(cloned.extractable, false);
  assert.deepEqual(cloned.usages, ['sign']);
  assert.equal(hex(await s.sign({ name: 'KMAC128', outputLength: 256, customization: Buffer.from('test') }, cloned, message)), '8793ba829fb0fc632bacca5b9e8f663a9ab8759c4c566f0d11d84b50c0fd5fe5');
  console.log('crypto-webcrypto-modern-smoke ok');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
