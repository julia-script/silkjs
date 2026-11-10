'use strict';

// Compatibility: <runtime> --expose-gc tests/util-abort-transfer-smoke.cjs
// Additional ownership cleanup: append --cleanup (Node 24 retains closed-peer
// sender listeners; this mode checks the runtime's explicit teardown contract).
// Exact v24.22.2 oracle probe: after postMessage(signal, [signal]) to a closed
// peer, getEventListeners(signal, 'abort').length was still 1 after 20 ms.
// Cleanup mode intentionally requires 0 instead; it is not a parity claim.
const assert = require('node:assert/strict');
const { transferableAbortController, transferableAbortSignal, aborted } = require('node:util');
const { getEventListeners } = require('node:events');
const { Worker, MessageChannel, receiveMessageOnPort, isMainThread, parentPort, workerData } = require('node:worker_threads');
const delay = () => new Promise(resolve => setTimeout(resolve, 5));
function inbox(port) {
  const queued = [], waiting = [];
  port.on('message', value => waiting.length ? waiting.shift()(value) : queued.push(value));
  return () => queued.length ? Promise.resolve(queued.shift()) : new Promise(resolve => waiting.push(resolve));
}
function waitForAbort(signal) {
  if (signal.aborted) return Promise.resolve(signal.reason);
  return new Promise(resolve => signal.addEventListener('abort', () => resolve(signal.reason), { once: true }));
}
async function eventually(check, message) {
  for (let attempt = 0; attempt < 200; attempt++) {
    await delay();
    if (check()) return;
  }
  assert.fail(message);
}
async function collect(reference) {
  for (let attempt = 0; attempt < 200; attempt++) {
    await delay();
    globalThis.gc();
    await delay();
    if (reference.deref() === undefined) return;
  }
  assert.fail('weakly owned object was retained');
}

