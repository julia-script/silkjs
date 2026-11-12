'use strict';

const host = require('internal/host');
const { EventTarget, Event, DOMException } = require('internal/path_events/event_target');
const { createHistogram, createSlidingWindowHistogram, importHistogram, isHistogram } = require('internal/histogram');
const monitorEventLoopDelay = require('internal/perf/event_loop_delay');
const trace = require('internal/trace_events');
const { codes: { ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE, ERR_MISSING_ARGS } } = require('internal/errors');
const { validateFunction, validateObject } = require('internal/validators');
const token = Symbol('Performance');
const entries = new WeakMap();
const markTimings = new Map();
const buffers = { mark: [], measure: [], resource: [] };
const observers = new Set();
const pending = new Set();
const enqueueObserver = Symbol('enqueue');
const deliverObserver = Symbol('deliver');
const observesType = Symbol('observesType');
const reservedMarks = new Set(['nodeStart', 'v8Start', 'environment', 'loopStart', 'loopExit', 'bootstrapComplete']);
const supportedTypes = Object.freeze(['dns', 'function', 'gc', 'http', 'http2', 'mark', 'measure', 'net', 'resource']);
// Only an installed instance counts: reading the lazy global would load this module
// again while it loads, and settle globalThis.performance to undefined.
const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance');
const previousPerformance = previousDescriptor && 'value' in previousDescriptor ? previousDescriptor.value : undefined;
const fallbackStart = host.performanceStartTime ?? (host.now() - (previousPerformance?.now() ?? process.uptime() * 1000));
const fallbackOrigin = host.performanceTimeOrigin ?? previousPerformance?.timeOrigin ?? (Date.now() - (host.now() - fallbackStart));
// Read each time: a heap image start, and a worker (which takes the process's clock), set them later.
const clockStart = () => host.performanceStartTime ?? fallbackStart;
const now = () => host.now() - clockStart();
let deliveryScheduled = false;
let resourceLimit = 250;
let resourcePending = false;
let resourceOverflow = [];
// WebIDL unsigned long, with Node's messages for the values ToNumber rejects.
function unsignedLong(value, context) {
  if (typeof value === 'bigint') throw error('ERR_INVALID_ARG_TYPE', `${context} is a BigInt and cannot be converted to a number.`);
  if (typeof value === 'symbol') throw error('ERR_INVALID_ARG_TYPE', `${context} is a Symbol and cannot be converted to a number.`);
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.trunc(number) >>> 0;
}
function error(code, message, Type = TypeError) { return Object.assign(new Type(message), { code }); }
function object(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw error('ERR_INVALID_ARG_TYPE', `${name} must be an object`);
}
function required(count, name) { if (!count) throw error('ERR_MISSING_ARGS', `The "${name}" argument must be specified`); }
function illegal() { return error('ERR_ILLEGAL_CONSTRUCTOR', 'Illegal constructor'); }
function timestamp(value) {
  if (typeof value !== 'number') throw error('ERR_INVALID_ARG_TYPE', 'startTime must be a number');
  if (value < 0) throw error('ERR_PERFORMANCE_INVALID_TIMESTAMP', `${value} is not a valid timestamp`);
  return value;
}
function cloneDetail(value) {
  if (value == null) return null;
  if (typeof globalThis.structuredClone === 'function') return globalThis.structuredClone(value);
  const { serialize, deserialize } = require('internal/serialization/v8');
  try { return deserialize(serialize(value)); }
  catch (cause) { throw new DOMException(cause.message, 'DataCloneError'); }
}
function data(entry) {
  const value = entries.get(entry);
  if (!value) throw error('ERR_INVALID_THIS', 'Value must be a PerformanceEntry');
  return value;
}
function sort(list) { return list.sort((a, b) => a.startTime - b.startTime); }
function filter(list, name, type) {
  return sort(list.filter(entry => (name === undefined || entry.name === name) && (type === undefined || entry.entryType === type)));
}
function allEntries() { return [...buffers.mark, ...buffers.measure, ...buffers.resource]; }
function scheduleDelivery() {
  if (deliveryScheduled) return;
  deliveryScheduled = true;
  setImmediate(() => {
    deliveryScheduled = false;
    const batch = Array.from(pending);
    pending.clear();
    for (const observer of batch) {
      if (!observers.has(observer)) continue;
      try { observer[deliverObserver](); }
      catch (cause) { process.nextTick(() => { throw cause; }); }
    }
  });
}
function enqueue(entry) {
  trace.performanceEntry(entry, clockStart());
  for (const observer of observers) observer[enqueueObserver](entry);
}
function bufferResource(entry) {
  if (!resourcePending && buffers.resource.length < resourceLimit) { buffers.resource.push(entry); return; }
  resourceOverflow.push(entry);
  if (resourcePending) return;
  resourcePending = true;
  setImmediate(() => {
    while (resourceOverflow.length) {
      const before = resourceOverflow.length;
      performance.dispatchEvent(new Event('resourcetimingbufferfull'));
      const count = Math.max(0, Math.min(resourceLimit - buffers.resource.length, resourceOverflow.length));
      buffers.resource.push(...resourceOverflow.splice(0, count));
      if (resourceOverflow.length >= before) { resourceOverflow = []; break; }
    }
    resourcePending = false;
  });
}
class PerformanceEntry {
  constructor(key, name, type, start, duration, detail) {
    if (key !== token) throw illegal();
    entries.set(this, { name, type, start, duration, detail });
  }
  get name() { return data(this).name; }
  get entryType() { return data(this).type; }
  get startTime() { return data(this).start; }
  get duration() { return data(this).duration; }
  toJSON() { return { name: this.name, entryType: this.entryType, startTime: this.startTime, duration: this.duration }; }
  [Symbol.for('nodejs.util.inspect.custom')](depth, options) {
    if (depth < 0) return this;
    const opts = { ...options, depth: options.depth == null ? null : options.depth - 1 };
    return `${this.constructor.name} ${require('util').inspect(this.toJSON(), opts)}`;
  }
}
class PerformanceMark extends PerformanceEntry {
  constructor(name, options) {
    required(arguments.length, 'name');
    name = `${name}`;
    if (reservedMarks.has(name)) throw error('ERR_INVALID_ARG_VALUE', `The argument 'name' is invalid: ${name}`);
    if (options != null) object(options, 'options');
    const start = timestamp(options?.startTime ?? now());
    markTimings.set(name, start);
    const detail = cloneDetail(options?.detail);
    super(token, name, 'mark', start, 0, detail);
  }
  get detail() { return data(this).detail; }
  toJSON() { return { ...super.toJSON(), detail: this.detail }; }
}
class PerformanceMeasure extends PerformanceEntry {
  get detail() { return data(this).detail; }
  toJSON() { return { ...super.toJSON(), detail: this.detail }; }
}
class PerformanceNodeEntry extends PerformanceEntry {
  get detail() { return data(this).detail; }
  toJSON() { return { ...super.toJSON(), detail: this.detail }; }
}
const resourceFields = {
  workerStart: 'finalServiceWorkerStartTime', redirectStart: 'redirectStartTime', redirectEnd: 'redirectEndTime',
  fetchStart: 'postRedirectStartTime', requestStart: 'finalNetworkRequestStartTime',
  finalResponseHeadersStart: 'finalNetworkResponseStartTime', responseEnd: 'endTime',
  encodedBodySize: 'encodedBodySize', decodedBodySize: 'decodedBodySize'
};
const connectionFields = {
  domainLookupStart: 'domainLookupStartTime', domainLookupEnd: 'domainLookupEndTime',
  connectStart: 'connectionStartTime', connectEnd: 'connectionEndTime',
  secureConnectionStart: 'secureConnectionStartTime', nextHopProtocol: 'ALPNNegotiatedProtocol'
};
class PerformanceResourceTiming extends PerformanceEntry {
  get startTime() { return data(this).timing.startTime; }
  get duration() { const timing = data(this).timing; return timing.endTime - timing.startTime; }
  get initiatorType() { return data(this).initiatorType; }
  get firstInterimResponseStart() { return data(this).timing.firstInterimNetworkResponseStartTime ?? 0; }
  get responseStart() { const timing = data(this).timing; return timing.firstInterimNetworkResponseStartTime || timing.finalNetworkResponseStartTime; }
  get transferSize() { return data(this).cacheMode === 'local' ? 0 : this.encodedBodySize + 300; }
  get deliveryType() { return data(this).deliveryType; }
  get responseStatus() { return data(this).responseStatus; }
  get renderBlockingStatus() { return data(this).timing.renderBlocking === true ? 'blocking' : 'non-blocking'; }
  get contentType() { return data(this).bodyInfo?.contentType ?? ''; }
  get contentEncoding() { return data(this).bodyInfo?.contentEncoding ?? ''; }
  toJSON() {
    data(this);
    const result = {};
    for (const key of resourceJSONKeys) result[key] = this[key];
    return result;
  }
}
// Node's order, which inspect output follows.
const resourceJSONKeys = ['name', 'entryType', 'startTime', 'duration', 'initiatorType', 'nextHopProtocol', 'workerStart',
  'redirectStart', 'redirectEnd', 'fetchStart', 'domainLookupStart', 'domainLookupEnd', 'connectStart', 'connectEnd',
  'secureConnectionStart', 'requestStart', 'finalResponseHeadersStart', 'firstInterimResponseStart', 'responseStart',
  'responseEnd', 'transferSize', 'encodedBodySize', 'decodedBodySize', 'deliveryType', 'responseStatus',
  'renderBlockingStatus', 'contentType', 'contentEncoding'];
