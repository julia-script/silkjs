'use strict';

// Run on the exact Node 24 reference and SilkJSRuntime after loader integration.
const assert = require('node:assert/strict');
const { SourceMap, findSourceMap, getSourceMapsSupport, setSourceMapsSupport } = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const payload = {
  version: 3, sourceRoot: '/not-applied-by-constructor/', sources: ['original.ts'],
  names: ['originalName'], mappings: 'EACGA,K,GAEE;AACA', extra: { retained: true },
};
const lengths = [30, 20];
const map = new SourceMap(payload, { lineLengths: lengths });
assert.deepEqual(map.findEntry(0, 1), {});
assert.deepEqual(map.findEntry(-1, 100), {});
assert.deepEqual(map.findEntry(0, 2), {
  generatedLine: 0, generatedColumn: 2, originalSource: 'original.ts',
  originalLine: 1, originalColumn: 3, name: 'originalName',
});
assert.deepEqual(map.findEntry(0, 6), map.findEntry(0, 2));
assert.deepEqual(map.findEntry(0, 7), {
  generatedLine: 0, generatedColumn: 7, originalSource: undefined,
  originalLine: undefined, originalColumn: undefined, name: undefined,
});
assert.deepEqual(map.findOrigin(1, 8), {});
assert.deepEqual(map.findOrigin(1, 6), {
  name: 'originalName', fileName: 'original.ts', lineNumber: 2, columnNumber: 7,
});
assert.deepEqual(map.findEntry(100, 100), map.findEntry(1, 0));
assert.deepEqual(map.findOrigin(5, 10), {
  name: 'originalName', fileName: 'original.ts', lineNumber: 8, columnNumber: 15,
});
assert.equal(map.findEntry(0, 10).name, undefined);
// Node's EOF decoder reads names[0] on a terminal four-field segment.
assert.equal(map.findEntry(1, 0).name, 'originalName');
payload.sources[0] = 'changed.ts';
assert.equal(map.payload.sources[0], 'original.ts');
const returned = map.payload;
returned.sources[0] = 'also-changed.ts';
assert.equal(map.payload.sources[0], 'original.ts');
assert.equal(map.payload.extra, payload.extra);
lengths[0] = 99;
assert.deepEqual(map.lineLengths, [99, 20]);
map.lineLengths[0] = 1;
assert.deepEqual(map.lineLengths, [99, 20]);
assert.equal(new SourceMap({ sources: [], mappings: '' }, { lineLengths: [] }).lineLengths, undefined);

const indexed = new SourceMap({ version: 3, sections: [
  { offset: { line: 2, column: 3 }, map: { sources: ['first.ts'], names: [], mappings: 'AAAA;AACA;' } },
  { offset: { line: 5, column: 7 }, map: { sources: ['second.ts'], names: [], mappings: 'AACG;' } },
] });
assert.deepEqual(indexed.findEntry(2, 2), {});
assert.equal(indexed.findEntry(2, 3).originalSource, 'first.ts');
assert.equal(indexed.findEntry(3, 0).generatedColumn, 0);
assert.equal(indexed.findEntry(5, 6).originalSource, 'first.ts');
assert.deepEqual(indexed.findOrigin(6, 8), {
  name: undefined, fileName: 'second.ts', lineNumber: 2, columnNumber: 4,
});
for (const value of [undefined, null, [], true, 1, 'map']) {
  assert.throws(() => new SourceMap(value), { code: 'ERR_INVALID_ARG_TYPE' });
}
for (const value of [undefined, null, [], true, 1, {}, 'node:fs']) assert.equal(findSourceMap(value), undefined);

