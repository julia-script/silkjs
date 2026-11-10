'use strict';
// Run with Node 24 or silkjsruntime; covers brands, identity and operation realms.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { binary, signature, named, exported, echo, I32 } = require('./wasm-fixtures.cjs');

async function main() {
  const context = vm.createContext({});
  const realm = vm.runInContext('({ wasm: WebAssembly, Function, Object, Array, Promise, TypeError, RangeError })', context);
  const W = realm.wasm;
  assert.notEqual(W.Module, WebAssembly.Module);
  assert.notEqual(W.Module.prototype, WebAssembly.Module.prototype);
  assert.equal(W.Module instanceof realm.Function, true);
  assert.equal(W.Module instanceof Function, false);
  assert.equal(Object.getPrototypeOf(W.CompileError.prototype), vm.runInContext('Error.prototype', context));

  const bytes = binary({
    types: [signature([I32], [I32]), signature([], [])],
    functions: [{ type: 0, body: [0x20, 0] }, { type: 1, body: [0x00] }],
    exports: [exported('identity', 0, 0), exported('trap', 0, 1)],
    custom: [['realm', [7]]],
  });
  const module = new W.Module(bytes);
  assert.equal(module instanceof W.Module, true);
  assert.equal(module instanceof WebAssembly.Module, false);
  assert.deepEqual(WebAssembly.Module.exports(module), [
    { name: 'identity', kind: 'function' }, { name: 'trap', kind: 'function' },
  ]);
  assert.equal(Object.getPrototypeOf(W.Module.exports(module)), realm.Array.prototype);
  const rootModule = new WebAssembly.Module(bytes);
  assert.equal(new Uint8Array(W.Module.customSections(rootModule, 'realm')[0])[0], 7);
  const root = new WebAssembly.Instance(module);
  const foreign = new W.Instance(rootModule);
  assert.equal(Object.getPrototypeOf(root.exports.identity), Function.prototype);
  assert.equal(Object.getPrototypeOf(foreign.exports.identity), realm.Function.prototype);
  assert.equal(Object.getPrototypeOf(foreign.exports), null);
  assert.equal(foreign.exports.identity(42), 42);
  assert.throws(() => root.exports.trap(), WebAssembly.RuntimeError);
  assert.throws(() => foreign.exports.trap(), W.RuntimeError);
  assert.throws(() => W.Module.exports({}), realm.TypeError);
  assert.throws(() => new W.Module(Uint8Array.of(1, 2, 3)), W.CompileError);

  const memory = new WebAssembly.Memory({ initial: 1, maximum: 2 });
  const table = new WebAssembly.Table({ element: 'anyfunc', initial: 1, maximum: 2 }, foreign.exports.identity);
  const global = new WebAssembly.Global({ value: 'i32', mutable: true }, 3);
  const tag = new WebAssembly.Tag({ parameters: ['i32'] });
  const importBytes = binary({
    types: [signature([I32], [I32]), signature([I32], [])],
    imports: [named('host', 'fn', 0, [0]), named('host', 'table', 1, [0x70, 1, 1, 2]),
      named('host', 'memory', 2, [1, 1, 2]), named('host', 'global', 3, [I32, 1]),
      named('host', 'tag', 4, [0, 1])],
    exports: [exported('fn', 0, 0), exported('table', 1, 0), exported('memory', 2, 0),
      exported('global', 3, 0), exported('tag', 4, 0)],
  });
  const imports = { host: { fn: root.exports.identity, table, memory, global, tag } };
  const reexport = new W.Instance(new WebAssembly.Module(importBytes), imports).exports;
  for (const name of ['fn', 'table', 'memory', 'global', 'tag']) assert.equal(reexport[name], imports.host[name]);
  assert.equal(W.Table.prototype.get.call(table, 0), foreign.exports.identity);
  W.Table.prototype.set.call(table, 0, root.exports.identity);
  assert.equal(table.get(0), root.exports.identity);
  assert.throws(() => W.Table.prototype.get.call(table, 5), realm.RangeError);
  assert.equal(W.Memory.prototype.grow.call(memory, 0), 1);
  assert.equal(Object.getOwnPropertyDescriptor(W.Memory.prototype, 'buffer').get.call(memory), memory.buffer);
  Object.getOwnPropertyDescriptor(W.Global.prototype, 'value').set.call(global, 9);
  assert.equal(W.Global.prototype.valueOf.call(global), 9);
  const exception = new W.Exception(tag, [23], { traceStack: true });
  assert.equal(WebAssembly.Exception.prototype.is.call(exception, tag), true);
  assert.equal(WebAssembly.Exception.prototype.getArg.call(exception, tag, 0), 23);
  assert.equal(typeof exception.stack, 'string');
  const ownStack = Object.getOwnPropertyDescriptor(exception, 'stack');
  assert.equal(typeof ownStack.get, 'function');
  assert.equal(typeof ownStack.set, 'function');
  assert.equal(ownStack.enumerable, false);
  assert.equal(ownStack.configurable, true);
  const untraced = new WebAssembly.Exception(tag, [0]);
  assert.equal(Object.hasOwn(untraced, 'stack'), false);
  assert.equal(ownStack.get.call(untraced), undefined);
  for (const Constructor of [WebAssembly.Exception, W.Exception]) {
    const getStack = Object.getOwnPropertyDescriptor(Constructor.prototype, 'stack').get;
    assert.equal(getStack.call(exception), undefined);
    assert.throws(() => getStack.call({}), { name: 'TypeError' });
  }
  const rootException = new WebAssembly.Exception(tag, [1], { traceStack: true });
  assert.equal(ownStack.get.call(rootException), rootException.stack);
  const replacement = { stack: 'replacement' };
  ownStack.set.call(rootException, replacement);
  assert.equal(rootException.stack, replacement);
  exception.stack = replacement;
  assert.equal(exception.stack, replacement);
  assert.equal(delete exception.stack, true);
  assert.equal(exception.stack, undefined);
  assert.notEqual(W.JSTag, WebAssembly.JSTag);
  assert.equal(Object.getPrototypeOf(W.JSTag), W.Tag.prototype);
  assert.throws(() => new W.Exception(W.JSTag, [null]), realm.TypeError);
  const otherJSTag = new W.Exception(WebAssembly.JSTag, [tag]);
  assert.equal(otherJSTag.getArg(WebAssembly.JSTag, 0), tag);
  assert.equal(otherJSTag.is(W.JSTag), false);

  // A later realm must not replace callbacks used by either existing realm.
  const another = vm.runInNewContext('WebAssembly');
  assert.throws(() => foreign.exports.trap(), W.RuntimeError);
  assert.throws(() => root.exports.trap(), WebAssembly.RuntimeError);
  assert.throws(() => new another.Module(Uint8Array.of(1)), another.CompileError);
  const compiled = W.compile(bytes);
  assert.equal(Object.getPrototypeOf(compiled), realm.Promise.prototype);
  assert.equal(await compiled instanceof W.Module, true);
  const failedCompile = W.compile(Uint8Array.of(1));
  assert.equal(Object.getPrototypeOf(failedCompile), realm.Promise.prototype);
  await assert.rejects(failedCompile, W.CompileError);
  const instantiated = W.instantiate(rootModule);
  assert.equal(Object.getPrototypeOf(instantiated), realm.Promise.prototype);
  assert.equal(await instantiated instanceof W.Instance, true);
  // Await a root-owned promise, then compile after the foreign frame resumes.
  // The frame's capability and subsequent await assimilation keep its home realm.
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const deferredCompile = vm.runInContext('(async (gate, bytes) => { await gate; return WebAssembly.compile(bytes); })', context);
  const deferred = deferredCompile(gate, bytes);
  assert.equal(Object.getPrototypeOf(deferred), realm.Promise.prototype);
  release();
  assert.equal(await deferred instanceof W.Module, true);

  const sentinel = vm.runInContext('new TypeError("import realm")', context);
  const imported = new WebAssembly.Instance(new WebAssembly.Module(echo()), {
    host: { call: vm.runInContext('(sentinel => () => { throw sentinel; })', context)(sentinel) },
  });
  assert.throws(() => imported.exports.run(1), error => error === sentinel);
  const suspended = new W.Suspending(vm.runInContext('(async value => value + 1)', context));
  const asyncInstance = new WebAssembly.Instance(new W.Module(echo()), { host: { call: suspended } });
  const promising = W.promising(asyncInstance.exports.run);
  assert.equal(Object.getPrototypeOf(promising), realm.Function.prototype);
  const pending = promising(8);
  assert.equal(Object.getPrototypeOf(pending), realm.Promise.prototype);
  assert.equal(await pending, 9);
  const rejecting = new WebAssembly.Instance(new W.Module(echo()), {
    host: { call: new W.Suspending(async () => { throw sentinel; }) },
  });
  await assert.rejects(W.promising(rejecting.exports.run)(0), error => error === sentinel);
  await assert.rejects(W.promising(root.exports.trap)(), WebAssembly.RuntimeError);

  const disabled = vm.createContext({}, { codeGeneration: { wasm: false } });
  const D = vm.runInContext('WebAssembly', disabled);
  assert.equal(D.validate(bytes), true);
  assert.throws(() => new D.Module(bytes), D.CompileError);
  await assert.rejects(D.compile(bytes), D.CompileError);
  await assert.rejects(D.instantiate(bytes), D.CompileError);
  assert.equal(new D.Instance(rootModule).exports.identity(5), 5);
  console.log('wasm realms smoke passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
