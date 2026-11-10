'use strict';

// Run unchanged with Node 24.22.2 and SilkJSRuntime, with and without
// --experimental-vm-modules. Every assertion crosses the public CJS vm boundary.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { isModuleNamespaceObject } = require('node:util/types');

async function main() {
  const defaultLoader = vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER;
  assert.equal(typeof defaultLoader, 'symbol');
  const path = await new vm.Script('import("node:path")', {
    importModuleDynamically: defaultLoader,
  }).runInThisContext();
  assert.equal(path.basename('/one/two'), 'two');
  await assert.rejects(new vm.Script('import("missing")').runInThisContext(), {
    code: 'ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING',
  });
  if (vm.SourceTextModule === undefined) {
    assert.equal(vm.Module, undefined);
    assert.equal(vm.SyntheticModule, undefined);
    let called = false;
    await assert.rejects(new vm.Script('import("missing")', {
      importModuleDynamically() { called = true; },
    }).runInThisContext(), { code: 'ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG' });
    assert.equal(called, false);
    console.log('vm modules flag gate: PASS');
    return;
  }

  const marker = { reason: 'module rejection' };
  const context = vm.createContext({ marker }, { codeGeneration: { strings: false } });
  const leaf = new vm.SourceTextModule('export let value = 1; export function bump() { value++; }', { context });
  let metaCalls = 0;
  const root = new vm.SourceTextModule(`
    import { value, bump } from 'leaf' with { custom: 'retained' };
    export { value, bump };
    export const meta = import.meta;
  `, {
    context, identifier: 'module-root.js',
    initializeImportMeta(meta, module) {
      assert.equal(module, root);
      assert.equal(Object.getPrototypeOf(meta), null);
      meta.identity = module.identifier;
      metaCalls++;
    },
  });
  assert.equal(root.status, 'unlinked');
  assert.equal(root.context, context);
  assert.throws(() => root.namespace, { code: 'ERR_VM_MODULE_STATUS' });
  assert.equal(root.moduleRequests[0].attributes.custom, 'retained');
  await root.link(async (specifier, parent, extra) => {
    assert.equal(specifier, 'leaf');
    assert.equal(parent, root);
    assert.equal(extra.attributes.custom, 'retained');
    assert.equal(extra.assert, extra.attributes);
    await Promise.resolve();
    return leaf;
  });
  assert.equal(root.status, 'linked');
  assert.equal(metaCalls, 0);
  assert.ok(isModuleNamespaceObject(root.namespace));
  assert.throws(() => root.namespace.value, { name: 'ReferenceError' });
  await root.evaluate();
  assert.equal(root.namespace.value, 1);
  root.namespace.bump();
  assert.equal(leaf.namespace.value, 2);
  assert.equal(root.namespace.value, 2);
  assert.equal(root.namespace.meta.identity, 'module-root.js');
  await root.evaluate();
  assert.equal(metaCalls, 1);
  await assert.rejects(root.link(() => leaf), { code: 'ERR_VM_MODULE_STATUS' });
  const sameName = [1, 2].map(id => new vm.SourceTextModule('export default import.meta.id', {
    context, identifier: 'same-identifier.js', initializeImportMeta(meta) { meta.id = id; },
  }));
  for (const module of sameName) { await module.link(() => {}); await module.evaluate(); }
  assert.deepEqual(sameName.map(module => module.namespace.default), [1, 2]);

  const synthetic = new vm.SyntheticModule(['value'], function () {
    this.setExport('value', 10);
  }, { context });
  assert.equal(synthetic.status, 'linked');
  synthetic.setExport('value', 3);
  assert.equal(synthetic.namespace.value, 3);
  const consumer = new vm.SourceTextModule('export { value } from "synthetic"', { context });
  await consumer.link(() => synthetic);
  await consumer.evaluate();
  assert.equal(consumer.namespace.value, 10);
  synthetic.setExport('value', 11);
  assert.equal(consumer.namespace.value, 11);
  assert.throws(() => synthetic.setExport('absent', 1), ReferenceError);

  const a = new vm.SourceTextModule('import { readB } from "b"; export let a = 2; export const read = () => a + readB();', { context });
  const b = new vm.SourceTextModule('import { a } from "a"; export const readB = () => a + 3;', { context });
  await a.link(async name => name === 'a' ? a : b);
  await a.evaluate();
  assert.equal(a.namespace.read(), 7);
  assert.equal(b.status, 'evaluated');

  const tla = new vm.SourceTextModule('export const result = await Promise.resolve(23)', { context });
  tla.linkRequests([]);
  tla.instantiate();
  assert.equal(tla.hasTopLevelAwait(), true);
  assert.equal(tla.hasAsyncGraph(), true);
  await tla.evaluate();
  assert.equal(tla.namespace.result, 23);
  const synchronousFailure = new vm.SourceTextModule('throw marker', { context });
  const synchronousParent = new vm.SourceTextModule('import "synchronous"', { context });
  await synchronousParent.link(() => synchronousFailure);
  await assert.rejects(synchronousParent.evaluate(), error => error === marker);
  assert.equal(synchronousFailure.error, marker);
  assert.equal(synchronousParent.error, marker);
  const rejected = new vm.SourceTextModule('await Promise.resolve(); throw marker', { context });
  const rejectedParent = new vm.SourceTextModule('import \"rejected\"', { context });
  await rejectedParent.link(() => rejected);
  await assert.rejects(rejectedParent.evaluate(), error => error === marker);
  assert.equal(rejectedParent.status, 'errored');
  assert.equal(rejectedParent.error, marker);
  assert.equal(rejected.status, 'errored');
  assert.equal(rejected.error, marker);
  await assert.rejects(rejected.evaluate(), error => error === marker);

  const foreign = new vm.SourceTextModule('export default 1', { context: vm.createContext({}) });
  const invalidGraph = new vm.SourceTextModule('import "foreign"', { context });
  await assert.rejects(invalidGraph.link(() => foreign), { code: 'ERR_VM_MODULE_DIFFERENT_CONTEXT' });

  const imports = [];
  function dynamic(specifier, referrer, attributes, phase) {
    imports.push(referrer);
    assert.equal(specifier, 'synthetic');
    assert.equal(attributes.custom, 'dynamic');
    assert.equal(Object.getPrototypeOf(attributes), null);
    assert.equal(phase, 'evaluation');
    return synthetic;
  }
  const expression = 'import("synthetic", { with: { custom: "dynamic" } })';
  const script = new vm.Script(expression, { importModuleDynamically: dynamic });
  assert.equal((await script.runInContext(context)).value, 11);
  assert.equal(imports.pop(), script);
  const cached = new vm.Script(expression, {
    cachedData: Buffer.from(script.createCachedData()), importModuleDynamically: dynamic,
  });
  assert.equal(cached.cachedDataRejected, false);
  assert.equal((await cached.runInContext(context)).value, 11);
  assert.equal(imports.pop(), cached);
  const fn = vm.compileFunction(`return ${expression}`, [], { parsingContext: context, importModuleDynamically: dynamic });
  assert.equal((await fn()).value, 11);
  assert.equal(imports.pop(), fn);
  const importing = new vm.SourceTextModule(`export const imported = await ${expression}`, { context, importModuleDynamically: dynamic });
  await importing.link(() => {});
  await importing.evaluate();
  assert.equal(importing.namespace.imported.value, 11);
  assert.equal(imports.pop(), importing);
  const dynamicError = new Error('callback failure');
  await assert.rejects(new vm.Script('import("x")', {
    importModuleDynamically() { throw dynamicError; },
  }).runInThisContext(), error => error === dynamicError);
  await assert.rejects(new vm.Script('import("x")', {
    importModuleDynamically() { return {}; },
  }).runInThisContext(), { code: 'ERR_VM_MODULE_NOT_MODULE' });
  assert.throws(() => new vm.SourceTextModule('', { importModuleDynamically: defaultLoader }), { code: 'ERR_INVALID_ARG_TYPE' });

  // Eval-generated code inherits the owning Script callback without making a
  // filename-based registry (two scripts may have the same filename).
  const inherited = new vm.Script(`eval(${JSON.stringify(expression)})`, { importModuleDynamically: dynamic });
  assert.equal((await inherited.runInThisContext()).value, 11);
  assert.equal(imports.pop(), inherited);
  console.log('vm modules linking and dynamic imports: PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