for (const [name, field] of Object.entries(resourceFields)) Object.defineProperty(PerformanceResourceTiming.prototype, name, {
  enumerable: true, configurable: true, get() { return data(this).timing[field]; }
});
for (const [name, field] of Object.entries(connectionFields)) Object.defineProperty(PerformanceResourceTiming.prototype, name, {
  enumerable: true, configurable: true, get() { return data(this).timing.finalConnectionTimingInfo?.[field]; }
});
// The attributes of a resource entry are enumerable accessors on the prototype, as in Node.
for (const name of [...Object.getOwnPropertyNames(PerformanceResourceTiming.prototype), 'toJSON']) {
  const descriptor = Object.getOwnPropertyDescriptor(PerformanceResourceTiming.prototype, name);
  if (name !== 'constructor' && descriptor && !descriptor.enumerable) {
    descriptor.enumerable = true;
    Object.defineProperty(PerformanceResourceTiming.prototype, name, descriptor);
  }
}
class PerformanceObserverEntryList {
  #entries;
  constructor(key, list) { if (key !== token) throw illegal(); this.#entries = sort(list); }
  getEntries() { return this.#entries.slice(); }
  getEntriesByType(type) { required(arguments.length, 'type'); return filter(this.#entries, undefined, `${type}`); }
  getEntriesByName(name, type) { required(arguments.length, 'name'); return filter(this.#entries, `${name}`, type == null ? undefined : type); }
}
class PerformanceObserver {
  #callback;
  #types = new Set();
  #mode;
  #records = [];
  constructor(callback) {
    validateFunction(callback, 'callback');
    this.#callback = callback;
  }
  // Validation and messages as Node's lib/internal/perf/observe.js.
  observe(options = {}) {
    validateObject(options, 'options');
    const { entryTypes, type, buffered } = { ...options };
    if (entryTypes === undefined && type === undefined) throw new ERR_MISSING_ARGS('options.entryTypes', 'options.type');
    if (entryTypes != null && type != null)
      throw new ERR_INVALID_ARG_VALUE('options.entryTypes', entryTypes, 'options.entryTypes can not set with options.type together');
    const mode = entryTypes !== undefined ? 'multiple' : 'single';
    if (this.#mode !== undefined && this.#mode !== mode)
      throw new DOMException(`PerformanceObserver can not change to ${mode} observation${mode === 'multiple' ? 's' : ''}`, 'InvalidModificationError');
    this.#mode = mode;
    if (mode === 'multiple') {
      if (!Array.isArray(entryTypes)) throw new ERR_INVALID_ARG_TYPE('options.entryTypes', 'string[]', entryTypes);
      this.#types = new Set(entryTypes.filter(value => supportedTypes.includes(value)));
    } else {
      if (!supportedTypes.includes(type)) return;
      this.#types.add(type);
      if (buffered) {
        this.#records.push(...filter(allEntries(), undefined, type));
        pending.add(this); scheduleDelivery();
      }
    }
    if (this.#types.size) { observers.add(this); countObservers(); } else this.disconnect();
  }
  disconnect() { observers.delete(this); pending.delete(this); this.#records = []; this.#types.clear(); this.#mode = undefined; countObservers(); }
  takeRecords() { const records = this.#records; this.#records = []; return records; }
  [observesType](type) { return this.#types.has(type); }
  static get supportedEntryTypes() { return supportedTypes; }
  [enqueueObserver](entry) {
    if (!this.#types.has(entry.entryType)) return;
    this.#records.push(entry); pending.add(this); scheduleDelivery();
  }
  [deliverObserver]() { this.#callback(new PerformanceObserverEntryList(token, this.takeRecords()), this); }
}
function getMark(value) {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return timestamp(value);
  const name = `${value}`;
  if (reservedMarks.has(name)) return nodeTiming[name];
  if (!markTimings.has(name)) throw new DOMException(`The "${name}" performance mark has not been set`, 'SyntaxError');
  return markTimings.get(name);
}
function eventLoopUtilization(util1, util2) {
  // lib/internal/perf/event_loop_utilization.js: nothing is measured before the loop starts.
  if (!(nodeTiming.loopStart > 0)) return { idle: 0, active: 0, utilization: 0 };
  if (util2) {
    const idle = util1.idle - util2.idle, active = util1.active - util2.active;
    return { idle, active, utilization: active / (idle + active) };
  }
  if (typeof host.performanceLoopStats !== 'function') throw error('ERR_NOT_SUPPORTED', 'Event loop idle/active instrumentation is not available', Error);
  const current = host.performanceLoopStats();
  const idle = current.idle - (util1?.idle ?? 0), active = current.active - (util1?.active ?? 0);
  return { idle, active, utilization: !util1 && idle === 0 && active === 0 ? 0 : active / (idle + active) };
}
function timerify(fn, options = {}) {
  validateFunction(fn, 'fn');
  validateObject(options, 'options');
  const histogram = options.histogram;
  if (histogram !== undefined && (!isHistogram(histogram) || typeof histogram.record !== 'function')) throw new ERR_INVALID_ARG_TYPE('options.histogram', 'RecordableHistogram', histogram);
  function timerified(...args) {
    const start = now();
    const complete = () => {
      const duration = now() - start;
      if (histogram !== undefined) histogram.record(Math.ceil(duration * 1e6));
      const entry = new PerformanceNodeEntry(token, fn.name, 'function', start, duration, args);
      for (let i = 0; i < args.length; i++) entry[i] = args[i];
      enqueue(entry);
    };
    const result = new.target === undefined ? Reflect.apply(fn, this, args) : Reflect.construct(fn, args, fn);
    if (new.target === undefined && typeof result?.finally === 'function') return result.finally(complete);
    complete(); return result;
  }
  Object.defineProperties(timerified, {
    name: { value: `timerified ${fn.name}`, enumerable: true, configurable: false },
    length: { value: fn.length, enumerable: true, configurable: false }
  });
  return timerified;
}
class PerformanceNodeTiming extends PerformanceEntry {
  constructor() { super(token, 'node', 'node', 0, 0); }
  get duration() { return now(); }
  toJSON() {
    const result = super.toJSON();
    for (const key of [...reservedMarks, 'idleTime']) result[key] = this[key];
    return result;
  }
}
for (const name of [...reservedMarks, 'idleTime']) Object.defineProperty(PerformanceNodeTiming.prototype, name, {
  configurable: true, enumerable: true, get() {
    if (name === 'nodeStart') return 0;
    const value = host.performanceNodeTiming?.()[name];
    if (value !== undefined) return value;
    if (name === 'idleTime' && typeof host.performanceLoopStats === 'function') return host.performanceLoopStats().idle;
    return -1;
  }
});
const nodeTiming = new PerformanceNodeTiming();
class Performance extends EventTarget {
  #handler = null;
  constructor(key) { super(); if (key !== token) throw illegal(); }
  now() { brand(this); return now(); }
  get timeOrigin() { brand(this); return host.performanceTimeOrigin ?? fallbackOrigin; }
  get nodeTiming() { brand(this); return nodeTiming; }
  mark(name, options) {
    brand(this); required(arguments.length, 'name');
    const entry = new PerformanceMark(name, options); enqueue(entry); buffers.mark.push(entry); return entry;
  }
  measure(name, startOrOptions = {}, endMark) {
    brand(this); required(arguments.length, 'name');
    if (typeof name !== 'string') throw error('ERR_INVALID_ARG_TYPE', 'name must be a string');
    let start, end, duration;
    if (startOrOptions !== null && typeof startOrOptions === 'object') ({ start, end, duration } = startOrOptions);
    const valid = start !== undefined || end !== undefined;
    if (valid && (endMark !== undefined || (start !== undefined && end !== undefined && duration !== undefined))) {
      throw error('ERR_PERFORMANCE_MEASURE_INVALID_OPTIONS', 'Invalid performance measure options');
    }
    if (endMark !== undefined) end = getMark(endMark);
    else if (valid && end !== undefined) end = getMark(end);
    else if (valid && start !== undefined && duration !== undefined) end = getMark(start) + getMark(duration);
    else end = now();
    if (typeof startOrOptions === 'string') start = getMark(startOrOptions);
    else if (valid && start !== undefined) start = getMark(start);
    else if (valid && duration !== undefined) start = end - getMark(duration);
    else start = 0;
    const entry = new PerformanceMeasure(token, name, 'measure', start, end - start, cloneDetail(startOrOptions?.detail));
    enqueue(entry); buffers.measure.push(entry); return entry;
  }
  clearMarks(name) {
    brand(this);
    if (name === undefined) markTimings.clear();
    else { name = `${name}`; if (reservedMarks.has(name)) throw error('ERR_INVALID_ARG_VALUE', 'Invalid mark name'); markTimings.delete(name); }
    buffers.mark = name === undefined ? [] : buffers.mark.filter(entry => entry.name !== name);
  }
  clearMeasures(name) { brand(this); buffers.measure = name === undefined ? [] : buffers.measure.filter(entry => entry.name !== `${name}`); }
  clearResourceTimings(name) { brand(this); buffers.resource = name === undefined ? [] : buffers.resource.filter(entry => entry.name !== `${name}`); }
  getEntries() { brand(this); return sort(allEntries()); }
  getEntriesByType(type) { brand(this); required(arguments.length, 'type'); return filter(allEntries(), undefined, `${type}`); }
  getEntriesByName(name, type) { brand(this); required(arguments.length, 'name'); return filter(allEntries(), `${name}`, type === undefined ? undefined : `${type}`); }
  setResourceTimingBufferSize(maxSize) { brand(this); required(arguments.length, 'maxSize'); resourceLimit = unsignedLong(maxSize, 'maxSize'); }
  markResourceTiming(timingInfo, requestedUrl, initiatorType, global, cacheMode, bodyInfo, responseStatus, deliveryType = '') {
    if (cacheMode !== '' && cacheMode !== 'local') throw error('ERR_INTERNAL_ASSERTION', "cache must be an empty string or 'local'", Error);
    const entry = new PerformanceResourceTiming(token, requestedUrl, 'resource');
    Object.assign(data(entry), { timing: timingInfo, initiatorType, cacheMode, bodyInfo, responseStatus, deliveryType });
    enqueue(entry); bufferResource(entry); return entry;
  }
  get onresourcetimingbufferfull() { return this.#handler; }
  set onresourcetimingbufferfull(value) {
    if (this.#handler) this.removeEventListener('resourcetimingbufferfull', this.#handler);
    this.#handler = typeof value === 'function' ? value : null;
    if (this.#handler) this.addEventListener('resourcetimingbufferfull', this.#handler);
  }
  toJSON() { brand(this); return { nodeTiming: this.nodeTiming, timeOrigin: this.timeOrigin, eventLoopUtilization: this.eventLoopUtilization() }; }
}
// As in Node, the methods are the module's own functions, not wrappers.
Object.defineProperties(Performance.prototype, {
  timerify: { value: timerify, writable: true, enumerable: true, configurable: true },
  eventLoopUtilization: { value: eventLoopUtilization, writable: true, enumerable: true, configurable: true },
});
const performance = new Performance(token);
function brand(value) { if (value !== performance) throw error('ERR_INVALID_THIS', 'Value must be a Performance'); }
for (const Constructor of [Performance, PerformanceEntry, PerformanceMark, PerformanceMeasure, PerformanceResourceTiming,
  PerformanceObserver, PerformanceObserverEntryList, PerformanceNodeTiming]) {
  Object.defineProperty(Constructor.prototype, Symbol.toStringTag, { value: Constructor.name, configurable: true });
}
function emitNodeEntry(name, type, start, duration, detail) {
  if (!supportedTypes.includes(type)) return;
  const entry = new PerformanceNodeEntry(token, name, type, start, duration, detail);
  if (detail && typeof detail === 'object') for (const key of Object.keys(detail)) {
    if (!(key in entry)) Object.defineProperty(entry, key, { enumerable: true, configurable: true, get: () => detail[key] });
  }
  enqueue(entry);
}
if (typeof host.performanceSetObserverCallback === 'function') host.performanceSetObserverCallback(emitNodeEntry);
const internalEntries = require('internal/perf_observers');
internalEntries.observing = (type) => {
  for (const observer of observers) if (observer[observesType](type)) return true;
  return false;
};
internalEntries.emit = (name, type, start, duration, detail) => emitNodeEntry(name, type, start - clockStart(), duration, detail);
// As Node's binding: per Node entry type, how many observers watch it (observerCounts).
const nodeEntryTypes = ['gc', 'http', 'http2', 'net', 'dns'];
function countObservers() {
  const counts = internalEntries.observerCounts;
  for (let index = 0; index < nodeEntryTypes.length; index++) {
    let count = 0;
    for (const observer of observers) if (observer[observesType](nodeEntryTypes[index])) count++;
    counts[index] = count;
  }
  observeCollections(counts[0] !== 0);
}
// 'gc' entries, as Node's GC prologue/epilogue callbacks queue them: the trace
// provider keeps each collection's start and end while an observer watches, and
// they become entries once per loop turn, or right after a forced gc().
// v8.GCProfiler reads the same records through host.watchCollections, so the
// provider stays on while either wants them.
let stopCollections;
let observingEntries = false;
const collectionListeners = new Set();
function observeCollections(watch) {
  observingEntries = watch;
  refreshCollections();
}
function refreshCollections() {
  const watch = observingEntries || collectionListeners.size !== 0;
  if (watch === (stopCollections !== undefined) || typeof host.traceNative !== 'function') return;
  host.traceNative('observe', watch);
  if (watch) {
    stopCollections = host.performanceAddLoopListener(() => takeCollections(0));
    host.gcObserver = forced => takeCollections(forced ? constants.NODE_PERFORMANCE_GC_FLAGS_FORCED : 0);
  } else {
    stopCollections();
    stopCollections = undefined;
    host.gcObserver = undefined;
  }
}
// Each record is start and end (ns), whether it was a young collection, the
// allocator bytes in use at the start, the young part of them, and the bytes in
// use at the end.
const RECORD = 6;
function takeCollections(flags) {
  const count = host.traceNative('collections') * RECORD;
  if (!(count > 0)) return;
  const values = [];
  for (let index = 0; index < count; index++) values.push(host.traceNative('collection', index));
  const records = [];
  for (let index = 0; index + RECORD - 1 < values.length; index += RECORD) {
    records.push({ start: values[index], end: values[index + 1], young: values[index + 2] !== 0,
      usedBefore: values[index + 3], youngBefore: values[index + 4], usedAfter: values[index + 5] });
  }
  if (observingEntries) {
    for (const record of records) {
      const kind = record.young ? constants.NODE_PERFORMANCE_GC_MINOR : constants.NODE_PERFORMANCE_GC_MAJOR;
      emitNodeEntry('gc', 'gc', record.start / 1e6 - clockStart(), (record.end - record.start) / 1e6, { kind, flags });
    }
  }
  for (const listener of collectionListeners) listener(records);
}
// listener(records) gets each batch of collections while it is registered; take
// reads the ones not delivered yet.
host.watchCollections = {
  add(listener) { collectionListeners.add(listener); refreshCollections(); },
  delete(listener) { collectionListeners.delete(listener); refreshCollections(); },
  take() { if (stopCollections !== undefined) takeCollections(0); },
};
const constants = {
  NODE_PERFORMANCE_GC_MAJOR: 4, NODE_PERFORMANCE_GC_MINOR: 1, NODE_PERFORMANCE_GC_MINOR_MARK_SWEEP: 2, NODE_PERFORMANCE_GC_INCREMENTAL: 8, NODE_PERFORMANCE_GC_WEAKCB: 16,
  NODE_PERFORMANCE_GC_FLAGS_NO: 0, NODE_PERFORMANCE_GC_FLAGS_CONSTRUCT_RETAINED: 2, NODE_PERFORMANCE_GC_FLAGS_FORCED: 4,
  NODE_PERFORMANCE_GC_FLAGS_SYNCHRONOUS_PHANTOM_PROCESSING: 8, NODE_PERFORMANCE_GC_FLAGS_ALL_AVAILABLE_GARBAGE: 16,
  NODE_PERFORMANCE_GC_FLAGS_ALL_EXTERNAL_MEMORY: 32, NODE_PERFORMANCE_GC_FLAGS_SCHEDULE_IDLE: 64
};
// Node defines the entry type indexes as hidden (non-enumerable) constants.
for (let index = 0; index < nodeEntryTypes.length; index++)
  Object.defineProperty(constants, `NODE_PERFORMANCE_ENTRY_TYPE_${nodeEntryTypes[index].toUpperCase()}`, { value: index, enumerable: false });
Object.freeze(constants);
module.exports = { Performance, PerformanceEntry, PerformanceMark, PerformanceMeasure, PerformanceObserver, PerformanceObserverEntryList,
  PerformanceResourceTiming, monitorEventLoopDelay, createHistogram, createSlidingWindowHistogram, importHistogram,
  eventLoopUtilization, timerify, performance, constants };
