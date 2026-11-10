'use strict';
const assert = require('node:assert/strict');

// Separate process: reserves a full Wasm32 address space, touching only its tail.
// A 4-GiB ArrayBuffer length does not fit u32, even though its last offset does.
const memory = new WebAssembly.Memory({ initial: 65536, maximum: 65536 });
const buffer = memory.buffer;
assert.equal(buffer.byteLength, 4294967296);
const bytes = new Uint8Array(buffer);
assert.equal(bytes.length, 4294967296);
bytes[4294967295] = 117;
const end = new DataView(buffer, 4294967292, 4);
assert.equal(end.byteLength, 4);
assert.equal(end.getUint8(3), 117);
assert.equal(memory.grow(0), 65536);
assert.equal(buffer.byteLength, 0);
assert.equal(bytes.length, 0);
assert.equal(memory.buffer.byteLength, 4294967296);
assert.equal(new DataView(memory.buffer, 4294967292, 4).getUint8(3), 117);
assert.throws(() => memory.grow(1), RangeError);
console.log('WebAssembly full Wasm32 range smoke passed');

// Memory64 additionally needs property keys and byte offsets above UINT32_MAX.
// Like the Wasm32 case, this reserves virtual space and touches only two pages.
const memory64 = new WebAssembly.Memory({ address: 'i64', initial: 262144n, maximum: 262144n });
const buffer64 = memory64.buffer;
assert.equal(buffer64.byteLength, 17179869184);
const bytes64 = new Uint8Array(buffer64);
assert.equal(bytes64.length, 17179869184);
bytes64[4294967296] = 91;
bytes64[17179869183] = 203;
assert.equal(Object.getOwnPropertyDescriptor(bytes64, '4294967296').value, 91);
assert.equal(new DataView(buffer64, 4294967296, 1).getUint8(0), 91);
assert.equal(new DataView(buffer64, 17179869183, 1).getUint8(0), 203);
assert.deepEqual([...new Uint8Array(buffer64.slice(17179869183))], [203]);
assert.equal(memory64.grow(0n), 262144n);
assert.equal(buffer64.byteLength, 0);
assert.equal(bytes64.length, 0);
assert.equal(memory64.buffer.byteLength, 17179869184);
assert.equal(new Uint8Array(memory64.buffer)[4294967296], 91);
assert.equal(new Uint8Array(memory64.buffer)[17179869183], 203);
assert.throws(() => memory64.grow(1n), RangeError);
console.log('WebAssembly full Memory64 range smoke passed');
