'use strict';
// The OpenSSL providers are configured on the main thread at its first crypto call,
// or before it starts a worker. Either way PKCS#8 exports of ML-KEM and ML-DSA keys
// hold the seed alone, as in Node (86 and 54 bytes).
const assert = require('node:assert/strict');
const { Worker, isMainThread, parentPort } = require('node:worker_threads');

function sizes() {
  const crypto = require('node:crypto');
  const result = {};
  for (const algorithm of ['ml-kem-768', 'ml-dsa-44']) {
    const { privateKey } = crypto.generateKeyPairSync(algorithm);
    result[algorithm] = privateKey.export({ format: 'der', type: 'pkcs8' }).length;
  }
  return result;
}
const expected = { 'ml-kem-768': 86, 'ml-dsa-44': 54 };

if (!isMainThread) {
  parentPort.postMessage(sizes());
} else {
  // The worker makes the first crypto call of the process.
  const worker = new Worker(__filename);
  worker.once('message', fromWorker => {
    assert.deepEqual(fromWorker, expected);
    assert.deepEqual(sizes(), expected);
    console.log('crypto-pqc-encoding-smoke ok');
  });
  worker.once('error', error => { throw error; });
}
