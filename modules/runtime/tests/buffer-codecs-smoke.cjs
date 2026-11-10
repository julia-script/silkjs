'use strict';
// Run unchanged under Node and Silk; diff stdout for the generated malformed,
// bounded-write and coercion cases. Assertions also lock down critical contracts.
const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const records = [];
function record(name, action) {
  try { records.push([name, action()]); }
  catch (error) { records.push([name, error.name, error.code || null]); }
}
function units(string) { return Array.from({ length: string.length }, (_, i) => string.charCodeAt(i)); }
const malformed = [
  [], [0], [0xef, 0xbb, 0xbf], [0x80, 0x80, 0x41], [0xc0, 0xaf], [0xc1, 0xbf],
  [0xc2], [0xc2, 0x41], [0xe0, 0x80, 0x80], [0xe0, 0xa0], [0xe1, 0x80, 0x41],
  [0xed, 0x9f, 0xbf], [0xed, 0xa0, 0x80], [0xf0, 0x80, 0x80, 0x80],
  [0xf0, 0x90, 0x80], [0xf1, 0x80, 0x41], [0xf4, 0x8f, 0xbf, 0xbf],
  [0xf4, 0x90, 0x80, 0x80], [0xf5, 0x80, 0x80, 0x80], [0xff, 0xfe, 0x41],
];
for (const bytes of malformed) {
  const buffer = Buffer.from(bytes);
  for (let start = 0; start <= buffer.length; start++) {
    for (let end = start; end <= buffer.length; end++) {
      record(['decode', bytes, start, end], () => units(buffer.toString('utf8', start, end)));
    }
  }
}
// Every possible leading byte with valid, constrained and truncated successors.
for (let first = 0; first < 256; first++) {
  for (const rest of [[], [0x80], [0xa0, 0x80], [0x90, 0x80, 0x80], [0xbf, 0x41]]) {
    record(['lead', first, rest], () => units(Buffer.from([first, ...rest]).toString()));
  }
}
const strings = ['', 'ASCII\0end', '\u0080\u07ff\u0800\uffff', '\ud800', '\udc00', '\ud800A', '\ud800\ud800\udc00', '\ud83d\ude00', '\ufeffA'];
for (const string of strings) {
  for (const encoding of ['utf8', 'utf-8', 'utf16le', 'ucs2']) {
    record(['from', units(string), encoding], () => [Buffer.byteLength(string, encoding), [...Buffer.from(string, encoding)]]);
    for (let limit = 0; limit <= 12; limit++) {
      record(['write', units(string), encoding, limit], () => {
        const backing = Buffer.alloc(18, 0x7f);
        const view = backing.subarray(2, 16);
        const written = view.write(string, 1, limit, encoding);
        return [written, [...backing]];
      });
    }
  }
}
assert.equal(Buffer.from([0xef, 0xbb, 0xbf]).toString(), '\ufeff');
assert.equal(Buffer.from([0xed, 0xa0, 0x80]).toString(), '\ufffd\ufffd\ufffd');
assert.equal(Buffer.from([0xe1, 0x80, 0x41]).toString(), '\ufffdA');
assert.equal(Buffer.from([0x00, 0xd8, 0, 0, 0xff]).toString('utf16le'), '\ud800\0');
for (const string of strings) assert.equal(Buffer.from(string, 'utf16le').toString('utf16le'), string);
for (let start = 0; start < 5; start++) {
  for (let end = start; end <= 5; end++) {
    record(['utf16-range', start, end], () => units(Buffer.from([0, 0xd8, 0, 0xdc, 0xff]).toString('utf16le', start, end)));
  }
}
const shared = new SharedArrayBuffer(16);
const sharedView = Buffer.from(shared, 3, 10);
assert.equal(sharedView.write('A\ud83d\ude00', 1, 5), 5);
assert.equal(sharedView.toString('utf8', 1, 6), 'A\ud83d\ude00');
assert.deepEqual([...new Uint8Array(shared)].slice(0, 4), [0, 0, 0, 0]);
for (const op of ['read', 'write', 'zero']) {
  record(['detached', op], () => {
    const backing = new ArrayBuffer(8);
    const view = Buffer.from(backing, 2, 4);
    backing.transfer();
    return op === 'read' ? view.toString() : view.write(op === 'zero' ? '' : 'x');
  });
}
for (const encoding of ['utf8', 'utf16le']) {
  for (const tracking of [false, true]) {
    for (const op of ['read', 'write', 'coercion-read', 'coercion-write', 'regrow']) {
      record(['resize', encoding, tracking, op], () => {
        const backing = new ArrayBuffer(12, { maxByteLength: 24 });
        const view = tracking ? Buffer.from(backing, 2) : Buffer.from(backing, 2, 8);
        view.fill(65);
        if (op === 'coercion-read') return units(view.toString(encoding, { valueOf() { backing.resize(1); return 0; } }));
        if (op === 'coercion-write') return view.write('AB', 0, 4, { toString() { backing.resize(1); return encoding; } });
        backing.resize(1);
        if (op === 'regrow') { backing.resize(12); return [view.write('AB', 0, 4, encoding), units(view.toString(encoding))]; }
        return op === 'read' ? units(view.toString(encoding)) : view.write('AB', encoding);
      });
    }
  }
}
for (const byteLength of [3, 5, 7]) {
  for (const offset of [0, 1, 3]) {
    for (const encoding of ['utf8', 'utf16le']) {
      record(['shrink-during-write', byteLength, offset, encoding], () => {
        const backing = new ArrayBuffer(12, { maxByteLength: 24 });
        const view = Buffer.from(backing, 2);
        const written = view.write('ABCD', offset, 5, { toString() { backing.resize(byteLength); return encoding; } });
        return [written, [...new Uint8Array(backing)]];
      });
    }
  }
}
for (const args of [['x', -1], ['x', 0, -1], ['x', 0, 8], ['x', 0, 1, 'bad'], [42], ['x', 0.5]]) {
  record(['invalid', args], () => Buffer.alloc(4).write(...args));
}
// Representative consumer sizes, without putting slow JS per-unit work in the
// assertion. Storage's quota-sized value is covered by its separate smoke.
for (const string of ['x'.repeat(12000), ('A\ud83d\ude00\0').repeat(4000)]) {
  assert.equal(Buffer.from(string).toString(), string);
  assert.equal(Buffer.from(string, 'utf16le').toString('utf16le'), string);
}
console.log(JSON.stringify(records));
