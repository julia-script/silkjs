'use strict';

// Run under Node; argv[2] selects the runtime to compare with the host reference.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const target = path.resolve(process.argv[2] || process.execPath);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'silk-test-plan-'));
const file = path.join(root, 'plans.cjs');
try {
  fs.writeFileSync(file, `
const test = require('node:test'), assert = require('node:assert/strict');
test('wait true', t => { t.plan(1, { wait: true }); setTimeout(() => t.assert.equal(2, 2), 5); });
test('wait number', t => { t.plan(1, { wait: 1000 }); setImmediate(() => t.assert.ok(true)); });
test('wait zero timeout', t => { t.plan(1, { wait: 0 }); });
test('wait finite timeout', t => { t.plan(1, { wait: 5 }); });
test('no wait mismatch', t => { t.plan(1); });
test('over plan', t => { t.plan(1); t.assert.ok(true); t.assert.ok(true); });
test('test timeout interrupts plan', { timeout: 10 }, t => { t.plan(1, { wait: true }); });
test('hooks run after plan check', t => { t.plan(1); t.assert.ok(true); t.after(() => t.assert.ok(true)); });
test('assertion object captures plan', t => { const a = t.assert; t.plan(1); a.ok(true); });
test('validation does not install a plan', t => {
  for (const count of [undefined, null, true, '1']) assert.throws(() => t.plan(count), { code: 'ERR_INVALID_ARG_TYPE' });
  for (const count of [-1, 1.5, NaN, Infinity, 4294967296]) assert.throws(() => t.plan(count), { code: 'ERR_OUT_OF_RANGE' });
  for (const options of [null, [], false]) assert.throws(() => t.plan(1, options), { code: 'ERR_INVALID_ARG_TYPE' });
  for (const wait of [null, '1', {}]) assert.throws(() => t.plan(1, { wait }), { code: 'ERR_INVALID_ARG_TYPE' });
  for (const wait of [-1, NaN, Infinity, 2147483648]) assert.throws(() => t.plan(1, { wait }), { code: 'ERR_OUT_OF_RANGE' });
  t.plan(0, { wait: true });
  assert.throws(() => t.plan(0), { code: 'ERR_TEST_FAILURE' });
});
`);
  const driver = `const stream=require('node:test').run({files:[${JSON.stringify(file)}],isolation:'none'}),rows=[];stream.on('data',event=>{if(event.type==='test:pass'||event.type==='test:fail')rows.push([event.data.name,event.type,event.data.details.error?.failureType??null]);});stream.on('end',()=>console.log(JSON.stringify(rows.sort((a,b)=>a[0].localeCompare(b[0])))));stream.on('error',error=>{console.error(error);process.exitCode=1});`;
  const env = { ...process.env }; delete env.NODE_OPTIONS;
  function run(executable) {
    const result = spawnSync(executable, ['-e', driver], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout);
  }
  const expected = run(process.execPath);
  assert.equal(expected.find(row => row[0] === 'wait true')[1], 'test:pass');
  assert.equal(expected.find(row => row[0] === 'wait finite timeout')[2], 'testTimeoutFailure');
  assert.equal(expected.find(row => row[0] === 'validation does not install a plan')[1], 'test:pass');
  assert.deepEqual(run(target), expected);
  console.log('test assertion-plan lifecycle smoke: passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
