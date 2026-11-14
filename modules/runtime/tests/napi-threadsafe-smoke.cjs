'use strict';
// Thread-safe functions as napi-rs addons (rolldown, oxc) use them. One that a producer never
// releases must not keep the process from exiting: Node finalizes it at environment teardown, and
// on abort. A producer that waits for an answer from a promise job must get it: the loop runs its
// checkpoint after it delivers calls, before it waits again.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (process.argv[2] === '--fixture') {
  const addon = require(path.resolve(process.argv[3]));
  const mode = process.argv[4];
  if (mode === 'unref') addon.hold(false);
  else if (mode === 'abort') {
    addon.hold(true);
    setImmediate(() => { addon.abort(); console.log('aborted'); });
  } else if (mode === 'worker') {
    const { Worker } = require('node:worker_threads');
    const worker = new Worker(`require(${JSON.stringify(path.resolve(process.argv[3]))}).hold(false);`, { eval: true });
    worker.on('exit', code => console.log('worker exit ' + code));
  } else if (mode === 'pingpong') {
    let calls = 0;
    addon.pingpong(round => {
      assert.equal(round, calls++);
      Promise.resolve().then(() => addon.answer());
    }, 2000);
    process.on('exit', () => console.log('rounds ' + calls));
  }
  return;
}

const executable = path.resolve(process.argv[2] || process.execPath);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'silk-napi-threadsafe-'));
try {
  const filename = path.join(root, 'threadsafe.node');
  const compiler = process.env.CC || 'cc';
  const flags = process.platform === 'darwin' ? ['-bundle', '-undefined', 'dynamic_lookup'] : ['-shared', '-fPIC'];
  const compilation = spawnSync(compiler, ['-std=c11', ...flags,
    '-I', path.resolve(__dirname, '../vendor/node-api'), path.join(__dirname, 'fixtures/napi/threadsafe.c'), '-o', filename, '-lpthread'], { encoding: 'utf8' });
  if (compilation.error) throw compilation.error;
  assert.equal(compilation.status, 0, compilation.stderr);
  const expected = {
    unref: 'held function finalized\n',
    abort: 'aborted\nheld function finalized\n',
    worker: 'held function finalized\nworker exit 0\n',
    pingpong: 'rounds 2000\n',
  };
  for (const [mode, stdout] of Object.entries(expected)) {
    const result = spawnSync(executable, [__filename, '--fixture', filename, mode], { encoding: 'utf8', timeout: 20000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${mode}: ${JSON.stringify(result)}`);
    assert.equal(result.stdout, stdout, mode);
  }
  console.log('napi thread-safe function smoke passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
