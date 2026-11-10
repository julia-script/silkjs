'use strict';
const assert = require('node:assert/strict');
const { Worker, isMainThread, parentPort, threadId, locks } = require('node:worker_threads');
function inbox(worker) {
  const queued = [], waiting = [];
  worker.on('message', value => waiting.length ? waiting.shift()(value) : queued.push(value));
  return () => queued.length ? Promise.resolve(queued.shift()) : new Promise(resolve => waiting.push(resolve));
}
if (!isMainThread) {
  const releases = new Map();
  parentPort.on('message', command => {
    if (command.op === 'release') { releases.get(command.name)?.(); releases.delete(command.name); return; }
    if (command.op === 'hold') {
      locks.request(command.name, { mode: command.mode || 'exclusive' }, lock => {
        parentPort.postMessage({ held: lock.name, mode: lock.mode, owner: threadId });
        return new Promise(resolve => releases.set(command.name, resolve));
      }).then(() => parentPort.postMessage({ released: command.name }), error => parentPort.postMessage({ rejected: command.name, name: error.name }));
    }
  });
  parentPort.postMessage('ready');
} else {
  const active = new Set();
  const timer = setTimeout(() => { console.error('Shared locks timed out'); process.exitCode = 1; for (const worker of active) worker.terminate(); }, 15000);
  async function start() {
    const worker = new Worker(__filename);
    active.add(worker);
    worker.once('exit', () => active.delete(worker));
    worker.on('error', error => { console.error(error); process.exitCode = 1; });
    const next = inbox(worker);
    assert.equal(await next(), 'ready');
    return { worker, next };
  }
  (async () => {
    const a = await start(), b = await start();
    await assert.rejects(locks.request('-reserved', () => {}), { name: 'NotSupportedError' });
    await assert.rejects(locks.request('x', { mode: 'shared', steal: true }, () => {}), { name: 'NotSupportedError' });
    await assert.rejects(locks.request('x', { ifAvailable: true, steal: true }, () => {}), { name: 'NotSupportedError' });
    const result = await locks.request('result', async lock => {
      assert.equal(lock.name, 'result'); assert.equal(lock.mode, 'exclusive');
      assert.equal(Object.prototype.toString.call(lock), '[object Lock]');
      assert.throws(() => new lock.constructor(), TypeError);
      assert.deepEqual(await locks.query(), {
        held: [{ name: 'result', mode: 'exclusive', clientId: `node-${process.pid}-${threadId}` }],
        pending: [],
      });
      return Promise.resolve(42);
    });
    assert.equal(result, 42);
    const callbackFailure = new Error('callback rejected');
    await assert.rejects(locks.request('result', () => Promise.reject(callbackFailure)), error => error === callbackFailure);
    assert.deepEqual(await locks.query(), { held: [], pending: [] });

    for (const state of [a, b]) state.worker.postMessage({ op: 'hold', name: 'readers', mode: 'shared' });
    assert.equal((await a.next()).mode, 'shared');
    assert.equal((await b.next()).mode, 'shared');
    // Arbitration is shared, but query exposes only the calling environment.
    assert.deepEqual(await locks.query(), { held: [], pending: [] });
    const order = [];
    let releaseWriter;
    const writer = locks.request('readers', lock => {
      order.push('writer');
      assert.equal(lock.mode, 'exclusive');
      return new Promise(resolve => { releaseWriter = resolve; });
    });
    const reader = locks.request('readers', { mode: 'shared' }, () => order.push('reader'));
    assert.deepEqual((await locks.query()).pending.map(lock => [lock.name, lock.mode]),
      [['readers', 'exclusive'], ['readers', 'shared']]);
    await locks.request('readers', { ifAvailable: true }, lock => assert.equal(lock, null));
    const controller = new AbortController();
    const aborted = locks.request('readers', { signal: controller.signal }, () => assert.fail('aborted callback ran'));
    const rejected = assert.rejects(aborted, error => error === 'cancelled');
    controller.abort('cancelled');
    await rejected;
    assert.deepEqual(order, []);
    a.worker.postMessage({ op: 'release', name: 'readers' });
    assert.deepEqual(await a.next(), { released: 'readers' });
    assert.deepEqual(order, []);
    b.worker.postMessage({ op: 'release', name: 'readers' });
    await b.next();
    // A real event-loop turn allows the remote release notification to arrive.
    while (!releaseWriter) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(order, ['writer']);
    releaseWriter();
    await Promise.all([writer, reader]);
    assert.deepEqual(order, ['writer', 'reader']);

    a.worker.postMessage({ op: 'hold', name: 'steal' });
    await a.next();
    await locks.request('steal', { steal: true }, lock => assert.equal(lock.mode, 'exclusive'));
    assert.deepEqual(await a.next(), { rejected: 'steal', name: 'AbortError' });
    a.worker.postMessage({ op: 'release', name: 'steal' });
    // A signal only cancels acquisition; it cannot revoke a callback's held lock.
    const heldSignal = new AbortController();
    assert.equal(await locks.request('signal-held', { signal: heldSignal.signal }, async () => {
      heldSignal.abort('too late');
      await Promise.resolve();
      return 17;
    }), 17);

    a.worker.postMessage({ op: 'hold', name: 'owner-exit' });
    await a.next();
    let acquired = false;
    const afterExit = locks.request('owner-exit', () => { acquired = true; return 'released-on-exit'; });
    assert.equal(acquired, false);
    await a.worker.terminate();
    assert.equal(await afterExit, 'released-on-exit');
    assert.deepEqual(await locks.query(), { held: [], pending: [] });
    console.log('Shared lock exclusion, readers, queueing, cancellation, steal and owner exit smoke passed');
  })().catch(error => { console.error(error); process.exitCode = 1; })
    .finally(async () => { for (const worker of active) await worker.terminate(); clearTimeout(timer); });
}
