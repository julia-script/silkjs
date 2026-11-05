'use strict';
const assert = require('node:assert/strict');
const { Worker, isMainThread, parentPort, workerData, resourceLimits } = require('node:worker_threads');

function burn(milliseconds) {
  const until = Date.now() + milliseconds;
  while (Date.now() < until) Math.sqrt(Date.now());
}

if (!isMainThread) {
  if (workerData === 'cpu') {
    parentPort.on('message', () => { burn(250); parentPort.postMessage('worked'); });
    parentPort.postMessage('ready');
  } else {
    let depth = 0;
    function recurse() { depth++; recurse(); return depth; }
    if (workerData === 'uncaught') recurse();
    else {
      try { recurse(); }
      catch (error) { parentPort.postMessage({ depth, message: error.message, stackSizeMb: resourceLimits.stackSizeMb }); }
      parentPort.close();
    }
  }
} else {
  const active = new Set();
  const timeout = setTimeout(() => {
    console.error('Worker resource controls timed out');
    process.exitCode = 1;
    for (const worker of active) worker.terminate();
  }, 20000);
  function start(mode, stackSizeMb = 4) {
    const worker = new Worker(__filename, { workerData: mode, resourceLimits: { stackSizeMb } });
    active.add(worker);
    worker.once('exit', () => active.delete(worker));
    return worker;
  }
  function message(worker) {
    return new Promise((resolve, reject) => {
      function onError(error) { worker.off('message', onMessage); reject(error); }
      function onMessage(value) { worker.off('error', onError); resolve(value); }
      worker.once('error', onError);
      worker.once('message', onMessage);
    });
  }
  async function depth(stackSizeMb) {
    const worker = start('depth', stackSizeMb);
    const exited = new Promise(resolve => worker.once('exit', resolve));
    const result = await message(worker);
    assert.equal(await exited, 0);
    assert.match(result.message, /stack/i);
    assert.equal(result.stackSizeMb, stackSizeMb);
    assert.deepEqual(worker.resourceLimits, {});
    return result.depth;
  }
  (async () => {
    const worker = start('cpu');
    assert.equal(await message(worker), 'ready');
    assert.throws(() => worker.cpuUsage({}), { code: 'ERR_INVALID_ARG_TYPE' });
    assert.throws(() => worker.cpuUsage({ user: -1, system: 0 }), { code: 'ERR_OUT_OF_RANGE' });
    assert.throws(() => worker.cpuUsage({ user: NaN, system: 0 }), { code: 'ERR_OUT_OF_RANGE' });
    assert.throws(() => worker.cpuUsage({ user: 0, system: '0' }), { code: 'ERR_INVALID_ARG_TYPE' });
    const before = await worker.cpuUsage();
    assert.equal(Number.isInteger(before.user) && before.user >= 0, true);
    assert.equal(Number.isInteger(before.system) && before.system >= 0, true);
    const parentBefore = process.cpuUsage();
    burn(400);
    const parentDelta = process.cpuUsage(parentBefore);
    const idleDelta = await worker.cpuUsage(before);
    assert.ok(idleDelta.user + idleDelta.system < (parentDelta.user + parentDelta.system) / 2 + 1000,
      'parent CPU must not be charged to an idle worker');
    const busyBefore = await worker.cpuUsage();
    const worked = message(worker);
    worker.postMessage('work');
    assert.equal(await worked, 'worked');
    const busyDelta = await worker.cpuUsage(busyBefore);
    assert.ok(busyDelta.user + busyDelta.system > 0, 'worker work must consume real thread CPU');
    const negative = await worker.cpuUsage({ user: Number.MAX_SAFE_INTEGER, system: Number.MAX_SAFE_INTEGER });
    assert.ok(negative.user < 0 && negative.system < 0, 'previous usage is subtracted without clamping');
    const fractional = await worker.cpuUsage({ user: 0.5, system: 0.5 });
    assert.equal(fractional.user % 1, 0.5);
    await worker.terminate();
    await assert.rejects(worker.cpuUsage(), { code: 'ERR_WORKER_NOT_RUNNING' });
    await assert.rejects(Worker.prototype.cpuUsage.call({}), { code: 'ERR_WORKER_NOT_RUNNING' });
    assert.throws(() => worker.cpuUsage({}), { code: 'ERR_INVALID_ARG_TYPE' });
    assert.deepEqual(worker.resourceLimits, {});

    const small = await depth(1);
    const large = await depth(2);
    assert.ok(large > small, 'larger configured stack must permit deeper recursion');
    const overflow = start('uncaught', 1);
    let failure;
    overflow.once('error', error => { failure = error; });
    const code = await new Promise(resolve => overflow.once('exit', resolve));
    assert.equal(code, 1);
    assert.ok(failure && /stack/i.test(failure.message), 'uncaught overflow must report error before exit');
    // The worker failure must not damage its parent or a subsequent worker.
    await depth(1);
    console.log('Worker CPU and stack controls smoke passed');
  })().catch(error => { console.error(error); process.exitCode = 1; })
    .finally(async () => {
      for (const worker of active) await worker.terminate();
      clearTimeout(timeout);
    });
}
