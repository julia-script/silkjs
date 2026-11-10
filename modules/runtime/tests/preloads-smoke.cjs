'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const executable = path.resolve(process.argv[2] || process.execPath);
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'silk-preloads-')));
function file(name, source) { fs.writeFileSync(path.join(root, name), source); }
function run(args, options = {}) {
  const env = { ...process.env }; delete env.NODE_OPTIONS;
  const result = spawnSync(executable, args, { cwd: root, env, encoding: 'utf8', timeout: 30000, ...options });
  if (result.error) throw result.error;
  return result;
}
function success(args, options) {
  const result = run(args, options);
  assert.equal(result.status, 0, JSON.stringify({ args, ...result }));
  return result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
try {
  file('dependency.cjs', `globalThis.preloadEvents.push(['dependency',module.isPreloading]);`);
  file('pre.cjs', `globalThis.preloadEvents ||= [];preloadEvents.push(['require',module.isPreloading,module.parent.id,module.parent.filename,typeof globalThis.require]);require('./dependency.cjs');`);
  file('second.cjs', `preloadEvents.push(['second',module.isPreloading]);`);
  file('a.mjs', `preloadEvents.push(['a-start',import.meta.main]);await new Promise(r=>setTimeout(r,2));preloadEvents.push(['a-end']);`);
  file('b.mjs', `preloadEvents.push(['b',import.meta.main]);`);
  const required = [['require', true, 'internal/preload', null, 'undefined'], ['dependency', true]];
  const imported = [...required, ['second', true], ['a-start', false], ['a-end'], ['b', false]];
  const report = `console.log(JSON.stringify([preloadEvents,typeof module==='object'?module.isPreloading:null,process.argv.slice(1)]));`;
  file('entry.cjs', report);
  const flags = ['--import', './a.mjs', '-r', './pre.cjs', '--import=./b.mjs', '--require=./second.cjs'];
  assert.deepEqual(success([...flags, 'entry.cjs', 'argument']), [[imported, false, [path.join(root, 'entry.cjs'), 'argument']]]);
  assert.deepEqual(success([...flags, '-e', report, 'argument']), [[imported, false, ['argument']]]);
  assert.deepEqual(success([...flags, '--input-type=module', '-e', report]), [[imported, null, []]]);
  assert.deepEqual(success([...flags, '-'], { input: report }), [[imported, false, ['-']]]);
  file('syntax-preload.mjs', `console.log(JSON.stringify('syntax-preload'));`);
  assert.deepEqual(success(['--import', './syntax-preload.mjs', '--check', 'entry.cjs']), ['syntax-preload']);
  const env = { ...process.env, NODE_OPTIONS: '--require ./pre.cjs --import ./a.mjs' };
  assert.deepEqual(success(['--require', './second.cjs', '--import', './b.mjs', 'entry.cjs'], { env }),
    [[imported, false, [path.join(root, 'entry.cjs')]]]);
  file('worker-main.cjs', `const {Worker}=require('node:worker_threads');const w=new Worker(${JSON.stringify(report)},{eval:true,stdout:true});w.stdout.pipe(process.stdout);w.on('error',e=>{throw e});w.on('exit',code=>{if(code)process.exitCode=code});`);
  assert.deepEqual(success([...flags, 'worker-main.cjs']), [[[...required, ['second', true]], false, ['[worker eval]']]]);
  file('worker-esm.cjs', `const {Worker}=require('node:worker_threads');const w=new Worker(${JSON.stringify('await Promise.resolve();' + report)},{eval:true,stdout:true});w.stdout.pipe(process.stdout);w.on('error',e=>{throw e});w.on('exit',code=>{if(code)process.exitCode=code});`);
  assert.deepEqual(success([...flags, 'worker-esm.cjs']), [[imported, null, ['[worker eval]']]]);
  file('throw.mjs', `throw new Error('preload-rejection-marker');`);
  file('forbidden.cjs', `console.log('ENTRY-MUST-NOT-RUN');`);
  let result = run(['--import', './throw.mjs', 'forbidden.cjs']);
  assert.equal(result.status, 1); assert.match(result.stderr, /preload-rejection-marker/); assert.equal(result.stdout, '');
  result = run(['--require', './missing.cjs', 'forbidden.cjs']);
  assert.equal(result.status, 1); assert.match(result.stderr, /MODULE_NOT_FOUND/); assert.equal(result.stdout, '');
  file('visible.cjs', `console.log('PRELOAD-MUST-NOT-RUN');`);
  for (const args of [['--check', '-e', '0'], ['--test', '-e', '0']]) {
    result = run(['-r', './visible.cjs', ...args]);
    assert.equal(result.status, 9); assert.equal(result.stdout, '');
  }
  for (const arg of ['--require=', '--import=']) {
    result = run([arg, '-e', '0']); assert.equal(result.status, 9); assert.equal(result.stdout, '');
  }
  console.log('preload lifecycle smoke: passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
