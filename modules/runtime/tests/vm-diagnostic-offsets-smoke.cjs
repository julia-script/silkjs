'use strict';

// Run unchanged with the exact Node reference and SilkJSRuntime.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { getCallSites } = require('node:util');
const filename = 'vm-offsets-owned.js';
const realm = vm.createContext({ getCallSites });
const pair = site => [site.lineNumber, site.columnNumber];
const unsigned = value => value >>> 0;
const offsets = [
  [0, 0], [3, 7], [3, -7], [-2, -8], [-1, -1],
  [-2147483648, -2147483648], [2147483647, 2147483647],
];
for (const [lineOffset, columnOffset] of offsets) {
  const options = { filename, lineOffset, columnOffset };
  for (const prefix of ['', '\n', '\r\n', '\u2028', '/* 💩 */ ']) {
    const second = /[\n\r\u2028]/.test(prefix);
    const line = second ? 2 : 1;
    const column = second ? 1 : prefix.length + 1;
    const script = new vm.Script(prefix + 'getCallSites(1)', options);
    const site = script.runInContext(realm)[0];
    assert.deepEqual(pair(site), [unsigned(line + lineOffset), unsigned(column + (second ? 0 : columnOffset))]);
    assert.equal(site.scriptName, filename);
    assert.equal(script.runInContext(vm.createContext({ getCallSites }))[0].scriptId, site.scriptId);
  }
  for (const prefix of ['', '\n', '\r', '\u2029']) {
    const second = prefix !== '';
    const fn = vm.compileFunction(prefix + 'return getCallSites(1)', ['unused'], {
      ...options, parsingContext: realm, contextExtensions: [{}, { getCallSites }],
    });
    const site = fn()[0];
    assert.deepEqual(pair(site), [unsigned((second ? 2 : 1) + lineOffset), unsigned(8 + (second ? 0 : columnOffset))]);
  }
  for (const compile of [
    code => () => new vm.Script(code, options).runInContext(realm),
    code => vm.compileFunction(code, [], { ...options, parsingContext: realm }),
  ]) {
    const code = 'throw new Error("offset marker")';
    const line = (1 + lineOffset) | 0;
    const column = (7 + columnOffset) | 0;
    const coordinate = filename + (line === 0 ? '' : ':' + line + (column === 0 ? '' : ':' + column));
    assert.throws(compile(code), error => {
      assert.ok(error.stack.split('\n').some(frame => frame.includes('at ') && (frame.endsWith(coordinate) || frame.endsWith(coordinate + ')'))));
      return true;
    });
  }
}

const nested = 'function inner(){return getCallSites(2)} inner()';
const nestedScript = new vm.Script(nested, { filename, lineOffset: 9, columnOffset: 11 });
const nestedSites = nestedScript.runInContext(realm);
assert.deepEqual(nestedSites.map(pair), [[10, nested.indexOf('getCallSites') + 12], [10, nested.lastIndexOf('inner()') + 12]]);
assert.equal(nestedSites[0].scriptId, nestedSites[1].scriptId);

// Reusing bytecode with different offsets must not mutate the producer or clones.
const source = 'getCallSites(1)';
const original = new vm.Script(source, { filename, lineOffset: 4, columnOffset: 8 });
const originalSite = original.runInContext(realm)[0];
const cached = new vm.Script(source, { filename, lineOffset: -2, columnOffset: -8, cachedData: original.createCachedData() });
assert.equal(cached.cachedDataRejected, false);
assert.deepEqual(pair(cached.runInContext(realm)[0]), [4294967295, 4294967289]);
assert.deepEqual(pair(original.runInContext(realm)[0]), [5, 9]);
assert.deepEqual(pair(original.runInNewContext({ getCallSites })[0]), [5, 9]);
assert.equal(original.runInContext(realm)[0].scriptId, originalSite.scriptId);
const fnOptions = { filename, parsingContext: realm, produceCachedData: true, lineOffset: 4, columnOffset: 8 };
const originalFn = vm.compileFunction('return getCallSites(1)', [], fnOptions);
const cachedFn = vm.compileFunction('return getCallSites(1)', [], {
  ...fnOptions, lineOffset: -2, columnOffset: -8, cachedData: originalFn.cachedData,
});
assert.equal(cachedFn.cachedDataRejected, false);
assert.deepEqual(pair(originalFn()[0]), [5, 16]);
assert.deepEqual(pair(cachedFn()[0]), [4294967295, 0]);

// Eval starts a new coordinate space; only the caller retains the VM offsets.
for (const expression of ['eval("getCallSites(2)")', '(0,eval)("getCallSites(2)")']) {
  const sites = new vm.Script(expression, { filename, lineOffset: 8, columnOffset: 6 }).runInContext(realm);
  assert.equal(sites[0].scriptName, '');
  assert.deepEqual(pair(sites[0]), [1, 1]);
  assert.equal(sites[1].scriptName, filename);
  assert.equal(sites[1].lineNumber, 9);
}

// Diagnostic lines/carets use the unmodified source, not padded/wrapped input.
for (const lineOffset of [3, -2, 2147483647]) {
  for (const prefix of ['', '\n', '\r\n', '\u2028']) {
    for (const columnOffset of [7, -9]) {
      const code = prefix + 'let a = ;';
      for (const make of [
        () => new vm.Script(code, { filename, lineOffset, columnOffset }),
        () => vm.compileFunction(code, [], { filename, lineOffset, columnOffset }),
      ]) {
        assert.throws(make, error => {
          assert.equal(error.name, 'SyntaxError');
          const lines = error.stack.split('\n');
          assert.equal(lines[0], filename + ':' + (((prefix ? 2 : 1) + lineOffset) | 0));
          assert.equal(lines[1], 'let a = ;');
          assert.equal(lines[2], '        ' + (!prefix && columnOffset === -9 ? '' : '^'));
          return true;
        });
      }
    }
  }
}

const unnamed = vm.compileFunction('return getCallSites(1)', ['getCallSites'], { lineOffset: 2, columnOffset: 4 })(getCallSites)[0];
assert.equal(unnamed.scriptName, '');
assert.deepEqual(pair(unnamed), [3, 12]);

// Neither strict directives nor continuations acquire prefix bytes/newlines.
assert.equal(vm.compileFunction('"use strict"; return this', [], { lineOffset: 20, columnOffset: 30 })(), undefined);
assert.equal(new vm.Script('"a\\\nb"', { lineOffset: 20, columnOffset: 30 }).runInThisContext(), 'ab');
console.log('vm-diagnostic-offsets smoke passed');
