'use strict';

const host = require('internal/host');
const token = Symbol('Histogram');
const states = new WeakMap();
const maxInt64 = 9223372036854775807n;
function error(code, message, Type = RangeError) { return Object.assign(new Type(message), { code }); }
function integer(value, name, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'number') throw error('ERR_INVALID_ARG_TYPE', `${name} must be a number`, TypeError);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw error('ERR_OUT_OF_RANGE', `${name} is out of range`);
}
function positive(value, name) {
  if (typeof value === 'bigint') {
    if (value < 1n || value > maxInt64) throw error('ERR_OUT_OF_RANGE', `${name} is out of range`);
    return value;
  }
  integer(value, name);
  return BigInt(value);
}
function state(value) {
  const result = states.get(value);
  if (!result) throw error('ERR_INVALID_THIS', 'Value must be a Histogram', TypeError);
  return result;
}
function bucket(s, value) {
  let shift = s.unit;
  let scaled = value >> shift;
  while (scaled >= s.subBuckets) { scaled >>= 1n; shift++; }
  const width = 1n << shift;
  return { low: (value >> shift) << shift, width };
}
function updateEwma(s, value) {
  if (!s.alpha) return;
  value = Number(value);
  if (!s.ewmaInitialized) {
    s.ewmaMean = value; s.ewmaVariance = 0; s.ewmaInitialized = true;
    s.ewmaErrorRate = s.threshold > 0 && value > s.threshold ? 1 : 0;
    return;
  }
  const difference = value - s.ewmaMean;
  s.ewmaMean += s.alpha * difference;
  s.ewmaVariance = (1 - s.alpha) * (s.ewmaVariance + s.alpha * difference ** 2);
  if (s.threshold > 0) s.ewmaErrorRate += s.alpha * ((value > s.threshold ? 1 : 0) - s.ewmaErrorRate);
}
function record(s, value, count = 1n, update = true) {
  if (value < 0n || value > s.limit) { s.exceeds += count; return false; }
  const { low, width } = bucket(s, value);
  let entry = s.bins.get(low);
  if (!entry) { entry = { low, width, count: 0n }; s.bins.set(low, entry); }
  entry.count += count;
  s.count += count;
  if (update) updateEwma(s, value);
  return true;
}
function sorted(s) { return Array.from(s.bins.values()).sort((a, b) => a.low < b.low ? -1 : a.low > b.low ? 1 : 0); }
function percentile(s, p) {
  if (typeof p !== 'number') throw error('ERR_INVALID_ARG_TYPE', 'percentile must be a number', TypeError);
  if (!(p > 0 && p <= 100)) throw error('ERR_OUT_OF_RANGE', 'percentile must be > 0 and <= 100');
  if (!s.count) return 0n;
  const target = BigInt(Math.max(1, Math.floor(p / 100 * Number(s.count) + 0.5)));
  let count = 0n;
  for (const entry of sorted(s)) { count += entry.count; if (count >= target) return entry.low + entry.width - 1n; }
  return 0n;
}
function moments(s) {
  if (!s.count) return { mean: NaN, stddev: NaN };
  let sum = 0;
  for (const entry of s.bins.values()) sum += Number(entry.low + (entry.width >> 1n)) * Number(entry.count);
  const mean = sum / Number(s.count);
  let squared = 0;
  for (const entry of s.bins.values()) squared += (Number(entry.low + (entry.width >> 1n)) - mean) ** 2 * Number(entry.count);
  return { mean, stddev: Math.sqrt(squared / Number(s.count)) };
}
class Histogram {
  constructor(key, options) {
    if (key !== token) throw error('ERR_ILLEGAL_CONSTRUCTOR', 'Illegal constructor', TypeError);
    const lowest = positive(options.lowest ?? 1, 'options.lowest');
    const highest = positive(options.highest ?? Number.MAX_SAFE_INTEGER, 'options.highest');
    if (highest < lowest * 2n) throw error('ERR_OUT_OF_RANGE', 'options.highest must be >= 2 * options.lowest');
    const figures = options.figures ?? 3;
    integer(figures, 'options.figures', 1, 5);
    const unit = BigInt(lowest.toString(2).length - 1);
    const subBuckets = 1n << BigInt(Math.ceil(Math.log2(2 * 10 ** figures)));
    // HDR allocates complete buckets, including the rest of the highest bucket.
    let limit = (subBuckets << unit) - 1n;
    while (limit < highest) limit = (limit << 1n) | 1n;
    const halfLife = options.halfLife ?? 0, threshold = options.threshold ?? 0;
    for (const [name, value] of [['halfLife', halfLife], ['threshold', threshold]]) {
      if (typeof value !== 'number') throw error('ERR_INVALID_ARG_TYPE', `options.${name} must be a number`, TypeError);
      if (!(value >= 0) || !Number.isFinite(value)) throw error('ERR_OUT_OF_RANGE', `options.${name} must be finite and >= 0`);
    }
    states.set(this, { bins: new Map(), count: 0n, exceeds: 0n, unit, subBuckets, limit, lowest, highest, figures, previous: undefined,
      alpha: halfLife > 0 ? 1 - 2 ** (-1 / halfLife) : 0, threshold, ewmaMean: 0, ewmaVariance: 0, ewmaErrorRate: 0, ewmaInitialized: false });
  }
  get count() { return Number(state(this).count); }
  get countBigInt() { return state(this).count; }
  get exceeds() { return Number(state(this).exceeds); }
  get exceedsBigInt() { return state(this).exceeds; }
  get minBigInt() { const entries = sorted(state(this)); return entries.length ? entries[0].low : maxInt64; }
  get min() { return Number(this.minBigInt); }
  get maxBigInt() { const entries = sorted(state(this)); const last = entries[entries.length - 1]; return last ? last.low + last.width - 1n : 0n; }
  get max() { return Number(this.maxBigInt); }
  get mean() { return moments(state(this)).mean; }
  get stddev() { return moments(state(this)).stddev; }
  get ewmaMean() { return state(this).ewmaMean; }
  get ewmaStddev() { return Math.sqrt(state(this).ewmaVariance); }
  get ewmaErrorRate() { return state(this).ewmaErrorRate; }
  countAt(value) {
    if (typeof value !== 'number') throw error('ERR_INVALID_ARG_TYPE', 'value must be a number', TypeError);
    if (!Number.isFinite(value) || value < 0) return 0;
    const s = state(this);
    return Number(s.bins.get(bucket(s, BigInt(Math.trunc(value))).low)?.count ?? 0n);
  }
  cdf(value) {
    if (typeof value !== 'number') throw error('ERR_INVALID_ARG_TYPE', 'value must be a number', TypeError);
    const s = state(this);
    if (!s.count) return 0;
    let count = 0n;
    for (const entry of s.bins.values()) if (Number(entry.low) <= value) count += entry.count;
    return Number(count) / Number(s.count);
  }
  ccdf(value) { return 1 - this.cdf(value); }
  get skewness() { return shape(state(this), 3); }
  get kurtosis() { return shape(state(this), 4) - 3; }
  export() { return exportHistogram(state(this)); }
  percentile(value) { return Number(percentile(state(this), value)); }
  percentileBigInt(value) { return percentile(state(this), value); }
  percentilesAt(values) {
    if (!Array.isArray(values)) throw error('ERR_INVALID_ARG_TYPE', 'percentiles must be an array', TypeError);
    const result = new Map();
    for (const value of values) result.set(value, this.percentile(value));
    return new Map(Array.from(result).sort((a, b) => a[0] - b[0]));
  }
  burnRate(target) {
    if (typeof target !== 'number') throw error('ERR_INVALID_ARG_TYPE', 'sloTarget must be a number', TypeError);
    if (!(target > 0 && target < 1)) throw error('ERR_OUT_OF_RANGE', 'sloTarget must be > 0 and < 1');
    return this.ewmaErrorRate / (1 - target);
  }
  ksTest(other) {
    if (!states.has(other)) throw error('ERR_INVALID_ARG_TYPE', 'other must be a Histogram', TypeError);
    const left = state(this), right = state(other);
    if (!left.count || !right.count) return 0;
    const deltas = new Map();
    for (const entry of left.bins.values()) {
      const index = indexFor(left, entry.low); deltas.set(index, (deltas.get(index) ?? 0) + Number(entry.count) / Number(left.count));
    }
    for (const entry of right.bins.values()) {
      const index = indexFor(right, entry.low); deltas.set(index, (deltas.get(index) ?? 0) - Number(entry.count) / Number(right.count));
    }
    let difference = 0, maximum = 0;
    for (const [, delta] of Array.from(deltas).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) {
      difference += delta; maximum = Math.max(maximum, Math.abs(difference));
    }
    return maximum;
  }
  get percentilesBigInt() {
    const s = state(this), result = new Map();
    if (!s.count) { result.set(100, 0n); return result; }
    const list = sorted(s);
    let index = 0, cumulative = list[0].count;
    for (let p = 0; p < 100;) {
      while (index + 1 < list.length && Number(cumulative) * 100 / Number(s.count) < p) cumulative += list[++index].count;
      result.set(p, list[index].low);
      if (cumulative === s.count) break;
      p += 100 / 2 ** (Math.floor(Math.log2(100 / (100 - p))) + 1);
    }
    result.set(100, list[list.length - 1].low);
    return result;
  }
  get percentiles() { return new Map(Array.from(this.percentilesBigInt, ([key, value]) => [key, Number(value)])); }
  reset() {
    const s = state(this); s.bins.clear(); s.count = 0n; s.exceeds = 0n; s.previous = undefined;
    s.ewmaMean = 0; s.ewmaVariance = 0; s.ewmaErrorRate = 0; s.ewmaInitialized = false;
  }
  toJSON() {
    return { count: this.count, min: this.min, max: this.max, mean: this.mean, exceeds: this.exceeds, stddev: this.stddev,
      skewness: this.skewness, kurtosis: this.kurtosis, ewmaMean: this.ewmaMean, ewmaStddev: this.ewmaStddev,
      ewmaErrorRate: this.ewmaErrorRate, percentiles: Object.fromEntries(this.percentiles) };
  }
}
// A bigint value must fit the int64 recorder and be at least 1, as in Node's native histogram.
function bigintValue(value) {
  if (value < 1n || value > maxInt64) throw error('ERR_OUT_OF_RANGE', `The value of "val" is out of range. It must be >= 1 && <= ${maxInt64}. Received ${value}n`);
  return value;
}
class RecordableHistogram extends Histogram {
  record(value) {
    const s = state(this);
    if (typeof value !== 'bigint') integer(value, 'val');
    else bigintValue(value);
    record(s, BigInt(value));
  }
  recordDelta() {
    const s = state(this), current = host.nowNanoseconds();
    if (s.previous !== undefined) record(s, current - s.previous);
    s.previous = current;
  }
  recordCorrected(value, interval) {
    if (typeof value === 'bigint') {
      if (typeof interval !== 'bigint') throw error('ERR_INVALID_ARG_TYPE', 'expectedInterval must be a bigint', TypeError);
    } else { integer(value, 'val'); integer(interval, 'expectedInterval'); }
    const s = state(this), amount = BigInt(value), step = BigInt(interval);
    if (!record(s, amount)) return;
    if (step > 0n) for (let missing = amount - step; missing >= step; missing -= step) record(s, missing, 1n, false);
  }
  subtract(other) {
    if (!(other instanceof RecordableHistogram)) throw error('ERR_INVALID_ARG_TYPE', 'other must be a RecordableHistogram', TypeError);
    const s = state(this), source = state(other);
    if (s.unit !== source.unit || s.subBuckets !== source.subBuckets || s.limit !== source.limit) throw error('ERR_INVALID_ARG_VALUE', 'Histograms must have compatible configurations', TypeError);
    for (const entry of Array.from(source.bins.values(), entry => ({ ...entry }))) {
      const target = s.bins.get(entry.low);
      if (!target) continue;
      const count = target.count < entry.count ? target.count : entry.count;
      target.count -= count; s.count -= count;
      if (!target.count) s.bins.delete(entry.low);
    }
    s.exceeds = s.exceeds > source.exceeds ? s.exceeds - source.exceeds : 0n;
  }
  add(other) {
    if (!(other instanceof RecordableHistogram)) throw error('ERR_INVALID_ARG_TYPE', 'other must be a RecordableHistogram', TypeError);
    const source = state(other), target = state(this);
    // Snapshot permits adding a histogram to itself without mutating iteration counts.
    const entries = Array.from(source.bins.values(), entry => [entry.low, entry.count]);
    target.exceeds += source.exceeds;
    if (source.previous !== undefined && (target.previous === undefined || source.previous > target.previous)) target.previous = source.previous;
    for (const [value, count] of entries) record(target, value, count, false);
  }
}
function createHistogram(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw error('ERR_INVALID_ARG_TYPE', 'options must be an object', TypeError);
  return new RecordableHistogram(token, options);
}
class ELDHistogram extends Histogram {
  #stop;
  #resolution;
  #perIteration;
  #previous;
  constructor(resolution, perIteration) { super(token, { lowest: perIteration ? 1 : 1000, highest: maxInt64 }); this.#resolution = resolution; this.#perIteration = perIteration; }
  enable() {
    if (this.#stop !== undefined) return false;
    this.#previous = host.nowNanoseconds();
    const sample = () => {
      const current = host.nowNanoseconds();
      if (this.#previous !== undefined) record(state(this), current - this.#previous);
      this.#previous = current;
    };
    if (this.#perIteration) this.#stop = host.performanceAddLoopListener(sample);
    else {
      const timer = setInterval(sample, this.#resolution);
      timer.unref();
      this.#stop = () => clearInterval(timer);
    }
    return true;
  }
  disable() {
    if (this.#stop === undefined) return false;
    this.#stop(); this.#stop = undefined; return true;
  }
  reset() { super.reset(); this.#previous = undefined; }
  [Symbol.dispose]() { this.disable(); }
}
function monitorEventLoopDelay(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw error('ERR_INVALID_ARG_TYPE', 'options must be an object', TypeError);
  const resolution = options.resolution ?? 10;
  integer(resolution, 'options.resolution');
  const perIteration = options.samplePerIteration ?? false;
  if (typeof perIteration !== 'boolean') throw error('ERR_INVALID_ARG_TYPE', 'options.samplePerIteration must be a boolean', TypeError);
  if (perIteration && typeof host.performanceAddLoopListener !== 'function') throw error('ERR_NOT_SUPPORTED', 'Per-iteration event loop instrumentation is not available', Error);
  return new ELDHistogram(resolution, perIteration);
}
function shape(s, power) {
  const { mean, stddev } = moments(s);
  if (s.count < BigInt(power) || !stddev) return power === 4 ? 3 : 0;
  let sum = 0;
  for (const entry of s.bins.values()) sum += ((Number(entry.low + (entry.width >> 1n)) - mean) / stddev) ** power * Number(entry.count);
  return sum / Number(s.count);
}
function countsLength(s) {
  const buckets = BigInt((s.limit + 1n).toString(2).length - (s.subBuckets << s.unit).toString(2).length + 1);
  return (buckets + 1n) * (s.subBuckets >> 1n);
}
function indexFor(s, value) {
  const { width } = bucket(s, value);
  const shift = BigInt(width.toString(2).length - 1) - s.unit;
  return shift * (s.subBuckets >> 1n) + (value >> (s.unit + shift));
}
function valueFor(s, index) {
  const half = s.subBuckets >> 1n;
  if (index < s.subBuckets) return index << s.unit;
  const shift = index / half - 1n;
  return ((index % half) + half) << (s.unit + shift);
}
function exportHistogram(s) {
  const { encode } = require('internal/performance_cbor');
  const list = sorted(s), sparse = [];
  let previous = 0n;
  for (const entry of list) {
    const index = indexFor(s, entry.low);
    sparse.push(index - previous, entry.count); previous = index;
  }
  const map = new Map([
    [0, 1n], [1, s.lowest], [2, s.highest], [3, BigInt(s.figures)], [4, s.count],
    [5, list.length ? list[0].low : maxInt64], [6, list.length ? list[list.length - 1].low : 0n],
    [7, 0n], [8, 1], [9, countsLength(s)], [10, sparse]
  ]);
  if (s.alpha > 0) map.set(11, new Map([[0, s.alpha], [1, s.ewmaMean], [2, s.ewmaVariance], [3, s.ewmaErrorRate], [4, BigInt(Math.trunc(s.threshold))]]));
  return encode(map);
}
function importHistogram(bytes) {
  const { decode, invalid } = require('internal/performance_cbor');
  const map = decode(bytes);
  if (!(map instanceof Map) || map.get(0n) !== 1n) invalid();
  for (const key of map.keys()) if (key > 11n) invalid();
  for (const key of [1n, 2n, 3n, 4n, 5n, 6n, 7n, 9n]) if (typeof map.get(key) !== 'bigint') invalid();
  const ewma = map.get(11n);
  if (ewma !== undefined && !(ewma instanceof Map)) invalid();
  const alpha = Number(ewma?.get(0n) ?? 0);
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) invalid();
  let histogram;
  try {
    histogram = createHistogram({ lowest: map.get(1n), highest: map.get(2n), figures: Number(map.get(3n)),
      halfLife: alpha > 0 && alpha < 1 ? -1 / Math.log2(1 - alpha) : 0, threshold: Number(ewma?.get(4n) ?? 0) });
  } catch { invalid(); }
  const s = state(histogram), length = countsLength(s), offset = map.get(7n), sparse = map.get(10n);
  if (map.get(9n) !== length || offset < 0n || offset >= length || !Array.isArray(sparse) || sparse.length % 2) invalid();
  let index = 0n;
  for (let i = 0; i < sparse.length; i += 2) {
    const delta = sparse[i], count = sparse[i + 1];
    if (typeof delta !== 'bigint' || typeof count !== 'bigint' || count > maxInt64 || (i && delta === 0n)) invalid();
    index += delta;
    if (index >= length) invalid();
    if (count) record(s, valueFor(s, (index + offset) % length), count, false);
  }
  if (s.count !== map.get(4n)) invalid();
  if (ewma) {
    for (const key of ewma.keys()) if (key > 4n) invalid();
    s.alpha = alpha; s.ewmaMean = Number(ewma.get(1n) ?? 0); s.ewmaVariance = Number(ewma.get(2n) ?? 0);
    s.ewmaErrorRate = Number(ewma.get(3n) ?? 0); s.ewmaInitialized = alpha > 0;
    if (![s.ewmaMean, s.ewmaVariance, s.ewmaErrorRate].every(Number.isFinite) || s.ewmaVariance < 0) invalid();
  }
  return histogram;
}
const slidingWindows = new WeakSet();
function checkSlidingWindow(value) {
  if (!slidingWindows.has(value)) throw error('ERR_INVALID_THIS', 'Value of "this" must be of type SlidingWindowHistogram', TypeError);
}
class SlidingWindowHistogram {
  #options;
  #chunks;
  #duration;
  #records;
  #attempts = 0;
  #epoch;
  #index = 0;
  #ring = new Map();
  constructor(key, options) {
    if (key !== token) throw error('ERR_ILLEGAL_CONSTRUCTOR', 'Illegal constructor', TypeError);
    slidingWindows.add(this);
    this.#options = { lowest: options.lowest, highest: options.highest, figures: options.figures };
    this.#chunks = options.chunks;
    this.#duration = options.chunkDuration === undefined ? undefined : BigInt(options.chunkDuration) * 1000000n;
    this.#records = options.recordsPerChunk;
    this.#epoch = host.nowNanoseconds();
    this.#ring.set(0, createHistogram(this.#options));
  }
  #rotate(recording) {
    let index = this.#index;
    if (this.#duration !== undefined) index = Number((host.nowNanoseconds() - this.#epoch) / this.#duration);
    else if (recording && this.#attempts === this.#records) { index++; this.#attempts = 0; }
    if (index !== this.#index) {
      this.#index = index;
      for (const key of this.#ring.keys()) if (key <= index - this.#chunks) this.#ring.delete(key);
    }
  }
  record(value) {
    checkSlidingWindow(this);
    if (typeof value !== 'bigint') integer(value, 'val');
    else bigintValue(value);
    this.#rotate(true);
    let current = this.#ring.get(this.#index);
    if (!current) { current = createHistogram(this.#options); this.#ring.set(this.#index, current); }
    current.record(value); this.#attempts++;
  }
  snapshot() {
    checkSlidingWindow(this);
    this.#rotate(false);
    const result = new Histogram(token, this.#options), target = state(result);
    for (const histogram of this.#ring.values()) {
      const source = state(histogram); target.exceeds += source.exceeds;
      for (const entry of source.bins.values()) record(target, entry.low, entry.count, false);
    }
    return result;
  }
  reset() { checkSlidingWindow(this); this.#ring.clear(); this.#epoch = host.nowNanoseconds(); this.#index = 0; this.#attempts = 0; }
}
function createSlidingWindowHistogram(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw error('ERR_INVALID_ARG_TYPE', 'options must be an object', TypeError);
  integer(options.chunks, 'options.chunks', 1, 1024);
  if ((options.chunkDuration === undefined) === (options.recordsPerChunk === undefined)) throw error('ERR_INVALID_ARG_VALUE', 'Specify exactly one of chunkDuration or recordsPerChunk', TypeError);
  if (options.chunkDuration !== undefined) integer(options.chunkDuration, 'options.chunkDuration', 1, 18446744073709);
  else integer(options.recordsPerChunk, 'options.recordsPerChunk');
  return new SlidingWindowHistogram(token, options);
}
// A sliding window keeps its chunks private to the thread that records into it.
host.types.isSlidingWindowHistogram = value => slidingWindows.has(value);
Object.defineProperty(Histogram.prototype, Symbol.toStringTag, { value: 'Histogram', configurable: true });
Object.defineProperty(Histogram.prototype, Symbol.for('nodejs.util.inspect.custom'), {
  configurable: true, writable: true,
  value: function inspect(depth, options) {
    const { inspect } = require('util');
    if (depth < 0) return this;
    const opts = { ...options, depth: options.depth == null ? null : options.depth - 1 };
    return `Histogram ${inspect({ min: this.min, max: this.max, mean: this.mean, exceeds: this.exceeds, stddev: this.stddev,
      skewness: this.skewness, kurtosis: this.kurtosis, count: this.count, percentiles: this.percentiles }, opts)}`;
  },
});
Object.defineProperty(RecordableHistogram.prototype, Symbol.toStringTag, { value: 'RecordableHistogram', configurable: true });
module.exports = { createHistogram, createSlidingWindowHistogram, importHistogram, monitorEventLoopDelay,
  isRecordableHistogram: value => value instanceof RecordableHistogram };
