'use strict';

// Run under the pinned Node reference; argv[2] is the runtime under test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const reference = process.execPath;
const target = path.resolve(process.argv[2] || reference);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'silk-test-snapshots-'));
const file = path.join(root, 'entry.cjs');
const raw = path.join(root, 'nested', 'raw.txt');
const snapshots = file + '.snapshot';
const env = { ...process.env };
delete env.NODE_OPTIONS;
function run(executable, flags = [], extraEnv = {}) {
  return spawnSync(executable, [...flags, file], { cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 30000 });
}
function success(result) { assert.equal(result.status, 0, result.stderr + result.stdout); }
try {
  fs.writeFileSync(file, `
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const parent = ${JSON.stringify('parent \n ` ${literal}')};
if (process.env.SNAPSHOT_BAD_PATH) test.snapshot.setResolveSnapshotPath(() => process.env.SNAPSHOT_BAD_PATH);
const pipeline = [value => ({ wrapped: value }), value => JSON.stringify(value, null, 2)];
test.snapshot.setDefaultSnapshotSerializers(pipeline);
pipeline[0] = () => { throw new Error('serializer array was not copied'); };
test(parent, async t => {
  await t.test('child', child => {
    assert.equal(child.fullName, parent + ' > child');
    assert.equal(fs.realpathSync(child.filePath), fs.realpathSync(__filename));
    child.plan(2);
    child.assert.snapshot(process.env.SNAPSHOT_MISMATCH ? 'changed' : { unicode: 'π', escaped: ${JSON.stringify('` \\ ${value}')} });
    child.assert.snapshot('second');
  });
});
test('file and serialization boundaries', t => {
  t.assert.fileSnapshot('raw\\nπ', ${JSON.stringify(raw)}, { serializers: [value => value] });
  const input = {}, cause = new Error('serializer failure');
  assert.throws(() => t.assert.snapshot(input, { serializers: [() => { throw cause; }] }), error => error.code === 'ERR_INVALID_STATE' && error.input === input && error.cause === cause);
  for (const bad of [null, [], false]) assert.throws(() => t.assert.snapshot('x', bad), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.throws(() => test.snapshot.setDefaultSnapshotSerializers([null]), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.throws(() => test.snapshot.setResolveSnapshotPath(null), { code: 'ERR_INVALID_ARG_TYPE' });
  let reads = 0;
  t.assert.snapshot('getter', { get serializers() { reads++; return [value => value]; } });
  assert.equal(reads, 1);
});
`);
  // Persisted snapshots are interoperable in both directions, not just an
  // implementation-specific writer/reader roundtrip.
  success(run(reference, ['--test-update-snapshots']));
  assert.equal(fs.readFileSync(raw, 'utf8'), 'raw\nπ');
  success(run(target));
  fs.appendFileSync(snapshots, '\nexports[`obsolete 1`] = `stale`;\n');
  success(run(target, ['--test-update-snapshots']));
  const scope = { exports: Object.create(null) };
  require('node:vm').runInNewContext(fs.readFileSync(snapshots, 'utf8'), scope);
  assert.equal(Object.hasOwn(scope.exports, 'obsolete 1'), false);
  success(run(reference));
  const before = fs.readFileSync(snapshots);
  const mismatch = run(target, [], { SNAPSHOT_MISMATCH: '1' });
  assert.equal(mismatch.status, 1, mismatch.stderr + mismatch.stdout);
  assert.deepEqual(fs.readFileSync(snapshots), before);
  fs.unlinkSync(snapshots);
  const missing = run(target);
  assert.equal(missing.status, 1, missing.stderr + missing.stdout);
  assert.equal(fs.existsSync(snapshots), false);
  // Process-isolated CLI runs must inherit update mode before loading tests.
  success(run(target, ['--test', '--test-update-snapshots']));
  success(run(reference));
  // Last CLI flag wins; this option is deliberately forbidden in NODE_OPTIONS.
  fs.unlinkSync(snapshots);
  const disabled = run(target, ['--test-update-snapshots', '--no-test-update-snapshots']);
  assert.equal(disabled.status, 1, disabled.stderr + disabled.stdout);
  assert.equal(fs.existsSync(snapshots), false);
  assert.equal(run(target, [], { NODE_OPTIONS: '--test-update-snapshots' }).status, 9);
  const blocker = path.join(root, 'not-a-directory');
  fs.writeFileSync(blocker, 'block');
  const writeFailure = run(target, ['--test-update-snapshots'], { SNAPSHOT_BAD_PATH: path.join(blocker, 'snapshot') });
  assert.equal(writeFailure.status, 1, writeFailure.stderr + writeFailure.stdout);
  // Registered snapshot assertions take precedence over the built-in manager.
  fs.writeFileSync(file, `const test=require('node:test'),assert=require('node:assert/strict');test.assert.register('snapshot',function(value){assert.equal(this.name,'override');assert.equal(value,42)});test('override',t=>{t.plan(1);t.assert.snapshot(42)});`);
  success(run(target));
  console.log('test snapshot persistence and interoperability smoke: passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