const previous = getSourceMapsSupport();
const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'silk-source-maps-')));
const sourceURL = name => pathToFileURL(path.join(directory, name + '.js')).href;
const flat = { version: 3, sources: ['original.ts'], sourceRoot: './src/', names: [], mappings: 'AAAA;' };
const inline = 'data:application/json;base64,' + Buffer.from(JSON.stringify(flat)).toString('base64');
function evaluate(name, mappingURL) {
  const source = '0;\n//# sourceURL=' + sourceURL(name) + '\n//# sourceMappingURL=' + mappingURL;
  (0, eval)(source);
  return source;
}
(async () => {
try {
  setSourceMapsSupport(true);
  const support = getSourceMapsSupport();
  assert.equal(Object.getPrototypeOf(support), null);
  assert.equal(Object.isFrozen(support), true);
  assert.deepEqual({ ...support }, { enabled: true, nodeModules: false, generatedCode: false });
  assert.equal(process.sourceMapsEnabled, true);
  for (const options of [null, [], true, () => {}]) {
    assert.throws(() => setSourceMapsSupport(true, options), { code: 'ERR_INVALID_ARG_TYPE' });
  }
  assert.throws(() => setSourceMapsSupport(1), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.throws(() => setSourceMapsSupport(true, { nodeModules: 1 }), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.throws(() => setSourceMapsSupport(true, { generatedCode: 1 }), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.equal(getSourceMapsSupport(), support);
  const source = evaluate('inline', inline);
  const inlineMap = findSourceMap(sourceURL('inline'));
  assert.ok(inlineMap instanceof SourceMap);
  assert.equal(findSourceMap(path.join(directory, 'inline.js')), inlineMap);
  assert.equal(inlineMap.payload.sourceRoot, '');
  assert.equal(inlineMap.findEntry(0, 0).originalSource, pathToFileURL(path.join(directory, 'src/original.ts')).href);
  assert.deepEqual(inlineMap.lineLengths, source.split('\n').map(line => line.length));
  for (const [name, suffix, retained] of [
    ['template-comment', 'void `\n//# sourceMappingURL=missing.map\n`;', false],
    ['block-comment', '/*# sourceMappingURL=missing.map */', false],
    ['extra-marker-space', '//#  sourceMappingURL=missing.map', false],
    ['empty-directive', '//# sourceMappingURL=', true],
    ['invalid-directive-token', '//# sourceMappingURL=' + inline + ' extra', true],
    ['unicode-marker-space', '//#\u00a0sourceMappingURL=' + inline, true],
  ]) {
    const filename = sourceURL(name);
    (0, eval)('0;\n//# sourceURL=' + filename + '\n//# sourceMappingURL=' + inline + '\n' + suffix);
    assert.equal(findSourceMap(filename) instanceof SourceMap, retained, name);
  }
  fs.writeFileSync(path.join(directory, 'external.map'), JSON.stringify(flat));
  evaluate('external', 'external.map');
  assert.equal(findSourceMap(sourceURL('external')).findOrigin(1, 1).lineNumber, 1);
  evaluate('bad-json', 'data:application/json;base64,' + Buffer.from('{').toString('base64'));
  assert.equal(findSourceMap(sourceURL('bad-json')), undefined);
  evaluate('network', 'https://invalid.example/map.json');
  assert.equal(findSourceMap(sourceURL('network')), undefined);
  evaluate('absolute-map-url', pathToFileURL(path.join(directory, 'external.map')).href);
  assert.equal(findSourceMap(sourceURL('absolute-map-url')), undefined);
  evaluate('percent-data', 'data:application/json,' + encodeURIComponent(JSON.stringify(flat)));
  assert.equal(findSourceMap(sourceURL('percent-data')), undefined);
  const cjsFilename = path.join(directory, 'consumer.cjs');
  const cjsSource = 'exports.capture = options => require("node:util").getCallSites(1, options)[0];\n' +
    '//# sourceMappingURL=external.map';
  fs.writeFileSync(cjsFilename, cjsSource);
  const consumer = require(cjsFilename);
  const cjsMap = findSourceMap(cjsFilename);
  const originalURL = pathToFileURL(path.join(directory, 'src/original.ts')).href;
  assert.ok(cjsMap instanceof SourceMap);
  assert.deepEqual(cjsMap.lineLengths, cjsSource.split('\n').map(line => line.length));
  assert.equal(consumer.capture({ sourceMap: true }).scriptName, originalURL);
  assert.equal(consumer.capture({ sourceMap: false }).scriptName, cjsFilename);
  assert.equal(consumer.capture().scriptName, previous.enabled ? originalURL : cjsFilename);
  assert.equal(Object.getPrototypeOf(consumer.capture({ sourceMap: true })), null);
  assert.equal(Object.hasOwn(consumer.capture({ sourceMap: true }), 'scriptId'), false);

  const esmFilename = path.join(directory, 'consumer.mjs');
  const esmSource = 'import { getCallSites } from "node:util";\n' +
    'export const capture = options => getCallSites(1, options)[0];\n' +
    'export const metadata = { url: import.meta.url, filename: import.meta.filename };\n' +
    'export const load = () => import("./mapped-dependency.mjs");\n' +
    '//# sourceMappingURL=' + inline;
  fs.writeFileSync(esmFilename, esmSource);
  const dependencyFilename = path.join(directory, 'mapped-dependency.mjs');
  fs.writeFileSync(dependencyFilename, 'export const marker = 42; export const url = import.meta.url;');
  const esm = await import(pathToFileURL(esmFilename).href);
  assert.ok(findSourceMap(esmFilename) instanceof SourceMap);
  assert.deepEqual(findSourceMap(esmFilename).lineLengths, esmSource.split('\n').map(line => line.length));
  assert.equal(esm.capture({ sourceMap: true }).scriptName, originalURL);
  assert.equal(esm.capture({ sourceMap: false }).scriptName, pathToFileURL(esmFilename).href);
  assert.deepEqual(esm.metadata, { url: pathToFileURL(esmFilename).href, filename: esmFilename });
  const dependency = await esm.load();
  assert.equal(dependency.marker, 42);
  assert.equal(dependency.url, pathToFileURL(dependencyFilename).href);

  // Public VM compilers do not populate Node's generated-eval registry.
  const vm = require('node:vm');
  for (const kind of ['script', 'function']) {
    const filename = path.join(directory, 'vm-' + kind + '.js');
    const vmSource = 'getCallSites(1, { sourceMap: true })[0]\n' +
      '//# sourceURL=' + pathToFileURL(filename).href + '\n//# sourceMappingURL=' + inline;
    const site = kind === 'script'
      ? new vm.Script(vmSource, { filename }).runInNewContext({ getCallSites: require('node:util').getCallSites })
      : vm.compileFunction('return ' + vmSource, ['getCallSites'], { filename })(require('node:util').getCallSites);
    assert.equal(findSourceMap(filename), undefined);
    assert.equal(site.scriptName, filename);
  }

  // Reloading without a map keeps the prior cached map; an invalid replacement
  // map shadows it. Compilation errors must not create a new cache entry.
  const owner = require.cache[cjsFilename];
  owner._compile('exports.value = 2;', cjsFilename);
  assert.equal(findSourceMap(cjsFilename), cjsMap);
  assert.throws(() => owner._compile('const = ;\n//# sourceMappingURL=' + inline, cjsFilename), SyntaxError);
  assert.equal(findSourceMap(cjsFilename), cjsMap);
  owner._compile('exports.value = 3;\n//# sourceMappingURL=missing.map', cjsFilename);
  assert.equal(findSourceMap(cjsFilename), undefined);
  const dependencyDirectory = path.join(directory, 'node_modules', 'mapped');
  fs.mkdirSync(dependencyDirectory, { recursive: true });
  const excluded = path.join(dependencyDirectory, 'excluded.cjs');
  const included = path.join(dependencyDirectory, 'included.cjs');
  const dependencySource = 'module.exports = 1;\n//# sourceMappingURL=' + inline;
  fs.writeFileSync(excluded, dependencySource);
  fs.writeFileSync(included, dependencySource);
  require(excluded);
  assert.equal(findSourceMap(excluded), undefined);
  process.setSourceMapsEnabled(true);
  require(included);
  assert.ok(findSourceMap(included) instanceof SourceMap);
  setSourceMapsSupport(true);
  assert.equal(findSourceMap(included), undefined);
  setSourceMapsSupport(false);
  assert.equal(process.sourceMapsEnabled, false);
  assert.equal(findSourceMap(sourceURL('inline')), inlineMap);
  evaluate('disabled', inline);
  assert.equal(findSourceMap(sourceURL('disabled')), undefined);
  process.setSourceMapsEnabled(true);
  assert.deepEqual({ ...getSourceMapsSupport() }, { enabled: true, nodeModules: true, generatedCode: true });
  process.setSourceMapsEnabled(false);
  assert.deepEqual({ ...getSourceMapsSupport() }, { enabled: false, nodeModules: false, generatedCode: false });
} finally {
  setSourceMapsSupport(previous.enabled, previous);
  fs.rmSync(directory, { recursive: true, force: true });
}
// CLI flags override NODE_OPTIONS; workers inherit startup policy, not later
// programmatic toggles. Explicit worker execArgv overrides the environment.
const { spawnSync } = require('node:child_process');
const optionProbe = `
  const { Worker } = require('node:worker_threads');
  const initial = process.sourceMapsEnabled;
  process.setSourceMapsEnabled(!initial);
  const source = 'require("node:worker_threads").parentPort.postMessage(require("node:module").getSourceMapsSupport())';
  const read = options => new Promise((resolve, reject) => {
    const worker = new Worker(source, { eval: true, ...options });
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  Promise.all([
    read({}),
    read({ execArgv: [initial ? '--no-enable-source-maps' : '--enable-source-maps'] }),
    read({ execArgv: [], env: { ...process.env, NODE_OPTIONS: '--enable-source-maps' } }),
  ]).then(workers => console.log(JSON.stringify({ initial, workers })));
`;
for (const enabled of [false, true]) {
  const child = spawnSync(process.execPath, [
    enabled ? '--enable-source-maps' : '--no-enable-source-maps', '-e', optionProbe,
  ], {
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: enabled ? '--no-enable-source-maps' : '--enable-source-maps' },
  });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.initial, enabled);
  assert.deepEqual(result.workers, [enabled, !enabled, true].map(value => ({
    enabled: value, nodeModules: value, generatedCode: value,
  })));
}
console.log('source-maps smoke passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
