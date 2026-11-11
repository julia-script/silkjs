'use strict';
const assert = require('node:assert/strict');
const { I32, signature, named, exported, binary } = require('./wasm-fixtures.cjs');

(async () => {
  const structType = [0x5f, 1, I32, 1];
  const structModule = new WebAssembly.Module(binary({
    types: [structType, signature([], [[0x63, 0]])],
    functions: [{ type: 1, body: [0x41, 42, 0xfb, 0, 0] }],
    exports: [exported('make', 0, 0)],
  }));
  const object = new WebAssembly.Instance(structModule).exports.make();
  assert.equal(typeof object, 'object');
  assert.equal(Object.getPrototypeOf(object), null);
  assert.deepEqual(Reflect.ownKeys(object), []);
  assert.equal(Object.isExtensible(object), false);
  assert.throws(() => { object.field = 1; }, TypeError);
  assert.equal(new WebAssembly.Global({ value: 'structref' }, object).value, object);
  assert.equal(new WebAssembly.Global({ value: 'eqref' }, object).value, object);
  assert.throws(() => new WebAssembly.Global({ value: 'i31ref' }, object), TypeError);
  for (const type of ['eqref', 'i31ref']) {
    for (const value of [-1073741824, 0, 1073741823]) {
      assert.equal(new WebAssembly.Global({ value: type }, value).value, value);
    }
    for (const value of [-0, 1073741824, 0.5, {}, undefined]) {
      assert.throws(() => new WebAssembly.Global({ value: type }, value), TypeError);
    }
  }

  // Struct identity and its mutable field survive a call into another module
  // whose equivalent reference type has a different local type index.
  const consumer = new WebAssembly.Instance(new WebAssembly.Module(binary({
    types: [signature([], []), structType, signature([[0x63, 1]], [I32])],
    functions: [{ type: 2, body: [0x20, 0, 0xfb, 2, 1, 0] }],
    exports: [exported('read', 0, 0)],
  })));
  assert.equal(consumer.exports.read(object), 42);

  // try_table is the modern EH encoding, distinct from legacy try/catch.
  const modernEH = new WebAssembly.Instance(new WebAssembly.Module(binary({
    types: [signature([I32], []), signature([], [I32])],
    tags: [[0, 0]],
    functions: [{ type: 1, body: [
      0x02, I32, 0x1f, I32, 1, 0, 0, 0,
      0x41, 42, 0x08, 0, 0x0b, 0x0b,
    ] }],
    exports: [exported('caught', 0, 0)],
  })));
  assert.equal(modernEH.exports.caught(), 42);

  // Keep a SIMD operand live while the interpreter suspends in an import.
  const vector = value => [0xfd, 0x0c, value, ...Array(15).fill(0)];
  let finish;
  const simd = new WebAssembly.Instance(new WebAssembly.Module(binary({
    types: [signature([], []), signature([], [I32])],
    imports: [named('host', 'wait', 0, [0])],
    functions: [{ type: 1, body: [
      ...vector(1), 0x10, 0, ...vector(2), 0xfd, 0xae, 1, 0xfd, 0x1b, 0,
    ] }],
    exports: [exported('run', 0, 1)],
  })), { host: { wait: new WebAssembly.Suspending(() => new Promise(resolve => { finish = resolve; })) } });
  const result = WebAssembly.promising(simd.exports.run)();
  finish();
  assert.equal(await result, 3);
  console.log('WebAssembly GC, modern EH, and SIMD suspension smoke passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
