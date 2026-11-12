'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const v8 = require('node:v8');
const { Readable } = require('node:stream');

function serialization() {
  assert.equal(require('v8'), v8);
  assert.ok(require('node:module').builtinModules.includes('v8'));
  assert.equal(v8.serialize('native-v8').toString('hex'), 'ff0f22096e61746976652d7638');
  const buffer = Buffer.from([10, 20, 30, 40]);
  const value = { view: buffer.subarray(1, 3), map: new Map([['key', 17n]]) };
  value.self = value;
  const copy = v8.deserialize(v8.serialize(value));
  assert.equal(copy.self, copy);
  assert.deepEqual([...copy.view], [20, 30]);
  assert.ok(Buffer.isBuffer(copy.view));
  assert.equal(copy.map.get('key'), 17n);
  const serializer = new v8.Serializer();
  serializer.writeHeader();
  serializer.writeUint32(42);
  serializer.writeDouble(1.25);
  serializer.writeValue({ answer: 42 });
  const deserializer = new v8.Deserializer(serializer.releaseBuffer());
  assert.equal(deserializer.readHeader(), true);
  assert.equal(deserializer.getWireFormatVersion(), 15);
  assert.equal(deserializer.readUint32(), 42);
  assert.equal(deserializer.readDouble(), 1.25);
  assert.deepEqual(deserializer.readValue(), { answer: 42 });
  const defaultSerializer = new v8.DefaultSerializer();
  defaultSerializer.writeHeader();
  defaultSerializer.writeValue(new Uint16Array([256, 4096]));
  const defaultDeserializer = new v8.DefaultDeserializer(defaultSerializer.releaseBuffer());
  defaultDeserializer.readHeader();
  assert.deepEqual([...defaultDeserializer.readValue()], [256, 4096]);
  assert.equal(v8.cachedDataVersionTag(), v8.cachedDataVersionTag());
  assert.ok(Number.isInteger(v8.cachedDataVersionTag()));
}
function objects() {
  class NativeQueryTarget {}
  const keep = [new NativeQueryTarget(), new NativeQueryTarget()];
  keep[0].self = keep[0];
  let inspected = false;
  keep[1][Symbol.for('nodejs.util.inspect.custom')] = () => { inspected = true; return 'custom-query-summary'; };
  assert.equal(v8.queryObjects(NativeQueryTarget), 2);
  assert.equal(inspected, false, 'count queries do not inspect matches');
  const summaries = v8.queryObjects(NativeQueryTarget, { format: 'summary' });
  assert.equal(summaries.length, 2);
  assert.ok(summaries.every(value => typeof value === 'string'));
  assert.ok(summaries.includes('custom-query-summary'));
  assert.equal(inspected, true, 'summary queries use normal util.inspect custom hooks');
  (() => { const unreachable = new NativeQueryTarget(); unreachable.self = unreachable; })();
  assert.equal(v8.queryObjects(NativeQueryTarget), 2, 'native query collects unreachable cycles');
  assert.equal(keep[0].self, keep[0]);
  const arrow = () => {};
  assert.equal(v8.queryObjects(arrow), 0);
  assert.deepEqual(v8.queryObjects(arrow, { format: 'summary' }), []);
  arrow.prototype = NativeQueryTarget.prototype;
  assert.equal(v8.queryObjects(arrow), 2, 'the prototype predicate does not require a constructable function');
  function EmptyPrototype() {}
  EmptyPrototype.prototype = null;
  assert.equal(v8.queryObjects(EmptyPrototype), 0);
  assert.equal(v8.queryObjects(NativeQueryTarget, { format: '' }), 2);
  assert.throws(() => v8.queryObjects(null), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.throws(() => v8.queryObjects(NativeQueryTarget, null), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.throws(() => v8.queryObjects(NativeQueryTarget, { format: 'objects' }), { code: 'ERR_INVALID_ARG_VALUE' });
}
function checkSnapshot(snapshot) {
  const { meta, node_count, edge_count } = snapshot.snapshot;
  const nodeWidth = meta.node_fields.length;
  assert.ok(node_count > 0);
  assert.ok(edge_count > 0);
  assert.equal(snapshot.nodes.length, node_count * nodeWidth);
  assert.equal(snapshot.edges.length, edge_count * meta.edge_fields.length);
  if (snapshot.silk) {
    const { silk } = snapshot;
    assert.equal(silk.format, 'silk.heap.snapshot');
    assert.equal(silk.version, 2);
    assert.equal(silk.graphVersion, 1);
    assert.equal(silk.identity, 'runtime-allocation-id');
    assert.equal(silk.root, 0);
    assert.equal(silk.rootKind, 'native');
    assert.equal(Object.hasOwn(silk, 'nodes'), false);
    assert.equal(Object.hasOwn(silk, 'edges'), false);
    assert.equal(silk.edgeStrengths.length, edge_count);
    assert.ok(silk.edgeStrengths.includes(0));
    assert.ok(silk.edgeStrengths.every(strength => Number.isInteger(strength) && strength >= 0 && strength <= 3));
    assert.equal(silk.ephemerons.length % 2, 0);
    for (let i = 0; i < silk.ephemerons.length; i += 2) {
      assert.equal(silk.edgeStrengths[silk.ephemerons[i]], 2);
      assert.ok(Number.isInteger(silk.ephemerons[i + 1]) && silk.ephemerons[i + 1] >= 0 && silk.ephemerons[i + 1] < node_count);
    }
    assert.equal(silk.nodeNativeBytes.length % 2, 0);
    for (let i = 0; i < silk.nodeNativeBytes.length; i += 2) {
      const node = silk.nodeNativeBytes[i], bytes = silk.nodeNativeBytes[i + 1];
      assert.ok(Number.isInteger(node) && node >= 0 && node < node_count);
      assert.ok(bytes > 0 && bytes <= snapshot.nodes[node * nodeWidth + 3]);
    }
    assert.ok(Array.isArray(silk.allocations));
    assert.ok(Array.isArray(silk.limitations));
    assert.match(silk.projection, /weak/);
  }
}
async function snapshots(root) {
  const stream = v8.getHeapSnapshot();
  assert.ok(stream instanceof Readable);
  assert.equal(stream.readableObjectMode, false);
  const chunks = [];
  for await (const chunk of stream) { assert.ok(Buffer.isBuffer(chunk)); chunks.push(chunk); }
  checkSnapshot(JSON.parse(Buffer.concat(chunks).toString()));
  const filename = path.join(root, 'native.heapsnapshot');
  assert.equal(v8.writeHeapSnapshot(filename), filename);
  checkSnapshot(JSON.parse(fs.readFileSync(filename, 'utf8')));
  assert.throws(() => v8.writeHeapSnapshot(path.join(root, 'missing', 'file.heapsnapshot')), { code: 'ENOENT' });
  assert.throws(() => v8.getHeapSnapshot({ exposeInternals: 1 }), { code: 'ERR_INVALID_ARG_TYPE' });
  const heap = v8.getHeapStatistics();
  assert.ok(heap.used_heap_size > 0);
  assert.ok(heap.total_heap_size >= heap.used_heap_size);
  assert.ok(heap.external_memory >= 0);
  if (heap.silk) {
    assert.ok(heap.silk.allocatorUsedBytes >= heap.used_heap_size);
    assert.ok(heap.silk.allocatorPeakBytes >= heap.silk.allocatorUsedBytes);
    assert.equal(Object.hasOwn(heap, 'total_available_size'), false);
    assert.equal(Object.hasOwn(heap, 'heap_size_limit'), false);
    assert.throws(() => v8.getHeapSnapshot({ exposeNumericValues: true }), { code: 'ERR_NOT_SUPPORTED' });
    for (const name of ['getHeapSpaceStatistics', 'getHeapCodeStatistics', 'getCppHeapStatistics'])
      assert.throws(() => v8[name](), { code: 'ERR_NOT_SUPPORTED' });
    // Without NODE_V8_COVERAGE there is no coverage to take or stop, as in Node.
    assert.equal(v8.takeCoverage(), undefined);
    assert.equal(v8.stopCoverage(), undefined);
    assert.throws(() => v8.setFlagsFromString('--expose-gc'), { code: 'ERR_NOT_SUPPORTED' });
    assert.throws(() => v8.startupSnapshot.addSerializeCallback(() => {}), { code: 'ERR_NOT_BUILDING_SNAPSHOT' });
    assert.equal(v8.startupSnapshot.isBuildingSnapshot(), false);
  }
}
async function promises(root) {
  const oldParent = Promise.resolve(10);
  const queuedBeforeHook = oldParent.then(value => value + 1);
  let settleOld;
  const oldPending = new Promise(resolve => { settleOld = resolve; });
  const events = [];
  const parentSnapshot = path.join(root, 'promise-parent.heapsnapshot');
  const stop = v8.promiseHooks.createHook({
    init(promise, parent) {
      events.push(['init', promise, parent]);
      if (parent === oldParent) v8.writeHeapSnapshot(parentSnapshot);
    },
    before(promise) { events.push(['before', promise]); },
    after(promise) { events.push(['after', promise]); },
    settled(promise) { events.push(['settled', promise]); },
  });
  const parent = Promise.resolve(41);
  const child = parent.then(value => value + 1);
  const lateChild = oldParent.then(value => value + 2);
  settleOld(13);
  assert.equal(await child, 42);
  assert.equal(await queuedBeforeHook, 11);
  assert.equal(await lateChild, 12);
  assert.equal(await oldPending, 13);
  stop();
  stop();
  assert.ok(events.some(event => event[0] === 'init' && event[1] === child && event[2] === parent));
  assert.ok(events.some(event => event[0] === 'settled' && event[1] === parent));
  assert.ok(events.some(event => event[0] === 'before' && event[1] === child));
  assert.ok(events.some(event => event[0] === 'after' && event[1] === child));
  assert.ok(events.some(event => event[0] === 'init' && event[1] === lateChild && event[2] === oldParent), 'late registration receives the actual preexisting parent');
  assert.equal(events.some(event => event[0] === 'init' && event[1] === oldParent), false, 'late registration does not invent init events');
  assert.ok(events.some(event => event[0] === 'settled' && event[1] === oldPending));
  assert.ok(events.some(event => event[0] === 'before' && event[1] === queuedBeforeHook));
  assert.ok(events.some(event => event[0] === 'after' && event[1] === queuedBeforeHook));
  const snapshot = JSON.parse(fs.readFileSync(parentSnapshot, 'utf8'));
  if (snapshot.silk) {
    const edgeWidth = snapshot.snapshot.meta.edge_fields.length;
    assert.ok(snapshot.silk.edgeStrengths.some((strength, index) =>
      strength === 3 && /^runtime\.asyncPromiseParent\[\d+\]$/.test(snapshot.strings[snapshot.edges[index * edgeWidth + 1]])),
    'the synchronous parent alias is captured without inventing ownership');
  }
  const count = events.length;
  await Promise.resolve();
  assert.equal(events.length, count);
  assert.throws(() => v8.promiseHooks.onInit(async () => {}), { code: 'ERR_INVALID_ARG_TYPE' });
}
function cpu() {
  const handle = v8.startCpuProfile();
  let value = 0;
  const end = performance.now() + 30;
  while (performance.now() < end) value += Math.sqrt(value + 1);
  const profile = JSON.parse(handle.stop());
  assert.ok(value > 0);
  assert.ok(profile.nodes.length > 0);
  assert.ok(profile.samples.length > 0);
  assert.equal(profile.timeDeltas.length, profile.samples.length);
  assert.ok(profile.endTime >= profile.startTime);
  assert.equal(handle.stop(), undefined);
  handle[Symbol.dispose]();
  const next = v8.startCpuProfile();
  next[Symbol.dispose]();
}
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'silk-v8-public-'));
  try {
    serialization();
    objects();
    await snapshots(root);
    await promises(root);
    cpu();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  console.log('v8 public native smoke passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
