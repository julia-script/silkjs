'use strict';
// Run with build/silkjsruntime tests/worker-profiles-smoke.cjs.
// Uses native interrupt delivery while worker guest JavaScript never yields.
const assert = require('node:assert/strict');
const { Worker, isMainThread, workerData } = require('node:worker_threads');
const { Buffer } = require('node:buffer');

if (!isMainThread) {
  const control = new Int32Array(workerData.memory);
  const key = {};
  const value = { bytes: new Uint8Array(8192) };
  globalThis.workerProfileGraph = { key, weak: new WeakMap([[key, value]]), weakRef: new WeakRef(value) };
  globalThis.workerProfileGraph.self = globalThis.workerProfileGraph;
  globalThis.workerProfileRetained = [];
  function workerAllocationLeaf() {
    for (let i = 0; i < 32; i++) globalThis.workerProfileRetained.push({ bytes: new Uint8Array(262144), index: i });
  }
  function workerProfileLeaf() {
    let total = 0;
    Atomics.store(control, 1, 1);
    while (Atomics.load(control, 0) === 0) {
      for (let i = 0; i < 4096; i++) total = (total + i) | 0;
      if (Atomics.load(control, 2) === 1) {
        workerAllocationLeaf();
        Atomics.store(control, 2, 2);
      }
    }
    return total;
  }
  globalThis.workerProfileResult = workerProfileLeaf();
} else {
  const memory = new SharedArrayBuffer(12);
  const control = new Int32Array(memory);
  const worker = new Worker(__filename, { workerData: { memory } });
  // Deliberately call before awaiting online: the native registry may not exist yet.
  const cpuStarted = worker.startCpuProfile();
  const failed = new Promise((resolve, reject) => worker.once('error', reject));
  const timeout = setTimeout(() => {
    console.error('Worker native profile consumer timed out');
    process.exitCode = 1;
    Atomics.store(control, 0, 1);
    worker.terminate();
  }, 20000);
  const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  async function waitFor(index, value) {
    const deadline = Date.now() + 5000;
    while (Atomics.load(control, index) !== value) {
      assert.ok(Date.now() < deadline, `Worker did not reach shared state ${index}:${value}`);
      await delay(2);
    }
  }
  async function consume() {
    const cpu = await cpuStarted;
    await waitFor(1, 1);
    await delay(100);
    const stoppingCpu = cpu.stop();
    assert.equal(cpu.stop(), stoppingCpu);
    const cpuText = await stoppingCpu;
    assert.equal(typeof cpuText, 'string');
    const profile = JSON.parse(cpuText);
    assert.ok(profile.samples.length > 0);
    assert.equal(profile.samples.length, profile.timeDeltas.length);
    assert.ok(profile.nodes.some(node => node.callFrame.functionName === 'workerProfileLeaf'));
    const ids = new Set(profile.nodes.map(node => node.id));
    assert.ok(profile.samples.every(id => ids.has(id)));
    assert.equal(Atomics.load(control, 0), 0, 'CPU stop must finish before releasing the busy guest loop');
    await cpu[Symbol.asyncDispose]();

    const heap = await worker.startHeapProfile();
    Atomics.store(control, 2, 1);
    await waitFor(2, 2);
    const stoppingHeap = heap.stop();
    assert.equal(heap.stop(), stoppingHeap);
    const heapText = await stoppingHeap;
    assert.equal(typeof heapText, 'string');
    const allocation = JSON.parse(heapText);
    assert.ok(allocation.samples.length > 0);
    assert.ok(allocation.silk.events.some(event => !event.reclaimed && event.requestedBytes > 0));
    assert.ok(allocation.silk.events.some(event => event.stack.some(frame => frame.functionName === 'workerAllocationLeaf')));
    await heap[Symbol.asyncDispose]();
    const disposableHeap = await worker.startHeapProfile();
    await disposableHeap[Symbol.asyncDispose]();
    assert.ok(JSON.parse(await disposableHeap.stop()).head);

    assert.throws(() => worker.getHeapSnapshot({ exposeNumericValues: 'yes' }), { code: 'ERR_INVALID_ARG_TYPE' });
    const stream = await worker.getHeapSnapshot({ exposeInternals: true });
    const chunks = [];
    for await (const chunk of stream) {
      assert.ok(Buffer.isBuffer(chunk));
      chunks.push(chunk);
    }
    const snapshot = JSON.parse(Buffer.concat(chunks).toString());
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
    const statistics = await worker.getHeapStatistics();
    assert.ok(statistics.used_heap_size > 0);
    assert.ok(statistics.total_heap_size >= statistics.used_heap_size);
    assert.ok(statistics.external_memory >= 0);
    assert.equal(Atomics.load(control, 0), 0, 'Heap requests must finish without guest event-loop progress');

    const deadCpu = await worker.startCpuProfile();
    const deadHeap = await worker.startHeapProfile();
    const exited = new Promise(resolve => worker.once('exit', resolve));
    Atomics.store(control, 0, 1);
    assert.equal(await exited, 0);
    const deadStop = deadCpu.stop();
    assert.equal(deadCpu.stop(), deadStop);
    await assert.rejects(deadStop, { code: 'ERR_WORKER_NOT_RUNNING' });
    await assert.rejects(deadHeap[Symbol.asyncDispose](), { code: 'ERR_WORKER_NOT_RUNNING' });
    for (const operation of ['startCpuProfile', 'startHeapProfile', 'getHeapSnapshot', 'getHeapStatistics']) {
      await assert.rejects(worker[operation](), { code: 'ERR_WORKER_NOT_RUNNING' });
    }
    console.log('Worker native CPU, allocation, heap snapshot and lifecycle consumers passed');
  }
  Promise.race([consume(), failed])
    .catch(error => { console.error(error); process.exitCode = 1; })
    .finally(async () => {
      Atomics.store(control, 0, 1);
      await worker.terminate();
      clearTimeout(timeout);
    });
}
