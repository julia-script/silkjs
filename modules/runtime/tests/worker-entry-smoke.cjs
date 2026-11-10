'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker, SHARE_ENV } = require('node:worker_threads');

function evaluate(source, options = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(source, { eval: true, ...options });
    const messages = [];
    worker.on('message', value => messages.push(value));
    worker.on('error', reject);
    worker.on('exit', code => code === 0 ? resolve(messages) : reject(new Error('Worker exit ' + code)));
  });
}
const report = expression => `import('node:worker_threads').then(({parentPort})=>parentPort.postMessage(${expression}));`;

async function main() {
  const initialExecArgv = process.execArgv.slice();
  assert.deepEqual(await evaluate(`var workerVisible=42;${report('[globalThis.workerVisible,typeof globalThis.require,typeof module.require,globalThis.module===module,typeof fs,typeof crypto.createHash]')}`, { execArgv: [] }),
    [[42, 'function', 'function', true, 'undefined', 'undefined']]);
  const moduleSource = `const {parentPort}=await import('node:worker_threads');parentPort.postMessage([typeof require,await Promise.resolve(42)]);`;
  assert.deepEqual(await evaluate(moduleSource, { execArgv: [] }), [['undefined', 42]]);
  assert.deepEqual(await evaluate(moduleSource, { execArgv: ['--input-type', 'module'] }), [['undefined', 42]]);
  await assert.rejects(evaluate(moduleSource, { execArgv: ['--input-type=commonjs'] }), SyntaxError);
  assert.deepEqual(await evaluate(report('typeof require'), { env: { NODE_OPTIONS: '--input-type=module' } }), ['undefined']);
  for (const execArgv of [['--input-type=invalid'], ['--input-type'], ['--expose-gc'], ['--trace-events-enabled']])
    assert.throws(() => new Worker('', { eval: true, execArgv }), { code: 'ERR_WORKER_INVALID_EXEC_ARGV' });
  assert.throws(() => new Worker('', { eval: true, env: { NODE_OPTIONS: '--silk-unknown-option' } }), { code: 'ERR_WORKER_INVALID_EXEC_ARGV' });
  assert.throws(() => new Worker('', { eval: true, execArgv: [Symbol()] }), TypeError);
  assert.throws(() => new Worker('', { eval: true, env: { SYMBOL: Symbol() } }), TypeError);

  const previous = process.env.NODE_OPTIONS;
  try {
    process.env.NODE_OPTIONS = '--input-type=module';
    assert.deepEqual(await evaluate(report('typeof require')), ['function']);
    assert.deepEqual(await evaluate(report('typeof require'), { env: SHARE_ENV }), ['function']);
    assert.deepEqual(await evaluate(report('typeof require'), { execArgv: [] }), ['undefined']);
    assert.deepEqual(await evaluate(report('typeof require'), { env: SHARE_ENV, execArgv: [] }), ['undefined']);
    assert.deepEqual(await evaluate(report('typeof require'), { env: { ...process.env } }), ['undefined']);
    process.env.NODE_OPTIONS = '--silk-unknown-option --input-type=module';
    assert.deepEqual(await evaluate(report('typeof require'), { execArgv: [] }), ['function']);
    delete process.env.NODE_OPTIONS;
    process.execArgv.push('--input-type=module');
    assert.deepEqual(await evaluate(report('[typeof require,process.execArgv]')), [['function', initialExecArgv]]);
  } finally {
    process.execArgv.splice(0, process.execArgv.length, ...initialExecArgv);
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
  }
  assert.deepEqual(await evaluate(report('typeof gc'), { execArgv: [] }), [typeof gc]);
  const metadata = (await evaluate(report('[__filename,__dirname,module.id,module.filename,module.paths]'), { execArgv: [] }))[0];
  assert.deepEqual(metadata.slice(0, 4), ['[worker eval]', '.', '[worker eval]', path.join(process.cwd(), '[worker eval]')]);
  assert.deepEqual(metadata[4], require('node:module')._nodeModulePaths(process.cwd()));
  const esmMetadata = (await evaluate(report('[import.meta.filename,import.meta.dirname]'), { execArgv: [] }))[0];
  assert.deepEqual(esmMetadata, [path.join(process.cwd(), '[eval1]'), process.cwd()]);
  console.log('worker entry smoke: passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
