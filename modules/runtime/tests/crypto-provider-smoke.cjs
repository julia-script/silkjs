'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const vectors = {
  argon2d: '512b391b6f1162975371d30919734294f868e3be3984f3c1a13a4db9fabe4acb',
  argon2i: 'c814d9d1dc7f37aa13f0d77f2494bda1c8de6b016dd388d29952a4c4672b6ce8',
  argon2id: '0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659',
};
function parameters() {
  return { message: Buffer.alloc(32, 1), nonce: Buffer.alloc(16, 2), parallelism: 4, tagLength: 32, memory: 32, passes: 3, secret: Buffer.alloc(8, 3), associatedData: Buffer.alloc(12, 4) };
}
function asyncCall(fn, ...args) { return new Promise((resolve, reject) => fn(...args, (e, value) => e ? reject(e) : resolve(value))); }
function peer(script, value) {
  const result = spawnSync(process.env.NODE_REFERENCE, ['-e', script], { input: JSON.stringify(value), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
async function main() {
  assert.equal(crypto.Mac, undefined);
  for (const [algorithm, expected] of Object.entries(vectors)) {
    assert.equal(crypto.argon2Sync(algorithm, parameters()).toString('hex'), expected);
    const inputs = parameters();
    const pending = asyncCall(crypto.argon2, algorithm, inputs);
    inputs.message.fill(9); inputs.secret.fill(9); inputs.associatedData.fill(9); inputs.nonce.fill(9);
    assert.equal((await pending).toString('hex'), expected);
  }
  assert.throws(() => crypto.argon2Sync('ARGON2ID', parameters()), { code: 'ERR_INVALID_ARG_VALUE' });
  assert.throws(() => crypto.argon2Sync('argon2id', { ...parameters(), memory: 31 }), { code: 'ERR_OUT_OF_RANGE' });
  assert.throws(() => crypto.argon2Sync('argon2id', { ...parameters(), nonce: Buffer.alloc(7) }), { code: 'ERR_OUT_OF_RANGE' });
  assert.throws(() => crypto.argon2('argon2id', parameters()), { code: 'ERR_INVALID_ARG_TYPE' });

  const names = crypto.getMacs();
  assert.ok(names.includes('hmac') && names.includes('kmac128'));
  names.length = 0;
  assert.ok(crypto.getMacs().includes('hmac'));
  const hmac = crypto.createMac('HMAC', crypto.createSecretKey(Buffer.alloc(20, 0x0b)), { digest: 'sha256' });
  hmac.update('Hi ').update(new Uint8Array(Buffer.from('There')));
  assert.equal(hmac.final('hex'), 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
  assert.throws(() => hmac.final(), { code: 'ERR_CRYPTO_MAC_FINALIZED' });
  assert.throws(() => hmac.update('x'), { code: 'ERR_CRYPTO_MAC_FINALIZED' });
  const key = Buffer.from(Array.from({ length: 32 }, (_, i) => 64 + i));
  const kmacExpected = 'e5780b0d3ea6f7d3a429c5706aa43a00fadbd7d49628839e3187243f456ee14e';
  assert.equal(crypto.createMac('kmac128', key, { outputLength: 32 }).update(Buffer.from([0, 1, 2, 3])).final('hex'), kmacExpected);
  assert.equal(crypto.createMac('kmac128', key, { outputLength: 0 }).final().length, 0);
  const cmacKey = Buffer.from('2b7e151628aed2a6abf7158809cf4f3c', 'hex');
  assert.equal(crypto.createMac('cmac', cmacKey, { cipher: 'aes-128-cbc' }).final('hex'), 'bb1d6929e95937287fa37d129b756746');
  assert.throws(() => crypto.createMac('hmac', key), { code: 'ERR_INVALID_ARG_VALUE' });
  assert.throws(() => crypto.createMac('hmac', key, { digest: 'sha256', customization: Buffer.alloc(0) }), { code: 'ERR_INVALID_ARG_VALUE' });
  assert.throws(() => crypto.createMac('hmac', 'not binary', { digest: 'sha256' }), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.throws(() => crypto.createMac('not-a-mac', key), { code: 'ERR_CRYPTO_INVALID_MAC' });
  const streamed = crypto.createMac('kmac128', key, { outputLength: 32 });
  const chunks = [];
  const completed = new Promise((resolve, reject) => { streamed.on('data', chunk => chunks.push(chunk)); streamed.on('end', resolve); streamed.on('error', reject); });
  streamed.write(Buffer.from([0, 1])); streamed.end(Buffer.from([2, 3]));
  await completed;
  assert.equal(Buffer.concat(chunks).toString('hex'), kmacExpected);

  const algorithms = [
    ['rsa', { modulusLength: 2048 }],
    ['ec', { namedCurve: 'prime256v1' }], ['ec', { namedCurve: 'secp384r1' }], ['ec', { namedCurve: 'secp521r1' }],
    ['x25519', {}], ['x448', {}],
    ['ml-kem-512', {}], ['ml-kem-768', {}], ['ml-kem-1024', {}],
  ];
  for (const [algorithm, options] of algorithms) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync(algorithm, options);
    const result = crypto.encapsulate(publicKey);
    assert.ok(Buffer.isBuffer(result.sharedKey) && Buffer.isBuffer(result.ciphertext));
    assert.deepEqual(crypto.decapsulate(privateKey, result.ciphertext), result.sharedKey);
    const asynchronous = await asyncCall(crypto.encapsulate, privateKey);
    const ciphertext = Buffer.from(asynchronous.ciphertext);
    const decoded = asyncCall(crypto.decapsulate, privateKey, ciphertext);
    ciphertext.fill(0);
    assert.deepEqual(await decoded, asynchronous.sharedKey);
    assert.throws(() => crypto.decapsulate(publicKey, result.ciphertext), { code: 'ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE' });
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
    const encoded = crypto.encapsulate(pem);
    assert.deepEqual(crypto.decapsulate(pem, encoded.ciphertext), encoded.sharedKey);
    if (algorithm !== 'rsa') {
      const publicBytes = publicKey.export({ format: 'raw-public' });
      const privateFormat = algorithm.startsWith('ml-kem-') ? 'raw-seed' : 'raw-private';
      const privateBytes = privateKey.export({ format: privateFormat });
      const publicOptions = { key: publicBytes, format: 'raw-public', asymmetricKeyType: algorithm, ...options };
      const privateOptions = { key: privateBytes, format: privateFormat, asymmetricKeyType: algorithm, ...options };
      const importedPublic = crypto.createPublicKey(publicOptions);
      const importedPrivate = crypto.createPrivateKey(privateOptions);
      assert.deepEqual(importedPublic.export({ format: 'raw-public' }), publicBytes);
      assert.deepEqual(importedPrivate.export({ format: privateFormat }), privateBytes);
      assert.deepEqual(crypto.createPublicKey(privateOptions).export({ format: 'raw-public' }), publicBytes);
      const rawResult = crypto.encapsulate(publicOptions);
      assert.deepEqual(crypto.decapsulate(privateOptions, rawResult.ciphertext), rawResult.sharedKey);
      const privateResult = await asyncCall(crypto.encapsulate, privateOptions);
      assert.deepEqual(await asyncCall(crypto.decapsulate, privateOptions, privateResult.ciphertext), privateResult.sharedKey);
      assert.throws(() => crypto.createPrivateKey(publicOptions), { code: 'ERR_INVALID_ARG_VALUE' });
      assert.throws(() => privateKey.export({ format: 'raw-public' }), { code: 'ERR_INVALID_ARG_VALUE' });
      assert.throws(() => publicKey.export({ format: privateFormat }), { code: 'ERR_INVALID_ARG_VALUE' });
      assert.throws(() => privateKey.export({ format: privateFormat, passphrase: 'secret' }), { code: 'ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS' });
      const incompatible = privateFormat === 'raw-seed' ? 'raw-private' : 'raw-seed';
      assert.throws(() => privateKey.export({ format: incompatible }), { code: 'ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS' });
      assert.throws(() => crypto.createPrivateKey({ ...privateOptions, format: incompatible }), { code: 'ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS' });
      if (algorithm === 'ec') {
        const compressed = publicKey.export({ format: 'raw-public', type: 'compressed' });
        assert.ok(compressed.length < publicBytes.length);
        const compressedPublic = crypto.createPublicKey({ ...publicOptions, key: compressed });
        assert.deepEqual(compressedPublic.export({ format: 'raw-public' }), publicBytes);
        assert.throws(() => publicKey.export({ format: 'raw-public', type: 'hybrid' }), { code: 'ERR_INVALID_ARG_VALUE' });
      }
    }
    if (process.env.NODE_REFERENCE) {
      const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
      const peerResult = peer('const c=require("crypto"),v=JSON.parse(require("fs").readFileSync(0,"utf8"));const r=c.encapsulate({key:Buffer.from(v.key,"base64"),format:"der",type:"spki"});console.log(JSON.stringify({sharedKey:r.sharedKey.toString("base64"),ciphertext:r.ciphertext.toString("base64")}));', { key: spki });
      assert.deepEqual(crypto.decapsulate(privateKey, Buffer.from(peerResult.ciphertext, 'base64')), Buffer.from(peerResult.sharedKey, 'base64'));
      const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
      const peerShared = peer('const c=require("crypto"),v=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(JSON.stringify(c.decapsulate({key:Buffer.from(v.key,"base64"),format:"der",type:"pkcs8"},Buffer.from(v.ciphertext,"base64")).toString("base64")));', { key: pkcs8, ciphertext: result.ciphertext.toString('base64') });
      assert.deepEqual(Buffer.from(peerShared, 'base64'), result.sharedKey);
    }
  }
  const rfcPrivate = crypto.createPrivateKey({
    format: 'raw-private', asymmetricKeyType: 'x25519',
    key: Buffer.from('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a', 'hex'),
  });
  assert.equal(crypto.createPublicKey(rfcPrivate).export({ format: 'raw-public' }).toString('hex'),
    '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a');
  const ed = crypto.generateKeyPairSync('ed25519');
  assert.throws(() => crypto.encapsulate(ed.publicKey));
  console.log('crypto provider smoke passed');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
