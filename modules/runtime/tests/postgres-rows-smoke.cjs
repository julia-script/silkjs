'use strict';
// Run unchanged under Node and Silk; diff stdout. A stand-in postgres.js
// connection.js (the loop and DataRow the loader patches, copied from
// postgres 3.4) decodes crafted DataRow runs under node_modules/postgres and,
// unpatched, under another path; both must agree, whether Silk's native rows
// (internal/postgres_rows) take the run or decline it to the package's code.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const connection = `'use strict'
module.exports = function decode(incoming, query, transform) {
  const result = []
  const other = []
  let rows = 0
  let length
  function DataRow(x) {
    let index = 7
    let length
    let column
    let value
    const row = query.isRaw ? new Array(query.statement.columns.length) : {}
    for (let i = 0; i < query.statement.columns.length; i++) {
      column = query.statement.columns[i]
      length = x.readInt32BE(index)
      index += 4
      value = length === -1
        ? null
        : query.isRaw === true
          ? x.subarray(index, index += length)
          : column.parser === undefined
            ? x.toString('utf8', index, index += length)
            : column.parser.array === true
              ? column.parser(x.toString('utf8', index + 1, index += length))
              : column.parser(x.toString('utf8', index, index += length))
      query.isRaw
        ? (row[i] = query.isRaw === true ? value : transform.value.from ? transform.value.from(value, column) : value)
        : (row[column.name] = transform.value.from ? transform.value.from(value, column) : value)
    }
    query.forEachFn
      ? query.forEachFn(transform.row.from ? transform.row.from(row) : row, result)
      : (result[rows++] = transform.row.from ? transform.row.from(row) : row)
  }
  function handle(x) { x[0] === 68 ? DataRow(x) : other.push(String.fromCharCode(x[0])) }
  function data() {
    while (incoming.length > 4) {
      length = incoming.readUInt32BE(1)
      if (length >= incoming.length) break
      handle(incoming.subarray(0, length + 1))
      incoming = incoming.subarray(length + 1)
    }
  }
  data()
  return { result, rows, other, rest: incoming.length }
}
`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-rows-'));
const patchedFile = path.join(root, 'node_modules', 'postgres', 'src', 'connection.js');
const plainFile = path.join(root, 'lib', 'connection.js');
for (const file of [patchedFile, plainFile]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, connection);
}
const patched = require(patchedFile);
const plain = require(plainFile);

function message(type, body) {
  const head = Buffer.alloc(5);
  head[0] = type.charCodeAt(0);
  head.writeUInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}
function dataRow(values) {
  const parts = [Buffer.alloc(2)];
  parts[0].writeUInt16BE(values.length);
  for (const value of values) {
    const size = Buffer.alloc(4);
    if (value === null) { size.writeInt32BE(-1); parts.push(size); continue; }
    const bytes = Buffer.from(value, 'utf8');
    size.writeInt32BE(bytes.length);
    parts.push(size, bytes);
  }
  return message('D', Buffer.concat(parts));
}
const toInteger = x => +x;
const toBoolean = x => x === 't';
const columns = [
  { name: 'id', type: 23, parser: toInteger },
  { name: 'first_name', type: 25 },
  { name: 'email', type: 1043 },
  { name: 'big', type: 20, parser: undefined },
  { name: 'small', type: 21, parser: toInteger },
  { name: 'active', type: 16, parser: toBoolean },
];
const none = { value: { from: undefined }, row: { from: undefined } };
function query(extra) { return { isRaw: false, forEachFn: undefined, statement: { columns }, ...extra }; }
const rows = [
  ['1', 'Ana', 'ana@example.com', '9007199254740993', '-5', 't'],
  ['2', 'José', 'josé@exämple.com', null, '0', 'f'],
  ['-0', '', null, '12', '32767', null],
  ['2147483648', 'x'.repeat(300), 'e', '1', '-32768', 't'],
  ['123456789012345', 'n', 'e', '1', '7', 'f'],
];
const cases = {
  plain: () => [Buffer.concat(rows.map(dataRow)), query(), none],
  trailing: () => [Buffer.concat([...rows.map(dataRow), message('C', Buffer.from('SELECT 5\0')), message('Z', Buffer.from('I'))]), query(), none],
  partial: () => { const all = Buffer.concat(rows.map(dataRow)); return [all.subarray(0, all.length - 3), query(), none]; },
  'not integer': () => [Buffer.concat([dataRow(['1.5', 'a', 'b', 'c', '1', 't']), dataRow(['12a', 'a', 'b', 'c', '1', 't']), dataRow(['1234567890123456', 'a', 'b', 'c', '1', 't'])]), query(), none],
  'wrong width': () => [Buffer.concat([dataRow(['1', 'a', 'b', 'c', '1', 't']), dataRow(['1', 'a'])]), query(), none],
  raw: () => [Buffer.concat(rows.map(dataRow)), query({ isRaw: 'values' }), none],
  transform: () => [Buffer.concat(rows.map(dataRow)), query(), { value: { from: v => typeof v }, row: { from: undefined } }],
  // Same length, same first 16 and last 8 bytes: only the compare tells them apart.
  repeated: () => [Buffer.concat([0, 1, 2, 1, 0].map(n => dataRow([String(n), `aaaaaaaaaaaaaaaa${n}${n}${n}bbbbbbbb`, 'same', null, '1', 't']))), query(), none],
  forEach: () => { const seen = []; return [Buffer.concat(rows.map(dataRow)), query({ forEachFn: row => seen.push(row.id) }), none]; },
};
const output = [];
function attempt(decode, input) {
  try { return decode(...input); }
  catch (error) { return { error: error.name, code: error.code, line: /connection\.js:(\d+)/.exec(error.stack)[1] }; }
}
for (const [name, make] of Object.entries(cases)) {
  const fast = attempt(patched, make());
  const slow = attempt(plain, make());
  assert.deepStrictEqual(fast, slow, name);
  if (fast.error) { output.push([name, fast]); continue; }
  for (const row of fast.result) if (!Array.isArray(row)) assert.deepStrictEqual(Object.keys(row), columns.map(c => c.name), name);
  output.push([name, fast.rows, fast.rest, fast.other.join(''), JSON.stringify(fast.result)]);
}
// Rows that share a columns array share their shape and stay ordinary objects.
const again = patched(...cases.plain());
again.result[0].extra = 1;
delete again.result[1].email;
assert.equal(again.result[0].extra, 1);
assert.equal('email' in again.result[1], false);
assert.equal(Object.getPrototypeOf(again.result[2]), Object.prototype);
fs.rmSync(root, { recursive: true, force: true });
for (const line of output) console.log(JSON.stringify(line));
console.log('postgres rows smoke ok');