if (!isMainThread) {
  assert(workerData.signal instanceof AbortSignal);
  assert(workerData.signal.reason instanceof RangeError);
  parentPort.postMessage({ ready: workerData.signal.reason.message });
  const outgoing = transferableAbortController();
  parentPort.on('message', async message => {
    if (message.op === 'receive') {
      const signal = message.signal;
      assert(signal instanceof AbortSignal);
      parentPort.postMessage('received');
      await waitForAbort(signal);
      parentPort.postMessage({ signal }, [signal]);
    } else if (message.op === 'create') {
      parentPort.postMessage(outgoing.signal, [outgoing.signal]);
    } else if (message.op === 'abort') {
      outgoing.abort(new SyntaxError('worker reason', { cause: { origin: 'worker' } }));
    }
  });
} else {
  const active = new Set();
  const watchdog = setTimeout(() => {
    console.error('Abort transfer smoke timed out');
    process.exitCode = 1;
    for (const worker of active) worker.terminate();
  }, 15000);
  (async () => {
    assert.equal(typeof globalThis.gc, 'function', 'run with --expose-gc');
    const ordinary = new AbortController();
    ordinary.signal.extra = 7;
    assert.deepEqual(structuredClone(ordinary.signal), { extra: 7 });
    assert.throws(() => structuredClone(ordinary.signal, { transfer: [ordinary.signal] }), { name: 'DataCloneError' });
    assert.equal(transferableAbortSignal(ordinary.signal), ordinary.signal);
    assert.throws(() => structuredClone(ordinary.signal), { name: 'DataCloneError' });
    assert.throws(() => transferableAbortSignal({ aborted: false }), { code: 'ERR_INVALID_ARG_TYPE' });
    await assert.rejects(aborted({}, {}), { code: 'ERR_INVALID_ARG_TYPE' });
    await assert.rejects(aborted(AbortSignal.abort(), null), { code: 'ERR_INVALID_ARG_TYPE' });
    assert.equal(await aborted(AbortSignal.abort(), () => {}), undefined);

    const controller = transferableAbortController();
    const first = structuredClone({ a: controller.signal, b: controller.signal }, { transfer: [controller.signal] });
    assert(first.a instanceof AbortSignal);
    assert.equal(first.a, first.b);
    const second = structuredClone(controller.signal, { transfer: [controller.signal] });
    const onward = structuredClone(first.a, { transfer: [first.a] });
    const delivered = [first.a, second, onward].map(waitForAbort);
    const reason = new TypeError('original reason', { cause: { marker: 42 } });
    controller.abort(reason);
    assert.equal(controller.signal.reason, reason);
    for (const received of await Promise.all(delivered)) {
      assert(received instanceof TypeError);
      assert.equal(received.message, reason.message);
      assert.deepEqual(received.cause, reason.cause);
      assert.equal(received.stack, reason.stack);
      assert.notEqual(received, reason);
    }
    const defaultController = transferableAbortController();
    defaultController.abort();
    const defaultCopy = structuredClone(defaultController.signal, { transfer: [defaultController.signal] });
    assert(defaultCopy.reason instanceof DOMException);
    assert.equal(defaultCopy.reason.name, 'AbortError');
    assert.equal(defaultCopy.reason.message, defaultController.signal.reason.message);
    assert.equal(defaultCopy.reason.stack, defaultController.signal.reason.stack);
    const cycle = transferableAbortController();
    cycle.abort({ signal: cycle.signal });
    const cycleCopy = structuredClone(cycle.signal, { transfer: [cycle.signal] });
    assert.equal(cycleCopy.reason.signal, cycleCopy);
    const getter = transferableAbortController();
    const snapshot = structuredClone({ signal: getter.signal, get abort() { getter.abort('getter'); return true; } }, { transfer: [getter.signal] });
    assert.equal(snapshot.signal.aborted, true);
    assert.equal(snapshot.signal.reason, 'getter');

    const rollback = transferableAbortController();
    const buffer = new ArrayBuffer(8);
    assert.throws(() => structuredClone({ signal: rollback.signal, bad() {} }, { transfer: [rollback.signal, buffer] }), { name: 'DataCloneError' });
    assert.equal(buffer.byteLength, 8);
    assert.equal(getEventListeners(rollback.signal, 'abort').length, 0);
    assert.throws(() => structuredClone(rollback.signal, { transfer: [rollback.signal, rollback.signal] }), { name: 'DataCloneError' });
    const channel = new MessageChannel();
    assert.throws(() => channel.port1.postMessage(rollback.signal), { name: 'DataCloneError' });
    const badReason = transferableAbortController();
    badReason.abort(() => {});
    assert.throws(() => structuredClone(badReason.signal, { transfer: [badReason.signal] }), { name: 'DataCloneError' });
    channel.port1.postMessage(rollback.signal, [rollback.signal]);
    const viaPort = receiveMessageOnPort(channel.port2).message;
    assert(viaPort instanceof AbortSignal);
    const portAbort = waitForAbort(viaPort);
    rollback.abort({ transported: 'port' });
    assert.deepEqual(await portAbort, { transported: 'port' });
    channel.port1.close(); channel.port2.close();

    const relay = transferableAbortController();
    function forward() {
      const intermediate = structuredClone(relay.signal, { transfer: [relay.signal] });
      return structuredClone(intermediate, { transfer: [intermediate] });
    }
    const forwarded = forward();
    const relayAbort = waitForAbort(forwarded);
    await delay();
    globalThis.gc();
    relay.abort('retained relay');
    assert.equal(await relayAbort, 'retained relay');

    const initial = transferableAbortController();
    initial.abort(new RangeError('worker data'));
    const worker = new Worker(__filename, { execArgv: [], workerData: { signal: initial.signal }, transferList: [initial.signal] });
    active.add(worker);
    const next = inbox(worker);
    worker.on('error', error => { console.error(error); process.exitCode = 1; });
    assert.deepEqual(await next(), { ready: 'worker data' });
    const future = transferableAbortController();
    worker.postMessage({ op: 'receive', signal: future.signal }, [future.signal]);
    assert.equal(await next(), 'received');
    future.abort(new TypeError('main reason', { cause: 17 }));
    const returned = (await next()).signal;
    assert(returned instanceof AbortSignal);
    assert(returned.reason instanceof TypeError);
    assert.equal(returned.reason.message, 'main reason');
    assert.equal(returned.reason.cause, 17);
    worker.postMessage({ op: 'create' });
    const fromWorker = await next();
    assert(fromWorker instanceof AbortSignal);
    const workerAbort = waitForAbort(fromWorker);
    worker.postMessage({ op: 'abort' });
    const workerReason = await workerAbort;
    assert(workerReason instanceof SyntaxError);
    assert.equal(workerReason.message, 'worker reason');
    assert.deepEqual(workerReason.cause, { origin: 'worker' });
    await worker.terminate();
    active.delete(worker);

    const resistant = new AbortController();
    resistant.signal.addEventListener('abort', event => event.stopImmediatePropagation());
    const liveResource = {};
    const waiting = aborted(resistant.signal, liveResource);
    resistant.abort();
    const event = await waiting;
    assert.equal(event.type, 'abort');
    assert.equal(event.target, resistant.signal);
    assert.equal(getEventListeners(resistant.signal, 'abort').length, 1);
    assert.equal(typeof liveResource, 'object');

    const weakController = new AbortController();
    let resolved = false;
    function weakWait() {
      const resource = {};
      const reference = new WeakRef(resource);
      aborted(weakController.signal, resource).then(() => { resolved = true; });
      return reference;
    }
    await collect(weakWait());
    await eventually(() => getEventListeners(weakController.signal, 'abort').length === 0, 'collected resource listener was not removed');
    weakController.abort();
    await delay();
    assert.equal(resolved, false);

    if (process.argv.includes('--cleanup')) {
      const closed = transferableAbortController();
      const pair = new MessageChannel();
      pair.port2.close();
      pair.port1.postMessage(closed.signal, [closed.signal]);
      await eventually(() => getEventListeners(closed.signal, 'abort').length === 0, 'closed peer retained its sender listener');
      pair.port1.close();
      const source = transferableAbortController();
      function discardedReceiver() {
        return new WeakRef(structuredClone(source.signal, { transfer: [source.signal] }));
      }
      await collect(discardedReceiver());
      await eventually(() => getEventListeners(source.signal, 'abort').length === 0, 'collected receiver retained its sender listener');
      const exitSource = transferableAbortController();
      const seed = transferableAbortController(); seed.abort(new RangeError('worker data'));
      const exiting = new Worker(__filename, { execArgv: [], workerData: { signal: seed.signal }, transferList: [seed.signal] });
      active.add(exiting);
      const exitNext = inbox(exiting);
      await exitNext();
      exiting.postMessage({ op: 'receive', signal: exitSource.signal }, [exitSource.signal]);
      assert.equal(await exitNext(), 'received');
      await exiting.terminate();
      active.delete(exiting);
      await eventually(() => getEventListeners(exitSource.signal, 'abort').length === 0, 'worker termination retained its sender listener');
    }
    console.log('Abort transfer, reasons, rollback, workers and weak-resource ownership passed');
  })().catch(error => { console.error(error); process.exitCode = 1; })
    .finally(async () => { for (const worker of active) await worker.terminate(); clearTimeout(watchdog); });
}
