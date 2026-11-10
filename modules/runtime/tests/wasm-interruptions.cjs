'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { Worker } = require('node:worker_threads');
const F = require('./wasm-fixtures.cjs');
const signature = F.signature([], []);
const loop = [0x03, 0x40, 0x0c, 0, 0x0b];
const wait = [0x41, 0, 0x41, 0, 0x42, 0x7f, 0xfe, 1, 2, 0, 0x1a];
const spinBytes = F.binary({ types: [signature], functions: [{ type: 0, body: loop }], exports: [F.exported('run', 0, 0)] });
const instance = new WebAssembly.Instance(new WebAssembly.Module(spinBytes));
function deadline(source, values) {
  const sandbox = { ...values, caught: false, WebAssembly };
  assert.throws(() => vm.runInNewContext(`try { ${source} } catch (error) { caught = true; }`, sandbox, { timeout: 25 }),
    { code: 'ERR_SCRIPT_EXECUTION_TIMEOUT' });
  assert.equal(sandbox.caught, false, 'guest catch must not consume host cancellation');
}
deadline('instance.exports.run()', { instance });
deadline('WebAssembly.promising(instance.exports.run)()', { instance });
const start = new WebAssembly.Module(F.binary({ types: [signature], functions: [{ type: 0, body: loop }], start: 0 }));
deadline('new WebAssembly.Instance(module)', { module: start });
const importedModule = new WebAssembly.Module(F.binary({
  types: [signature], imports: [F.named('host', 'run', 0, [0])],
  functions: [{ type: 0, body: [0x10, 0] }], exports: [F.exported('run', 0, 1)],
}));
const jsLoop = new WebAssembly.Instance(importedModule, { host: { run() { while (true) {} } } });
deadline('instance.exports.run()', { instance: jsLoop });
const nested = new WebAssembly.Instance(importedModule, { host: { run() { instance.exports.run(); } } });
deadline('instance.exports.run()', { instance: nested });
const waiting = new WebAssembly.Instance(new WebAssembly.Module(F.binary({
  types: [signature], imports: [F.named('host', 'memory', 2, [3, 1, 1])],
  functions: [{ type: 0, body: wait }], exports: [F.exported('run', 0, 0)],
})), { host: { memory: new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }) } });
deadline('instance.exports.run()', { instance: waiting });
// Cancellation must not poison later execution in the same runtime.
assert.equal(vm.runInNewContext('6 * 7', {}, { timeout: 100 }), 42);
const finite = new WebAssembly.Instance(new WebAssembly.Module(F.binary({
  types: [F.signature([], [F.I32])], functions: [{ type: 0, body: [0x41, 42] }], exports: [F.exported('run', 0, 0)],
})));
assert.equal(finite.exports.run(), 42);
async function terminate(mode) {
  const bytes = F.binary({
    types: [signature], imports: [F.named('host', 'ready', 0, [0]), ...(mode === 'wait' ? [F.named('host', 'memory', 2, [3, 1, 1])] : [])],
    functions: [{ type: 0, body: [0x10, 0, ...(mode === 'wait' ? wait : loop)] }], exports: [F.exported('run', 0, 1)],
  });
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const ready = () => parentPort.postMessage('running');
    const host = { ready: workerData.mode === 'resume' ? new WebAssembly.Suspending(async () => { await Promise.resolve(); ready(); }) : ready };
    if (workerData.mode === 'wait') host.memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    const instance = new WebAssembly.Instance(new WebAssembly.Module(workerData.bytes), { host });
    if (workerData.mode === 'resume') WebAssembly.promising(instance.exports.run)();
    else instance.exports.run();
  `, { eval: true, workerData: { mode, bytes } });
  await new Promise((resolve, reject) => {
    let running = false;
    worker.once('error', reject);
    worker.once('exit', code => { if (!running) reject(new Error(`worker exited before entering Wasm: ${code}`)); });
    worker.once('message', message => {
      try { assert.equal(message, 'running'); } catch (error) { reject(error); return; }
      running = true;
      // Let the import return (or JSPI resume) before requesting cancellation.
      setTimeout(() => worker.terminate().then(code => {
        try { assert.equal(code, 1); resolve(); } catch (error) { reject(error); }
      }, reject), 10);
    });
  });
}
(async () => {
  for (const mode of ['loop', 'wait', 'resume']) await terminate(mode);
  console.log('Wasm VM deadlines, import unwinding, blocking waits, and worker termination passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
