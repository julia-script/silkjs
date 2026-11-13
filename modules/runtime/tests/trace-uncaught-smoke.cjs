'use strict';

// Run unchanged with the exact Node reference and SilkJSRuntime: --trace-uncaught
// prints the stack of the throw, and a call that fails inside a built-in module
// names its callee as V8 does.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm');
// An error's trace is its stack from where it was made, as V8's message takes it.
for (const [value, column] of [['null', 16], ['undefined', 16], ['{ get stack() { throw 1 } }', 16], ['new Error("x")', 22]]) {
  const child = spawnSync(process.execPath, ['--trace-uncaught', '-e', `function f() { throw ${value}; }\nf();`], { encoding: 'utf8' });
  assert.equal(child.status, 1, value);
  assert.match(child.stderr, new RegExp(`^Thrown at:\n {4}at f \\(\\[eval\\]:1:${column}\\)\n {4}at \\[eval\\]:2:1$`, 'm'), value);
  assert.doesNotMatch(child.stderr, /--trace-uncaught \.\.\./, value);
}
const quiet = spawnSync(process.execPath, ['-e', 'throw null'], { encoding: 'utf8' });
assert.doesNotMatch(quiet.stderr, /Thrown at:/);
assert.match(quiet.stderr, /\(Use `.* --trace-uncaught \.\.\.` to show where the exception was thrown\)/);
assert.throws(() => new vm.Script('').runInNewContext.call('x'), /^TypeError: this\.runInContext is not a function$/);
console.log('ok');
