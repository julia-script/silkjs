'use strict';

// Run with --expose-gc on both SilkJSRuntime and the exact Node reference.
const assert = require('node:assert/strict');
const util = require('node:util');
const vm = require('node:vm');
const { getCallSites } = util;
assert.equal(typeof globalThis.gc, 'function');

const source = [
  'function outer() {',
  '  function inner() {',
  '    return getCallSites(3);',
  '  }',
  '  return inner();',
  '}',
  'outer();',
].join('\n');
const context = vm.createContext({ getCallSites });
const script = new vm.Script(source, { filename: 'callsites-owned.js' });
const first = script.runInContext(context);
assert.equal(first.length, 3);
assert.deepEqual(first.map(site => [site.functionName, site.lineNumber, site.columnNumber]), [
  ['inner', 3, 12], ['outer', 5, 10], ['', 7, 1],
]);
for (const site of first) {
  assert.equal(Object.getPrototypeOf(site), null);
  assert.deepEqual(Object.keys(site), ['functionName', 'scriptId', 'scriptName', 'lineNumber', 'columnNumber', 'column']);
  assert.equal(site.scriptName, 'callsites-owned.js');
  assert.match(site.scriptId, /^[1-9][0-9]*$/);
  assert.equal(site.scriptId, first[0].scriptId);
  assert.equal(site.column, site.columnNumber);
  for (const key of Object.keys(site)) {
    assert.deepEqual(Object.getOwnPropertyDescriptor(site, key), {
      value: site[key], writable: true, enumerable: true, configurable: true,
    });
  }
}
assert.equal(script.runInContext(context)[0].scriptId, first[0].scriptId);
assert.notEqual(new vm.Script(source + '\n// separate compilation', { filename: 'callsites-owned.js' }).runInContext(context)[0].scriptId, first[0].scriptId);
const serialized = JSON.stringify(first);
for (let i = 0; i < 4; i++) {
  vm.runInNewContext(source, { getCallSites }, { filename: 'callsites-owned.js' });
  globalThis.gc();
}
assert.equal(JSON.stringify(first), serialized);
first[0].functionName = 'mutated snapshot';
assert.equal(script.runInContext(context)[0].functionName, 'inner');

// Cached bytecode keeps one consistent identity across its whole function tree.
// Node may reuse a live compilation from its cache instead of deserializing.
const cached = script.createCachedData();
const loaded = new vm.Script(source, { filename: 'callsites-owned.js', cachedData: cached });
assert.equal(loaded.cachedDataRejected, false);
const loadedSites = loaded.runInContext(context);
assert.ok(loadedSites.every(site => site.scriptId === loadedSites[0].scriptId));
assert.equal(loaded.runInContext(context)[0].scriptId, loadedSites[0].scriptId);
assert.deepEqual(loadedSites.map(site => [site.functionName, site.lineNumber, site.columnNumber]),
  JSON.parse(serialized).map(site => [site.functionName, site.lineNumber, site.columnNumber]));

// A user-chosen compatibility-looking filename must never hide a real frame.
const spoof = vm.runInNewContext('getCallSites(1)', { getCallSites }, { filename: 'node:internal/util' });
assert.equal(spoof[0].scriptName, 'node:internal/util');
assert.equal(spoof[0].lineNumber, 1);
assert.equal(spoof[0].columnNumber, 1);

const fromEval = vm.runInNewContext(
  'eval("function fromEval(){return getCallSites(2)};fromEval()")',
  { getCallSites }, { filename: 'callsites-eval-parent.js' });
assert.equal(fromEval[0].functionName, 'fromEval');
assert.equal(fromEval[0].scriptName, '');
assert.equal(fromEval[0].lineNumber, 1);
assert.equal(fromEval[0].columnNumber, 28);
assert.equal(fromEval[0].scriptId, fromEval[1].scriptId);
assert.notEqual(fromEval[0].scriptId, first[0].scriptId);

