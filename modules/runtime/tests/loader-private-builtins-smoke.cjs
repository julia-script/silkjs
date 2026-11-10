'use strict';
const assert = require('node:assert/strict');
const { registerHooks, isBuiltin } = require('node:module');
const vm = require('node:vm');

async function main() {
  const forbidden = [
    'node:internal/host', 'node:internal/options',
    'silk:host', 'silk:std', 'silk:os', 'silk:host/std', 'silk:host/os',
  ];
  for (const name of forbidden) {
    assert.equal(isBuiltin(name), false, name);
    assert.throws(() => require(name), name);
    await assert.rejects(import(name), name);
    const literal = JSON.stringify(name);
    await assert.rejects(import('data:text/javascript,' + encodeURIComponent(`import ${literal};`)), name);
    await assert.rejects(Function('specifier', 'return import(specifier)')(name), name);
    // A user-controlled filename must never confer bootstrap privileges.
    const script = new vm.Script(`import(${literal})`, {
      filename: 'silk:bootstrap',
      importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    });
    await assert.rejects(script.runInNewContext(), name);
    if (typeof vm.SourceTextModule === 'function') {
      const module = new vm.SourceTextModule(`await import(${literal})`, {
        identifier: 'silk:bootstrap',
        importModuleDynamically: specifier => import(specifier),
      });
      await module.link(() => { throw new Error('Unexpected static dependency'); });
      await assert.rejects(module.evaluate(), name);
    }
    if (globalThis.__silkModuleBridge) assert.throws(() => globalThis.__silkModuleBridge.get(name), name);
  }
  if (globalThis.__silkModuleBridge) {
    const includes = Array.prototype.includes, filter = Array.prototype.filter;
    const get = Map.prototype.get, has = Map.prototype.has;
    const fs = require('node:fs');
    let denied = false, value;
    try {
      Array.prototype.includes = () => true;
      Array.prototype.filter = function() { return this; };
      try { globalThis.__silkModuleBridge.get('node:internal/host'); } catch { denied = true; }
      Map.prototype.get = function(key) {
        return Reflect.apply(get, this, [Reflect.apply(has, this, ['internal/host']) ? 'internal/host' : key]);
      };
      value = globalThis.__silkModuleBridge.get('node:fs');
    } finally {
      Array.prototype.includes = includes;
      Array.prototype.filter = filter;
      Map.prototype.get = get;
    }
    assert.equal(denied, true);
    assert.equal(value, fs);
  }
  for (const name of forbidden) {
    for (const format of ['builtin', 'module']) {
      const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
        if (specifier === 'private-host-probe') return { url: name, format, shortCircuit: true };
        return nextResolve(specifier, context);
      } });
      try {
        assert.throws(() => require('private-host-probe'), name);
        await assert.rejects(import('private-host-probe'), name);
      } finally { hooks.deregister(); }
    }
  }
  assert.equal(require('node:fs'), require('fs'));
  assert.equal(require('node:os'), require('os'));
  assert.equal((await import('os')).default, require('os'));
  console.log('Private host builtin isolation consumer smoke passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
