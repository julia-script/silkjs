'use strict';
// resourceLimits.maxOldGenerationSizeMb is a worker's heap budget. A worker that
// exhausts it ends with exit code 1 and ERR_WORKER_OUT_OF_MEMORY, even when its
// JavaScript catches the allocation failure, and its heap space statistics stay
// within the limits. A zero budget fails while the worker starts.
const assert = require('node:assert/strict');
const v8 = require('node:v8');
const { Worker, isMainThread, resourceLimits, parentPort, workerData } = require('node:worker_threads');

if (!isMainThread) {
  const spaces = Object.fromEntries(v8.getHeapSpaceStatistics().map(space => [space.space_name, space]));
  parentPort.postMessage({
    limit: v8.getHeapStatistics().heap_size_limit, used: v8.getHeapStatistics().used_heap_size,
    newSpace: spaces.new_space.space_size, oldSpace: spaces.old_space.space_size, codeSpace: spaces.code_space.space_size,
  });
  const keep = [];
  if (workerData === 'catch') {
    // Catching the failure does not keep the worker running.
    try { while (true) keep.push(new Array(1000).fill(keep.length)); }
    catch {}
    while (true) keep.length = 0;
  }
  while (true) keep.push(new Array(1000).fill(keep.length));
}

function run(mode, limits) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: mode, resourceLimits: limits });
    assert.deepEqual(worker.resourceLimits, { stackSizeMb: 4, ...limits });
    const result = { messages: [], errors: [] };
    worker.on('message', message => result.messages.push(message));
    worker.on('error', error => result.errors.push(error));
    worker.on('exit', code => { result.code = code; result.after = worker.resourceLimits; resolve(result); });
    setTimeout(() => reject(new Error(`${mode} worker did not end`)), 20000).unref();
  });
}

(async () => {
  assert.deepEqual(resourceLimits, {});
  const limits = { maxOldGenerationSizeMb: 24, maxYoungGenerationSizeMb: 4, codeRangeSizeMb: 16 };
  for (const mode of ['grow', 'catch']) {
    const result = await run(mode, limits);
    assert.equal(result.code, 1);
    assert.deepEqual(result.after, {});
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].code, 'ERR_WORKER_OUT_OF_MEMORY');
    assert.equal(result.errors[0].message, 'Worker terminated due to reaching memory limit: JS heap out of memory');
    const [stats] = result.messages;
    assert.equal(stats.limit, 24 * 1048576);
    assert.ok(stats.used < stats.limit);
    assert.ok(stats.oldSpace < stats.limit && stats.newSpace < 8 * 1048576 && stats.codeSpace === 0);
  }
  const empty = await run('grow', { maxOldGenerationSizeMb: 0, maxYoungGenerationSizeMb: 0 });
  assert.equal(empty.code, 1);
  assert.deepEqual(empty.errors.map(error => error.code), ['ERR_WORKER_OUT_OF_MEMORY']);
  assert.deepEqual(empty.messages, []);
  console.log('worker heap limit ok');
})();
