'use strict';
// Run with --expose-gc. v8.GCProfiler records the engine's own collections:
// a gc() is a full collection (MarkSweepCompact), gc({ type: 'minor' }) a young
// one (MinorMarkSweep). Each entry carries the heap in use before and after it,
// with only measured fields. perf_hooks 'gc' entries keep working while a
// profiler reads the same collections.
const assert = require('node:assert/strict');
const v8 = require('node:v8');
const { PerformanceObserver } = require('node:perf_hooks');

let entries = 0;
const observer = new PerformanceObserver(list => { entries += list.getEntries().length; });
observer.observe({ entryTypes: ['gc'] });

const profiler = new v8.GCProfiler();
assert.equal(profiler.stop(), undefined);
profiler.start();
profiler.start();
let keep = [];
for (let i = 0; i < 20000; i++) { const o = { i }; o.self = o; keep.push(o); }
keep = null;
gc();
gc({ type: 'minor' });
const profile = profiler.stop();
assert.equal(profiler.stop(), undefined);
assert.equal(profile.version, 1);
assert.ok(profile.endTime >= profile.startTime && profile.startTime > 0);
assert.deepEqual(profile.statistics.map(item => item.gcType), ['MarkSweepCompact', 'MinorMarkSweep']);
for (const item of profile.statistics) {
  assert.ok(item.cost >= 0);
  for (const phase of [item.beforeGC, item.afterGC]) {
    assert.deepEqual(Object.keys(phase.heapStatistics), ['totalHeapSize', 'usedHeapSize', 'totalPhysicalSize']);
    assert.deepEqual(phase.heapSpaceStatistics.map(space => space.spaceName), ['new_space', 'old_space', 'code_space']);
    const used = phase.heapSpaceStatistics.reduce((sum, space) => sum + space.spaceUsedSize, 0);
    assert.equal(used, phase.heapStatistics.usedHeapSize);
  }
  assert.equal(item.afterGC.heapSpaceStatistics[0].spaceUsedSize, 0);
}
// The full collection freed the 20000 self-cycles.
const [full] = profile.statistics;
assert.ok(full.afterGC.heapStatistics.usedHeapSize < full.beforeGC.heapStatistics.usedHeapSize);

// Nothing is recorded after stop, and a disposed profiler stops.
const later = new v8.GCProfiler();
later.start();
later[Symbol.dispose]();
gc();
assert.equal(later.stop(), undefined);

gc({ type: 'minor', execution: 'async' }).then(() => {
  setTimeout(() => {
    assert.ok(entries >= 4, `perf_hooks saw ${entries} gc entries`);
    observer.disconnect();
    console.log('gc profiler ok');
  }, 20);
});
