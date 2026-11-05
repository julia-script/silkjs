'use strict';
const assert = require('node:assert/strict');
const F = require('./wasm-fixtures.cjs');
const W = WebAssembly;
const U64_MAX = (1n << 64n) - 1n;
const maxBytes = [...Array(9).fill(0xff), 1];
const limits = (maximum = maxBytes) => [0x70, 5, 0, ...maximum];

// Declared bounds are independent of the physical allocation/growth limit.
for (const maximum of [F.unsigned(0x100000000), maxBytes]) {
  const bytes = F.binary({ tables: [limits(maximum)], exports: [F.exported('table', 1, 0)] });
  assert.equal(W.validate(bytes), true);
  const table = new W.Instance(new W.Module(bytes)).exports.table;
  assert.equal(table.length, 0n);
  assert.equal(table.grow(1n), 0n);
  assert.equal(table.length, 1n);
  assert.throws(() => table.grow(0x100000000n), RangeError);
  assert.equal(table.length, 1n);
}
const importTable = maximum => new W.Module(F.binary({
  imports: [F.named('host', 'table', 1, limits(maximum))],
  exports: [F.exported('table', 1, 0)],
}));
const wide = new W.Table({ element: 'anyfunc', address: 'i64', initial: 0n, maximum: U64_MAX });
assert.equal(new W.Instance(importTable(maxBytes), { host: { table: wide } }).exports.table, wide);
assert.throws(() => new W.Instance(importTable(F.unsigned(0x100000000)), { host: { table: wide } }), W.LinkError);
const narrower = new W.Table({ element: 'anyfunc', address: 'i64', initial: 0n, maximum: 0x100000000n });
assert.equal(new W.Instance(importTable(maxBytes), { host: { table: narrower } }).exports.table, narrower);
const table32 = F.binary({ tables: [[0x70, 1, 0, ...F.unsigned(0xffffffff)]], exports: [F.exported('table', 1, 0)] });
assert.equal(W.validate(table32), true);
assert.equal(new W.Instance(new W.Module(table32)).exports.table.length, 0);
assert.equal(W.validate(F.binary({ tables: [[0x70, 1, 0, ...F.unsigned(0x100000000)]] })), false);
assert.equal(W.validate(F.binary({ tables: [[0x70, 5, 2, 1]] })), false);

// The classic interpreter must consume i64 indices/deltas without narrowing.
const instructions = new W.Module(F.binary({
  types: [F.signature([F.I64], [F.I64]), F.signature([F.I64], [])],
  tables: [limits()],
  functions: [
    { type: 0, body: [0xd0, 0x70, 0x20, 0, 0xfc, 15, 0] },
    { type: 1, body: [0x20, 0, 0x25, 0, 0x1a] },
  ],
  exports: [F.exported('grow', 0, 0), F.exported('get', 0, 1), F.exported('table', 1, 0)],
}));
const ops = new W.Instance(instructions).exports;
assert.equal(ops.grow(1n), 0n);
assert.equal(ops.grow(0x100000000n), -1n);
assert.equal(ops.table.length, 1n);
ops.get(0n);
assert.throws(() => ops.get(0x100000000n), W.RuntimeError);

function withElements(bytes, expression, values = []) {
  // Active expression-form element segment, explicit table index zero.
  const payload = F.vector([[6, 0, ...expression, 0x70, ...F.vector(values)]]);
  return new Uint8Array([...bytes, 9, ...F.unsigned(payload.length), ...payload]);
}
const activeBase = F.binary({ tables: [[0x70, 5, 1, ...maxBytes]] });
for (const encoded of [F.unsigned(0x100000000), F.unsigned(0x100000001), [0x7f]]) {
  for (const values of [[], [[0xd0, 0x70, 0x0b]]]) {
    const bytes = withElements(activeBase, [0x42, ...encoded, 0x0b], values);
    assert.equal(W.validate(bytes), true);
    const compiled = new W.Module(bytes);
    assert.throws(() => new W.Instance(compiled), W.RuntimeError);
  }
}
new W.Instance(new W.Module(withElements(activeBase, [0x42, 1, 0x0b])));
const globalBase = F.binary({
  imports: [F.named('host', 'offset', 3, [F.I64, 0])],
  tables: [[0x70, 5, 1, ...maxBytes]],
});
const globalOffsets = new W.Module(withElements(globalBase, [0x23, 0, 0x0b]));
new W.Instance(globalOffsets, { host: { offset: 1n } });
assert.throws(() => new W.Instance(globalOffsets, { host: { offset: 0x100000000n } }), W.RuntimeError);
console.log('wasm table64 smoke: ok');
