'use strict';
// Runtime regression: category ownership, real producers, and committed JSON.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

async function child(file) {
  const { createTracing, getEnabledCategories } = require('node:trace_events');
  assert.equal(getEnabledCategories(), undefined);
  for (const options of [undefined, null, [], { categories: 'node' }, { categories: [1] }]) {
    assert.throws(() => createTracing(options), { code: 'ERR_INVALID_ARG_TYPE' });
  }
  assert.throws(() => createTracing({ categories: [] }), { code: 'ERR_TRACE_EVENTS_CATEGORY_REQUIRED' });
  const first = createTracing({ categories: ['node.async_hooks', 'node.fs.async', 'node.fs.sync', 'node.perf.usertiming', 'node.diagnostics_channel'] });
  const overlap = createTracing({ categories: ['node.async_hooks', 'node.async_hooks'] });
  assert.equal(first.enabled, false);
  first.enable(); first.enable(); overlap.enable();
  first.disable(); first.disable();
  assert.equal(getEnabledCategories(), 'node.async_hooks');
  overlap.disable();
  assert.equal(getEnabledCategories(), undefined);
  first.enable();
  const perf = require('node:perf_hooks').performance;
  perf.mark('trace-smoke-start');
  fs.statSync(__filename);
  await new Promise((resolve, reject) => fs.stat(__filename, error => error ? reject(error) : resolve()));
  await new Promise(resolve => setTimeout(resolve, 2));
  await Promise.resolve().then(() => {});
  require('node:diagnostics_channel').channel('trace-smoke').publish({});
  perf.mark('trace-smoke-end');
  perf.measure('trace-smoke-duration', 'trace-smoke-start', 'trace-smoke-end');
  first.disable();
  assert.equal(getEnabledCategories(), undefined);
  const events = JSON.parse(fs.readFileSync(file, 'utf8')).traceEvents;
  assert.ok(events.some(event => event.cat.includes('node.async_hooks') && event.name === 'PROMISE'));
  assert.ok(events.some(event => event.cat.includes('node.async_hooks') && /Timeout/.test(event.name)));
  assert.ok(events.some(event => event.cat.includes('node.fs.async') && event.ph === 'b'));
  assert.ok(events.some(event => event.cat.includes('node.fs.async') && event.ph === 'e'));
  assert.ok(events.some(event => event.cat.includes('node.fs.sync') && event.ph === 'B'));
  assert.ok(events.some(event => event.name === 'trace-smoke-start'));
  assert.ok(events.some(event => event.name === 'trace-smoke-duration' && event.dur >= 0));
  assert.ok(events.some(event => event.cat === 'node.diagnostics_channel' && event.name === 'trace-smoke'));
  for (const event of events) {
    assert.equal(event.pid, process.pid);
    assert.ok(Number.isInteger(event.tid) && event.tid > 0);
    assert.ok(Number.isFinite(event.ts) && event.ts >= 0);
  }
  const before = fs.readFileSync(file, 'utf8');
  fs.statSync(__filename);
  await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  const unknown = createTracing({ categories: ['silk.unknown.category'] });
  unknown.enable();
  fs.statSync(__filename);
  unknown.disable();
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  // Disabling all owners and re-enabling must append, never truncate.
  first.enable(); perf.mark('trace-smoke-reenabled'); first.disable();
  const appended = JSON.parse(fs.readFileSync(file, 'utf8')).traceEvents;
  assert.ok(appended.some(event => event.name === 'trace-smoke-start'));
  assert.ok(appended.some(event => event.name === 'trace-smoke-reenabled'));
  let warnings = 0;
  const warning = value => { if (value.message.includes('trace_events memory leak')) warnings++; };
  process.on('warning', warning);
  const owners = Array.from({ length: 11 }, () => createTracing({ categories: ['silk.unknown.category'] }));
  for (const owner of owners) { owner.enable(); owner.enable(); }
  for (const owner of owners) owner.disable();
  await new Promise(resolve => process.nextTick(resolve));
  process.removeListener('warning', warning);
  assert.equal(warnings, 1);
  const { Worker } = require('node:worker_threads');
  await new Promise((resolve, reject) => {
    const worker = new Worker(`const { parentPort } = require('node:worker_threads'); try { require('node:trace_events'); parentPort.postMessage('unexpected success'); } catch (error) { parentPort.postMessage(error.code); }`, { eval: true });
    worker.on('message', code => { try { assert.equal(code, 'ERR_TRACE_EVENTS_UNAVAILABLE'); } catch (error) { reject(error); } });
    worker.on('error', reject);
    worker.on('exit', code => code ? reject(new Error(`worker exited ${code}`)) : resolve());
  });
}
if (process.argv[2] === '--child') {
  child(process.argv[3]).catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'silk-trace-'));
  try {
    const file = path.join(directory, 'events.json');
    const result = spawnSync(process.execPath, [`--trace-event-file-pattern=${file}`, __filename, '--child', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const cliFile = path.join(directory, 'cli.json');
    const cli = spawnSync(process.execPath, ['--expose-gc', '--trace-event-categories=v8', `--trace-event-file-pattern=${cliFile}`,
      '-e', "require('node:assert/strict').equal(require('node:trace_events').getEnabledCategories(), 'v8'); gc();"], { encoding: 'utf8' });
    assert.equal(cli.status, 0, `${cli.stdout}\n${cli.stderr}`);
    const gcEvents = JSON.parse(fs.readFileSync(cliFile, 'utf8')).traceEvents.filter(event => event.name === 'SilkGC');
    assert.ok(gcEvents.some(event => event.ph === 'B'));
    assert.ok(gcEvents.some(event => event.ph === 'E'));
    console.log('trace events smoke ok');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
