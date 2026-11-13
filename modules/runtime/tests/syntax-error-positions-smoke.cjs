'use strict';

// Run unchanged with the exact Node reference and SilkJSRuntime: V8 texts,
// caret columns and widths of early errors, and SyntaxError own keys.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const cases = [
  ['let abc; let abc;', "Identifier 'abc' has already been declared", 13, 1],
  ['function foo(){} let foo;', "Identifier 'foo' has already been declared", 21, 1],
  ['class Kls {} let Kls;', "Identifier 'Kls' has already been declared", 17, 1],
  ['let Kls; class Kls {}', "Identifier 'Kls' has already been declared", 9, 12],
  ['lbl: lbl: 1', "Label 'lbl' has already been declared", 5, 3],
  ['function g(xy, xy) { "use strict" }', 'Duplicate parameter name not allowed in this context', 15, 2],
  ['(xy, xy) => 1', 'Duplicate parameter name not allowed in this context', 5, 2],
  ['let qq; function qq(){}', "Identifier 'qq' has already been declared", 8, 1],
  ['const k = 1; function k(){}', "Identifier 'k' has already been declared", 13, 1],
  ['{ let z; var z; }', "Identifier 'z' has already been declared", 13, 1],
  ['a b', "Unexpected identifier 'b'", 2, 1],
  ['let 1x', 'Invalid or unexpected token', 4, 1],
];
for (const [source, message, column, width] of cases) {
  let error;
  try { new vm.Script(source, { filename: 'f.js' }); } catch (caught) { error = caught; }
  assert.ok(error instanceof SyntaxError, source);
  assert.equal(error.message, message, source);
  assert.deepEqual(Object.getOwnPropertyNames(error), ['stack', 'message'], source);
  assert.equal(error.fileName, undefined, source);
  assert.equal(error.lineNumber, undefined, source);
  const lines = error.stack.split('\n');
  assert.equal(lines[0], 'f.js:1', source);
  assert.equal(lines[1], source, source);
  assert.equal(lines[2], ' '.repeat(column) + '^'.repeat(width), source);
}
for (const source of ['var f; function f(){}', 'function f(){} function f(){}']) new vm.Script(source);
console.log('ok');
