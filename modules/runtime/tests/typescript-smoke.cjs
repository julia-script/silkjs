'use strict';
const assert = require('node:assert/strict');
const { stripTypeScriptTypes } = require('node:module');
const fixtures = require('./fixtures/typescript/reference.json');

// Strip-only fixtures preserve executable-token coordinates. Transform fixtures
// check execution rather than the parser's incidental pretty-printing.
for (const fixture of fixtures.cases) {
  if (fixture.error) {
    assert.throws(() => stripTypeScriptTypes(fixture.source, fixture.options),
      { name: fixture.error.name, code: fixture.error.code }, fixture.name);
    continue;
  }
  const output = stripTypeScriptTypes(fixture.source, fixture.options);
  if (fixture.output !== undefined) assert.equal(output, fixture.output, fixture.name);
  if (fixture.execute) {
    const target = { exports: {} };
    new Function('module', 'exports', output)(target, target.exports);
    assert.deepEqual(target.exports, fixture.result, fixture.name + ': transformed execution');
  }
  if (fixture.options?.sourceMap) {
    const prefix = '\n\n//# sourceMappingURL=data:application/json;base64,';
    const map = JSON.parse(Buffer.from(output.slice(output.lastIndexOf(prefix) + prefix.length), 'base64').toString());
    assert.equal(map.version, 3);
    assert.equal(map.sources[0], fixture.options.sourceUrl || '');
    assert.equal(output.includes('//# sourceURL='), false);
  }
  if (fixture.options?.sourceUrl && !fixture.options.sourceMap)
    assert.ok(output.endsWith('//# sourceURL=' + fixture.options.sourceUrl));
}

// Erasing types preserves the location of executable tokens and line endings.
const positions = fixtures.cases.find(item => item.name === 'positions-crlf-unicode');
const stripped = stripTypeScriptTypes(positions.source);
assert.equal(stripped.length, positions.source.length);
assert.equal(stripped.indexOf('module.exports'), positions.source.indexOf('module.exports'));
assert.deepEqual([...stripped.matchAll(/\r\n/g)].map(match => match.index),
  [...positions.source.matchAll(/\r\n/g)].map(match => match.index));

// Validation must not coerce inputs or change observable options getter order.
let coerced = false;
assert.throws(() => stripTypeScriptTypes({ toString() { coerced = true; return ''; } }),
  { code: 'ERR_INVALID_ARG_TYPE' });
assert.equal(coerced, false);
const accesses = [];
stripTypeScriptTypes('', {
  get sourceMap() { accesses.push('sourceMap'); return false; },
  get sourceUrl() { accesses.push('sourceUrl'); return ''; },
  get mode() { accesses.push('mode'); return 'strip'; },
});
assert.deepEqual(accesses, ['sourceMap', 'sourceUrl', 'mode']);
const sentinel = new Error('options getter');
assert.throws(() => stripTypeScriptTypes('', { get sourceMap() { throw sentinel; } }), error => error === sentinel);
assert.equal(stripTypeScriptTypes('', { mode: undefined, sourceMap: undefined, sourceUrl: undefined }), '');
assert.equal(stripTypeScriptTypes('', { unknownOption: true }), '');
assert.throws(() => stripTypeScriptTypes('', () => {}), { code: 'ERR_INVALID_ARG_TYPE' });

// The stripping API must never execute input, even when it is valid JavaScript.
globalThis.__typeStripExecutionSentinel = 0;
stripTypeScriptTypes('globalThis.__typeStripExecutionSentinel = 1;');
assert.equal(globalThis.__typeStripExecutionSentinel, 0);
delete globalThis.__typeStripExecutionSentinel;

assert.throws(() => stripTypeScriptTypes('enum Answer { Yes = 42 }', { sourceUrl: 'diagnostic.ts' }), error => {
  assert.equal(error.code, 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX');
  assert.ok(error.stack.includes('diagnostic.ts:1'));
  assert.ok(error.stack.includes('enum Answer'));
  return true;
});
console.log('TypeScript stripping, transformation, diagnostics, maps and execution smoke passed');
