'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { Worker } = require('node:worker_threads');
const { once } = require('node:events');
const { spawnSync } = require('node:child_process');

function signalSender() {
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const sender = new Worker(`const { workerData } = require('node:worker_threads');
    const gate = new Int32Array(workerData);
    Atomics.wait(gate, 0, 0);
    process.kill(process.pid, 'SIGINT');`, { eval: true, workerData: gate.buffer });
  return { gate, exited: once(sender, 'exit') };
}
const releaseSender = 'Atomics.store(gate, 0, 1); Atomics.notify(gate, 0);';
async function scenario(mode) {
  if (mode === 'default-signal') {
    vm.runInThisContext('1', { breakOnSigint: true });
    process.kill(process.pid, 'SIGINT');
    setTimeout(() => { throw new Error('SIGINT was swallowed after VM execution'); }, 100);
    return;
  }
  if (mode === 'timeout-wait') {
    assert.throws(() => vm.runInNewContext('Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)', {}, { timeout: 20 }), { code: 'ERR_SCRIPT_EXECUTION_TIMEOUT' });
    assert.equal(vm.runInThisContext('Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 0)'), 'timed-out');
    return;
  }
  if (mode === 'worker-terminate') {
    const worker = new Worker(`const { parentPort } = require('node:worker_threads');
      globalThis.ready = () => parentPort.postMessage('waiting');
      require('node:vm').runInThisContext('ready(); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)', { breakOnSigint: true });`, { eval: true });
    assert.deepEqual(await once(worker, 'message'), ['waiting']);
    assert.equal(await worker.terminate(), 1);
    assert.equal(vm.runInThisContext('6 * 7', { breakOnSigint: true }), 42);
    return;
  }
  if (mode === 'worker-signal' || mode === 'worker-late-listener' || mode === 'worker-module-signal') {
    let signals = 0;
    const listener = () => signals++;
    if (mode !== 'worker-late-listener') process.on('SIGINT', listener);
    const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads');
      const vm = require('node:vm');
      globalThis.ready = () => parentPort.postMessage('ready');
      (async () => {
        let code;
        if (workerData) {
          const module = new vm.SourceTextModule('ready(); while(true){}');
          await module.link(() => {});
          try { await module.evaluate({ breakOnSigint: true }); }
          catch (error) { code = error.code; }
        } else {
          try { vm.runInThisContext('ready(); while(true){}', { breakOnSigint: true }); }
          catch (error) { code = error.code; }
        }
        parentPort.postMessage({ code, value: vm.runInThisContext('6 * 7') });
      })().catch(error => { throw error; });`, { eval: true, workerData: mode === 'worker-module-signal' });
    const exited = once(worker, 'exit');
    assert.deepEqual(await once(worker, 'message'), ['ready']);
    if (mode === 'worker-late-listener') process.on('SIGINT', listener);
    const interrupted = once(worker, 'message');
    process.kill(process.pid, 'SIGINT');
    assert.deepEqual(await interrupted, [{ code: 'ERR_SCRIPT_EXECUTION_INTERRUPTED', value: 42 }]);
    assert.deepEqual(await exited, [0]);
    await new Promise(setImmediate);
    assert.equal(signals, 0);
    const deadline = setTimeout(() => { throw new Error('main SIGINT listener was not restored'); }, 5000);
    const delivered = once(process, 'SIGINT');
    process.kill(process.pid, 'SIGINT');
    await delivered;
    clearTimeout(deadline);
    assert.equal(signals, 1);
    process.removeListener('SIGINT', listener);
    return;
  }
  const { gate, exited } = signalSender();
  globalThis.gate = gate;
  if (mode === 'nested') {
    globalThis.inner = new vm.Script(releaseSender + 'while (true) {}');
    const outer = new vm.Script(`let interrupted;
      try { inner.runInThisContext({ breakOnSigint: true }); }
      catch (error) { interrupted = error.code; }
      for (let index = 0; index < 100000; index++);
      interrupted;`);
    assert.equal(outer.runInThisContext({ breakOnSigint: true }), 'ERR_SCRIPT_EXECUTION_INTERRUPTED');
  } else if (mode === 'module') {
    let signals = 0;
    const listener = () => signals++;
    process.on('SIGINT', listener);
    const context = vm.createContext({ gate, process, observed: {} });
    const module = new vm.SourceTextModule('observed.listeners = process.listenerCount("SIGINT");' + releaseSender + 'while (true) {}', { context });
    await module.link(() => {});
    await assert.rejects(module.evaluate({ breakOnSigint: true }), { code: 'ERR_SCRIPT_EXECUTION_INTERRUPTED' });
    await exited;
    assert.equal(context.observed.listeners, 1);
    assert.equal(signals, 0);
    assert.equal(module.status, 'errored');
    assert.equal(module.error, null);
    await assert.rejects(module.evaluate(), reason => reason === null);
    process.removeListener('SIGINT', listener);
    assert.equal(vm.runInContext('21 + 21', context), 42);
    return;
  } else {
    let normalSignals = 0;
    let onceSignals = 0;
    const normal = () => normalSignals++;
    process.on('SIGINT', normal);
    process.once('SIGINT', () => onceSignals++);
    const context = vm.createContext({ gate, process, observed: {} });
    const body = mode === 'atomics' ? 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)' : 'while (true) {}';
    const script = new vm.Script('observed.listeners = process.listenerCount("SIGINT");' + releaseSender + body);
    assert.throws(() => script.runInContext(context, { breakOnSigint: true }), { code: 'ERR_SCRIPT_EXECUTION_INTERRUPTED' });
    assert.equal(context.observed.listeners, 0);
    assert.equal(normalSignals, 0);
    assert.equal(onceSignals, 0);
    assert.equal(vm.runInContext('6 * 7', context), 42);
    const deadline = setTimeout(() => { throw new Error('restored SIGINT listeners did not run'); }, 5000);
    const delivered = once(process, 'SIGINT');
    process.kill(process.pid, 'SIGINT');
    await delivered;
    clearTimeout(deadline);
    assert.equal(normalSignals, 1);
    assert.equal(onceSignals, 1);
    process.removeListener('SIGINT', normal);
    assert.equal(process.listenerCount('SIGINT'), 0);
  }
  await exited;
  assert.equal(vm.runInThisContext('2 + 3'), 5);
}
async function main() {
  if (process.argv[2]) return scenario(process.argv[2]);
  for (const mode of ['script', 'atomics', 'nested', 'module', 'timeout-wait', 'worker-terminate', 'worker-signal', 'worker-late-listener', 'worker-module-signal', 'default-signal']) {
    const result = spawnSync(process.execPath, ['--experimental-vm-modules', __filename, mode], { encoding: 'utf8', timeout: 20000 });
    if (result.error) throw result.error;
    if (mode === 'default-signal') assert.ok(result.signal === 'SIGINT' || result.status === 130, JSON.stringify({ mode, ...result }));
    else assert.equal(result.status, 0, `${mode}: ${result.stdout}\n${result.stderr}`);
  }
  console.log('VM SIGINT execution, nested ownership, waits, listener restoration and worker teardown smoke passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
