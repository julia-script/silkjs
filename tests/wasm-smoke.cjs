'use strict';
const assert = require('node:assert/strict');
const F = require('./wasm-fixtures.cjs');
const W = WebAssembly;
const instantiate = (bytes, imports) => new W.Instance(new W.Module(bytes), imports);

async function main() {
  const bytes = F.echo();
  assert.equal(W.validate(bytes), true);
  assert.equal(W.validate(new Uint8Array([0, 1])), false);
  assert.throws(() => new W.Module(new Uint8Array([0, 1])), W.CompileError);
  const module = new W.Module(bytes);
  assert.deepEqual(W.Module.imports(module), [{ module: 'host', name: 'call', kind: 'function' }]);
  assert.deepEqual(W.Module.exports(module), [{ name: 'run', kind: 'function' }]);
  assert.deepEqual(W.Module.customSections(module, 'silk-smoke').map(b => [...new Uint8Array(b)]), [[1, 3, 5, 7], [2, 4]]);
  const sections = W.Module.customSections(module, 'silk-smoke');
  new Uint8Array(sections[0])[0] = 255;
  assert.equal(new Uint8Array(W.Module.customSections(module, 'silk-smoke')[0])[0], 1);
  assert.throws(() => new W.Instance(module, { host: { call: 1 } }), W.LinkError);
  assert.equal(new W.Instance(module, { host: { call: x => x + 3 } }).exports.run(39), 42);
  assert.equal((await W.instantiate(bytes, { host: { call: x => x * 2 } })).instance.exports.run(21), 42);
  assert.equal((await W.instantiate(await W.compile(bytes), { host: { call: x => x } })).exports.run(42), 42);

  const marker = { original: true };
  const throwing = new W.Instance(module, { host: { call() { throw marker; } } });
  assert.throws(() => throwing.exports.run(1), e => e === marker);
  for (const [type, value] of [[F.I64, -9223372036854775808n], [F.F32, Math.fround(1.1)], [F.F64, -0], [F.EXTERNREF, marker]]) {
    let received;
    const e = instantiate(F.echo(type), { host: { call(x) { received = x; return x; } } }).exports;
    assert.equal(e.run(value), value);
    assert.equal(received, value);
    if (type === F.I64) assert.throws(() => e.run(1), TypeError);
  }
  const multi = instantiate(F.binary({
    types: [F.signature([F.I32, F.I64, F.EXTERNREF], [F.I32, F.I64, F.EXTERNREF])],
    functions: [{ type: 0, body: [0x20, 0, 0x20, 1, 0x20, 2] }],
    exports: [F.exported('run', 0, 0)],
  })).exports.run;
  assert.deepEqual(multi(42, 43n, marker), [42, 43n, marker]);
  const trap = instantiate(F.binary({
    types: [F.signature([], [])], functions: [{ type: 0, body: [0] }], exports: [F.exported('run', 0, 0)],
  })).exports.run;
  assert.throws(trap, W.RuntimeError);

  const counter = new W.Global({ value: 'i32', mutable: true }, 7);
  const table = new W.Table({ element: 'anyfunc', initial: 1, maximum: 3 });
  const globals = instantiate(F.binary({
    types: [F.signature([F.I32], [F.I32])],
    imports: [F.named('host', 'counter', 3, [F.I32, 1]), F.named('host', 'table', 1, [0x70, 1, 1, 3])],
    functions: [{ type: 0, body: [0x20, 0, 0x24, 0, 0x23, 0] }],
    exports: [F.exported('set', 0, 0), F.exported('counter', 3, 0), F.exported('table', 1, 0)],
  }), { host: { counter, table } }).exports;
  assert.equal(globals.counter, counter);
  assert.equal(globals.table, table);
  assert.equal(globals.set(19), 19);
  assert.equal(counter.value, 19);
  counter.value = 23;
  assert.equal(counter.valueOf(), 23);
  const immutable = new W.Global({ value: 'i64' }, 2n);
  assert.throws(() => { immutable.value = 3n; }, TypeError);
  table.set(0, globals.set);
  assert.equal(table.get(0), globals.set);
  assert.equal(table.get(0)(41), 41);
  assert.equal(table.grow(1, globals.set), 1);
  assert.equal(table.get(1), globals.set);
  assert.throws(() => table.grow(2), RangeError);
  assert.throws(() => table.set(0, () => 1), TypeError);
  const refs = new W.Table({ element: 'externref', initial: 1, maximum: 2 }, marker);
  assert.equal(refs.get(0), marker);
  refs.set(0, undefined);
  assert.equal(refs.get(0), undefined);
  refs.grow(1, marker);
  assert.equal(refs.get(1), marker);
  const refGlobal = new W.Global({ value: 'externref', mutable: true }, marker);
  assert.equal(refGlobal.value, marker);
  const wideTable = new W.Table({ element: 'externref', address: 'i64', initial: 0n, maximum: 18446744073709551615n });
  assert.equal(wideTable.length, 0n);
  assert.equal(wideTable.grow(1n, marker), 0n);
  assert.equal(wideTable.length, 1n);
  assert.equal(wideTable.get(0n), marker);
  assert.throws(() => wideTable.get(0), TypeError);
  const largeMaximumTable = new W.Table({ element: 'externref', initial: 0, maximum: 4294967295 });
  assert.equal(largeMaximumTable.grow(1, marker), 0);
  assert.equal(largeMaximumTable.get(0), marker);

  const memory = new W.Memory({ initial: 1, maximum: 2 });
  let old = memory.buffer;
  let oldView = new Uint8Array(old);
  oldView[0] = 73;
  assert.equal(memory.grow(0), 1);
  assert.equal(old.byteLength, 0);
  assert.equal(oldView.length, 0);
  assert.notEqual(memory.buffer, old);
  assert.equal(new Uint8Array(memory.buffer)[0], 73);
  let afterCount = 0;
  const grow = instantiate(F.growth(), { host: { memory, after() {
    afterCount++;
    // Observe detachment *inside* the import, before the exported call returns.
    assert.equal(old.byteLength, 0);
    assert.equal(oldView.length, 0);
    assert.notEqual(memory.buffer, old);
  } } }).exports.grow;
  old = memory.buffer;
  oldView = new Uint8Array(old);
  assert.equal(grow(0), 1);
  old = memory.buffer;
  oldView = new Uint8Array(old);
  assert.equal(grow(1), 1);
  assert.equal(afterCount, 2);
  assert.equal(memory.buffer.byteLength, 131072);
  const beforeFailure = memory.buffer;
  assert.throws(() => memory.grow(1), RangeError);
  assert.equal(memory.buffer, beforeFailure);
  assert.throws(() => structuredClone(memory.buffer, { transfer: [memory.buffer] }), e => e.name === 'DataCloneError');
  assert.equal(memory.buffer.byteLength, 131072);
  // The public .buffer property may be shadowed; internal WASI branding must not use it.
  Object.defineProperty(memory, 'buffer', { value: new ArrayBuffer(0) });
  const realBuffer = Object.getOwnPropertyDescriptor(W.Memory.prototype, 'buffer').get.call(memory);
  assert.equal(realBuffer.byteLength, 131072);
  assert.throws(() => Object.getOwnPropertyDescriptor(W.Memory.prototype, 'buffer').get.call({}), TypeError);
  let temporary = new W.Memory({ initial: 1 });
  const retained = temporary.buffer;
  new Uint8Array(retained)[17] = 97;
  temporary = null;
  if (typeof globalThis.gc === 'function') globalThis.gc();
  else console.log('retained-buffer forced-GC check requires --expose-gc');
  assert.equal(new Uint8Array(retained)[17], 97);
  const ordinary = new ArrayBuffer(8);
  new Uint8Array(ordinary)[0] = 99;
  const moved = structuredClone(ordinary, { transfer: [ordinary] });
  assert.equal(ordinary.byteLength, 0);
  assert.equal(new Uint8Array(moved)[0], 99);

  const shared = new W.Memory({ initial: 1, maximum: 2, shared: true });
  const sharedOld = shared.buffer;
  assert.equal(sharedOld instanceof SharedArrayBuffer, true);
  Atomics.store(new Int32Array(sharedOld), 0, 31);
  assert.equal(shared.grow(1), 1);
  assert.equal(sharedOld.byteLength, 65536);
  assert.equal(shared.buffer.byteLength, 131072);
  assert.equal(Atomics.load(new Int32Array(shared.buffer), 0), 31);
  const sharedClone = structuredClone(shared);
  assert.notEqual(sharedClone, shared);
  assert.equal(sharedClone instanceof W.Memory, true);
  assert.notEqual(sharedClone.buffer, shared.buffer);
  assert.equal(Atomics.load(new Int32Array(sharedClone.buffer), 0), 31);
  assert.equal(instantiate(F.atomic(), { host: { memory: shared } }).exports.bump(), 31);
  assert.equal(Atomics.load(new Int32Array(sharedOld), 0), 32);
  const moduleClone = structuredClone(module);
  assert.equal(new W.Instance(moduleClone, { host: { call: x => x + 1 } }).exports.run(41), 42);
  assert.notEqual(moduleClone, module);
  assert.equal(moduleClone instanceof W.Module, true);
  const graph = structuredClone({ memories: [shared, sharedClone, shared], modules: [module, module] });
  assert.notEqual(graph.memories[0], shared);
  assert.notEqual(graph.memories[0], graph.memories[1]);
  assert.equal(graph.memories[0], graph.memories[2]);
  assert.equal(Atomics.load(new Int32Array(graph.memories[1].buffer), 0), 32);
  assert.notEqual(graph.modules[0], module);
  assert.equal(graph.modules[0], graph.modules[1]);

  const tag = new W.Tag({ parameters: ['i32', 'externref'] });
  const exception = new W.Exception(tag, [42, marker]);
  assert.equal(exception.is(tag), true);
  assert.equal(exception.is(new W.Tag({ parameters: ['i32', 'externref'] })), false);
  assert.equal(exception.getArg(tag, 0), 42);
  assert.equal(exception.getArg(tag, 1), marker);
  assert.throws(() => exception.getArg(tag, 2), RangeError);
  assert.throws(() => new W.Exception(W.JSTag, [marker]), TypeError);
  const eh = instantiate(F.binary({
    types: [F.signature([F.I32], []), F.signature([], [F.I32])],
    imports: [F.named('host', 'fail', 0, [1])],
    tags: [[0, 0]],
    functions: [
      { type: 0, body: [0x20, 0, 0x08, 0] },
      // Legacy EH is enabled in Node 24: try/catch_all, not try_table.
      { type: 1, body: [0x06, F.I32, 0x10, 0, 0x19, 0x41, 42, 0x0b] },
    ],
    exports: [F.exported('throw', 0, 1), F.exported('catch', 0, 2), F.exported('tag', 4, 0)],
  }), { host: { fail() { throw marker; } } }).exports;
  assert.throws(() => eh.throw(19), e => e instanceof W.Exception && e.is(eh.tag) && e.getArg(eh.tag, 0) === 19);
  assert.equal(eh.catch(), 42);

  const suspending = new W.Suspending(async x => x + 1);
  const asyncInstance = instantiate(F.echo(), { host: { call: suspending } });
  assert.throws(() => asyncInstance.exports.run(1), W.SuspendError);
  assert.equal(await W.promising(asyncInstance.exports.run)(41), 42);
  assert.throws(() => W.promising(() => 1), TypeError);
  const promisedExport = W.promising(asyncInstance.exports.run);
  const promisedTable = new W.Table({ element: 'anyfunc', initial: 1 }, promisedExport);
  assert.equal(promisedTable.get(0), promisedExport);
  assert.notEqual(promisedTable.get(0), asyncInstance.exports.run);
  const promisedGlobal = new W.Global({ value: 'anyfunc' }, promisedExport);
  assert.equal(promisedGlobal.value, promisedExport);
  assert.equal(await promisedGlobal.value(41), 42);
  const promisedAgain = W.promising(promisedExport);
  assert.notEqual(promisedAgain, promisedExport);
  promisedTable.set(0, promisedAgain);
  assert.equal(promisedTable.get(0), promisedAgain);
  const rejecting = instantiate(F.echo(), { host: { call: new W.Suspending(async () => { throw marker; }) } });
  await assert.rejects(W.promising(rejecting.exports.run)(1), e => e === marker);
  const pending = [];
  const mutable = new W.Global({ value: 'i32', mutable: true }, 1);
  const concurrent = instantiate(F.concurrent(), { host: {
    counter: mutable,
    wait: new W.Suspending(x => new Promise(resolve => pending.push({ x, resolve }))),
  } }).exports;
  const promising = W.promising(concurrent.run);
  const first = promising(10);
  const second = promising(20);
  assert.equal(pending.length, 2, 'same-store calls must both reach imports before either resolves');
  mutable.value = 100;
  assert.equal(concurrent.inspect(), 100, 'sync execution must work while other calls are suspended');
  pending[1].resolve(pending[1].x);
  assert.equal(await second, 120);
  mutable.value = 200;
  pending[0].resolve(pending[0].x);
  assert.equal(await first, 210);

  const headers = { 'Content-Type': 'application/wasm' };
  const streamed = await W.compileStreaming(Promise.resolve(new Response(bytes, { headers })));
  assert.equal(new W.Instance(streamed, { host: { call: x => x } }).exports.run(42), 42);
  const streamedInstance = await W.instantiateStreaming(new Response(bytes, { headers }), { host: { call: x => x + 1 } });
  assert.equal(streamedInstance.instance.exports.run(41), 42);
  await assert.rejects(W.compileStreaming(new Response(bytes, { headers: { 'Content-Type': 'text/plain' } })), TypeError);
  await assert.rejects(W.compileStreaming(new Response(bytes, { status: 404, headers })), TypeError);
  await assert.rejects(W.compileStreaming(Promise.reject(marker)), e => e === marker);
  const failedBody = new ReadableStream({ start(controller) { controller.error(marker); } });
  await assert.rejects(W.compileStreaming(new Response(failedBody, { headers })), e => e === marker);
  const cancelled = new Response(bytes, { headers });
  await cancelled.body.cancel();
  await assert.rejects(W.compileStreaming(cancelled), TypeError);
  await assert.rejects(W.compileStreaming(new Response(new Uint8Array([0, 1]), { headers })), W.CompileError);
  await assert.rejects(W.compileStreaming(new Response(bytes, { headers: { 'Content-Type': 'application/wasm; charset=utf-8' } })), e => e.code === 'ERR_WEBASSEMBLY_RESPONSE');
  const viewChunks = new ReadableStream({
    start(controller) {
      controller.enqueue(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      controller.close();
    },
  });
  assert.ok(await W.compileStreaming(new Response(viewChunks, { headers })) instanceof W.Module);
  let chunkCancelled = false;
  const badChunk = new ReadableStream({
    start(controller) { controller.enqueue(42); },
    cancel() { chunkCancelled = true; },
  });
  await assert.rejects(W.compileStreaming(new Response(badChunk, { headers })), e => e.code === 'ERR_INVALID_ARG_TYPE');
  assert.equal(chunkCancelled, true);
  const streamOrder = [];
  const streamedOptions = { get builtins() { streamOrder.push('options'); return []; } };
  const streamedSource = { get then() { streamOrder.push('source'); return resolve => resolve(new Response(bytes, { headers })); } };
  await W.compileStreaming(streamedSource, streamedOptions);
  assert.deepEqual(streamOrder, ['options', 'source']);
  console.log('WebAssembly smoke passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
