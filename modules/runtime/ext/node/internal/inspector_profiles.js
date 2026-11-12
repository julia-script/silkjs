'use strict';

const host = require('internal/host');
const { protocolError } = require('internal/inspector_values');
const states = new WeakMap();
const profilerSessions = new Set();
let nextConsoleId = 1;
let cpuOwner;
let allocationOwner;
const unknown = method => protocolError(-32601, `'${method}' wasn't found`);
function state(session) {
  let value = states.get(session);
  if (!value) { value = { cpuEnabled: false, heapEnabled: false, interval: 1000, cpu: false, sampling: false, tracking: null, includeCollected: false }; states.set(session, value); }
  return value;
}
function positive(value, fallback, maximum, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw protocolError(-32602, `Invalid ${name}`);
  return value;
}
function parse(value, message) {
  if (value === null) throw protocolError(-32000, message);
  return JSON.parse(value);
}

function heapSnapshot() {
  return host.heapSnapshotDevtools();
}
// V8's trace_function_infos and trace_tree from the recorded allocation stacks of
// objects still alive; each node's trace_node_id names the stack that allocated it.
function withAllocationTraces(text, recording) {
  const snapshot = JSON.parse(text);
  const strings = snapshot.strings, stringIds = new Map();
  for (let i = 0; i < strings.length; i++) stringIds.set(strings[i], i);
  const string = value => { let id = stringIds.get(value); if (id === undefined) { id = strings.length; strings.push(value); stringIds.set(value, id); } return id; };
  const functions = [], functionIds = new Map();
  const functionInfo = (key, name, scriptId, line, column) => {
    let index = functionIds.get(key);
    if (index === undefined) {
      index = functions.length / 6; functionIds.set(key, index);
      functions.push(index, string(name), string(''), Number(scriptId) || 0, line, column);
    }
    return index;
  };
  let nextId = 1;
  const root = { id: nextId++, info: functionInfo('(root)', '(root)', 0, 0, 0), count: 0, size: 0, children: new Map() };
  const alive = new Map();
  for (const event of recording.events) {
    if (event.reclaimed) alive.delete(event.id); else alive.set(event.id, event);
  }
  const traceOf = new Map();
  for (const event of alive.values()) {
    let node = root;
    for (let i = event.stack.length - 1; i >= 0; i--) {
      const frame = event.stack[i];
      const key = `${frame.functionAddress}:${frame.scriptId}:${frame.pc}`;
      let child = node.children.get(key);
      if (!child) {
        const info = functionInfo(`${frame.functionAddress}:${frame.scriptId}`, frame.functionName || (frame.scriptId === '0' ? '(native)' : ''), frame.scriptId, frame.line > 0 ? frame.line : 0, frame.column > 0 ? frame.column : 0);
        child = { id: nextId++, info, count: 0, size: 0, children: new Map() };
        node.children.set(key, child);
      }
      node = child;
    }
    node.count++; node.size += event.requestedBytes;
    traceOf.set(String(event.id), node.id);
  }
  const flatten = node => [node.id, node.info, node.count, node.size, [...node.children.values()].flatMap(flatten)];
  const width = snapshot.snapshot.meta.node_fields.length;
  const idField = snapshot.snapshot.meta.node_fields.indexOf('id'), traceField = snapshot.snapshot.meta.node_fields.indexOf('trace_node_id');
  for (let at = 0; at < snapshot.nodes.length; at += width) {
    const trace = traceOf.get(String(snapshot.nodes[at + idField]));
    if (trace !== undefined) snapshot.nodes[at + traceField] = trace;
  }
  snapshot.snapshot.trace_function_count = functions.length / 6;
  snapshot.trace_function_infos = functions;
  snapshot.trace_tree = flatten(root);
  if (snapshot.silk) snapshot.silk.allocationTraces = { droppedEvents: recording.droppedEvents, incomplete: recording.droppedEvents !== 0 };
  return JSON.stringify(snapshot);
}
function emitSnapshot(session, params, recording) {
  const snapshot = recording !== undefined ? withAllocationTraces(heapSnapshot(), parse(recording, 'No allocation profile is active')) : heapSnapshot();
  // Progress counts are actual serialized UTF-16 code units, never fabricated objects.
  const total = snapshot.length;
  for (let at = 0; at < total; at += 65536) {
    const chunk = snapshot.slice(at, at + 65536);
    session.emit('HeapProfiler.addHeapSnapshotChunk', { chunk });
    if (params.reportProgress) session.emit('HeapProfiler.reportHeapSnapshotProgress', { done: Math.min(at + 65536, total), total, finished: at + 65536 >= total });
  }
}
function samplingProfile(recording, includeCollected) {
  const alive = new Map();
  const collected = [];
  for (const event of recording.events) {
    if (event.reclaimed) {
      const allocation = alive.get(event.id);
      if (allocation && includeCollected) collected.push(allocation);
      alive.delete(event.id);
    } else alive.set(event.id, event);
  }
  const root = { callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 }, selfSize: 0, id: 1, children: [] };
  const children = new Map([[1, new Map()]]);
  const samples = [];
  let nextId = 2;
  let ordinal = 0;
  for (const event of [...collected, ...alive.values()]) {
    let node = root;
    for (let i = event.stack.length - 1; i >= 0; i--) {
      const frame = event.stack[i];
      const key = `${frame.functionAddress}:${frame.scriptId}:${frame.pc}`;
      const siblings = children.get(node.id);
      let child = siblings.get(key);
      if (!child) {
        child = {
          callFrame: { functionName: frame.functionName || (frame.scriptId === '0' ? '(native)' : ''), scriptId: frame.scriptId, url: '', lineNumber: frame.line > 0 ? frame.line - 1 : -1, columnNumber: frame.column > 0 ? frame.column - 1 : -1 },
          selfSize: 0, id: nextId++, children: [],
          silk: { functionAddress: frame.functionAddress, pc: frame.pc, nameTruncated: frame.nameTruncated }
        };
        siblings.set(key, child); node.children.push(child); children.set(child.id, new Map());
      }
      node = child;
    }
    node.selfSize += event.requestedBytes;
    samples.push({ size: event.requestedBytes, nodeId: node.id, ordinal: ++ordinal });
  }
  return {
    head: root, samples,
    silk: {
      sampling: recording.sampling, intervalBytes: recording.intervalBytes,
      sizes: 'observed native allocator request bytes; not statistical population estimates',
      stackPc: recording.stackPc, droppedEvents: recording.droppedEvents,
      incomplete: recording.droppedEvents !== 0,
      collection: 'reference-count and GC reclamation are observed without inventing V8 generations',
      events: recording.events
    }
  };
}
function startAllocation(session, params) {
  const current = state(session);
  if (allocationOwner === session && current.sampling) return {};
  if (allocationOwner) throw protocolError(-32000, 'An allocation profile is already active');
  const interval = positive(params.samplingInterval, 32768, 1073741824, 'samplingInterval');
  if (!host.allocationProfileStart(interval, 2048)) throw protocolError(-32000, 'An allocation profile is already active');
  allocationOwner = session; current.sampling = true;
  current.includeCollected = !!(params.includeObjectsCollectedByMajorGC || params.includeObjectsCollectedByMinorGC);
  return {};
}
function sampleTracking(session, tracking) {
  const census = host.heapCensus();
  if (census.identity !== 'runtime-allocation-id') throw protocolError(-32000, 'Heap tracking requires stable runtime allocation identities');
  const live = new Set();
  const buckets = new Map();
  for (let at = 0; at < census.length; at += 2) {
    const id = census[at];
    live.add(id);
    let bucket = tracking.ids.get(id);
    if (bucket === undefined) { bucket = tracking.next; tracking.ids.set(id, bucket); }
    let totals = buckets.get(bucket);
    if (!totals) { totals = { count: 0, bytes: 0 }; buckets.set(bucket, totals); }
    totals.count++; totals.bytes += census[at + 1];
    tracking.lastId = Math.max(tracking.lastId, id);
  }
  const changed = [];
  for (const [index, before] of tracking.buckets) {
    const after = buckets.get(index);
    if (!after) changed.push(index, 0, 0);
    else if (before.count !== after.count || before.bytes !== after.bytes) changed.push(index, after.count, after.bytes);
  }
  for (const [index, totals] of buckets) if (!tracking.buckets.has(index)) changed.push(index, totals.count, totals.bytes);
  for (const id of tracking.ids.keys()) if (!live.has(id)) tracking.ids.delete(id);
  tracking.buckets = buckets; tracking.next++;
  if (changed.length) session.emit('HeapProfiler.heapStatsUpdate', { statsUpdate: changed });
  session.emit('HeapProfiler.lastSeenObjectId', { lastSeenObjectId: tracking.lastId, timestamp: require('perf_hooks').performance.now() });
}
function stopTracking(current) {
  if (current.tracking) clearInterval(current.tracking.timer);
  current.tracking = null;
}
function emitConsoleEvent(method, params) {
  for (const session of profilerSessions) session.emit(method, params);
}
function consoleLocation(skipThrough) {
  const frame = host.captureCallSites(1, skipThrough)[0];
  if (!frame || !frame.scriptId || frame.lineNumber <= 0) throw protocolError(-32000, 'Console profile source location is unavailable');
  return { scriptId: frame.scriptId, lineNumber: frame.lineNumber - 1, columnNumber: frame.columnNumber > 0 ? frame.columnNumber - 1 : -1 };
}
function consoleProfile(title = '', notify, skipThrough = consoleProfile) {
  title = String(title);
  if (cpuOwner && cpuOwner.console && cpuOwner.title === title) return;
  if (cpuOwner) throw protocolError(-32000, 'A CPU profile is already active');
  const location = consoleLocation(skipThrough);
  if (!host.cpuProfileStart(1000, 16384)) throw protocolError(-32000, 'A CPU profile is already active');
  const id = String(nextConsoleId++);
  cpuOwner = { console: true, title, id, notify };
  notify('Profiler.consoleProfileStarted', { id, location, title });
}
function consoleProfileEnd(title, notify, skipThrough = consoleProfileEnd) {
  if (!cpuOwner || !cpuOwner.console) return;
  if (title !== undefined && String(title) !== cpuOwner.title) return;
  const location = consoleLocation(skipThrough);
  const recording = cpuOwner;
  cpuOwner = undefined;
  const profile = parse(host.cpuProfileStop(), 'No console CPU profile is active');
  (notify || recording.notify)('Profiler.consoleProfileFinished', { id: recording.id, location, title: recording.title, profile });
}
function releaseConsoleIfUnobserved() {
  if (profilerSessions.size === 0 && cpuOwner && cpuOwner.console) {
    host.cpuProfileStop(); cpuOwner = undefined;
  }
}
function dispatch(session, method, params = {}) {
  const current = state(session);
  switch (method) {
    case 'Profiler.enable': current.cpuEnabled = true; profilerSessions.add(session); return {};
    case 'HeapProfiler.enable': current.heapEnabled = true; return {};
    case 'Profiler.disable':
      if (cpuOwner === session) { host.cpuProfileStop(); cpuOwner = undefined; current.cpu = false; }
      current.cpuEnabled = false;
      profilerSessions.delete(session); releaseConsoleIfUnobserved();
      return {};
    case 'Profiler.setSamplingInterval':
      if (current.cpu) throw protocolError(-32000, 'Cannot change sampling interval while profiling');
      current.interval = positive(params.interval, 1000, 1000000000, 'interval'); return {};
    case 'Profiler.start':
      if (!current.cpuEnabled) throw protocolError(-32000, 'Profiler is not enabled');
      if (cpuOwner === session) return {};
      if (cpuOwner || !host.cpuProfileStart(current.interval, 16384)) throw protocolError(-32000, 'A CPU profile is already active');
      cpuOwner = session; current.cpu = true; return {};
    case 'Profiler.stop': {
      if (cpuOwner !== session) throw protocolError(-32000, 'No CPU profile is active for this session');
      cpuOwner = undefined; current.cpu = false;
      return { profile: parse(host.cpuProfileStop(), 'No CPU profile is active') };
    }
    case 'HeapProfiler.startSampling': return startAllocation(session, params);
    case 'HeapProfiler.getSamplingProfile': {
      if (allocationOwner !== session || !current.sampling) throw protocolError(-32000, 'No allocation sampling profile is active');
      return { profile: samplingProfile(parse(host.allocationProfile(), 'No allocation profile is active'), current.includeCollected) };
    }
    case 'HeapProfiler.stopSampling': {
      if (allocationOwner !== session || !current.sampling) throw protocolError(-32000, 'No allocation sampling profile is active');
      allocationOwner = undefined; current.sampling = false;
      return { profile: samplingProfile(parse(host.allocationProfileStop(), 'No allocation profile is active'), current.includeCollected) };
    }
    case 'HeapProfiler.startTrackingHeapObjects': {
      if (!current.heapEnabled) throw protocolError(-32000, 'HeapProfiler is not enabled');
      if (current.tracking) return {};
      const tracking = { ids: new Map(), buckets: new Map(), next: 0, lastId: 0, timer: null, error: null, allocations: false };
      // V8's AllocationTracker: every allocation's stack, recorded by the allocation
      // observer at a one-byte interval and joined to snapshot nodes by allocation id.
      if (params.trackAllocations) {
        if (allocationOwner) throw protocolError(-32000, 'An allocation profile is already active');
        if (!host.allocationProfileStart(1, 2048)) throw protocolError(-32000, 'An allocation profile is already active');
        allocationOwner = session; tracking.allocations = true;
      }
      sampleTracking(session, tracking);
      current.tracking = tracking;
      tracking.timer = setInterval(() => {
        try { sampleTracking(session, tracking); }
        catch (error) { tracking.error = error; clearInterval(tracking.timer); }
      }, 100);
      tracking.timer.unref();
      return {};
    }
    case 'HeapProfiler.stopTrackingHeapObjects': {
      if (!current.tracking) throw protocolError(-32000, 'Heap object tracking is not active');
      const tracking = current.tracking;
      stopTracking(current);
      // Kept as text until the snapshot is taken, so its parsed events are not in it.
      const recording = tracking.allocations ? host.allocationProfileStop() : undefined;
      if (tracking.allocations) allocationOwner = undefined;
      if (tracking.error) throw tracking.error;
      sampleTracking(session, tracking);
      emitSnapshot(session, params, recording); return {};
    }
    case 'HeapProfiler.takeHeapSnapshot': emitSnapshot(session, params); return {};
    case 'HeapProfiler.collectGarbage': host.collectGarbage(); return {};
    case 'HeapProfiler.disable':
      if (allocationOwner === session) { host.allocationProfileStop(); allocationOwner = undefined; current.sampling = false; }
      stopTracking(current); current.heapEnabled = false;
      return {};
    case 'Runtime.queryObjects': {
      const prototype = session.values.lookup(params.prototypeObjectId);
      return { objects: session.values.remote(host.queryObjects(prototype), params.objectGroup || '') };
    }
    default: throw unknown(method);
  }
}
function close(session) {
  if (cpuOwner === session) { host.cpuProfileStop(); cpuOwner = undefined; }
  if (allocationOwner === session) { host.allocationProfileStop(); allocationOwner = undefined; }
  const current = states.get(session);
  if (current) stopTracking(current);
  profilerSessions.delete(session); releaseConsoleIfUnobserved();
  states.delete(session);
}
module.exports = { dispatch, close, heapSnapshot, samplingProfile, consoleProfile, consoleProfileEnd, emitConsoleEvent };
