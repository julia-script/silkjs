'use strict';
// Waiting must sleep in the reactor, not spin: a lone timer, and a worker that only listens
// on parentPort, should each use far less CPU than the wall time they wait.
const assert = require('node:assert/strict');
const { Worker } = require('node:worker_threads');
const ms = (usage) => (usage.user + usage.system) / 1000;
const wait = 500, budget = 150;
const start = process.cpuUsage();
setTimeout(() => {
  const timer = ms(process.cpuUsage(start));
  assert.ok(timer < budget, `a ${wait} ms timer used ${timer} ms of CPU`);
  const worker = new Worker("const { parentPort } = require('node:worker_threads'); parentPort.on('message', () => {}); parentPort.postMessage('ready')", { eval: true });
  worker.once('message', async () => {
    const before = await worker.cpuUsage(), parent = process.cpuUsage();
    setTimeout(async () => {
      const after = await worker.cpuUsage();
      const idle = (after.user - before.user + after.system - before.system) / 1000;
      const host = ms(process.cpuUsage(parent));
      assert.ok(idle < budget, `an idle worker used ${idle} ms of CPU in ${wait} ms`);
      assert.ok(host < budget, `the parent used ${host} ms of CPU in ${wait} ms`);
      worker.terminate().then(() => console.log('idle cpu smoke ok'));
    }, wait);
  });
}, wait);
