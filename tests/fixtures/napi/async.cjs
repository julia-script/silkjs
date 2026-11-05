'use strict';
const assert = require('node:assert/strict');
const { AsyncLocalStorage, createHook, executionAsyncId } = require('node:async_hooks');
const addon = require(process.argv[2]);
const mode = process.argv[3] || 'normal';

if (mode === 'fatal') {
  addon.fatal(new Error('napi-fatal-fixture'));
  throw new Error('fatal exception unexpectedly returned');
} else if (mode === 'fatal-worker') {
  const { Worker } = require('node:worker_threads');
  const worker = new Worker(
    "require(require('node:worker_threads').workerData).fatal(new Error('worker-napi-fatal'));",
    { eval: true, workerData: process.argv[2] });
  let received;
  worker.on('error', error => { received = error; });
  worker.on('exit', code => {
    assert.equal(code, 1);
    assert.equal(received?.message, 'worker-napi-fatal');
    console.log('native fatal exception stayed in its worker');
  });
} else if (mode === 'fatal-handled') {
  const error = new Error('handled-native-fatal');
  let received;
  process.once('uncaughtException', value => { received = value; });
  addon.fatal(error);
  assert.equal(received, error);
  console.log('native fatal exception handler preserved identity');
} else if (mode === 'teardown') {
  addon.cleanup(process.argv[4]);
  // No referenced handle remains: shutdown must wake the blocked native
  // producer, dispose undelivered queue entries and join before unloading.
  addon.threaded(() => {}, 100000, true);
} else {
  (async () => {
    const storage = new AsyncLocalStorage();
    const events = [];
    const resources = new Set();
    const hook = createHook({
      init(id, type) {
        if (type.startsWith('silk-napi-')) {
          resources.add(id);
          events.push(['init', id, type]);
        }
      },
      before(id) { if (resources.has(id)) events.push(['before', id]); },
      after(id) { if (resources.has(id)) events.push(['after', id]); },
      destroy(id) { if (resources.has(id)) events.push(['destroy', id]); },
    }).enable();
    try {
      const completed = await addon.work(21, false);
      assert.equal(completed.value, 42);
      assert.equal(completed.status, 0);
      const cancelled = await addon.work(17, true);
      // Cancellation races execution; only successful cancellation promises
      // napi_cancelled (11). Failed uv_cancel must deliver ordinary completion.
      assert.equal(cancelled.status, cancelled.cancelStatus === 0 ? 11 : 0);
      if (cancelled.cancelStatus !== 0) assert.equal(cancelled.cancelStatus, 9);

      let scopedCalls = 0;
      storage.run('scope-store', () => {
        const outerId = executionAsyncId();
        assert.equal(addon.scopes(() => {
          assert.equal(storage.getStore(), scopedCalls === 0 ? undefined : 'scope-store');
          assert.notEqual(executionAsyncId(), outerId);
          scopedCalls++;
          return 42;
        }), 42);
        assert.equal(executionAsyncId(), outerId);
        const error = new Error('scope-unwind');
        assert.throws(() => addon.scopes(() => { throw error; }), value => value === error);
        assert.equal(executionAsyncId(), outerId);
        assert.equal(storage.getStore(), 'scope-store');
      });
      assert.equal(scopedCalls, 2);
      assert.equal(storage.getStore(), undefined);

      const received = [];
      const threaded = await storage.run('thread-store', () => addon.threaded(value => {
        assert.equal(storage.getStore(), undefined);
        received.push(value);
      }, 128));
      assert.deepEqual(received, Array.from({ length: 128 }, (_, i) => i));
      assert.equal(threaded.delivered, 128);
      assert.equal(threaded.disposed, 0);
      assert.equal(threaded.error, 0);
      assert.equal(storage.getStore(), undefined);

      const queuedValues = [];
      const queued = await addon.queue(value => queuedValues.push(value), false);
      assert.deepEqual(queuedValues, [1, 2]);
      assert.equal(queued.delivered, 2);
      assert.equal(queued.disposed, 0);
      assert.equal(queued.queueStatus, 15);
      const aborted = await addon.queue(() => assert.fail('aborted queue reached JS'), true);
      assert.equal(aborted.delivered, 0);
      assert.equal(aborted.disposed, 2);
      assert.equal(aborted.queueStatus, 15);

      for (const type of ['silk-napi-work', 'silk-napi-scope', 'silk-napi-thread', 'silk-napi-queue']) {
        assert.ok(events.some(event => event[0] === 'init' && event[2] === type), type);
      }
      assert.ok(events.some(event => event[0] === 'before'));
      assert.equal(events.filter(event => event[0] === 'before').length,
                   events.filter(event => event[0] === 'after').length);
      if (process.argv[4]) addon.cleanup(process.argv[4]);
      console.log('napi async fixture passed');
    } finally {
      hook.disable();
      storage.disable();
    }
  })().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
