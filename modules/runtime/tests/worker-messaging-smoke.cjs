'use strict';
const assert = require('node:assert/strict');
const { Worker, MessageChannel, isMainThread, parentPort, workerData, threadId, postMessageToThread } = require('node:worker_threads');

function inbox(worker) {
  const queued = [];
  const waiting = [];
  worker.on('message', value => waiting.length ? waiting.shift()(value) : queued.push(value));
  return () => queued.length ? Promise.resolve(queued.shift()) : new Promise(resolve => waiting.push(resolve));
}
if (!isMainThread) {
  const listener = (value, source) => {
    if (value.throw) throw new Error('receiver failed');
    if (value.port) value.port.postMessage({ bytes: Array.from(new Uint8Array(value.buffer)), source });
    parentPort.postMessage({ delivered: value.label, source });
  };
  if (workerData.listen) process.on('workerMessage', listener);
  parentPort.on('message', async command => {
    try {
      if (command.op === 'send') {
        await postMessageToThread(command.target, { label: command.label }, 2000);
        parentPort.postMessage({ sent: command.label });
      } else if (command.op === 'block') {
        parentPort.postMessage('blocking');
        Atomics.wait(new Int32Array(command.memory), 0, 0);
        parentPort.postMessage('unblocked');
      } else if (command.op === 'nested') {
        const child = new Worker(__filename, { workerData: { listen: true } });
        const next = inbox(child);
        await next();
        await postMessageToThread(child.threadId, { label: 'nested-parent' }, 2000);
        assert.equal((await next()).source, threadId);
        child.postMessage({ op: 'send', target: 0, label: 'nested-main' });
        assert.deepEqual(await next(), { sent: 'nested-main' });
        await child.terminate();
        parentPort.postMessage('nested-done');
      }
    } catch (error) { parentPort.postMessage({ failure: error.code || error.message }); }
  });
  parentPort.postMessage('ready');
} else {
  const active = new Set();
  const timer = setTimeout(() => { console.error('Thread messaging timed out'); process.exitCode = 1; for (const w of active) w.terminate(); }, 15000);
  function start(listen) {
    const worker = new Worker(__filename, { workerData: { listen } });
    active.add(worker);
    worker.once('exit', () => active.delete(worker));
    worker.on('error', error => { console.error(error); process.exitCode = 1; });
    return { worker, next: inbox(worker) };
  }
  (async () => {
    const a = start(true), b = start(true), silent = start(false);
    await Promise.all([a.next(), b.next(), silent.next()]);
    await assert.rejects(postMessageToThread(0, 'self'), { code: 'ERR_WORKER_MESSAGING_SAME_THREAD' });
    await assert.rejects(postMessageToThread(2147483647, 'missing'), { code: 'ERR_WORKER_MESSAGING_FAILED' });
    await assert.rejects(postMessageToThread(silent.worker.threadId, 'unhandled', 2000), { code: 'ERR_WORKER_MESSAGING_FAILED' });
    await assert.rejects(postMessageToThread(a.worker.threadId, { throw: true }, 2000), { code: 'ERR_WORKER_MESSAGING_ERRORED' });
    await postMessageToThread(a.worker.threadId, { label: 'main-worker' }, 2000);
    assert.deepEqual(await a.next(), { delivered: 'main-worker', source: 0 });
    a.worker.postMessage({ op: 'send', target: b.worker.threadId, label: 'sibling' });
    assert.deepEqual(await b.next(), { delivered: 'sibling', source: a.worker.threadId });
    assert.deepEqual(await a.next(), { sent: 'sibling' });
    const received = [];
    const listener = (value, source) => received.push({ value, source });
    process.on('workerMessage', listener);
    a.worker.postMessage({ op: 'send', target: 0, label: 'worker-main' });
    assert.deepEqual(await a.next(), { sent: 'worker-main' });
    assert.deepEqual(received.shift(), { value: { label: 'worker-main' }, source: a.worker.threadId });
    a.worker.postMessage({ op: 'nested' });
    assert.equal(await a.next(), 'nested-done');
    assert.equal(received.shift().value.label, 'nested-main');
    process.off('workerMessage', listener);
    const channel = new MessageChannel();
    const transferred = new Promise(resolve => channel.port1.once('message', resolve));
    const buffer = Uint8Array.from([3, 8, 13]).buffer;
    await postMessageToThread(a.worker.threadId, { label: 'transfer', buffer, port: channel.port2 }, [buffer, channel.port2], 2000);
    assert.equal(buffer.byteLength, 0);
    assert.deepEqual(await transferred, { bytes: [3, 8, 13], source: 0 });
    await a.next();
    channel.port1.close();
    const memory = new SharedArrayBuffer(4);
    a.worker.postMessage({ op: 'block', memory });
    assert.equal(await a.next(), 'blocking');
    await assert.rejects(postMessageToThread(a.worker.threadId, { label: 'late' }, 25), { code: 'ERR_WORKER_MESSAGING_TIMEOUT' });
    Atomics.store(new Int32Array(memory), 0, 1);
    Atomics.notify(new Int32Array(memory), 0);
    assert.equal(await a.next(), 'unblocked');
    assert.deepEqual(await a.next(), { delivered: 'late', source: 0 });
    const exitedId = a.worker.threadId;
    await a.worker.terminate();
    await assert.rejects(postMessageToThread(exitedId, 'exited', 2000), { code: 'ERR_WORKER_MESSAGING_FAILED' });
    console.log('Thread routing, acknowledgement, errors, timeout and transfer smoke passed');
  })().catch(error => { console.error(error); process.exitCode = 1; })
    .finally(async () => { for (const worker of active) await worker.terminate(); clearTimeout(timer); });
}
