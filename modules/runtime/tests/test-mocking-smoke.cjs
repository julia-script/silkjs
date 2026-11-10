'use strict';
const assert = require('node:assert/strict');
const { test, mock } = require('node:test');
const timers = require('node:timers');
const promises = require('node:timers/promises');

test('function construction, recursion, one-shot overrides and restoration', t => {
  function Original(value) { this.value = value; }
  const Constructor = t.mock.fn(Original, function(value) { this.value = value * 2; });
  const value = new Constructor(3);
  assert.ok(value instanceof Original);
  assert.equal(value.value, 6);
  assert.equal(Constructor.mock.calls[0].target, Original);
  assert.equal(Constructor.mock.calls[0].this, value);
  let recursive = t.mock.fn(n => n ? recursive(n - 1) + 1 : 0);
  assert.equal(recursive(2), 2);
  assert.deepEqual(recursive.mock.calls.map(call => call.arguments[0]), [0, 1, 2]);
  const fn = t.mock.fn(() => 'original', () => 'mock', { times: 1 });
  fn.mock.mockImplementationOnce(() => 'once', 1);
  assert.deepEqual([fn(), fn(), fn()], ['mock', 'once', 'original']);
  fn.mock.resetCalls();
  assert.equal(fn.mock.callCount(), 0);
  assert.throws(() => t.mock.fn(() => {}, () => {}, { times: null }), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.throws(() => fn.mock.mockImplementationOnce(() => {}, -1), { code: 'ERR_OUT_OF_RANGE' });
  const prototype = { method() { return 'original'; } };
  const object = Object.create(prototype);
  const method = t.mock.method(object, 'method', () => 'mock');
  method.mock.restore();
  assert.equal(object.method(), 'original');
  assert.equal(method(), 'mock');
  assert.equal(Object.hasOwn(object, 'method'), true);
  let assigned;
  const accessor = { get value() { return 1; }, set value(value) { assigned = value; } };
  const getter = t.mock.getter(accessor, 'value', () => 2, { times: 1 });
  assert.equal(accessor.value, 2);
  assert.equal(accessor.value, 1);
  assert.equal(getter(), 2);
  t.mock.setter(accessor, 'value', value => { assigned = value * 2; });
  accessor.value = 3;
  assert.equal(assigned, 6);
  t.mock.restoreAll();
  accessor.value = 4;
  assert.equal(assigned, 4);
  assert.throws(() => t.mock.getter(accessor, 'value', { setter: true }), { code: 'ERR_INVALID_ARG_VALUE' });
});

test('promise timers, cancellation, interval disposal and clock restoration', async t => {
  const originals = [globalThis.setTimeout, promises.setTimeout, promises.setInterval, promises.setImmediate, Date];
  t.mock.timers.enable({ now: 100 });
  const payload = {};
  const pending = promises.setTimeout(5, payload);
  const immediate = promises.setImmediate(payload);
  const controller = new AbortController();
  controller.signal.addEventListener('abort', event => event.stopImmediatePropagation());
  const canceled = promises.setTimeout(100, payload, { signal: controller.signal });
  const canceledCheck = assert.rejects(canceled, error => error.code === 'ABORT_ERR' && error.cause === payload);
  controller.abort(payload);
  t.mock.timers.tick(5);
  assert.equal(await pending, payload);
  assert.equal(await immediate, payload);
  await canceledCheck;
  assert.equal(Date.now(), 105);
  const intervals = promises.setInterval(2, payload);
  const first = intervals.next();
  t.mock.timers.tick(2);
  assert.equal((await first).value, payload);
  await intervals.return();
  const abortInterval = new AbortController();
  const iterable = promises.setInterval(2, payload, { signal: abortInterval.signal });
  const waiting = iterable.next();
  const rejected = assert.rejects(waiting, { code: 'ABORT_ERR' });
  abortInterval.abort();
  await rejected;
  let called = false;
  const handle = timers.setTimeout(() => { called = true; }, 3);
  handle[Symbol.dispose]();
  t.mock.timers.tick(3);
  assert.equal(called, false);
  t.mock.timers.reset();
  assert.deepEqual([globalThis.setTimeout, promises.setTimeout, promises.setInterval, promises.setImmediate, Date], originals);
});

test('test-local mocks and clocks are restored before the next child', async t => {
  const object = { value() { return 1; } };
  const nativeTimeout = globalThis.setTimeout;
  await t.test('owner', child => {
    child.mock.method(object, 'value', () => 2);
    child.mock.timers.enable({ apis: ['setTimeout'] });
    assert.equal(object.value(), 2);
  });
  await t.test('next consumer', () => {
    assert.equal(object.value(), 1);
    assert.equal(globalThis.setTimeout, nativeTimeout);
  });
});

if (typeof mock.module === 'function') {
  test('module mocks preserve CJS, ESM and builtin identities with scoped restoration', async t => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { pathToFileURL } = require('node:url');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'silk-test-mock-'));
    const cjs = path.join(directory, 'original.cjs');
    const esm = path.join(directory, 'original.mjs');
    const consumer = path.join(directory, 'consumer.mjs');
    fs.writeFileSync(cjs, 'module.exports = { original: true };');
    fs.writeFileSync(esm, 'export const original = true; export default { original };');
    const installer = path.join(directory, 'install.cjs');
    fs.writeFileSync(installer, 'module.exports = (mock, value) => mock.module(\"./original.cjs\", { exports: { default: value } });');
    fs.writeFileSync(consumer, 'import value, { identity } from "./original.mjs"; export { value, identity };');
    try {
      const original = require(cjs);
      const originalESM = await import(pathToFileURL(esm).href);
      const identity = { function: () => 42 };
      for (const cache of [false, true]) {
        const mocked = t.mock.module(cjs, { cache, exports: { identity } });
        const a = require(cjs);
        const b = require(cjs);
        assert.equal(a === b, cache);
        assert.equal(a.identity, identity);
        const x = await import(pathToFileURL(cjs).href);
        const y = await import(pathToFileURL(cjs).href);
        assert.equal(x === y, cache);
        assert.equal(x.default === a, cache);
        assert.equal(x.identity, identity);
        assert.throws(() => t.mock.module(cjs), { code: 'ERR_INVALID_STATE' });
        mocked.restore();
        mocked.restore();
        assert.equal(require(cjs), original);
      }
      const mockedESM = t.mock.module(pathToFileURL(esm), { cache: true, exports: { default: identity, identity } });
      const imported = await import(pathToFileURL(consumer).href);
      assert.equal(imported.value, identity);
      assert.equal(imported.identity, identity);
      assert.equal(require(esm), identity);
      mockedESM.restore();
      assert.equal(await import(pathToFileURL(esm).href), originalESM);
      const builtin = t.mock.module('node:path', { cache: true, exports: { identity } });
      const builtinCJS = require('path');
      assert.equal(require('node:path'), builtinCJS);
      const builtinESM = await import('node:path');
      const relative = require(installer)(t.mock, identity);
      assert.equal(require(cjs), identity);
      relative.restore();
      assert.equal(builtinESM.default, builtinCJS);
      assert.equal(builtinESM.identity, identity);
      builtin.restore();
      assert.equal(require('node:path'), path);
      await t.test('module owner', child => {
        child.mock.module(cjs, { exports: { default: identity } });
        assert.equal(require(cjs), identity);
      });
      assert.equal(require(cjs), original);
    } finally {
      t.mock.reset();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
