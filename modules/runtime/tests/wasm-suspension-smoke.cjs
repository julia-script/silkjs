'use strict';
const assert = require('node:assert/strict');
const F = require('./wasm-fixtures.cjs');
const W = WebAssembly;
const instance = (bytes, imports) => new W.Instance(new W.Module(bytes), imports);

async function main() {
  const marker = { retainedAcrossSuspension: true };
  let resumeReference;
  const references = instance(F.binary({
    types: [F.signature([], [F.I32]), F.signature([F.EXTERNREF], [F.EXTERNREF])],
    imports: [F.named('host', 'wait', 0, [0])],
    functions: [{ type: 1, body: [0x10, 0, 0x1a, 0x20, 0] }],
    exports: [F.exported('run', 0, 1)],
  }), { host: { wait: new W.Suspending(() => new Promise(resolve => { resumeReference = resolve; })) } });
  const retained = W.promising(references.exports.run)(marker);
  if (typeof globalThis.gc === 'function') globalThis.gc();
  resumeReference(0);
  assert.equal(await retained, marker, 'externref live local must be rooted across suspension');

  let resumeCatch;
  const catches = instance(F.binary({
    types: [F.signature([], []), F.signature([F.I32], [F.I32])],
    imports: [F.named('host', 'fail', 0, [0]), F.named('host', 'wait', 0, [1])],
    functions: [{ type: 1, body: [
      0x06, F.I32,             // try (result i32)
      0x10, 0, 0x41, 0,      // fail(); nominal result 0
      0x19,                   // catch_all
      0x20, 0, 0x10, 1,      // wait(argument)
      0x1a, 0x09, 0,         // drop; rethrow original exception
      0x0b,
    ] }],
    exports: [F.exported('run', 0, 2)],
  }), { host: {
    fail() { throw marker; },
    wait: new W.Suspending(x => new Promise(resolve => { resumeCatch = () => resolve(x); })),
  } });
  const caught = W.promising(catches.exports.run)(42);
  const caughtAssertion = assert.rejects(caught, error => error === marker);
  resumeCatch();
  await caughtAssertion;

  let resumeIndirect;
  const callee = instance(F.echo(), { host: {
    call: new W.Suspending(x => new Promise(resolve => { resumeIndirect = () => resolve(x + 1); })),
  } });
  const table = new W.Table({ element: 'anyfunc', initial: 1 });
  table.set(0, callee.exports.run);
  const caller = instance(F.binary({
    types: [F.signature([F.I32], [F.I32])],
    imports: [F.named('host', 'table', 1, [0x70, 0, 1])],
    functions: [{ type: 0, body: [0x20, 0, 0x41, 0, 0x11, 0, 0] }],
    exports: [F.exported('run', 0, 0)],
  }), { host: { table } });
  const indirect = W.promising(caller.exports.run)(41);
  const replacement = instance(F.echo(), { host: { call: x => x + 1000 } });
  table.set(0, replacement.exports.run);
  resumeIndirect();
  assert.equal(await indirect, 42, 'table mutation must not replace a suspended invocation frame');
  assert.equal(caller.exports.run(1), 1001);

  const directCallee = instance(F.echo(), { host: { call: new W.Suspending(async x => x + 1) } });
  const directCaller = instance(F.echo(), { host: { call: directCallee.exports.run } });
  assert.equal(await W.promising(directCaller.exports.run)(41), 42, 'direct cross-module suspension');
  const jsBoundary = instance(F.echo(), { host: { call: x => directCallee.exports.run(x) } });
  await assert.rejects(W.promising(jsBoundary.exports.run)(41), W.SuspendError);
  const nestedPromising = instance(F.echo(), { host: {
    call: new W.Suspending(x => W.promising(directCallee.exports.run)(x)),
  } });
  assert.equal(await W.promising(nestedPromising.exports.run)(41), 42);

  const tail = instance(F.binary({
    types: [F.signature([F.I32], [F.I32])],
    imports: [F.named('host', 'wait', 0, [0])],
    functions: [{ type: 0, body: [0x20, 0, 0x12, 0] }],
    exports: [F.exported('run', 0, 1)],
  }), { host: { wait: new W.Suspending(async x => x + 1) } });
  assert.equal(await W.promising(tail.exports.run)(41), 42);
  let settleShared;
  const sharedPromise = new Promise(resolve => { settleShared = resolve; });
  const resumed = [];
  const samePromise = instance(F.binary({
    types: [F.signature([F.I32], [F.I32]), F.signature([F.I32], [])],
    imports: [F.named('host', 'wait', 0, [0]), F.named('host', 'record', 0, [1])],
    functions: [{ type: 0, body: [0x20, 0, 0x10, 0, 0x1a, 0x20, 0, 0x10, 1, 0x20, 0] }],
    exports: [F.exported('run', 0, 2)],
  }), { host: { wait: new W.Suspending(() => sharedPromise), record: value => resumed.push(value) } });
  const sharedEntry = W.promising(samePromise.exports.run);
  const sharedFirst = sharedEntry(11);
  const sharedSecond = sharedEntry(22);
  settleShared(7);
  assert.deepEqual(await Promise.all([sharedFirst, sharedSecond]), [11, 22]);
  assert.deepEqual(resumed, [11, 22], 'same-Promise reactions resume their exact invocations in registration order');
  assert.equal(await sharedEntry(33), 33, 'already-settled Promise remains a new suspension');
  console.log('WebAssembly suspension semantics smoke passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
