'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

async function exercise(filename) {
  const addon = require(filename);
  assert.equal(addon.moduleFilename, require('node:url').pathToFileURL(require.resolve(filename)).href);
  const values = addon.primitives();
  assert.equal(addon.pendingPrimitives(new Error('preserve pending identity')), true);
  assert.equal(values.text, 'A\0😀');
  assert.equal(values.latin, '\xff\0z');
  assert.equal(values.big, -0x123456789abcdef0ffffffffffffffffn);
  assert.equal(values.min, -(1n << 63n));
  assert.equal(values.date.getTime(), 123456789);
  assert.equal(values.symbol, Symbol.for('silk.fixture'));
  const instance = new addon.NativeValue(17);
  assert.equal(instance.value, 17);
  instance.value = 29;
  assert.equal(instance.value, 29);
  assert.equal(instance.check(), true);
  assert.equal(instance.constructor, addon.NativeValue);
  assert.equal(Object.getOwnPropertyDescriptor(addon.NativeValue.prototype, 'value').enumerable, true);
  assert.equal(Object.getOwnPropertyDescriptor(addon.NativeValue.prototype, 'check').enumerable, false);
  const buffers = addon.buffers();
  assert.equal(buffers.view[0], 1234);
  assert.ok(Buffer.isBuffer(buffers.buffer));
  assert.equal(buffers.buffer.buffer, buffers.backing);
  assert.equal(buffers.dataView.buffer, buffers.backing);
  assert.deepEqual([...buffers.external], [7, 42, 9]);
  buffers.buffer[0] = 55;
  assert.equal(new Uint8Array(buffers.backing)[4], 55);
  buffers.external[2] = 88;
  assert.equal(buffers.external[2], 88);
  assert.equal(await addon.promise(43, false), 43);
  const failure = new Error('native deferred rejection');
  await assert.rejects(addon.promise(failure, true), error => error === failure);
  const prototype = { inherited: true, shadow: true };
  const object = Object.create(prototype);
  object[3] = 'indexed'; object.own = true;
  Object.defineProperty(object, 'shadow', { value: false });
  object[Symbol('ignored')] = true;
  assert.deepEqual(addon.keys(object), [3, 'own', 'inherited']);
  const receiver = {};
  assert.equal(addon.invoke(function(arg) { assert.equal(this, receiver); return arg; }, receiver), receiver);
  const thrown = new Error('callback exception identity');
  assert.throws(() => addon.invoke(() => { throw thrown; }, receiver), error => error === thrown);
  addon.removeWrap(instance);
  assert.throws(() => instance.check.call({}));
  assert.equal(Object.getPrototypeOf(addon.external()), null);
  addon.detach(buffers.backing);
  assert.equal(buffers.backing.byteLength, 0);
  assert.equal(buffers.view.length, 0);
  const module = { exports: {} };
  process.dlopen(module, filename);
  assert.equal(module.exports.primitives().min, -(1n << 63n));
  assert.equal(module.exports.moduleFilename, '');
  assert.throws(() => process.dlopen({ exports: {} }, filename + '.missing'), { code: 'ERR_DLOPEN_FAILED' });
}

async function main() {
  if (process.argv[2] === '--fixture') return exercise(path.resolve(process.argv[3]));
  const executable = path.resolve(process.argv[2] || process.execPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'silk-napi-values-'));
  try {
    const filename = path.join(root, 'values.node');
    const compiler = process.env.CC || 'cc';
    const flags = process.platform === 'darwin' ? ['-bundle', '-undefined', 'dynamic_lookup'] : ['-shared', '-fPIC'];
    const compilation = spawnSync(compiler, ['-std=c11', ...flags,
      '-I', path.resolve(__dirname, '../vendor/node-api'), path.join(__dirname, 'fixtures/napi/values.c'), '-o', filename], { encoding: 'utf8' });
    if (compilation.error) throw compilation.error;
    assert.equal(compilation.status, 0, compilation.stderr);
    const result = spawnSync(executable, [__filename, '--fixture', filename], { encoding: 'utf8', timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, JSON.stringify(result));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
