'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const { once } = require('node:events');
const util = require('node:util');
const banner = 'KEYBOARD_INTERRUPT: Script execution was interrupted by `SIGINT`\n';

async function consumer(mode) {
  if (mode === 'api') {
    assert.equal(util.setTraceSigInt.length, 1);
    assert.equal(util.setTraceSigInt(false), undefined);
    const listeners = [process.listenerCount('newListener'), process.listenerCount('removeListener')];
    for (const enable of [true, 1, 'yes', Symbol('enable'), { valueOf() { throw new Error('must not coerce'); } }]) {
      assert.equal(util.setTraceSigInt(enable), undefined);
      assert.equal(util.setTraceSigInt(enable), undefined);
      assert.equal(util.setTraceSigInt(false), undefined);
    }
    for (const disable of [undefined, null, false, 0, '', NaN]) assert.equal(util.setTraceSigInt(disable), undefined);
    assert.deepEqual([process.listenerCount('newListener'), process.listenerCount('removeListener')], listeners);
    assert.equal(process.allowedNodeEnvironmentFlags.has('--trace-sigint'), true);
    assert.equal(process.allowedNodeEnvironmentFlags.has('--no-trace-sigint'), true);
    const namespace = await import('node:util');
    assert.equal(namespace.setTraceSigInt, util.setTraceSigInt);
    for (const flag of ['--trace-sigint', '--no-trace-sigint']) {
      assert.throws(() => new Worker('', { eval: true, execArgv: [flag] }), { code: 'ERR_WORKER_INVALID_EXEC_ARGV' });
    }
    const worker = new Worker(`const assert = require('node:assert/strict');
      const { setTraceSigInt } = require('node:util');
      for (const value of [true, false, undefined, null, 1, {}]) {
        assert.throws(() => setTraceSigInt(value), {
          name: 'TypeError', code: 'ERR_WORKER_UNSUPPORTED_OPERATION',
          message: 'Calling util.setTraceSigInt is not supported in workers'
        });
      }`, { eval: true });
    assert.deepEqual(await once(worker, 'exit'), [0]);
    console.log('api-ok');
    return;
  }
  // SIGINT tracing cannot invoke a user Error stack formatter.
  Error.prepareStackTrace = () => { throw new Error('SIGINT called a JS stack formatter'); };
  Error.stackTraceLimit = 0;
  let timer;
  const listener = () => { clearInterval(timer); console.log('handled'); };
  if (mode === 'listener-before') process.on('SIGINT', listener);
  if (!mode.startsWith('startup')) util.setTraceSigInt(true);
  if (mode === 'listener-after' || mode === 'listener-removed' || mode === 'disabled-listener-cycle') {
    process.on('SIGINT', listener);
    if (mode === 'disabled-listener-cycle') util.setTraceSigInt(false);
    process.removeListener('SIGINT', listener);
    if (mode === 'listener-after') process.on('SIGINT', listener);
  }
  if (mode === 'disabled') util.setTraceSigInt(0);
  if (mode === 'worker-busy') {
    const worker = new Worker(`require('node:worker_threads').parentPort.postMessage('worker-ready');
      function workerBusy(){ while(true) {} } workerBusy();`, { eval: true });
    await once(worker, 'message');
  }
  if (['idle', 'startup-idle', 'listener-before', 'listener-after', 'worker-busy'].includes(mode)) {
    timer = setInterval(() => {}, 1000);
    console.log('ready');
    return;
  }
  function traceSigintOuter() {
    function traceSigintBusy() {
      console.log('ready');
      while (true) {}
    }
    traceSigintBusy();
  }
  traceSigintOuter();
}

function run(mode, flags = [], nodeOptions = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...flags, __filename, mode], {
      env: { ...process.env, NODE_OPTIONS: nodeOptions }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', sent = false, signalTimer;
    const deadline = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${mode} timed out: ${stdout}\n${stderr}`)); }, 15000);
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (!sent && stdout.includes('ready\n')) {
        sent = true;
        // Allow the ready callback to return for the deliberately idle cases.
        const idle = /idle|listener-before|listener-after|worker-busy/.test(mode);
        signalTimer = setTimeout(() => child.kill('SIGINT'), idle ? 100 : 0);
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(deadline); clearTimeout(signalTimer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(deadline); clearTimeout(signalTimer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}
async function main() {
  if (process.argv[2]) return consumer(process.argv[2]);
  for (const [mode, flags, options, traced, stack] of [
    ['busy', [], '', true, true],
    ['idle', [], '', true, false],
    ['disabled', [], '', false, false],
    ['disabled-listener-cycle', [], '', false, false],
    ['listener-removed', [], '', true, true],
    ['startup-busy', ['--trace-sigint'], '', true, true],
    ['startup-idle', [], '--trace-sigint', true, false],
    ['startup-busy', ['--no-trace-sigint'], '--trace-sigint', false, false],
    ['startup-busy', ['--trace_sigint=ignored'], '--no-trace-sigint', true, true],
    ['worker-busy', ['--trace-sigint'], '', true, false],
  ]) {
    const result = await run(mode, flags, options);
    assert.ok(result.signal === 'SIGINT' || result.code === 130, JSON.stringify({ mode, ...result }));
    if (traced) {
      assert.ok(result.stderr.startsWith(banner), JSON.stringify({ mode, ...result }));
      assert.equal(result.stderr.split(banner).length - 1, 1);
      if (stack) {
        assert.match(result.stderr, /at traceSigintBusy \(.*util-trace-sigint-smoke\.cjs:\d+:\d+\)/);
        assert.match(result.stderr, /at traceSigintOuter \(.*util-trace-sigint-smoke\.cjs:\d+:\d+\)/);
        assert.ok(result.stderr.split('\n').filter(line => line.startsWith('    at ')).length <= 10);
      } else assert.equal(result.stderr, banner);
    } else assert.equal(result.stderr, '');
  }
  for (const mode of ['listener-before', 'listener-after']) {
    const result = await run(mode);
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'ready\nhandled\n');
  }
  // Inherited process-wide options must not reject worker creation or enable a
  // worker watchdog, while the public API rejects every argument in workers.
  const result = await run('api', ['--trace-sigint']);
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, 'api-ok\n');
  console.log('util.setTraceSigInt native busy/idle stacks, signals, listeners, options and workers smoke passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
