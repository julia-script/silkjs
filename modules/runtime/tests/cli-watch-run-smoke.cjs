'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => "'" + value.replace(/'/g, "'\"'\"'") + "'";
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-watch-run-'));
const running = new Set();
function put(name, source) { fs.writeFileSync(path.join(root, name), source); }
function watch(args, options = {}) {
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, NODE_OPTIONS: '', ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  running.add(child);
  let output = '', closed = false;
  const waiters = new Set();
  const notify = () => { for (const check of [...waiters]) check(); };
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk.toString(); notify(); });
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { closed = true; running.delete(child); notify(); resolve({ code, signal }); });
  });
  function until(predicate) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(check); reject(new Error('Watch output deadline: ' + output)); }, 15000);
      const check = () => {
        const value = predicate(output);
        if (value || closed) {
          clearTimeout(timer); waiters.delete(check);
          if (value) resolve(value); else reject(new Error('Watch exited early: ' + output));
        }
      };
      waiters.add(check); check();
    });
  }
  const records = () => output.split('\n').filter(line => line.startsWith('READY ')).map(line => JSON.parse(line.slice(6)));
  return { child, exit, until, records, output: () => output,
    ready: count => until(() => records().length >= count && records()[count - 1]),
    async stop() { child.kill('SIGTERM'); const result = await exit; assert.equal(result.code, 0, output); },
  };
}
function run(args, cwd) {
  const result = spawnSync(process.execPath, args, { cwd, env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 15000 });
  if (result.error) throw result.error;
  return result;
}
async function main() {
  fs.mkdirSync(path.join(root, 'pkg', 'nested'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', '.bin', 'ancestor-tool'), '#!/bin/sh\nprintf ancestor-bin');
  fs.chmodSync(path.join(root, 'node_modules', '.bin', 'ancestor-tool'), 0o755);
  put('pkg/capture.cjs', `console.log(JSON.stringify({ cwd:process.cwd(), name:process.env.NODE_RUN_SCRIPT_NAME, pkg:process.env.NODE_RUN_PACKAGE_JSON_PATH, args:process.argv.slice(2), path:process.env.PATH }));`);
  const scripts = { capture: quote(process.execPath) + ' capture.cjs', ancestor: 'ancestor-tool', fail: 'exit 7', signal: 'kill -TERM $$', empty: '', invalid: 42 };
  put('pkg/package.json', JSON.stringify({ scripts }));
  put('pkg/nested/package.json', '');
  const cwd = path.join(root, 'pkg', 'nested');
  const args = ['plain', '', 'two words', 'single\'quote', 'double"quote', '$HOME; echo injected', 'line\nbreak', '\\backslash', 'é'];
  const captured = run(['--run', 'capture', 'ignored', '--', ...args], cwd);
  assert.equal(captured.status, 0, captured.stderr);
  const record = JSON.parse(captured.stdout);
  assert.equal(fs.realpathSync(record.cwd), fs.realpathSync(path.join(root, 'pkg')));
  assert.equal(record.name, 'capture');
  assert.equal(fs.realpathSync(record.pkg), fs.realpathSync(path.join(root, 'pkg', 'package.json')));
  assert.deepEqual(record.args, args);
  assert.equal(run(['--run=ancestor'], cwd).stdout, 'ancestor-bin');
  assert.equal(run(['--run=fail'], cwd).status, 1);
  assert.equal(run(['--run=signal'], cwd).status, 0);
  assert.equal(run(['--run=empty'], cwd).status, 0);
  assert.match(run(['--run=invalid'], cwd).stderr, /unexpectedly not a string/);
  assert.match(run(['--run=missing'], cwd).stderr, /Missing script: "missing"[\s\S]*Available scripts are:/);
  const listed = run(['--run'], cwd);
  assert.equal(listed.status, 9);
  assert.match(listed.stderr, /Available scripts are:/);
  put('pkg/nested/package.json', '{');
  assert.match(run(['--run=capture'], cwd).stderr, /Can't parse/);

  put('dep.cjs', 'module.exports = 1;');
  put('dep.mjs', 'export default 1;');
  put('worker-dep.cjs', 'module.exports = 1;');
  put('worker.cjs', `require('node:worker_threads').parentPort.postMessage(require('./worker-dep.cjs'));`);
  put('.env', 'WATCH_SMOKE_VALUE=one\n');
  put('main.cjs', `const { Worker } = require('node:worker_threads');
const cjs = require('./dep.cjs');
Promise.all([import('./dep.mjs'), new Promise((resolve,reject) => {
const worker = new Worker(require('node:path').join(__dirname,'worker.cjs'), { env: {} });
worker.on('message', resolve); worker.on('error', reject);
})]).then(([esm,worker]) => console.log('READY '+JSON.stringify({pid:process.pid,cjs,esm:esm.default,worker,env:process.env.WATCH_SMOKE_VALUE})));
const timer = setInterval(() => {}, 1000);
for(const signal of ['SIGUSR2','SIGTERM']) process.on(signal, () => { console.log('SIGNAL '+signal); clearInterval(timer); });`);
  const implicit = watch(['--watch', '--watch-preserve-output', '--watch-kill-signal=SIGUSR2', '--env-file=.env', 'main.cjs']);
  const first = await implicit.ready(1);
  put('unrelated.txt', 'ignored');
  await delay(650);
  assert.equal(implicit.records().length, 1, implicit.output());
  put('dep.cjs', 'module.exports = 2;');
  const second = await implicit.ready(2);
  assert.equal(second.cjs, 2);
  assert.notEqual(first.pid, second.pid);
  assert.match(implicit.output(), /SIGNAL SIGUSR2/);
  put('worker-dep.cjs', 'module.exports = 2;');
  assert.equal((await implicit.ready(3)).worker, 2);
  put('.env', 'WATCH_SMOKE_VALUE=two\n');
  assert.equal((await implicit.ready(4)).env, 'two');
  // As in Node, a dependency deleted under a failed run is not watched again.
  put('dep.mjs', 'export default 2;');
  assert.equal((await implicit.ready(5)).esm, 2);
  const latest = implicit.records().at(-1).pid;
  await implicit.stop();
  assert.match(implicit.output(), /SIGNAL SIGTERM/);
  assert.throws(() => process.kill(latest, 0), { code: 'ESRCH' });

  fs.mkdirSync(path.join(root, 'watched'));
  put('once.cjs', `console.log('READY '+JSON.stringify({pid:process.pid}));`);
  const explicit = watch(['--watch-path=watched', '--watch-preserve-output', 'once.cjs']);
  await explicit.ready(1);
  await explicit.until(output => output.includes('Completed running'));
  put('watched/unrelated.txt', 'one');
  await explicit.ready(2);
  await explicit.until(output => output.split('Completed running').length === 3);
  put('watched/nested.txt', 'two');
  await explicit.ready(3);
  await explicit.stop();
  console.log('CLI watch restart/dependency/signal and package runner smoke passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  for (const child of running) child.kill('SIGTERM');
  if (running.size) await Promise.all([...running].map(child => new Promise(resolve => child.once('close', resolve))));
  fs.rmSync(root, { recursive: true, force: true });
});
