'use strict';
// Run with build/silkjsruntime tests/inspector-profiles-smoke.cjs.
// Exercises production native recorders and graph visitor, not fabricated packets.
const assert = require('node:assert/strict');
const inspector = require('node:inspector');
const session = new inspector.Session();
session.connect();
const post = (method, params) => new Promise((resolve, reject) => {
  session.post(method, params || {}, (error, result) => {
    return error ? reject(error) : resolve(result);
  });
});
function profileLeaf() { let result = 0; for (let i = 0; i < 200000; i++) result += i; return result; }
function profileOuter() { return profileLeaf(); }
function allocationLeaf() { return { bytes: new Uint8Array(256), value: 7 }; }
(async () => {
  await post('Profiler.enable');
  await post('Profiler.setSamplingInterval', { interval: 1 });
  await post('Profiler.start');
  assert.equal(profileOuter(), 19999900000);
  const { profile } = await post('Profiler.stop');
  assert.ok(profile.samples.length > 0);
  assert.equal(profile.samples.length, profile.timeDeltas.length);
  assert.ok(profile.nodes.some(node => node.callFrame.functionName === 'profileLeaf'));
  assert.ok(profile.nodes.some(node => node.callFrame.functionName === 'profileOuter'));
  assert.ok(profile.timeDeltas.every(delta => delta > 0));
  assert.ok(profile.timeDeltas.reduce((sum, delta) => sum + delta, 0) <= profile.endTime - profile.startTime);
  assert.equal(profile.silk.safepointBias, true);
  const ids = new Set(profile.nodes.map(node => node.id));
  assert.ok(profile.samples.every(id => ids.has(id)));
  assert.ok(profile.nodes.every(node => node.children.every(id => ids.has(id))));
  await assert.rejects(post('Profiler.stop'));

  await post('HeapProfiler.startSampling', { samplingInterval: 1 });
  globalThis.profileRetained = Array.from({ length: 12 }, allocationLeaf);
  const ongoing = (await post('HeapProfiler.getSamplingProfile')).profile;
  assert.ok(ongoing.samples.length > 0);
  const completed = (await post('HeapProfiler.stopSampling')).profile;
  assert.equal(completed.silk.sampling, 'deterministic-byte-interval');
  assert.ok(completed.silk.events.some(event => !event.reclaimed && event.requestedBytes > 0));
  assert.ok(completed.silk.events.some(event => event.stack.some(frame => frame.functionName === 'allocationLeaf')));
  assert.ok(completed.silk.events.every(event => BigInt(event.timestampNs) > 0n));
  const issued = new Map();
  for (const event of completed.silk.events) {
    if (!event.reclaimed) issued.set(event.id, event);
    else if (issued.has(event.id)) {
      assert.equal(event.requestedBytes, issued.get(event.id).requestedBytes);
      assert.equal(event.chargedBytes, issued.get(event.id).chargedBytes);
    }
  }

  let getterReads = 0;
  const key = {};
  const value = { retained: new ArrayBuffer(8192) };
  const weak = new WeakMap([[key, value]]);
  const cycle = { key, weak };
  cycle.self = cycle;
  Object.defineProperty(cycle, 'getter', { get() { getterReads++; throw new Error('snapshot executed getter'); } });
  globalThis.profileGraph = cycle;
  await post('HeapProfiler.enable');
  const statistics = [];
  const observedIds = [];
  session.on('HeapProfiler.heapStatsUpdate', event => statistics.push(event.params.statsUpdate));
  session.on('HeapProfiler.lastSeenObjectId', event => observedIds.push(event.params.lastSeenObjectId));
  await post('HeapProfiler.startTrackingHeapObjects');
  globalThis.trackedAfterStart = { buffer: new ArrayBuffer(1024) };
  await post('HeapProfiler.stopTrackingHeapObjects');
  assert.ok(statistics.length >= 1 && statistics.every(update => update.length % 3 === 0));
  assert.ok(observedIds.length >= 2 && observedIds[observedIds.length - 1] > observedIds[0]);
  delete globalThis.trackedAfterStart;
  const chunks = [];
  session.on('HeapProfiler.addHeapSnapshotChunk', event => chunks.push(event.params.chunk));
  await post('HeapProfiler.takeHeapSnapshot');
  const snapshot = JSON.parse(chunks.join(''));
  assert.equal(getterReads, 0);
  const nodeWidth = snapshot.snapshot.meta.node_fields.length;
  const edgeWidth = snapshot.snapshot.meta.edge_fields.length;
  assert.equal(snapshot.nodes.length, snapshot.snapshot.node_count * nodeWidth);
  assert.equal(snapshot.edges.length, snapshot.snapshot.edge_count * edgeWidth);
  const { silk } = snapshot;
  assert.equal(silk.format, 'silk.heap.snapshot');
  assert.equal(silk.version, 3);
  assert.equal(silk.graphVersion, 1);
  assert.equal(silk.identity, 'runtime-allocation-id');
  assert.equal(silk.root, 0);
  assert.equal(silk.rootKind, 'native');
  assert.equal(Object.hasOwn(silk, 'nodes'), false);
  assert.equal(Object.hasOwn(silk, 'edges'), false);
  assert.equal(silk.edgeStrengths.length, snapshot.snapshot.edge_count);
  let ephemeronCount = 0, hasStrong = false, hasWeak = false;
  for (let i = 0; i < silk.edgeStrengths.length; i++) {
    const offset = i * edgeWidth;
    const target = snapshot.edges[offset + 2];
    if (target % nodeWidth !== 0 || !(target >= 0 && target < snapshot.nodes.length) || (target === 0 && 1 / target < 0)) assert.fail(`Invalid target for heap edge ${i}`);
    const strength = silk.edgeStrengths[i];
    if (strength !== 0 && strength !== 1 && strength !== 2 && strength !== 3) assert.fail(`Invalid strength for heap edge ${i}`);
    if (strength === 0 ? ![1, 2, 3].includes(snapshot.edges[offset]) : snapshot.edges[offset] !== 6) assert.fail(`Incorrect DevTools type for heap edge ${i}`);
    if (strength === 0) hasStrong = true;
    else if (strength === 1) hasWeak = true;
    else if (strength === 2) ephemeronCount++;
  }
  assert.ok(hasStrong);
  assert.ok(hasWeak);
  assert.ok(ephemeronCount > 0);
  assert.equal(silk.ephemerons.length, ephemeronCount * 2);
  let previousEdge = -1;
  for (let i = 0; i < silk.ephemerons.length; i += 2) {
    const edge = silk.ephemerons[i], condition = silk.ephemerons[i + 1];
    assert.ok(Number.isInteger(edge) && edge > previousEdge);
    assert.equal(silk.edgeStrengths[edge], 2);
    assert.ok(Number.isInteger(condition) && condition >= 0 && condition < snapshot.snapshot.node_count);
    previousEdge = edge;
  }
  assert.ok(silk.nodeNativeBytes.length > 0 && silk.nodeNativeBytes.length % 2 === 0);
  let previousNode = -1;
  for (let i = 0; i < silk.nodeNativeBytes.length; i += 2) {
    const node = silk.nodeNativeBytes[i], bytes = silk.nodeNativeBytes[i + 1];
    assert.ok(Number.isInteger(node) && node > previousNode && node < snapshot.snapshot.node_count);
    assert.ok(bytes > 0 && bytes <= snapshot.nodes[node * nodeWidth + 3]);
    previousNode = node;
  }
  assert.ok(silk.allocations.some(allocation => allocation.chargedBytes >= 8192));
  assert.ok(Array.isArray(silk.limitations));
  assert.match(silk.projection, /weak/);
  delete globalThis.profileRetained;
  delete globalThis.profileGraph;
  await post('HeapProfiler.collectGarbage');
  await post('Profiler.disable');
  await post('HeapProfiler.disable');
  session.disconnect();
  console.log('inspector native profile consumers passed');
})().catch(error => { session.disconnect(); console.error(error); process.exitCode = 1; });
