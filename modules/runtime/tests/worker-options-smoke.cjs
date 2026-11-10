'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Worker, isMainThread, parentPort, SHARE_ENV } = require('node:worker_threads');

if (!isMainThread) {
  parentPort.postMessage('file worker');
} else {
  const active = new Set();
  const timeout = setTimeout(() => {
    console.error('Worker option contracts timed out');
    process.exitCode = 1;
    for (const worker of active) worker.terminate();
  }, 30000);
  function launch(source, options = {}, input) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(source, { eval: true, ...options });
      active.add(worker);
      const messages = [];
      let stdout = '', stderr = '';
      worker.on('message', value => messages.push(value));
      worker.stdout.on('data', chunk => { stdout += chunk; });
      worker.stderr.on('data', chunk => { stderr += chunk; });
      worker.on('error', reject);
      worker.on('exit', code => {
        active.delete(worker);
        if (code === 0) resolve({ worker, messages, stdout, stderr });
        else reject(new Error('Worker exit ' + code));
      });
      if (input !== undefined) worker.stdin.end(input);
    });
  }
  const report = expression => `require('node:worker_threads').parentPort.postMessage(${expression});`;
  function throwsFirst(filename, options, code, message) {
    assert.throws(() => new Worker(filename, options), error =>
      error.code === code && (!message || message.test(error.message)));
  }
  async function main() {
    const initialExecArgv = process.execArgv.slice();
    const previousNodeOptions = process.env.NODE_OPTIONS;
    const previousMarker = process.env.SILK_WORKER_OPTION_MARKER;
    try {
      process.env.SILK_WORKER_OPTION_MARKER = 'inherited';
      const coercions = await launch(`${report('[process.argv.slice(2),process.execArgv,process.env.SILK_WORKER_OPTION_MARKER]')}process.stdout.write('truthy stdout');`,
        { eval: 'yes', env: null, execArgv: null, argv: false, stdout: 1, stderr: 0, stdin: 0, trackUnmanagedFds: 0 });
      assert.deepEqual(coercions.messages, [[[], initialExecArgv, 'inherited']]);
      assert.equal(coercions.stdout, 'truthy stdout');
      assert.equal(coercions.worker.stdin, null);
      assert.equal(coercions.worker.threadName, null);

      // A falsy non-array does not reset private inherited runtime options.
      process.env.NODE_OPTIONS = '--input-type=module';
      process.execArgv.push('--input-type=module');
      for (const value of [null, false, 0, '', NaN]) {
        const result = await launch(report('[typeof require,process.argv.slice(2),process.execArgv]'),
          { env: null, execArgv: value, argv: value });
        assert.deepEqual(result.messages, [['function', [], initialExecArgv]]);
      }
      const moduleReport = `import('node:worker_threads').then(({parentPort})=>parentPort.postMessage(typeof require));`;
      assert.deepEqual((await launch(moduleReport, { execArgv: [], env: null })).messages, ['undefined']);
      assert.deepEqual((await launch(moduleReport, { execArgv: null, env: { ...process.env } })).messages, ['undefined']);
      assert.deepEqual((await launch(report('typeof require'), { execArgv: false, env: SHARE_ENV })).messages, ['function']);
      delete process.env.NODE_OPTIONS;
      process.execArgv.splice(0, process.execArgv.length, ...initialExecArgv);

      const input = await launch(`let text='';process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>{process.stdout.write(text);process.stderr.write('captured stderr');});`,
        { stdin: 'yes', stdout: {}, stderr: 1 }, 'actual stdin');
      assert.equal(input.stdout, 'actual stdin');
      assert.equal(input.stderr, 'captured stderr');
      assert.deepEqual((await launch(report('process.argv.slice(2)'), { argv: [Symbol('arg'), null, 7] })).messages,
        [['Symbol(arg)', 'null', '7']]);
      const indexedExecArgv = [];
      indexedExecArgv[Symbol.iterator] = () => { throw new Error('execArgv iterator must not run'); };
      assert.deepEqual((await launch(report('process.execArgv'), { execArgv: indexedExecArgv })).messages, [[]]);

      for (const [name, expected] of [[undefined, 'WorkerThread'], ['', 'WorkerThread'], [null, 'WorkerThread'],
        [false, 'WorkerThread'], [0, 'WorkerThread'], ['  named worker  ', 'named worker'], ['   ', '']]) {
        const worker = new Worker(report("require('node:worker_threads').threadName"), { eval: true, name });
        active.add(worker);
        assert.equal(worker.threadName, expected);
        let observed;
        worker.on('message', value => { observed = value; });
        await new Promise((resolve, reject) => { worker.on('error', reject); worker.on('exit', resolve); });
        active.delete(worker);
        assert.equal(observed, expected);
        assert.equal(worker.threadName, null);
      }
      // Primitive option bags are property-accessed, not rejected as non-objects.
      for (const options of [false, 0, '', () => {}]) {
        const worker = new Worker(__filename, options);
        active.add(worker);
        let message;
        worker.on('message', value => { message = value; });
        await new Promise((resolve, reject) => { worker.on('error', reject); worker.on('exit', resolve); });
        active.delete(worker);
        assert.equal(message, 'file worker');
      }
      throwsFirst('', null, undefined, /null/);
      throwsFirst(42, { execArgv: true, argv: true }, 'ERR_INVALID_ARG_TYPE', /execArgv/);
      throwsFirst(42, { argv: true }, 'ERR_INVALID_ARG_TYPE', /argv/);
      throwsFirst(42, { eval: 'yes', env: false }, 'ERR_INVALID_ARG_VALUE');
      throwsFirst('', { eval: true, env: false, name: 1, execArgv: [Symbol()] }, 'ERR_INVALID_ARG_TYPE', /env/);
      throwsFirst('', { eval: true, name: 1, execArgv: [Symbol()] }, 'ERR_INVALID_ARG_TYPE', /name/);
      throwsFirst('', { eval: true, env: { NODE_OPTIONS: '--silk-invalid-option' }, execArgv: [Symbol()] }, 'ERR_WORKER_INVALID_EXEC_ARGV');
      assert.throws(() => new Worker('', { eval: true, execArgv: [Symbol()] }), TypeError);
      assert.throws(() => new Worker('', { eval: true, env: { VALUE: Symbol() } }), TypeError);
      // Resource-limit getters run before native execArgv string conversion.
      const sentinel = new Error('resource getter');
      assert.throws(() => new Worker('', { eval: true, execArgv: [Symbol()], resourceLimits: {
        get stackSizeMb() { throw sentinel; },
      } }), error => error === sentinel);
      for (const resourceLimits of [null, false, 'ignored', { stackSizeMb: NaN }, { stackSizeMb: -1 }, { stackSizeMb: 0 }, { stackSizeMb: '1' }]) {
        assert.deepEqual((await launch(report("require('node:worker_threads').resourceLimits.stackSizeMb"), { resourceLimits })).messages, [4]);
      }
      const fractional = 1.0000001;
      assert.deepEqual((await launch(report("require('node:worker_threads').resourceLimits.stackSizeMb"),
        { resourceLimits: { stackSizeMb: fractional } })).messages, [fractional]);

      // Observe real shared descriptor lifetime rather than copied option values.
      for (const [trackUnmanagedFds, closes] of [[0, false], [null, true], ['yes', true]]) {
        const result = await launch(report("require('node:fs').openSync('/dev/null','r')"), { trackUnmanagedFds });
        const fd = result.messages[0];
        if (closes) assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' });
        else { try { assert.ok(fs.fstatSync(fd).isCharacterDevice()); } finally { fs.closeSync(fd); } }
      }
      const nestedSource = `
        const { Worker, parentPort } = require('node:worker_threads');
        const fs = require('node:fs');
        const child = new Worker(${JSON.stringify(report("require('node:fs').openSync('/dev/null','r')"))},
          { eval: true, trackUnmanagedFds: 0 });
        let fd;
        child.on('message', value => { fd = value; });
        child.on('error', error => { throw error; });
        child.on('exit', () => {
          try { fs.fstatSync(fd); fs.closeSync(fd); parentPort.postMessage('open'); }
          catch (error) { parentPort.postMessage(error.code); }
        });
      `;
      assert.deepEqual((await launch(nestedSource, { trackUnmanagedFds: 'yes' })).messages, ['EBADF']);
      console.log('worker options smoke: passed');
    } finally {
      process.execArgv.splice(0, process.execArgv.length, ...initialExecArgv);
      if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previousNodeOptions;
      if (previousMarker === undefined) delete process.env.SILK_WORKER_OPTION_MARKER;
      else process.env.SILK_WORKER_OPTION_MARKER = previousMarker;
    }
  }
  main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    for (const worker of active) await worker.terminate();
    clearTimeout(timeout);
  });
}
