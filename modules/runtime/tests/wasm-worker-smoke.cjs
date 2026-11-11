'use strict';
const assert = require('node:assert/strict');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { atomic } = require('./wasm-fixtures.cjs');

if (!isMainThread) {
  const { module, memory } = workerData;
  assert.equal(module instanceof WebAssembly.Module, true);
  assert.equal(memory instanceof WebAssembly.Memory, true);
  const instance = new WebAssembly.Instance(module, { host: { memory } });
  assert.equal(instance.exports.memory, memory);
  assert.equal(memory.grow(1), 1);
  for (let i = 0; i < 1000; i++) instance.exports.bump();
  const old = memory.buffer;
  const local = new ArrayBuffer(8);
  new Uint8Array(local)[0] = 93;
  parentPort.postMessage({ memory, view: new Int32Array(old), moved: local }, [local]);
  assert.equal(local.byteLength, 0);
  parentPort.close();
} else {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
  const initial = memory.buffer;
  const module = new WebAssembly.Module(atomic());
  const instance = new WebAssembly.Instance(module, { host: { memory } });
  const worker = new Worker(__filename, { workerData: { memory, module } });
  const timeout = setTimeout(() => {
    console.error('Worker WebAssembly smoke timed out');
    process.exitCode = 1;
    worker.terminate();
  }, 15000);
  let received = false;
  worker.on('message', message => {
    try {
      received = true;
      assert.equal(message.memory instanceof WebAssembly.Memory, true);
      assert.notEqual(message.memory, memory);
      assert.equal(initial.byteLength, 65536);
      assert.equal(memory.buffer.byteLength, 131072);
      assert.equal(message.memory.buffer.byteLength, 131072);
      assert.equal(message.view.buffer instanceof SharedArrayBuffer, true);
      assert.equal(Atomics.load(new Int32Array(initial), 0), 2000);
      assert.equal(Atomics.load(message.view, 0), 2000);
      Atomics.store(message.view, 1, 77);
      assert.equal(Atomics.load(new Int32Array(memory.buffer), 1), 77);
      assert.equal(new Uint8Array(message.moved)[0], 93);
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
  worker.on('error', error => { console.error(error); process.exitCode = 1; });
  worker.on('exit', code => {
    clearTimeout(timeout);
    if (code !== 0 || !received) process.exitCode = 1;
    if (!process.exitCode) console.log('WebAssembly worker sharing smoke passed');
  });
  for (let i = 0; i < 1000; i++) instance.exports.bump();
}