for (const expression of ['util.getCallSites(1)', '(util.getCallSites)(1)', 'util["getCallSites"](1)', 'util?.getCallSites(1)']) {
  const expected = { 'util.getCallSites(1)': 6, '(util.getCallSites)(1)': 20, 'util["getCallSites"](1)': 21, 'util?.getCallSites(1)': 7 }[expression];
  assert.equal(vm.runInNewContext(expression, { util }, { filename: 'callsites-expression.js' })[0].columnNumber, expected);
}
for (const prefix of ['const face="\u{1f4a9}"; ', '/* unicode */\u2028', '/* carriage */\r', '/* pair */\r\n']) {
  const code = prefix + 'getCallSites(1)';
  const site = vm.runInNewContext(code, { getCallSites }, { filename: 'callsites-unicode.js' })[0];
  const newline = /[\r\n\u2028\u2029]/.test(prefix);
  assert.equal(site.lineNumber, newline ? 2 : 1);
  assert.equal(site.columnNumber, newline ? 1 : prefix.length + 1);
}

function namedCaller() { return getCallSites(1); }
assert.equal(namedCaller()[0].functionName, 'namedCaller');
Object.defineProperty(namedCaller, 'name', { get() { throw new Error('must not run a name accessor'); } });
assert.equal(namedCaller()[0].functionName, 'namedCaller');
const prepare = Error.prepareStackTrace;
const limit = Error.stackTraceLimit;
Error.prepareStackTrace = () => { throw new Error('must not format Error.stack'); };
Error.stackTraceLimit = 0;
assert.equal(namedCaller().length, 1);
Error.prepareStackTrace = prepare;
Error.stackTraceLimit = limit;

for (const count of [0, -1, 201, NaN, Infinity, 1.5]) {
  assert.throws(() => getCallSites(count), { code: 'ERR_OUT_OF_RANGE' });
}
for (const count of ['1', true, 1n, Symbol('count'), () => 1]) {
  assert.throws(() => getCallSites(count), { code: 'ERR_INVALID_ARG_TYPE' });
}
for (const options of [null, [], 1, 'x', () => {}]) {
  assert.throws(() => getCallSites(1, options), { code: 'ERR_INVALID_ARG_TYPE' });
}
assert.throws(() => getCallSites(null), { code: 'ERR_INVALID_ARG_TYPE' });
assert.throws(() => getCallSites({}, {}), { code: 'ERR_INVALID_ARG_TYPE' });
assert.throws(() => getCallSites({ sourceMap: 1 }), { code: 'ERR_INVALID_ARG_TYPE' });
assert.throws(() => getCallSites(1, { sourceMap: 1 }), { code: 'ERR_INVALID_ARG_TYPE' });
assert.equal(getCallSites(1, { sourceMaps: 'ignored plural spelling' }).length, 1);
function deep(depth, count) { if (depth) return deep(depth - 1, count); return getCallSites(count); }
assert.equal(deep(205, 200).length, 200);
assert.equal(deep(20, undefined).length, 10);
let reads = 0;
assert.equal(getCallSites(1, { get sourceMap() { reads++; return false; } }).length, 1);
assert.equal(reads, 3);
const sentinel = new Error('option getter');
assert.throws(() => getCallSites(0, { get sourceMap() { throw sentinel; } }), error => error === sentinel);
let coerced = false;
assert.throws(() => getCallSites({ valueOf() { coerced = true; return 1; } }, {}), { code: 'ERR_INVALID_ARG_TYPE' });
assert.equal(coerced, false);
const mapped = vm.runInNewContext('getCallSites(1, {sourceMap: true})', { getCallSites }, { filename: 'callsites-no-map.js' });
assert.equal(mapped[0].scriptName, 'callsites-no-map.js');
assert.equal(mapped[0].lineNumber, 1);
assert.equal(mapped[0].columnNumber, 1);
console.log('util-call-sites smoke passed');
