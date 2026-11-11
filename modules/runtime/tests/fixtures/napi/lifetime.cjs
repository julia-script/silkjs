'use strict';
const assert = require('node:assert/strict');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const path = require('node:path');
const addonPath = isMainThread ? path.resolve(process.argv[2]) : workerData;
const addon = require(addonPath);
async function exercise() {
  const object = { worker: !isMainThread };
  assert.equal(addon.hold(object, 1), object);
  assert.equal(addon.current(), object);
  assert.equal(addon.scoped(value => addon.scoped(inner => inner, value), object), object);
  const exception = { identity: Symbol('exception') };
  assert.throws(() => addon.scoped(() => { throw exception; }, object), value => value === exception);
  for (const value of [undefined, null, true, 42, 'primitive', 9007199254740993n])
    assert.equal(addon.primitive(value), value);
  assert.equal(addon.unref(), 0);
  const exportsBefore = addon;
  delete require.cache[addonPath];
  const reloaded = require(addonPath);
  assert.notEqual(reloaded, exportsBefore);
  assert.equal(reloaded.current(), undefined);
  assert.equal(exportsBefore.current(), object);
  if (process.argv.includes('--gc')) {
    assert.equal(typeof global.gc, 'function', 'invoke runtime with --expose-gc');
    let target = {};
    reloaded.hold(target, 1);
    target = null;
    global.gc();
    assert.equal(typeof reloaded.current(), 'object');
    reloaded.unref();
    for (let i = 0; i < 100 && reloaded.stats() === 0; ++i) {
      global.gc();
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(reloaded.current(), undefined);
    assert.equal(reloaded.stats(), 1);
  }
}
(async () => {
  await exercise();
  if (!isMainThread) { parentPort.postMessage('isolated'); return; }
  await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: addonPath });
    let delivered = false;
    worker.once('message', value => { assert.equal(value, 'isolated'); delivered = true; });
    worker.once('error', reject);
    worker.once('exit', code => { try { assert.equal(code, 0); assert.equal(delivered, true); resolve(); } catch (error) { reject(error); } });
  })));
  console.log('native addon scopes/references/reload/workers: ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
