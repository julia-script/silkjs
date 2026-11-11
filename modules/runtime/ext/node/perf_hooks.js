'use strict';

const host = require('internal/host');
const { EventTarget, Event, DOMException } = require('internal/path_events/event_target');
const { createHistogram, createSlidingWindowHistogram, importHistogram, monitorEventLoopDelay, isRecordableHistogram } = require('internal/performance_histogram');
const trace = require('internal/trace_events');
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
const supportedTypes = Object.freeze([...new Set(['function', 'http2', 'mark', 'measure', 'resource', ...(host.performanceObserverTypes || [])])].sort());
const previousPerformance = globalThis.performance;
let startTime = host.performanceStartTime ?? (host.now() - (previousPerformance?.now() ?? process.uptime() * 1000));
let timeOrigin = host.performanceTimeOrigin ?? previousPerformance?.timeOrigin ?? (Date.now() - (host.now() - startTime));
// A process started from a heap image has its own start.
host.onHydrate(() => { startTime = host.performanceStartTime; timeOrigin = host.performanceTimeOrigin; });
const now = () => host.now() - startTime;
let deliveryScheduled = false;
let resourceLimit = 250;
let resourcePending = false;
let resourceOverflow = [];
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
  trace.performanceEntry(entry, startTime);
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
    const result = super.toJSON();
    for (const key of ['initiatorType', 'nextHopProtocol', ...Object.keys(resourceFields), ...Object.keys(connectionFields),
      'firstInterimResponseStart', 'responseStart', 'transferSize', 'deliveryType', 'responseStatus', 'renderBlockingStatus', 'contentType', 'contentEncoding']) result[key] = this[key];
    return result;
  }
}
for (const [name, field] of Object.entries(resourceFields)) Object.defineProperty(PerformanceResourceTiming.prototype, name, {
  enumerable: true, configurable: true, get() { return data(this).timing[field]; }
});
for (const [name, field] of Object.entries(connectionFields)) Object.defineProperty(PerformanceResourceTiming.prototype, name, {
  enumerable: true, configurable: true, get() { return data(this).timing.finalConnectionTimingInfo?.[field]; }
});
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
    if (typeof callback !== 'function') throw error('ERR_INVALID_ARG_TYPE', 'callback must be a function');
    this.#callback = callback;
  }
  observe(options = {}) {
    object(options, 'options');
    const { entryTypes, type, buffered } = options;
    if (entryTypes === undefined && type === undefined) throw error('ERR_MISSING_ARGS', 'options.entryTypes or options.type is required');
    if (entryTypes != null && type != null) throw error('ERR_INVALID_ARG_VALUE', 'entryTypes and type cannot both be set');
    const mode = entryTypes !== undefined ? 'multiple' : 'single';
    if (this.#mode !== undefined && this.#mode !== mode) throw new DOMException('PerformanceObserver cannot change observation mode', 'InvalidModificationError');
    this.#mode = mode;
    if (mode === 'multiple') {
      if (!Array.isArray(entryTypes)) throw error('ERR_INVALID_ARG_TYPE', 'options.entryTypes must be an array');
      this.#types = new Set(entryTypes.filter(value => supportedTypes.includes(value)));
    } else {
      if (!supportedTypes.includes(type)) return;
      this.#types.add(type);
      if (buffered) {
        this.#records.push(...filter(allEntries(), undefined, type));
        pending.add(this); scheduleDelivery();
      }
    }
    if (this.#types.size) observers.add(this); else this.disconnect();
  }
  disconnect() { observers.delete(this); pending.delete(this); this.#records = []; this.#types.clear(); this.#mode = undefined; }
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
  if (typeof fn !== 'function') throw error('ERR_INVALID_ARG_TYPE', 'fn must be a function');
  object(options, 'options');
  const histogram = options.histogram;
  if (histogram !== undefined && !isRecordableHistogram(histogram)) throw error('ERR_INVALID_ARG_TYPE', 'options.histogram must be a RecordableHistogram');
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
    if (name === 'v8Start') return -1;
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
  get timeOrigin() { brand(this); return timeOrigin; }
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
  setResourceTimingBufferSize(size) { brand(this); required(arguments.length, 'maxSize'); resourceLimit = +size >>> 0; }
  markResourceTiming(timingInfo, requestedUrl, initiatorType, global, cacheMode, bodyInfo, responseStatus, deliveryType = '') {
    if (cacheMode !== '' && cacheMode !== 'local') throw error('ERR_INTERNAL_ASSERTION', "cache must be an empty string or 'local'", Error);
    const entry = new PerformanceResourceTiming(token, requestedUrl, 'resource');
    Object.assign(data(entry), { timing: timingInfo, initiatorType, cacheMode, bodyInfo, responseStatus, deliveryType });
    enqueue(entry); bufferResource(entry); return entry;
  }
  timerify(fn, options) { return timerify(fn, options); }
  eventLoopUtilization(util1, util2) { return eventLoopUtilization(util1, util2); }
  get onresourcetimingbufferfull() { return this.#handler; }
  set onresourcetimingbufferfull(value) {
    if (this.#handler) this.removeEventListener('resourcetimingbufferfull', this.#handler);
    this.#handler = typeof value === 'function' ? value : null;
    if (this.#handler) this.addEventListener('resourcetimingbufferfull', this.#handler);
  }
  toJSON() { brand(this); return { nodeTiming: this.nodeTiming, timeOrigin: this.timeOrigin, eventLoopUtilization: this.eventLoopUtilization() }; }
}
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
internalEntries.emit = (name, type, start, duration, detail) => emitNodeEntry(name, type, start - startTime, duration, detail);
const constants = Object.freeze({
  NODE_PERFORMANCE_GC_MAJOR: 4, NODE_PERFORMANCE_GC_MINOR: 1, NODE_PERFORMANCE_GC_INCREMENTAL: 8, NODE_PERFORMANCE_GC_WEAKCB: 16,
  NODE_PERFORMANCE_GC_FLAGS_NO: 0, NODE_PERFORMANCE_GC_FLAGS_CONSTRUCT_RETAINED: 2, NODE_PERFORMANCE_GC_FLAGS_FORCED: 4,
  NODE_PERFORMANCE_GC_FLAGS_SYNCHRONOUS_PHANTOM_PROCESSING: 8, NODE_PERFORMANCE_GC_FLAGS_ALL_AVAILABLE_GARBAGE: 16,
  NODE_PERFORMANCE_GC_FLAGS_ALL_EXTERNAL_MEMORY: 32, NODE_PERFORMANCE_GC_FLAGS_SCHEDULE_IDLE: 64
});
module.exports = { Performance, PerformanceEntry, PerformanceMark, PerformanceMeasure, PerformanceObserver, PerformanceObserverEntryList,
  PerformanceResourceTiming, monitorEventLoopDelay, createHistogram, createSlidingWindowHistogram, importHistogram,
  eventLoopUtilization, timerify, performance, constants };
