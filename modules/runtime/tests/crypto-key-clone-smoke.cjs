'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Worker, MessageChannel, moveMessagePortToContext, receiveMessageOnPort, isMainThread, workerData, parentPort } = require('node:worker_threads');
const { subtle } = crypto.webcrypto;
const iv = new Uint8Array(12);
const plaintext = new Uint8Array([1, 2, 3, 4]);

function checkGraph(graph) {
  assert.strictEqual(graph.key, graph.again);
  assert.strictEqual(graph.self, graph);
  assert.equal(graph.key.type, 'secret');
  assert.equal(graph.key.extractable, false);
  assert.deepEqual(graph.key.algorithm, { name: 'AES-GCM', length: 256 });
  assert.deepEqual(graph.key.usages, ['encrypt', 'decrypt']);
}

function checkTargetContext(value) {
  const { port1, port2 } = new MessageChannel();
  const moved = moveMessagePortToContext(port2, require('node:vm').createContext({}));
  try {
    port1.postMessage(value);
    assert.throws(() => receiveMessageOnPort(moved), { code: 'ERR_MESSAGE_TARGET_CONTEXT_UNAVAILABLE' });
  } finally { port1.close(); moved.close(); }
}

async function main() {
  if (!isMainThread) {
    checkGraph(workerData.graph);
    await assert.rejects(subtle.exportKey('raw', workerData.graph.key), { name: 'InvalidAccessError' });
    const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv }, workerData.graph.key, plaintext);
    const signature = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, workerData.privateKey, plaintext);
    assert(workerData.certificate instanceof crypto.X509Certificate);
    assert.equal(workerData.certificate.fingerprint256, workerData.fingerprint);
    const mac = crypto.createHmac('sha256', workerData.secretKey).update(plaintext).digest();
    const nativeSignature = crypto.sign('sha256', plaintext, workerData.signingKey);
    parentPort.postMessage({
      key: workerData.graph.key, again: workerData.graph.key, ciphertext, signature, mac, nativeSignature,
      secretKey: workerData.secretKey, secretAgain: workerData.secretKey,
      signingKey: workerData.signingKey, certificate: workerData.certificate, certificateAgain: workerData.certificate,
    });
    return;
  }

  const key = await subtle.importKey('raw', new Uint8Array(32).fill(7), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const graph = { key, again: key };
  graph.self = graph;
  const copy = structuredClone(graph);
  checkGraph(copy);
  assert.notStrictEqual(copy, graph);
  assert.notStrictEqual(copy.key, key);
  await assert.rejects(subtle.exportKey('raw', copy.key), { name: 'InvalidAccessError' });
  const encrypted = await subtle.encrypt({ name: 'AES-GCM', iv }, copy.key, plaintext);
  assert.deepEqual(new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted)), plaintext);

  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const nativePair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const secretKey = crypto.createSecretKey(Buffer.from(plaintext));
  secretKey.export = () => { throw new Error('Cloning must not call public key methods'); };
  const secretCopy = structuredClone({ key: secretKey, again: secretKey });
  assert.strictEqual(secretCopy.key, secretCopy.again);
  assert.notStrictEqual(secretCopy.key, secretKey);
  assert.deepEqual(secretCopy.key.export(), Buffer.from(plaintext));
  const certificate = new crypto.X509Certificate(require('node:tls').rootCertificates[0]);
  const fingerprint = certificate.fingerprint256;
  certificate.raw.fill(0);
  const certificateCopy = structuredClone({ certificate, again: certificate });
  assert.strictEqual(certificateCopy.certificate, certificateCopy.again);
  assert.notStrictEqual(certificateCopy.certificate, certificate);
  assert(certificateCopy.certificate instanceof crypto.X509Certificate);
  assert.equal(certificateCopy.certificate.fingerprint256, fingerprint);
  for (const value of [key, secretKey, certificate]) checkTargetContext(value);
  const worker = new Worker(__filename, { workerData: {
    graph, privateKey: pair.privateKey, signingKey: nativePair.privateKey, secretKey, certificate, fingerprint,
  } });
  let response;
  worker.on('message', value => { response = value; });
  await new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.once('exit', code => {
      if (code !== 0) reject(new Error('CryptoKey worker exited with code ' + code));
      else if (!response) reject(new Error('CryptoKey worker exited without returning a result'));
      else resolve();
    });
  });
  assert.strictEqual(response.key, response.again);
  assert.notStrictEqual(response.key, key);
  assert.equal(response.key.extractable, false);
  await assert.rejects(subtle.exportKey('raw', response.key), { name: 'InvalidAccessError' });
  assert.deepEqual(new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv }, response.key, response.ciphertext)), plaintext);
  assert.equal(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, response.signature, plaintext), true);
  assert.strictEqual(response.secretKey, response.secretAgain);
  assert.deepEqual(response.secretKey.export(), Buffer.from(plaintext));
  assert.deepEqual(Buffer.from(response.mac), crypto.createHmac('sha256', plaintext).update(plaintext).digest());
  assert.equal(crypto.verify('sha256', plaintext, nativePair.publicKey, response.nativeSignature), true);
  assert.equal(crypto.verify('sha256', plaintext, nativePair.publicKey, crypto.sign('sha256', plaintext, response.signingKey)), true);
  assert.strictEqual(response.certificate, response.certificateAgain);
  assert.equal(response.certificate.fingerprint256, fingerprint);
  assert.equal(response.certificate.issuerCertificate, undefined);
  console.log('CryptoKey, KeyObject and X509 structured clone ownership passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
