'use strict';
// Native safety regression, intentionally stronger than Node 24.22.2: deleting
// Storage from its warning callback fatally aborts that reference binary.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const mode = process.argv[2];
if (mode) {
  const original = process.emitWarning;
  const failure = new Error('initializer warning failed');
  let calls = 0;
  let nested;
  process.emitWarning = () => {
    calls++;
    // Force shape and property-array changes while the initializer is active.
    for (let i = 0; i < 2048; i++) globalThis[`storageReentrant${i}`] = i;
    if (mode === 'delete') delete globalThis.Storage;
    else if (mode === 'data') Object.defineProperty(globalThis, 'Storage', { value: 123, writable: false, configurable: false });
    else if (mode === 'accessor') Object.defineProperty(globalThis, 'Storage', { get() { return 456; }, configurable: true });
    else if (mode === 'assign') globalThis.Storage = 789;
    else if (mode === 'recursive') nested = globalThis.Storage;
    else if (mode === 'throw') { gc(); throw failure; }
    gc();
  };
  try {
    if (mode === 'throw') {
      assert.throws(() => globalThis.Storage, error => error === failure);
      assert.equal(globalThis.Storage, undefined);
    } else {
      const value = globalThis.Storage;
      if (mode === 'delete') {
        assert.equal(value, undefined);
        assert.equal(Object.prototype.hasOwnProperty.call(globalThis, 'Storage'), false);
      } else if (mode === 'data') {
        assert.equal(value, 123);
        assert.equal(Object.getOwnPropertyDescriptor(globalThis, 'Storage').configurable, false);
      } else if (mode === 'accessor') {
        assert.equal(value, 456);
        assert.equal(typeof Object.getOwnPropertyDescriptor(globalThis, 'Storage').get, 'function');
      } else if (mode === 'assign') assert.equal(value, 789);
      else {
        assert.equal(typeof value, 'function');
        assert.equal(value, globalThis.Storage);
        if (mode === 'recursive') assert.equal(nested, undefined);
      }
    }
    assert.equal(calls, 1);
    assert.equal(globalThis.storageReentrant2047, 2047);
  } finally {
    process.emitWarning = original;
    for (let i = 0; i < 2048; i++) delete globalThis[`storageReentrant${i}`];
  }
} else {
  for (const operation of ['grow', 'delete', 'data', 'accessor', 'assign', 'recursive', 'throw']) {
    const result = spawnSync(process.execPath, ['--expose-gc', '--experimental-webstorage', __filename, operation], {
      encoding: 'utf8', timeout: 30000,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${operation}: ${result.stdout}\n${result.stderr}`);
  }
  console.log('Web Storage lazy initialization reentrancy safety smoke passed');
}
