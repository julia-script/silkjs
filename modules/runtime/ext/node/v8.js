'use strict';

const host = require('internal/host');
const codec = require('internal/serialization/v8');
const { Buffer } = require('buffer');
const { Readable } = require('stream');
const { inspect } = require('util');

function error(code, message, Kind = Error) {
  return Object.assign(new Kind(message), { code });
}
function unsupported(api, reason) {
  throw error('ERR_NOT_SUPPORTED', `${api} is not supported by SilkJS: ${reason}`);
}
function object(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw error('ERR_INVALID_ARG_TYPE', `The "${name}" argument must be an object`, TypeError);
}
function string(value, name) {
  if (typeof value !== 'string') throw new (require('internal/errors').codes.ERR_INVALID_ARG_TYPE)(name, 'string', value);
}
function snapshotOptions(options = {}) {
  object(options, 'options');
  for (const name of ['exposeInternals', 'exposeNumericValues']) {
    if (options[name] !== undefined && typeof options[name] !== 'boolean')
      throw error('ERR_INVALID_ARG_TYPE', `The "options.${name}" argument must be a boolean`, TypeError);
  }
  if (options.exposeNumericValues)
    unsupported('exposeNumericValues', 'the native heap graph records references, not artificial numeric-value nodes');
}
function getHeapSnapshot(options) {
  snapshotOptions(options);
  // Capture synchronously, before returning a stream. silk fields retain exact
  // native edge strengths and projection limitations alongside DevTools data.
  const snapshot = require('internal/inspector_profiles').heapSnapshot();
  return Readable.from([Buffer.from(snapshot)], { objectMode: false });
}
function writeHeapSnapshot(filename, options) {
  if (filename !== undefined) {
    if (Buffer.isBuffer(filename)) filename = filename.toString();
    else if (filename instanceof require('url').URL) filename = require('url').fileURLToPath(filename);
    string(filename, 'filename');
    if (filename.includes('\0')) throw error('ERR_INVALID_ARG_VALUE', 'The "filename" argument must not contain null bytes', TypeError);
  }
  snapshotOptions(options);
  // heap_utils.cc TriggerHeapSnapshot: fs.write on the name as given, or on the cwd for a generated name.
  if (host.builtinLoaded('internal/permission')) require('internal/permission').check('fs.write', filename === undefined ? process.cwd() : filename);
  if (filename === undefined) {
    const date = new Date();
    const pad = value => String(value).padStart(2, '0');
    const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
    const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
    filename = `Heap-${day}-${time}-${process.pid}-${require('worker_threads').threadId}.heapsnapshot`;
  }
  filename = require('path').resolve(filename);
  require('fs').writeFileSync(filename, require('internal/inspector_profiles').heapSnapshot());
  return filename;
}
function getHeapStatistics() {
  const heap = JSON.parse(host.heapMetrics());
  // Individually owned live allocations, not reserved V8 arenas. Omit metrics
  // the engine does not measure rather than inventing limits or zeros: the heap
  // limit is there only with a budget (a worker's resourceLimits).
  const statistics = { total_heap_size: heap.heapTotal, used_heap_size: heap.heapUsed, external_memory: heap.external, silk: heap.silk };
  if (heap.silk.limitBytes !== null) statistics.heap_size_limit = heap.silk.limitBytes;
  return statistics;
}
function queryObjects(ctor, options = {}) {
  if (typeof ctor !== 'function') throw error('ERR_INVALID_ARG_TYPE', 'The "constructor" argument must be a function', TypeError);
  object(options, 'options');
  const format = options.format || 'count';
  if (format !== 'count' && format !== 'summary')
    throw error('ERR_INVALID_ARG_VALUE', 'The "options.format" argument must be "count" or "summary"', TypeError);
  require('internal/util').emitExperimentalWarning('v8.queryObjects()');
  const prototype = ctor.prototype;
  // Node's native predicate returns an empty result for a non-object search
  // prototype; being constructable is not a requirement of this API.
  if (prototype === null || (typeof prototype !== 'object' && typeof prototype !== 'function'))
    return format === 'count' ? 0 : [];
  host.collectGarbage();
  const matches = host.queryObjects(prototype);
  if (format === 'count') return matches.length;
  return matches.map(value => inspect(value, { __proto__: null, depth: 0 }));
}
function cachedDataVersionTag() {
  // This tags Silk bytecode, using the same build identity as vm.Script and the
  // module cache. It does not claim interoperability with V8 cachedData.
  return Buffer.from(host.cacheBuildIdentity, 'hex').readUInt32LE(0);
}
class SyncCPUProfileHandle {
  #stopped = false;
  stop() {
    if (this.#stopped) return;
    this.#stopped = true;
    const profile = host.cpuProfileStop();
    if (profile === null) throw error('ERR_INVALID_STATE', 'The native CPU profile is no longer active');
    return profile;
  }
  [Symbol.dispose]() { this.stop(); }
}
function startCpuProfile() {
  if (!host.cpuProfileStart()) throw error('ERR_INVALID_STATE', 'A native CPU profile is already active in this thread');
  return new SyncCPUProfileHandle();
}
// The engine's own generations under V8's space names: new_space is what was
// allocated since the last collection, old_space what collections kept. There is
// no machine code, so code_space is empty. Sizes are the bytes in use (the
// allocator reserves no space ahead); space_available_size is what the heap
// budget (a worker's resourceLimits) leaves, and is absent without one.
function getHeapSpaceStatistics() {
  const heap = JSON.parse(host.heapMetrics());
  const limit = heap.silk.limitBytes;
  const left = limit === null ? undefined : Math.max(0, limit - heap.silk.allocatorUsedBytes);
  const space = (space_name, used) => {
    const entry = { space_name, space_size: used, space_used_size: used, physical_space_size: used };
    if (left !== undefined) entry.space_available_size = space_name === 'code_space' ? 0 : left;
    return entry;
  };
  return [space('new_space', heap.youngUsed), space('old_space', heap.heapUsed - heap.youngUsed), space('code_space', 0)];
}
function getHeapCodeStatistics() {
  unsupported('getHeapCodeStatistics', 'the runtime does not measure V8 code and metadata categories');
}
function getCppHeapStatistics(detailLevel = 'detailed') {
  if (detailLevel !== 'brief' && detailLevel !== 'detailed')
    throw error('ERR_INVALID_ARG_VALUE', 'The "detailLevel" argument must be "brief" or "detailed"', TypeError);
  unsupported('getCppHeapStatistics', 'the runtime does not use V8 CppHeap');
}
function setFlagsFromString(flags) {
  string(flags, 'flags');
  // V8 reads --stack-size when an isolate's thread starts, so a running isolate
  // keeps its limit and a Worker keeps its resourceLimits stack.
  const tokens = flags.split(/\s+/).filter(Boolean);
  if (tokens.length && tokens.every(flag => /^--stack[-_]size=\d+$/.test(flag))) return;
  unsupported('setFlagsFromString', 'V8 execution flags do not control the Silk engine');
}
function setHeapSnapshotNearHeapLimit(limit) {
  if (typeof limit !== 'number') throw error('ERR_INVALID_ARG_TYPE', 'The "limit" argument must be a number', TypeError);
  if (!Number.isInteger(limit) || limit < 1 || limit > 0xffffffff)
    throw error('ERR_OUT_OF_RANGE', 'The "limit" argument must be a positive uint32', RangeError);
  // Node's binding checks fs.write (no resource) before it installs the callback.
  if (host.builtinLoaded('internal/permission')) require('internal/permission').check('fs.write', '');
  unsupported('setHeapSnapshotNearHeapLimit', 'the runtime has no V8 heap-limit callback or reserved heap arena');
}
function isStringOneByteRepresentation(content) {
  string(content, 'content');
  return host.isOneByteString(content);
}
// Node's v8.takeCoverage and v8.stopCoverage are the profiler binding's: they act on the
// coverage NODE_V8_COVERAGE started and do nothing without it.
function takeCoverage() {
  require('internal/profiler_binding').takeCoverage();
}
function stopCoverage() {
  require('internal/profiler_binding').stopCoverage();
}
// lib/v8.js GCProfiler over the collections the engine reports: each one's
// generation, its cost, and the heap in use before and after it. Only measured
// fields appear. Heap sizes are the allocator's bytes in use (buffer backing
// included); new_space is what was allocated since the previous collection, and
// every survivor is old afterwards. Young collections do not move cells, so they
// are named MinorMarkSweep rather than Scavenge; there is no compaction either,
// but MarkSweepCompact is V8's only name for a full collection.
function gcSnapshot(used, young) {
  const space = (spaceName, bytes) => ({ spaceName, spaceSize: bytes, spaceUsedSize: bytes, physicalSpaceSize: bytes });
  return {
    heapStatistics: { totalHeapSize: used, usedHeapSize: used, totalPhysicalSize: used },
    heapSpaceStatistics: [space('new_space', young), space('old_space', used - young), space('code_space', 0)],
  };
}
class GCProfiler {
  #statistics = null;
  #startTime = 0;
  #listener = null;
  start() {
    if (this.#statistics !== null) return;
    const statistics = [];
    this.#statistics = statistics;
    this.#startTime = Date.now();
    this.#listener = records => {
      for (const record of records) {
        const young = Math.min(record.youngBefore, record.usedBefore);
        statistics.push({
          gcType: record.young ? 'MinorMarkSweep' : 'MarkSweepCompact',
          beforeGC: gcSnapshot(record.usedBefore, young),
          cost: (record.end - record.start) / 1e3,
          afterGC: gcSnapshot(record.usedAfter, 0),
        });
      }
    };
    require('perf_hooks');
    host.watchCollections.add(this.#listener);
  }
  stop() {
    if (this.#statistics === null) return;
    host.watchCollections.take();
    host.watchCollections.delete(this.#listener);
    const data = { version: 1, startTime: this.#startTime, statistics: this.#statistics, endTime: Date.now() };
    this.#statistics = null;
    this.#listener = null;
    return data;
  }
  [Symbol.dispose]() { this.stop(); }
}
// lib/v8.js: startupSnapshot is internal/v8/startup_snapshot's namespace.
const { namespace: startupSnapshot } = require('internal/v8/startup_snapshot');
const promiseHooks = require('internal/promise_hooks');

module.exports = {
  cachedDataVersionTag, getHeapSnapshot, getHeapStatistics, getHeapSpaceStatistics,
  getHeapCodeStatistics, getCppHeapStatistics, setFlagsFromString,
  Serializer: codec.Serializer, Deserializer: codec.Deserializer,
  DefaultSerializer: codec.DefaultSerializer, DefaultDeserializer: codec.DefaultDeserializer,
  serialize: codec.serialize, deserialize: codec.deserialize,
  takeCoverage, stopCoverage, writeHeapSnapshot, queryObjects, startupSnapshot, promiseHooks,
  setHeapSnapshotNearHeapLimit, GCProfiler, isStringOneByteRepresentation, startCpuProfile,
};
