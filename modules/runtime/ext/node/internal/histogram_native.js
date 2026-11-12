// Adapted from Node.js v24.22.1 src/histogram.cc, src/histogram-inl.h and
// deps/histogram/src/hdr_histogram.c (HdrHistogram_c, public domain).
// Copyright Node.js contributors. MIT license (see vendor/node-api/LICENSE).
'use strict';
// internalBinding('performance').Histogram and SlidingWindowHistogram: the
// native objects lib/internal/histogram.js wraps. A histogram's counts and
// fields live in one SharedArrayBuffer, so a clone sent to a port or a worker
// is the same histogram, as Node's shared_ptr<Histogram> is.
const host = require('internal/host');

const kMaxInt64 = 9223372036854775807n;
const kInt64Max = kMaxInt64;

// ---------------------------------------------------------------------------
// Special functions (histogram.cc, anonymous namespace).

const lgamma = host.lgamma;
const erfc = host.erfc;
const SQRT2 = Math.SQRT2;
const PI = Math.PI;
const clamp = (value, low, high) => (value < low ? low : high < value ? high : value);

function BetaContinuedFraction(a, b, x) {
  const FPMIN = 1e-30;
  const MAXIT = 200;
  const EPS = 3e-12;
  const qab = a + b;
  const qap = a + 1.0;
  const qam = a - 1.0;
  let c = 1.0;
  let d = 1.0 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1.0 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1.0 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1.0 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1.0 / d;
    h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1.0 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1.0 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1.0 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1.0) <= EPS) break;
  }
  return h;
}

function StirlingCorrection(x) {
  const inverse = 1.0 / x;
  const inverseSquared = inverse * inverse;
  return inverse * (1.0 / 12.0 + inverseSquared * (-1.0 / 360.0 + inverseSquared *
    (1.0 / 1260.0 + inverseSquared * (-1.0 / 1680.0 + inverseSquared / 1188.0))));
}

function MakeBetaParameters(a, b, approximateLargeShapes) {
  const sum = a + b;
  const mean = a / sum;
  const useAsymptoticFront = approximateLargeShapes && a >= 8.0 && b >= 8.0;
  const useAsymptoticCdf = approximateLargeShapes && a * b / sum >= 25000.0;
  const variance = mean * (1.0 - mean) / (sum + 1.0);
  const skewness = 2.0 * (b - a) * Math.sqrt(sum + 1.0) / ((sum + 2.0) * Math.sqrt(a * b));
  const excessKurtosis = 6.0 * ((a - b) * (a - b) * (sum + 1.0) - a * b * (sum + 2.0)) /
    (a * b * (sum + 2.0) * (sum + 3.0));
  return {
    a,
    b,
    logNormalization: useAsymptoticFront ? 0.0 : lgamma(sum) - lgamma(a) - lgamma(b),
    mean,
    standardDeviation: Math.sqrt(variance),
    skewness,
    excessKurtosis,
    logScale: useAsymptoticFront ?
      0.5 * Math.log(sum * mean * (1.0 - mean) / (2.0 * PI)) +
        StirlingCorrection(sum) - StirlingCorrection(a) - StirlingCorrection(b) :
      0.0,
    symmetryPoint: (a + 1.0) / (sum + 2.0),
    useAsymptoticFront,
    useAsymptoticCdf,
  };
}

function ReflectBetaParameters(params) {
  return {
    a: params.b,
    b: params.a,
    logNormalization: params.logNormalization,
    mean: 1.0 - params.mean,
    standardDeviation: params.standardDeviation,
    skewness: -params.skewness,
    excessKurtosis: params.excessKurtosis,
    logScale: params.logScale,
    symmetryPoint: 1.0 - params.symmetryPoint,
    useAsymptoticFront: params.useAsymptoticFront,
    useAsymptoticCdf: params.useAsymptoticCdf,
  };
}

function BetaFront(params, x) {
  if (x <= 0.0 || x >= 1.0) return 0.0;
  let logFront;
  if (params.useAsymptoticFront) {
    logFront = params.a * Math.log1p((x - params.mean) / params.mean) +
      params.b * Math.log1p((params.mean - x) / (1.0 - params.mean)) + params.logScale;
  } else {
    logFront = params.logNormalization + params.a * Math.log(x) + params.b * Math.log(1.0 - x);
  }
  return Math.exp(logFront);
}

// Returns [cdf, front].
function AsymptoticBetaCdf(params, x, wantFront) {
  const z = (x - params.mean) / params.standardDeviation;
  const normalCdf = 0.5 * erfc(-z / SQRT2);
  if (Math.abs(z) >= 8.0) return [normalCdf, 0.0];
  const z2 = z * z;
  const z3 = z2 * z;
  const normalPdf = Math.exp(-0.5 * z2) / Math.sqrt(2.0 * PI);
  let front = 0.0;
  if (wantFront) {
    const z4 = z2 * z2;
    const z6 = z3 * z3;
    const densityCorrection = 1.0 + params.skewness / 6.0 * (z3 - 3.0 * z) +
      params.excessKurtosis / 24.0 * (z4 - 6.0 * z2 + 3.0) +
      params.skewness * params.skewness / 72.0 * (z6 - 15.0 * z4 + 45.0 * z2 - 15.0);
    front = x * (1.0 - x) * normalPdf / params.standardDeviation * Math.max(0.0, densityCorrection);
  }
  const correction = params.skewness / 6.0 * (1.0 - z2) -
    params.excessKurtosis / 24.0 * (z3 - 3.0 * z) -
    params.skewness * params.skewness / 72.0 * (z3 * z2 - 10.0 * z3 + 15.0 * z);
  return [clamp(normalCdf + normalPdf * correction, 0.0, 1.0), front];
}

// Returns [cdf, front]; front is the integrand's front factor at x.
function RegularizedIncompleteBetaFront(params, x, wantFront) {
  if (x <= 0.0) return [0.0, 0.0];
  if (x >= 1.0) return [1.0, 0.0];
  if (params.useAsymptoticCdf) return AsymptoticBetaCdf(params, x, wantFront);
  const front = BetaFront(params, x);
  if (x < params.symmetryPoint) {
    return [front * BetaContinuedFraction(params.a, params.b, x) / params.a, front];
  }
  return [1.0 - front * BetaContinuedFraction(params.b, params.a, 1.0 - x) / params.b, front];
}
function RegularizedIncompleteBeta(params, x) { return RegularizedIncompleteBetaFront(params, x, false)[0]; }
function RegularizedIncompleteBetaAB(a, b, x) { return RegularizedIncompleteBeta(MakeBetaParameters(a, b, false), x); }

function NormalCdf(x) { return 0.5 * erfc(-x * SQRT2 / 2.0); }

function StudentTCdf(t, df) {
  const squared = t * t;
  const denominator = df + squared;
  if (squared < df) {
    const ibeta = RegularizedIncompleteBetaAB(0.5, df / 2.0, squared / denominator);
    return t >= 0.0 ? 0.5 + 0.5 * ibeta : 0.5 - 0.5 * ibeta;
  }
  const ibeta = RegularizedIncompleteBetaAB(df / 2.0, 0.5, df / denominator);
  return t >= 0.0 ? 1.0 - 0.5 * ibeta : 0.5 * ibeta;
}

function StudentTUpperQuantile(p, df) {
  let lo = 0.0;
  let hi = 1.0;
  while (StudentTCdf(-hi, df) > p) hi *= 2.0;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2.0;
    if (StudentTCdf(-mid, df) > p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2.0;
}

function BinomialCdf(k, n, p) {
  if (k < 0) return 0.0;
  if (k >= n) return 1.0;
  return RegularizedIncompleteBetaAB(n - k, k + 1, 1.0 - p);
}

// ---------------------------------------------------------------------------
// QRDE (quantile-respectful density estimation) over a recorded snapshot:
// { totalCount, totalCountBig, buckets: [{ value, resolution, count, cumulativeCount, remainingCount }] }.

const kQrdeNone = 0, kQrdeHdr = 1, kQrdeAll = 2;

function QrdeShouldDequantize(bucket, dequantization) {
  return bucket.count > 1 && (dequantization === kQrdeAll ||
    (dequantization === kQrdeHdr && bucket.resolution > 1.0));
}

function QrdeBucketRange(snapshot, index, dequantization) {
  const bucket = snapshot.buckets[index];
  if (!QrdeShouldDequantize(bucket, dequantization)) return [bucket.value, bucket.value];
  const halfResolution = bucket.resolution / 2.0;
  if (snapshot.buckets.length === 1) return [bucket.value - halfResolution, bucket.value + halfResolution];
  if (index === 0) return [bucket.value, bucket.value + halfResolution];
  if (index + 1 === snapshot.buckets.length) return [bucket.value - halfResolution, bucket.value];
  return [bucket.value - halfResolution, bucket.value + halfResolution];
}

// Returns [begin, end] or undefined.
function QrdeExactSupport(snapshot, params, reflected, count) {
  const tailMass = 2 ** -80;
  const buckets = snapshot.buckets;
  let lo = 0;
  let hi = buckets.length;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const cdf = RegularizedIncompleteBeta(params, buckets[mid].cumulativeCount / count);
    if (!Number.isFinite(cdf)) return undefined;
    if (cdf < tailMass) lo = mid + 1;
    else hi = mid;
  }
  if (lo === buckets.length) return undefined;
  const first = lo;
  lo = first;
  hi = buckets.length;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const survival = RegularizedIncompleteBeta(reflected, buckets[mid].remainingCount / count);
    if (!Number.isFinite(survival)) return undefined;
    if (survival > tailMass) lo = mid + 1;
    else hi = mid;
  }
  if (lo === buckets.length || lo < first) return undefined;
  return [first, lo + 1];
}

function lowerBoundCumulative(buckets, from, target) {
  let lo = from, hi = buckets.length;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (buckets[mid].cumulativeCount < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function QrdeQuantile(snapshot, p, dequantization) {
  const buckets = snapshot.buckets;
  const count = snapshot.totalCount;
  const a = (count + 1.0) * p;
  const b = (count + 1.0) * (1.0 - p);
  const massParams = MakeBetaParameters(a, b, true);
  const reflectedParams = ReflectBetaParameters(massParams);
  let beginIndex = 0;
  let endIndex = buckets.length;
  if (massParams.useAsymptoticCdf) {
    const supportDeviations = 12.0;
    const lowerRank = Math.max(0.0, massParams.mean - supportDeviations * massParams.standardDeviation);
    const upperRank = Math.min(1.0, massParams.mean + supportDeviations * massParams.standardDeviation);
    const first = lowerBoundCumulative(buckets, 0, lowerRank * count);
    const last = lowerBoundCumulative(buckets, first, upperRank * count);
    beginIndex = first;
    if (last !== buckets.length) endIndex = last + 1;
  } else if (buckets.length >= 512) {
    const support = QrdeExactSupport(snapshot, massParams, reflectedParams, count);
    if (support !== undefined) [beginIndex, endIndex] = support;
  }
  const dequantize = dequantization !== kQrdeNone;
  const lowerEndpoint = QrdeBucketRange(snapshot, 0, dequantization)[0];
  const upperEndpoint = QrdeBucketRange(snapshot, buckets.length - 1, dequantization)[1];
  let previousCdf = 0.0;
  let previousSurvival = 0.0;
  let previousFront = 0.0;
  let previousCount = beginIndex === 0 ? 0 : buckets[beginIndex - 1].cumulativeCount;
  if (previousCount !== 0) {
    const [cdf, front] = RegularizedIncompleteBetaFront(massParams, previousCount / count, dequantize);
    previousCdf = cdf;
    previousFront = dequantize ? front : 0.0;
    if (!Number.isFinite(previousCdf) || (dequantize && !Number.isFinite(previousFront))) {
      beginIndex = 0;
      endIndex = buckets.length;
      previousCount = 0;
      previousCdf = 0.0;
      previousFront = 0.0;
    } else {
      previousCdf = clamp(previousCdf, 0.0, 1.0);
    }
  }
  let quantile = lowerEndpoint * previousCdf;
  let usingSurvival = false;
  for (let i = beginIndex; i < endIndex; i++) {
    const bucket = buckets[i];
    const u0 = previousCount / count;
    const u1 = bucket.cumulativeCount / count;
    let front = 0.0;
    let mass;
    if (u1 <= massParams.symmetryPoint) {
      const [value, f] = RegularizedIncompleteBetaFront(massParams, u1, dequantize);
      if (dequantize) front = f;
      const cdf = clamp(value, previousCdf, 1.0);
      mass = cdf - previousCdf;
      previousCdf = cdf;
    } else {
      const remainingRank = bucket.remainingCount / count;
      const [value, f] = RegularizedIncompleteBetaFront(reflectedParams, remainingRank, dequantize);
      if (dequantize) front = f;
      let survival = value;
      if (usingSurvival) {
        survival = clamp(survival, 0.0, previousSurvival);
        mass = previousSurvival - survival;
      } else {
        survival = clamp(survival, 0.0, 1.0 - previousCdf);
        mass = 1.0 - previousCdf - survival;
        usingSurvival = true;
      }
      previousSurvival = survival;
    }
    if (!QrdeShouldDequantize(bucket, dequantization)) {
      quantile += bucket.value * mass;
    } else {
      const sum = a + b;
      const rankWidth = bucket.count / count;
      const localMoment = clamp((a / sum - u0) * mass - (front - previousFront) / sum, 0.0, rankWidth * mass);
      const [lower, upper] = QrdeBucketRange(snapshot, i, dequantization);
      quantile += lower * mass + (upper - lower) * localMoment / rankWidth;
    }
    previousFront = front;
    previousCount = bucket.cumulativeCount;
  }
  const remainingMass = usingSurvival ? previousSurvival : 1.0 - previousCdf;
  quantile += upperEndpoint * clamp(remainingMass, 0.0, 1.0);
  return quantile;
}

function CalculateQrde(snapshot, probabilities, dequantization) {
  const result = { quantiles: [], densities: [], corrections: 0 };
  if (snapshot.buckets.length === 0) return result;
  const quantiles = new Array(probabilities.length).fill(0);
  const densities = new Array(probabilities.length - 1).fill(0);
  quantiles[0] = QrdeBucketRange(snapshot, 0, dequantization)[0];
  quantiles[quantiles.length - 1] = QrdeBucketRange(snapshot, snapshot.buckets.length - 1, dequantization)[1];
  for (let i = 1; i + 1 < probabilities.length; i++) {
    let value = QrdeQuantile(snapshot, probabilities[i], dequantization);
    value = clamp(value, quantiles[0], quantiles[quantiles.length - 1]);
    if (value < quantiles[i - 1]) {
      value = quantiles[i - 1];
      result.corrections++;
    }
    quantiles[i] = value;
  }
  for (let i = 0; i < densities.length; i++) {
    const width = quantiles[i + 1] - quantiles[i];
    const probabilityMass = probabilities[i + 1] - probabilities[i];
    densities[i] = width === 0.0 ? Infinity : probabilityMass / width;
  }
  result.quantiles = quantiles;
  result.densities = densities;
  return result;
}

// ---------------------------------------------------------------------------
// hdr_histogram.c. The struct's mutable fields and the counts array live in a
// SharedArrayBuffer: an Int32 lock word, then 8-byte header slots, then the
// int64 counts. Values are int64 in C; here they are Numbers where a double
// holds them exactly and BigInts where an API returns one.

const kHeaderSlots = 14;
const kTotal = 1, kMin = 2, kMax = 3, kExceeds = 4, kPrev = 5, kGeneration = 6, kOffset = 7, kId = 8;
const kEwmaMean = 9, kEwmaVariance = 10, kEwmaErrorRate = 11, kEwmaInitialized = 12, kConversion = 13;
const kTwo32 = 4294967296;
const kMaxSafe = 9007199254740991n;

function power(base, exp) {
  let result = 1;
  while (exp) { result *= base; exp--; }
  return result;
}

function bucketsNeededToCoverValue(value, subBucketCount, unitMagnitude) {
  let smallestUntrackableValue = BigInt(subBucketCount) << BigInt(unitMagnitude);
  let bucketsNeeded = 1;
  while (smallestUntrackableValue <= value) {
    if (smallestUntrackableValue > kInt64Max / 2n) return bucketsNeeded + 1;
    smallestUntrackableValue <<= 1n;
    bucketsNeeded++;
  }
  return bucketsNeeded;
}

// hdr_calculate_bucket_config; undefined for EINVAL. lowest and highest are BigInts.
function calculateBucketConfig(lowest, highest, figures) {
  if (lowest < 1n || figures < 1 || 5 < figures || BigInt.asIntN(64, lowest * 2n) > highest) return undefined;
  const largestValueWithSingleUnitResolution = 2 * power(10, figures);
  const subBucketCountMagnitude = Math.ceil(Math.log(largestValueWithSingleUnitResolution) / Math.log(2));
  const subBucketHalfCountMagnitude = (subBucketCountMagnitude > 1 ? subBucketCountMagnitude : 1) - 1;
  const unitMagnitude = Math.trunc(Math.log(Number(lowest)) / Math.log(2));
  const subBucketCount = 2 ** (subBucketHalfCountMagnitude + 1);
  if (unitMagnitude + subBucketHalfCountMagnitude > 61) return undefined;
  const bucketCount = bucketsNeededToCoverValue(highest, subBucketCount, unitMagnitude);
  return {
    lowest, highest, figures, unitMagnitude, subBucketHalfCountMagnitude, subBucketCount,
    subBucketHalfCount: subBucketCount / 2, bucketCount, countsLen: (bucketCount + 1) * (subBucketCount / 2),
  };
}

function bufferSize(cfg) { return (kHeaderSlots + cfg.countsLen) * 8; }

function makeHdr(cfg, buffer) {
  const h = {
    ...cfg,
    buffer,
    highestNumber: Number(cfg.highest),
    i32: new Int32Array(buffer, 0, 2),
    big: new BigInt64Array(buffer, 0, kHeaderSlots),
    f64: new Float64Array(buffer, 0, kHeaderSlots),
    counts: new BigInt64Array(buffer, kHeaderSlots * 8, cfg.countsLen),
    offset: 0,
  };
  // normalizing_index_offset is only set by an import, before anyone shares the histogram.
  h.offset = Number(h.big[kOffset]);
  return h;
}

// hdr_init_preallocated over a fresh shared buffer.
function initHdr(cfg) {
  const h = makeHdr(cfg, new SharedArrayBuffer(bufferSize(cfg)));
  h.big[kMin] = kInt64Max;
  h.big[kId] = BigInt(Math.floor(Math.random() * 2 ** 52) + 1);
  h.f64[kConversion] = 1.0;
  return h;
}

function bitLength(value) {
  return value >= kTwo32 ? 64 - Math.clz32(Math.floor(value / kTwo32)) : 32 - Math.clz32(value);
}

function bitLengthBig(value) {
  if (value <= kMaxSafe) return bitLength(Number(value));
  return value.toString(2).length;
}

// get_bucket_index: 64 - clz(value | sub_bucket_mask) - unit - (half_magnitude + 1).
function getBucketIndex(h, value) {
  const floor = h.unitMagnitude + h.subBucketHalfCountMagnitude + 1;
  const length = bitLength(value);
  return (length > floor ? length : floor) - floor;
}

function getBucketIndexBig(h, value) {
  const floor = h.unitMagnitude + h.subBucketHalfCountMagnitude + 1;
  const length = bitLengthBig(value);
  return (length > floor ? length : floor) - floor;
}

function getSubBucketIndex(value, bucketIndex, unitMagnitude) {
  return Math.floor(value / 2 ** (bucketIndex + unitMagnitude));
}

function countsIndex(h, bucketIndex, subBucketIndex) {
  return (bucketIndex + 1) * h.subBucketHalfCount + subBucketIndex - h.subBucketHalfCount;
}

function countsIndexFor(h, value) {
  if (typeof value === 'bigint') {
    if (value <= kMaxSafe && value >= 0n) value = Number(value);
    else {
      const bucketIndex = getBucketIndexBig(h, value);
      return countsIndex(h, bucketIndex, Number(value >> BigInt(bucketIndex + h.unitMagnitude)));
    }
  }
  const bucketIndex = getBucketIndex(h, value);
  return countsIndex(h, bucketIndex, getSubBucketIndex(value, bucketIndex, h.unitMagnitude));
}

function indexBucket(h, index) {
  let bucketIndex = Math.floor(index / h.subBucketHalfCount) - 1;
  let subBucketIndex = (index % h.subBucketHalfCount) + h.subBucketHalfCount;
  if (bucketIndex < 0) {
    subBucketIndex -= h.subBucketHalfCount;
    bucketIndex = 0;
  }
  return [bucketIndex, subBucketIndex];
}

function valueAtIndex(h, index) {
  const [bucketIndex, subBucketIndex] = indexBucket(h, index);
  return subBucketIndex * 2 ** (bucketIndex + h.unitMagnitude);
}

function valueAtIndexBig(h, index) {
  const [bucketIndex, subBucketIndex] = indexBucket(h, index);
  return BigInt(subBucketIndex) << BigInt(bucketIndex + h.unitMagnitude);
}

function sizeOfEquivalentValueRange(h, value) {
  const bucketIndex = getBucketIndex(h, value);
  const subBucketIndex = getSubBucketIndex(value, bucketIndex, h.unitMagnitude);
  const adjustedBucket = subBucketIndex >= h.subBucketCount ? bucketIndex + 1 : bucketIndex;
  return 2 ** (h.unitMagnitude + adjustedBucket);
}

function lowestEquivalentValue(h, value) {
  const bucketIndex = getBucketIndex(h, value);
  return getSubBucketIndex(value, bucketIndex, h.unitMagnitude) * 2 ** (bucketIndex + h.unitMagnitude);
}

function highestEquivalentValue(h, value) {
  return lowestEquivalentValue(h, value) + sizeOfEquivalentValueRange(h, value) - 1;
}

function medianEquivalentValue(h, value) {
  return lowestEquivalentValue(h, value) + Math.floor(sizeOfEquivalentValueRange(h, value) / 2);
}

// The exact int64 forms, for the BigInt getters.
function lowestEquivalentValueBig(h, value) {
  const shift = BigInt(getBucketIndexBig(h, value) + h.unitMagnitude);
  return (value >> shift) << shift;
}

function highestEquivalentValueBig(h, value) {
  const bucketIndex = getBucketIndexBig(h, value);
  const subBucketIndex = value >> BigInt(bucketIndex + h.unitMagnitude);
  const adjustedBucket = subBucketIndex >= BigInt(h.subBucketCount) ? bucketIndex + 1 : bucketIndex;
  return BigInt.asIntN(64, lowestEquivalentValueBig(h, value) + (1n << BigInt(h.unitMagnitude + adjustedBucket)) - 1n);
}

function normalizeIndex(h, index) {
  const offset = h.offset;
  if (offset === 0) return index;
  const normalizedIndex = index - offset;
  if (normalizedIndex < 0) return normalizedIndex + h.countsLen;
  if (normalizedIndex >= h.countsLen) return normalizedIndex - h.countsLen;
  return normalizedIndex;
}

function countAtIndex(h, index) {
  const count = h.counts[normalizeIndex(h, index)];
  return count === undefined ? 0n : count;
}

function hdrReset(h) {
  h.big[kTotal] = 0n;
  h.big[kMin] = kInt64Max;
  h.big[kMax] = 0n;
  h.counts.fill(0n);
}

function hdrResetInternalCounters(h) {
  let minNonZeroIndex = -1;
  let maxIndex = -1;
  let observedTotalCount = 0n;
  const { counts, countsLen } = h;
  for (let i = 0; i < countsLen; i++) {
    const countAtIndex = counts[i];
    if (countAtIndex > 0n) {
      observedTotalCount += countAtIndex;
      maxIndex = i;
      if (minNonZeroIndex === -1 && i !== 0) minNonZeroIndex = i;
    }
  }
  h.big[kMax] = maxIndex === -1 ? 0n : highestEquivalentValueBig(h, valueAtIndexBig(h, maxIndex));
  h.big[kMin] = minNonZeroIndex === -1 ? kInt64Max : valueAtIndexBig(h, minNonZeroIndex);
  h.big[kTotal] = observedTotalCount;
}

// hdr_record_values: value is a Number (a safe integer) or a BigInt.
function hdrRecordValues(h, value, count) {
  if (value < 0 || h.highest < value) return false;
  const index = countsIndexFor(h, value);
  if (index < 0 || index >= h.countsLen) return false;
  const normalized = normalizeIndex(h, index);
  h.counts[normalized] += count;
  h.big[kTotal] += count;
  const big = h.big;
  if (value > big[kMax]) big[kMax] = BigInt(value);
  if (value != 0 && value < big[kMin]) big[kMin] = BigInt(value);
  return true;
}

function hdrRecordCorrectedValues(h, value, count, expectedInterval) {
  if (!hdrRecordValues(h, value, count)) return false;
  value = BigInt(value);
  if (expectedInterval <= 0n || value <= expectedInterval) return true;
  for (let missingValue = value - expectedInterval; missingValue >= expectedInterval; missingValue -= expectedInterval) {
    if (!hdrRecordValues(h, missingValue, count)) return false;
  }
  return true;
}

function hdrAdd(h, from) {
  let dropped = 0n;
  const iter = new HdrIter(from, recordedIterNext);
  while (iter.next()) {
    const value = valueAtIndexBig(from, iter.countsIndex);
    const count = BigInt(iter.count);
    if (!hdrRecordValues(h, value, count)) dropped += count;
  }
  return dropped;
}

function hdrMax(h) {
  const max = h.big[kMax];
  if (max === 0n) return 0n;
  return highestEquivalentValueBig(h, max);
}

function hdrMin(h) {
  if (countAtIndex(h, 0) > 0n) return 0n;
  const min = h.big[kMin];
  if (min === kInt64Max) return kInt64Max;
  return lowestEquivalentValueBig(h, min);
}

function indexUpToCount(h, countAtPercentile) {
  if (countAtPercentile < 1) countAtPercentile = 1;
  let countToIndex = 0;
  const { counts, countsLen } = h;
  for (let index = 0; index < countsLen; index++) {
    const count = counts[index];
    if (count !== 0n) {
      countToIndex += Number(count);
      if (countToIndex >= countAtPercentile) return index;
    }
  }
  return -1;
}

// hdr_value_at_percentile, exact.
function hdrValueAtPercentile(h, percentile) {
  const requestedPercentile = percentile < 100.0 ? percentile : 100.0;
  const countAtPercentile = Math.trunc((requestedPercentile / 100) * Number(h.big[kTotal]) + 0.5);
  const index = indexUpToCount(h, countAtPercentile);
  const valueFromIndex = index < 0 ? 0n : valueAtIndexBig(h, index);
  if (percentile === 0.0) return lowestEquivalentValueBig(h, valueFromIndex);
  return highestEquivalentValueBig(h, valueFromIndex);
}

function hdrValueAtPercentiles(h, percentiles, values, length) {
  const totalCount = Number(h.big[kTotal]);
  for (let i = 0; i < length; i++) {
    const requestedPercentile = percentiles[i] < 100.0 ? percentiles[i] : 100.0;
    const countAtPercentile = Math.trunc((requestedPercentile / 100) * totalCount + 0.5);
    values[i] = countAtPercentile > 1 ? countAtPercentile : 1;
  }
  const iter = new HdrIter(h, allValuesIterNext);
  let total = 0;
  let atPos = 0;
  while (iter.next() && atPos < length) {
    total += iter.count;
    while (atPos < length && total >= values[atPos]) {
      values[atPos] = highestEquivalentValue(h, iter.value);
      atPos++;
    }
  }
}

function hdrMean(h) {
  const totalCount = Number(h.big[kTotal]);
  let total = 0;
  let count = 0;
  const { countsLen } = h;
  for (let index = 0; index < countsLen && count < totalCount; index++) {
    const c = Number(countAtIndex(h, index));
    if (c !== 0) {
      count += c;
      total += c * medianEquivalentValue(h, valueAtIndex(h, index));
    }
  }
  return total / totalCount;
}

function hdrStddev(h) {
  const mean = hdrMean(h);
  let geometricDevTotal = 0.0;
  const { countsLen } = h;
  for (let index = 0; index < countsLen; index++) {
    const c = Number(countAtIndex(h, index));
    if (c !== 0) {
      const dev = medianEquivalentValue(h, valueAtIndex(h, index)) - mean;
      geometricDevTotal += dev * dev * c;
    }
  }
  return Math.sqrt(geometricDevTotal / Number(h.big[kTotal]));
}

function hdrCountAtValue(h, value) {
  const index = countsIndexFor(h, value);
  if (index < 0 || index >= h.countsLen) return 0n;
  return countAtIndex(h, index);
}

// struct hdr_iter and its next functions.
class HdrIter {
  constructor(h, next) {
    this.h = h;
    this.countsIndex = -1;
    this.totalCount = Number(h.big[kTotal]);
    this.count = 0;
    this.cumulativeCount = 0;
    this.value = 0;
    this.valueIndex = -1;
    this.highestEquivalentValue = 0;
    this.lowestEquivalentValue = 0;
    this.medianEquivalentValue = 0;
    this.valueIteratedFrom = 0;
    this.valueIteratedTo = 0;
    this.countAddedInThisIterationStep = 0;
    this._next = next;
  }
  next() { return this._next(this); }
}

function hasNext(iter) { return iter.cumulativeCount < iter.totalCount; }

function moveNext(iter) {
  const h = iter.h;
  iter.countsIndex++;
  if (iter.countsIndex >= h.countsLen) return false;
  iter.count = Number(countAtIndex(h, iter.countsIndex));
  iter.cumulativeCount += iter.count;
  const value = valueAtIndex(h, iter.countsIndex);
  const leq = lowestEquivalentValue(h, value);
  const size = sizeOfEquivalentValueRange(h, value);
  iter.lowestEquivalentValue = leq;
  iter.value = value;
  iter.valueIndex = iter.countsIndex;
  iter.highestEquivalentValue = leq + size - 1;
  iter.medianEquivalentValue = leq + Math.floor(size / 2);
  return true;
}

function nextValueGreaterThanReportingLevelUpperBound(iter, reportingLevelUpperBound) {
  if (iter.countsIndex >= iter.h.countsLen) return false;
  return valueAtIndex(iter.h, iter.countsIndex + 1) > reportingLevelUpperBound;
}

function basicIterNext(iter) {
  if (!hasNext(iter) || iter.countsIndex >= iter.h.countsLen) return false;
  moveNext(iter);
  return true;
}

function updateIteratedValues(iter, newValueIteratedTo) {
  iter.valueIteratedFrom = iter.valueIteratedTo;
  iter.valueIteratedTo = newValueIteratedTo;
}

function allValuesIterNext(iter) {
  const result = moveNext(iter);
  if (result) updateIteratedValues(iter, iter.value);
  return result;
}

function percentileIter(h, ticksPerHalfDistance) {
  const iter = new HdrIter(h, percentileIterNext);
  iter.seenLastValue = false;
  iter.ticksPerHalfDistance = ticksPerHalfDistance;
  iter.percentileToIterateTo = 0.0;
  iter.percentile = 0.0;
  return iter;
}

function percentileIterNext(iter) {
  if (!hasNext(iter)) {
    if (iter.seenLastValue) return false;
    iter.seenLastValue = true;
    iter.percentile = 100.0;
    return true;
  }
  if (iter.countsIndex === -1 && !basicIterNext(iter)) return false;
  const total = Number(iter.h.big[kTotal]);
  do {
    const currentPercentile = (100.0 * iter.cumulativeCount) / total;
    if (iter.count !== 0 && iter.percentileToIterateTo <= currentPercentile) {
      updateIteratedValues(iter, highestEquivalentValue(iter.h, iter.value));
      iter.percentile = iter.percentileToIterateTo;
      const temp = Math.trunc(Math.log(100 / (100.0 - iter.percentileToIterateTo)) / Math.log(2)) + 1;
      // (int64_t) of an infinite double is INT64_MIN on the targets Node ships.
      const halfDistance = Number.isFinite(temp) ? Math.trunc(2 ** temp) : 0;
      const percentileReportingTicks = iter.ticksPerHalfDistance * halfDistance;
      iter.percentileToIterateTo += 100.0 / percentileReportingTicks;
      return true;
    }
  } while (basicIterNext(iter));
  return true;
}

function recordedIterNext(iter) {
  while (basicIterNext(iter)) {
    if (iter.count !== 0) {
      updateIteratedValues(iter, iter.value);
      iter.countAddedInThisIterationStep = iter.count;
      return true;
    }
  }
  return false;
}

function linearIter(h, valueUnitsPerBucket) {
  const iter = new HdrIter(h, linearIterNext);
  iter.valueUnitsPerBucket = valueUnitsPerBucket;
  iter.nextValueReportingLevel = valueUnitsPerBucket;
  iter.nextValueReportingLevelLowestEquivalent = lowestEquivalentValue(h, valueUnitsPerBucket);
  return iter;
}

function linearIterNext(iter) {
  iter.countAddedInThisIterationStep = 0;
  if (hasNext(iter) ||
      nextValueGreaterThanReportingLevelUpperBound(iter, iter.nextValueReportingLevelLowestEquivalent)) {
    do {
      if (iter.value >= iter.nextValueReportingLevelLowestEquivalent) {
        updateIteratedValues(iter, iter.nextValueReportingLevel);
        iter.nextValueReportingLevel += iter.valueUnitsPerBucket;
        iter.nextValueReportingLevelLowestEquivalent = lowestEquivalentValue(iter.h, iter.nextValueReportingLevel);
        return true;
      }
      if (!moveNext(iter)) return true;
      iter.countAddedInThisIterationStep += iter.count;
    } while (true);
  }
  return false;
}

function logIter(h, valueUnitsFirstBucket, logBase) {
  const iter = new HdrIter(h, logIterNext);
  iter.logBase = logBase;
  iter.nextValueReportingLevel = valueUnitsFirstBucket;
  iter.nextValueReportingLevelLowestEquivalent = lowestEquivalentValue(h, valueUnitsFirstBucket);
  return iter;
}

function logIterNext(iter) {
  iter.countAddedInThisIterationStep = 0;
  if (hasNext(iter) ||
      nextValueGreaterThanReportingLevelUpperBound(iter, iter.nextValueReportingLevelLowestEquivalent)) {
    do {
      if (iter.value >= iter.nextValueReportingLevelLowestEquivalent) {
        updateIteratedValues(iter, iter.nextValueReportingLevel);
        iter.nextValueReportingLevel *= Math.trunc(iter.logBase);
        iter.nextValueReportingLevelLowestEquivalent = lowestEquivalentValue(iter.h, iter.nextValueReportingLevel);
        return true;
      }
      if (!moveNext(iter)) return true;
      iter.countAddedInThisIterationStep += iter.count;
    } while (true);
  }
  return false;
}

// ---------------------------------------------------------------------------
// node::Histogram (histogram.cc, histogram-inl.h). Node guards it with an
// RwLock; the lock word here is the first Int32 of the shared buffer, taken
// by every thread that holds the histogram.

function lock(h) {
  while (Atomics.compareExchange(h.i32, 0, 0, 1) !== 0);
}

function unlock(h) {
  Atomics.store(h.i32, 0, 0);
}

// Two histograms lock in id order, as Node locks in pointer order.
function withPair(a, b, fn) {
  const first = a.big[kId] < b.big[kId] ? a : b;
  const second = first === a ? b : a;
  lock(first);
  try {
    lock(second);
    try { return fn(); } finally { unlock(second); }
  } finally { unlock(first); }
}

const snapshotCaches = new WeakMap();

class NativeHistogram {
  constructor(h, alpha, threshold) {
    this.h = h;
    this.alpha = alpha;
    this.threshold = threshold;
  }

  static Create(options) {
    const cfg = calculateBucketConfig(options.lowest, options.highest, options.figures);
    if (cfg === undefined) return undefined;
    return NativeHistogram.FromBuffer(cfg, initHdr(cfg), options.halfLife ?? 0, options.threshold ?? 0n);
  }

  static FromBuffer(cfg, h, halfLife, threshold) {
    // alpha = 1 - 2^(-1/halfLife). With halfLife <= 0, EWMA is disabled.
    const alpha = halfLife > 0 ? 1.0 - Math.exp(-Math.log(2.0) / halfLife) : 0;
    return new NativeHistogram(h, alpha, threshold);
  }

  same(other) { return this.h.big[kId] === other.h.big[kId]; }

  UpdateEwma(value) {
    const alpha = this.alpha;
    if (alpha <= 0) return;
    const f64 = this.h.f64;
    const threshold = this.threshold;
    if (!f64[kEwmaInitialized]) {
      f64[kEwmaMean] = value;
      f64[kEwmaVariance] = 0;
      f64[kEwmaInitialized] = 1;
      if (threshold > 0n) f64[kEwmaErrorRate] = value > Number(threshold) ? 1.0 : 0.0;
      return;
    }
    const diff = value - f64[kEwmaMean];
    f64[kEwmaMean] += alpha * diff;
    f64[kEwmaVariance] = (1.0 - alpha) * (f64[kEwmaVariance] + alpha * diff * diff);
    if (threshold > 0n) {
      const exceeded = value > Number(threshold) ? 1.0 : 0.0;
      f64[kEwmaErrorRate] += alpha * (exceeded - f64[kEwmaErrorRate]);
    }
  }

  InvalidateRecordedSnapshot() { this.h.big[kGeneration]++; }

  Reset() {
    const h = this.h;
    lock(h);
    try {
      hdrReset(h);
      this.InvalidateRecordedSnapshot();
      h.big[kExceeds] = 0n;
      h.big[kPrev] = 0n;
      h.f64[kEwmaMean] = 0;
      h.f64[kEwmaVariance] = 0;
      h.f64[kEwmaErrorRate] = 0;
      h.f64[kEwmaInitialized] = 0;
    } finally { unlock(h); }
  }

  Add(other) {
    const h = this.h, o = other.h;
    const doAdd = () => {
      h.big[kExceeds] += o.big[kExceeds];
      if (o.big[kPrev] > h.big[kPrev]) h.big[kPrev] = o.big[kPrev];
      // hdr_add merges all bucket counts and total_count internally.
      const dropped = Number(hdrAdd(h, o));
      this.InvalidateRecordedSnapshot();
      return dropped;
    };
    if (this.same(other)) {
      lock(h);
      try { return doAdd(); } finally { unlock(h); }
    }
    return withPair(h, o, doAdd);
  }

  read(fn) {
    const h = this.h;
    lock(h);
    try { return fn(h); } finally { unlock(h); }
  }

  Count() { return this.read(h => BigInt.asUintN(64, h.big[kTotal])); }
  Exceeds() { return this.read(h => BigInt.asUintN(64, h.big[kExceeds])); }
  Min() { return this.read(hdrMin); }
  Max() { return this.read(hdrMax); }
  Mean() { return this.read(hdrMean); }
  Stddev() { return this.read(hdrStddev); }
  EwmaMean() { return this.read(h => (h.f64[kEwmaInitialized] ? h.f64[kEwmaMean] : 0)); }
  EwmaStddev() { return this.read(h => (h.f64[kEwmaInitialized] ? Math.sqrt(h.f64[kEwmaVariance]) : 0)); }
  EwmaErrorRate() { return this.read(h => (h.f64[kEwmaInitialized] ? h.f64[kEwmaErrorRate] : 0)); }

  Percentile(percentile) {
    return this.read(h => hdrValueAtPercentile(h, percentile));
  }

  // fn(percentile, valueIndex): Node passes iter.value, the value at the
  // iterator's current index.
  Percentiles(fn) {
    this.read(h => {
      const iter = percentileIter(h, 1);
      while (iter.next()) fn(iter.percentile, iter.valueIndex);
    });
  }

  CountAt(value) { return this.read(h => hdrCountAtValue(h, value)); }

  RecordCorrected(value, expectedInterval) {
    const h = this.h;
    lock(h);
    try {
      const recorded = hdrRecordCorrectedValues(h, value, 1n, expectedInterval);
      if (!recorded) h.big[kExceeds]++;
      else {
        this.InvalidateRecordedSnapshot();
        this.UpdateEwma(Number(value));
      }
      return recorded;
    } finally { unlock(h); }
  }

  Record(value) {
    const h = this.h;
    lock(h);
    try {
      const recorded = hdrRecordValues(h, value, 1n);
      if (!recorded) h.big[kExceeds]++;
      else {
        h.big[kGeneration]++;
        if (this.alpha > 0) this.UpdateEwma(Number(value));
      }
      return recorded;
    } finally { unlock(h); }
  }

  RecordDelta() {
    const h = this.h;
    lock(h);
    try {
      const time = host.nowNanoseconds();
      let delta = 0n;
      const prev = h.big[kPrev];
      if (prev > 0n) {
        delta = time - prev;
        if (!hdrRecordValues(h, delta, 1n)) h.big[kExceeds]++;
        else {
          this.InvalidateRecordedSnapshot();
          this.UpdateEwma(Number(delta));
        }
      }
      h.big[kPrev] = time;
      return delta;
    } finally { unlock(h); }
  }

  LinearBuckets(stepSize, fn) {
    this.read(h => {
      const iter = linearIter(h, stepSize);
      while (iter.next()) fn(iter.value, iter.countAddedInThisIterationStep);
    });
  }

  LogBuckets(firstBucket, logBase, fn) {
    this.read(h => {
      const iter = logIter(h, firstBucket, logBase);
      while (iter.next()) fn(iter.value, iter.countAddedInThisIterationStep);
    });
  }

  Cdf(value) {
    return this.read(h => {
      const total = Number(h.big[kTotal]);
      if (total === 0) return 0.0;
      const iter = new HdrIter(h, allValuesIterNext);
      while (iter.next()) {
        if (iter.highestEquivalentValue >= value) return iter.cumulativeCount / total;
        // All recorded data accounted for; remaining buckets are empty.
        if (iter.cumulativeCount >= total) break;
      }
      return 1.0;
    });
  }

  moment(minimum, order) {
    return this.read(h => {
      const total = Number(h.big[kTotal]);
      if (total < minimum) return 0.0;
      const mean = hdrMean(h);
      let m2 = 0.0;
      let mk = 0.0;
      const iter = new HdrIter(h, recordedIterNext);
      while (iter.next()) {
        const dev = medianEquivalentValue(h, iter.value) - mean;
        const d2 = dev * dev;
        m2 += iter.count * d2;
        mk += iter.count * (order === 3 ? d2 * dev : d2 * d2);
      }
      const variance = m2 / total;
      if (variance === 0.0) return 0.0;
      if (order === 3) return (mk / total) / (variance * Math.sqrt(variance));
      return (mk / total) / (variance * variance) - 3.0;
    });
  }

  Skewness() { return this.moment(3, 3); }
  Kurtosis() { return this.moment(4, 4); }

  Subtract(other) {
    const h = this.h, o = other.h;
    const doSubtract = () => {
      let dropped = 0n;
      const len = Math.min(h.countsLen, o.countsLen);
      for (let i = 0; i < len; i++) {
        let count = BigInt.asIntN(64, h.counts[i] - o.counts[i]);
        if (count < 0n) {
          dropped += -count;
          count = 0n;
        }
        h.counts[i] = count;
      }
      hdrResetInternalCounters(h);
      this.InvalidateRecordedSnapshot();
      const exceeds = BigInt.asUintN(64, h.big[kExceeds]), otherExceeds = BigInt.asUintN(64, o.big[kExceeds]);
      h.big[kExceeds] = exceeds > otherExceeds ? exceeds - otherExceeds : 0n;
      return Number(dropped);
    };
    if (this.same(other)) {
      lock(h);
      try { return doSubtract(); } finally { unlock(h); }
    }
    return withPair(h, o, doSubtract);
  }

  pair(other, same, fn) {
    if (this.same(other)) return same;
    return withPair(this.h, other.h, () => fn(this.h, other.h));
  }

  KsTest(other) {
    return this.pair(other, 0.0, (h, o) => {
      const n1 = Number(h.big[kTotal]), n2 = Number(o.big[kTotal]);
      if (n1 === 0 || n2 === 0) return 0.0;
      let maxD = 0.0;
      let cum1 = 0, cum2 = 0;
      const len = Math.max(h.countsLen, o.countsLen);
      for (let i = 0; i < len; i++) {
        if (i < h.countsLen) cum1 += Number(h.counts[i]);
        if (i < o.countsLen) cum2 += Number(o.counts[i]);
        const cdf1 = cum1 / n1;
        const cdf2 = cum2 / n2;
        const d = cdf1 > cdf2 ? cdf1 - cdf2 : cdf2 - cdf1;
        if (d > maxD) maxD = d;
      }
      return maxD;
    });
  }

  PercentilesAt(percentiles, values, length) {
    this.read(h => hdrValueAtPercentiles(h, percentiles, values, length));
  }

  MeanCI(confidence) {
    return this.read(h => {
      const count = Number(h.big[kTotal]);
      const mean = hdrMean(h);
      if (count < 2) return [mean, NaN, NaN];
      const stddev = hdrStddev(h);
      if (stddev === 0.0) return [mean, mean, mean];
      // HdrHistogram computes population stddev (divides by N). The confidence
      // interval requires sample variance (divides by N-1).
      const variance = stddev * stddev * count / (count - 1);
      const standardError = Math.sqrt(variance / count);
      const alpha = 1.0 - confidence;
      const tCrit = StudentTUpperQuantile(alpha / 2.0, count - 1);
      const margin = tCrit * standardError;
      return [mean, mean - margin, mean + margin];
    });
  }

  WelchTest(other, confidence) {
    return this.pair(other, [0, 0, 1, 0, 0], (h, o) => {
      const n1 = Number(h.big[kTotal]), n2 = Number(o.big[kTotal]);
      if (n1 < 2 || n2 < 2) return [0, 0, 1, 0, 0];
      const mean1 = hdrMean(h), mean2 = hdrMean(o);
      const sd1 = hdrStddev(h), sd2 = hdrStddev(o);
      // HdrHistogram computes population stddev (divides by N).
      // Welch's t-test requires sample variance (divides by N-1).
      const var1 = sd1 * sd1 * n1 / (n1 - 1);
      const var2 = sd2 * sd2 * n2 / (n2 - 1);
      const se1 = var1 / n1;
      const se2 = var2 / n2;
      const seSum = se1 + se2;
      if (seSum === 0.0) return [0, 0, 1, 0, 0];
      const t = (mean1 - mean2) / Math.sqrt(seSum);
      // Welch-Satterthwaite degrees of freedom.
      const df = (seSum * seSum) / (se1 * se1 / (n1 - 1) + se2 * se2 / (n2 - 1));
      // Two-tailed p-value.
      const p = 2.0 * StudentTCdf(-Math.abs(t), df);
      // Confidence interval on the difference of means.
      const alpha = 1.0 - confidence;
      const tCrit = StudentTUpperQuantile(alpha / 2.0, df);
      const margin = tCrit * Math.sqrt(seSum);
      const diff = mean1 - mean2;
      return [t, df, p, diff - margin, diff + margin];
    });
  }

  // Concordant and tied pairs over the raw counts (h1 values beat h2 values
  // at lower indices).
  static pairs(h, o) {
    const len = Math.max(h.countsLen, o.countsLen);
    let cum2 = 0;
    let concordant = 0.0;
    let tied = 0.0;
    for (let i = 0; i < len; i++) {
      const c1 = i < h.countsLen ? Number(h.counts[i]) : 0;
      const c2 = i < o.countsLen ? Number(o.counts[i]) : 0;
      concordant += c1 * cum2;
      tied += c1 * c2;
      cum2 += c2;
    }
    return [concordant, tied, len];
  }

  MannWhitneyTest(other) {
    return this.pair(other, [0, 0, 1], (h, o) => {
      const n1 = Number(h.big[kTotal]), n2 = Number(o.big[kTotal]);
      if (n1 === 0 || n2 === 0) return [0, 0, 1];
      const [concordant, tied, len] = NativeHistogram.pairs(h, o);
      // U statistic for sample 1: concordant + half of ties.
      const u = concordant + 0.5 * tied;
      const mu = n1 * n2 / 2.0;
      // Tie correction for the variance.
      const nTotal = n1 + n2;
      let tieCorrection = 0.0;
      for (let i = 0; i < len; i++) {
        const c1 = i < h.countsLen ? h.counts[i] : 0n;
        const c2 = i < o.countsLen ? o.counts[i] : 0n;
        const tk = Number(BigInt.asIntN(64, c1 + c2));
        if (tk > 1) tieCorrection += tk * tk * tk - tk;
      }
      const sigmaSq = (n1 * n2 / 12.0) * (nTotal + 1.0 - tieCorrection / (nTotal * (nTotal - 1.0)));
      if (sigmaSq <= 0.0) return [u, 0, 1];
      const z = (u - mu) / Math.sqrt(sigmaSq);
      // Two-tailed p-value using normal approximation.
      const p = 2.0 * NormalCdf(-Math.abs(z));
      return [u, z, p];
    });
  }

  CohensD(other) {
    return this.pair(other, 0.0, (h, o) => {
      const n1 = Number(h.big[kTotal]), n2 = Number(o.big[kTotal]);
      if (n1 < 2 || n2 < 2) return 0.0;
      const mean1 = hdrMean(h), mean2 = hdrMean(o);
      const sd1 = hdrStddev(h), sd2 = hdrStddev(o);
      // Convert population variance to sample variance (Bessel's correction).
      const var1 = sd1 * sd1 * n1 / (n1 - 1);
      const var2 = sd2 * sd2 * n2 / (n2 - 1);
      const pooledSd = Math.sqrt(((n1 - 1) * var1 + (n2 - 1) * var2) / (n1 + n2 - 2));
      if (pooledSd === 0.0) return 0.0;
      return (mean1 - mean2) / pooledSd;
    });
  }

  CliffsD(other) {
    return this.pair(other, 0.0, (h, o) => {
      const n1 = Number(h.big[kTotal]), n2 = Number(o.big[kTotal]);
      if (n1 === 0 || n2 === 0) return 0.0;
      const [concordant, tied] = NativeHistogram.pairs(h, o);
      const discordant = n1 * n2 - concordant - tied;
      return (concordant - discordant) / (n1 * n2);
    });
  }

  PercentileCI(percentile, confidence) {
    return this.read(h => {
      const value = hdrValueAtPercentile(h, percentile);
      const n = Number(h.big[kTotal]);
      if (n < 2) return [value, value, value];
      const p = percentile / 100.0;
      const alpha = 1.0 - confidence;
      // Lower rank: largest j such that BinomialCdf(j-1, n, p) <= alpha/2.
      let lo = 0;
      let hi = n;
      while (lo < hi) {
        const mid = lo + Math.trunc((hi - lo + 1) / 2);
        if (BinomialCdf(mid - 1, n, p) <= alpha / 2.0) lo = mid;
        else hi = mid - 1;
      }
      const lowerPct = lo / n * 100.0;
      // Upper rank: smallest k such that BinomialCdf(k-1, n, p) >= 1 - alpha/2.
      lo = 0;
      hi = n;
      while (lo < hi) {
        const mid = lo + Math.trunc((hi - lo) / 2);
        if (BinomialCdf(mid - 1, n, p) >= 1.0 - alpha / 2.0) hi = mid;
        else lo = mid + 1;
      }
      const upperPct = lo / n * 100.0;
      return [value, hdrValueAtPercentile(h, lowerPct), hdrValueAtPercentile(h, upperPct)];
    });
  }

  // Histogram::RecordedSnapshotSource: a cached snapshot, or a private copy of
  // the counts taken under the lock for the QRDE job to walk later.
  GetRecordedSnapshotSource(useCache) {
    return this.read(h => {
      const generation = h.big[kGeneration];
      const cache = snapshotCaches.get(this);
      if (useCache && cache !== undefined && cache.generation === generation)
        return { generation, snapshot: cache.snapshot, cacheHit: true };
      if (h.big[kTotal] === 0n) return { generation, snapshot: { totalCount: 0, totalCountBig: 0n, buckets: [] }, cacheHit: false };
      const copy = makeHdr(h, h.buffer.slice(0));
      return { generation, histogram: copy, cacheHit: false };
    });
  }

  CacheRecordedSnapshot(generation, snapshot) {
    this.read(h => {
      if (generation === h.big[kGeneration]) snapshotCaches.set(this, { generation, snapshot });
    });
  }

  static BuildRecordedSnapshot(h) {
    const snapshot = { totalCount: Number(h.big[kTotal]), totalCountBig: h.big[kTotal], buckets: [] };
    if (snapshot.totalCount === 0) return snapshot;
    // Node keeps the counts as int64 and converts each use to double; the exact
    // cumulative count also gives the int64 total - cumulative the estimator takes.
    let cumulative = 0n;
    const iter = new HdrIter(h, recordedIterNext);
    while (iter.next()) {
      cumulative += countAtIndex(h, iter.countsIndex);
      snapshot.buckets.push({
        value: iter.medianEquivalentValue,
        resolution: sizeOfEquivalentValueRange(h, iter.value),
        count: iter.count,
        cumulativeCount: Number(cumulative),
        remainingCount: Number(snapshot.totalCountBig - cumulative),
      });
    }
    return snapshot;
  }

  Export() { return this.read(h => exportHistogram(this, h)); }
}

// ---------------------------------------------------------------------------
// Minimal CBOR encoder/decoder (RFC 8949): just enough types for histogram
// export/import: unsigned int, float64, array, and map.

const kCborUint = 0 << 5;
const kCborArray = 4 << 5;
const kCborMap = 5 << 5;
const kCborFloat64 = 0xfb;

function CborWriteUint(out, major, val) {
  val = BigInt.asUintN(64, BigInt(val));
  if (val <= 23n) {
    out.push(major | Number(val));
  } else if (val <= 0xffn) {
    out.push(major | 24, Number(val));
  } else if (val <= 0xffffn) {
    const v = Number(val);
    out.push(major | 25, v >>> 8, v & 0xff);
  } else if (val <= 0xffffffffn) {
    const v = Number(val);
    out.push(major | 26, v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  } else {
    out.push(major | 27);
    for (let shift = 56n; shift >= 0n; shift -= 8n) out.push(Number((val >> shift) & 0xffn));
  }
}

function CborWriteFloat64(out, val) {
  out.push(kCborFloat64);
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, val, false);
  for (const byte of bytes) out.push(byte);
}

// Readers take a cursor { p } over a Uint8Array and return undefined on failure.
function CborReadUint(data, cursor) {
  const end = data.length;
  if (cursor.p >= end) return undefined;
  const info = data[cursor.p++] & 0x1f;
  if (info <= 23) return BigInt(info);
  const width = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
  // Indefinite length or reserved: not supported.
  if (width === 0 || cursor.p + width > end) return undefined;
  let val = 0n;
  for (let i = 0; i < width; i++) val = (val << 8n) | BigInt(data[cursor.p + i]);
  cursor.p += width;
  return val;
}

function CborReadFloat64(data, cursor) {
  if (cursor.p >= data.length || data[cursor.p] !== kCborFloat64) return undefined;
  cursor.p++;
  if (cursor.p + 8 > data.length) return undefined;
  const val = new DataView(data.buffer, data.byteOffset + cursor.p, 8).getFloat64(0, false);
  cursor.p += 8;
  return val;
}

// A value that may be either a uint or float64.
function CborReadNumber(data, cursor) {
  if (cursor.p >= data.length) return undefined;
  if (data[cursor.p] === kCborFloat64) return CborReadFloat64(data, cursor);
  const u = CborReadUint(data, cursor);
  return u === undefined ? undefined : Number(u);
}

const kExportVersion = 1n;
const kKeyVersion = 0, kKeyLowest = 1, kKeyHighest = 2, kKeyFigures = 3, kKeyTotalCount = 4, kKeyMin = 5,
  kKeyMax = 6, kKeyNormOffset = 7, kKeyConvRatio = 8, kKeyCountsLen = 9, kKeyCounts = 10, kKeyEwma = 11;
const kEwmaAlpha = 0, kEwmaMeanKey = 1, kEwmaVarianceKey = 2, kEwmaErrorRateKey = 3, kEwmaThreshold = 4;

// Histogram::Export: a CBOR map with integer keys (see histogram.cc), counts
// delta-encoded as flat [delta, count, ...] pairs.
function exportHistogram(histogram, h) {
  let nonZero = 0;
  for (let i = 0; i < h.countsLen; i++) if (h.counts[i] !== 0n) nonZero++;
  const hasEwma = histogram.alpha > 0;
  const out = [];
  CborWriteUint(out, kCborMap, hasEwma ? 12 : 11);
  CborWriteUint(out, kCborUint, kKeyVersion);
  CborWriteUint(out, kCborUint, kExportVersion);
  CborWriteUint(out, kCborUint, kKeyLowest);
  CborWriteUint(out, kCborUint, h.lowest);
  CborWriteUint(out, kCborUint, kKeyHighest);
  CborWriteUint(out, kCborUint, h.highest);
  CborWriteUint(out, kCborUint, kKeyFigures);
  CborWriteUint(out, kCborUint, h.figures);
  CborWriteUint(out, kCborUint, kKeyTotalCount);
  CborWriteUint(out, kCborUint, h.big[kTotal]);
  CborWriteUint(out, kCborUint, kKeyMin);
  CborWriteUint(out, kCborUint, h.big[kMin]);
  CborWriteUint(out, kCborUint, kKeyMax);
  CborWriteUint(out, kCborUint, h.big[kMax]);
  CborWriteUint(out, kCborUint, kKeyNormOffset);
  CborWriteUint(out, kCborUint, h.big[kOffset]);
  CborWriteUint(out, kCborUint, kKeyConvRatio);
  CborWriteFloat64(out, h.f64[kConversion]);
  CborWriteUint(out, kCborUint, kKeyCountsLen);
  CborWriteUint(out, kCborUint, h.countsLen);
  CborWriteUint(out, kCborUint, kKeyCounts);
  CborWriteUint(out, kCborArray, nonZero * 2);
  let prevIdx = 0;
  for (let i = 0; i < h.countsLen; i++) {
    if (h.counts[i] !== 0n) {
      CborWriteUint(out, kCborUint, i - prevIdx);
      CborWriteUint(out, kCborUint, h.counts[i]);
      prevIdx = i;
    }
  }
  if (hasEwma) {
    CborWriteUint(out, kCborUint, kKeyEwma);
    CborWriteUint(out, kCborMap, 5);
    CborWriteUint(out, kCborUint, kEwmaAlpha);
    CborWriteFloat64(out, histogram.alpha);
    CborWriteUint(out, kCborUint, kEwmaMeanKey);
    CborWriteFloat64(out, h.f64[kEwmaMean]);
    CborWriteUint(out, kCborUint, kEwmaVarianceKey);
    CborWriteFloat64(out, h.f64[kEwmaVariance]);
    CborWriteUint(out, kCborUint, kEwmaErrorRateKey);
    CborWriteFloat64(out, h.f64[kEwmaErrorRate]);
    CborWriteUint(out, kCborUint, kEwmaThreshold);
    CborWriteUint(out, kCborUint, histogram.threshold);
  }
  return new Uint8Array(out);
}

// Histogram::Import; undefined when the data is not a valid export.
function importHistogram(data) {
  const cursor = { p: 0 };
  const end = data.length;
  if (cursor.p >= end || (data[cursor.p] >> 5) !== 5) return undefined;
  const mapSize = CborReadUint(data, cursor);
  if (mapSize === undefined) return undefined;
  let lowest = 1n;
  let highest = kInt64Max;
  let figures = 3;
  let totalCount = 0n;
  let minValue = kInt64Max;
  let maxValue = 0n;
  let normOffset = 0;
  let convRatio = 1.0;
  let countsLen = 0;
  const sparseCounts = [];
  let ewmaAlpha = 0;
  let ewmaMean = 0;
  let ewmaVariance = 0;
  let ewmaErrorRate = 0;
  let threshold = 0n;
  const uint = () => CborReadUint(data, cursor);
  for (let i = 0n; i < mapSize; i++) {
    const key = uint();
    if (key === undefined) return undefined;
    let v;
    switch (key) {
      case BigInt(kKeyVersion):
        if ((v = uint()) === undefined || v !== kExportVersion) return undefined;
        break;
      case BigInt(kKeyLowest):
        if ((v = uint()) === undefined) return undefined;
        lowest = BigInt.asIntN(64, v);
        break;
      case BigInt(kKeyHighest):
        if ((v = uint()) === undefined) return undefined;
        highest = BigInt.asIntN(64, v);
        break;
      case BigInt(kKeyFigures):
        if ((v = uint()) === undefined) return undefined;
        figures = Number(BigInt.asIntN(32, v));
        break;
      case BigInt(kKeyTotalCount):
        if ((v = uint()) === undefined) return undefined;
        totalCount = BigInt.asIntN(64, v);
        break;
      case BigInt(kKeyMin):
        if ((v = uint()) === undefined) return undefined;
        minValue = BigInt.asIntN(64, v);
        break;
      case BigInt(kKeyMax):
        if ((v = uint()) === undefined) return undefined;
        maxValue = BigInt.asIntN(64, v);
        break;
      case BigInt(kKeyNormOffset):
        if ((v = uint()) === undefined) return undefined;
        // Reject values that cannot be represented as int32_t.
        if (v > 2147483647n) return undefined;
        normOffset = Number(v);
        break;
      case BigInt(kKeyConvRatio):
        if ((convRatio = CborReadNumber(data, cursor)) === undefined) return undefined;
        break;
      case BigInt(kKeyCountsLen):
        if ((v = uint()) === undefined) return undefined;
        countsLen = Number(BigInt.asIntN(32, v));
        break;
      case BigInt(kKeyCounts): {
        if (cursor.p >= end || (data[cursor.p] >> 5) !== 4) return undefined;
        const arrLen = uint();
        if (arrLen === undefined || arrLen % 2n !== 0n) return undefined;
        // Each element needs at least 1 byte of CBOR encoding.
        if (arrLen > BigInt(end - cursor.p)) return undefined;
        let accIdx = 0;
        for (let j = 0n; j < arrLen; j += 2n) {
          const delta = uint();
          if (delta === undefined) return undefined;
          const cnt = uint();
          if (cnt === undefined) return undefined;
          accIdx = (accIdx + Number(BigInt.asIntN(32, delta))) | 0;
          sparseCounts.push([accIdx, BigInt.asIntN(64, cnt)]);
        }
        break;
      }
      case BigInt(kKeyEwma): {
        if (cursor.p >= end || (data[cursor.p] >> 5) !== 5) return undefined;
        const subSize = uint();
        if (subSize === undefined) return undefined;
        for (let j = 0n; j < subSize; j++) {
          const subKey = uint();
          if (subKey === undefined) return undefined;
          let number;
          switch (subKey) {
            case BigInt(kEwmaAlpha):
              if ((number = CborReadNumber(data, cursor)) === undefined) return undefined;
              ewmaAlpha = number;
              break;
            case BigInt(kEwmaMeanKey):
              if ((number = CborReadNumber(data, cursor)) === undefined) return undefined;
              ewmaMean = number;
              break;
            case BigInt(kEwmaVarianceKey):
              if ((number = CborReadNumber(data, cursor)) === undefined) return undefined;
              ewmaVariance = number;
              break;
            case BigInt(kEwmaErrorRateKey):
              if ((number = CborReadNumber(data, cursor)) === undefined) return undefined;
              ewmaErrorRate = number;
              break;
            case BigInt(kEwmaThreshold):
              if ((v = uint()) === undefined) return undefined;
              threshold = BigInt.asIntN(64, v);
              break;
            default:
              return undefined;
          }
        }
        break;
      }
      default:
        return undefined;
    }
  }
  // Compute half_life from alpha: alpha = 1 - 2^(-1/halfLife).
  let halfLife = 0;
  if (ewmaAlpha > 0 && ewmaAlpha < 1) halfLife = -1.0 / Math.log2(1.0 - ewmaAlpha);
  const histogram = NativeHistogram.Create({ lowest, highest, figures, halfLife, threshold });
  if (histogram === undefined) return undefined;
  const h = histogram.h;
  if (h.countsLen !== countsLen) return undefined;
  // The normalization offset must index into the allocated counts array.
  if (normOffset < 0 || normOffset >= countsLen) return undefined;
  for (const [idx, cnt] of sparseCounts) {
    if (idx < 0 || idx >= countsLen) return undefined;
    h.counts[idx] = cnt;
  }
  h.big[kTotal] = totalCount;
  h.big[kMin] = minValue;
  h.big[kMax] = maxValue;
  h.big[kOffset] = BigInt(normOffset);
  h.offset = normOffset;
  h.f64[kConversion] = convRatio;
  if (ewmaAlpha > 0) {
    h.f64[kEwmaMean] = ewmaMean;
    h.f64[kEwmaVariance] = ewmaVariance;
    h.f64[kEwmaErrorRate] = ewmaErrorRate;
    h.f64[kEwmaInitialized] = 1;
  }
  return histogram;
}

// ---------------------------------------------------------------------------
// The binding objects: HistogramBase (with HistogramImpl's methods),
// SlidingWindowHistogram, and the event loop delay histograms
// createELDHistogram() returns.

const {
  kClone,
  kDeserialize,
  markTransferMode,
} = require('internal/worker/js_transferable');

function nodeError(Type, code, message) {
  return Object.assign(new Type(message), { code });
}

// BigInt::Int64Value(&lossless), or the static_cast<int64_t> of a Number.
function int64Arg(value) {
  if (typeof value === 'bigint') return BigInt.asIntN(64, value) === value ? value : undefined;
  return Math.trunc(value);
}

function recordValue(value, name = 'value') {
  const result = int64Arg(value);
  if (result === undefined || result < 1) throw nodeError(RangeError, 'ERR_OUT_OF_RANGE', `${name} is out of range`);
  return result;
}

function bigintOption(value, name) {
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  const result = int64Arg(value);
  if (result === undefined) throw nodeError(RangeError, 'ERR_OUT_OF_RANGE', `${name} is out of range`);
  return result;
}

const kWrap = Symbol('kWrap');
const toNumber = value => Number(value);

class Histogram {
  #histogram;

  constructor(lowest, highest, figures, halfLife, threshold) {
    markTransferMode(this, true, false);
    if (arguments.length === 0) return;  // A clone, filled in by [kDeserialize].
    const histogram = NativeHistogram.Create({
      lowest: bigintOption(lowest, 'options.lowest'),
      highest: bigintOption(highest, 'options.highest'),
      figures,
      halfLife: typeof halfLife === 'number' ? halfLife : 0,
      threshold: typeof threshold === 'number' ? BigInt.asIntN(64, BigInt(Math.trunc(threshold))) : 0n,
    });
    if (histogram === undefined) throw nodeError(TypeError, 'ERR_INVALID_ARG_VALUE', 'Invalid histogram options');
    this.#histogram = histogram;
  }

  static [kWrap](histogram, handle = new Histogram()) {
    handle.#histogram = histogram;
    return handle;
  }

  static histogramOf(handle) { return handle.#histogram; }

  static import(data) {
    if (!ArrayBuffer.isView(data) || !(data instanceof Uint8Array))
      throw nodeError(TypeError, 'ERR_INVALID_ARG_TYPE', 'data must be a Uint8Array');
    const histogram = importHistogram(data);
    if (histogram === undefined) throw nodeError(TypeError, 'ERR_INVALID_ARG_VALUE', 'Invalid histogram export data');
    return Histogram[kWrap](histogram);
  }

  // HistogramBase::CloneForMessaging: the clone holds the same histogram.
  [kClone]() {
    const histogram = this.#histogram;
    const h = histogram.h;
    return {
      data: {
        buffer: h.buffer, lowest: h.lowest, highest: h.highest, figures: h.figures,
        alpha: histogram.alpha, threshold: histogram.threshold,
      },
      deserializeInfo: 'internal/histogram_native:Histogram',
    };
  }

  [kDeserialize]({ buffer, lowest, highest, figures, alpha, threshold }) {
    const cfg = calculateBucketConfig(lowest, highest, figures);
    this.#histogram = new NativeHistogram(makeHdr(cfg, buffer), alpha, threshold);
  }

  record(value) { this.#histogram.Record(recordValue(value)); }
  recordDelta() { this.#histogram.RecordDelta(); }
  add(other) { return this.#histogram.Add(other.#histogram); }
  subtract(other) { return this.#histogram.Subtract(other.#histogram); }
  recordCorrected(value, expectedInterval) {
    value = recordValue(value);
    expectedInterval = recordValue(expectedInterval, 'expected_interval');
    this.#histogram.RecordCorrected(value, BigInt(expectedInterval));
  }

  count() { return Number(this.#histogram.Count()); }
  countBigInt() { return this.#histogram.Count(); }
  exceeds() { return Number(this.#histogram.Exceeds()); }
  exceedsBigInt() { return BigInt.asIntN(64, this.#histogram.Exceeds()); }
  min() { return Number(this.#histogram.Min()); }
  minBigInt() { return this.#histogram.Min(); }
  max() { return Number(this.#histogram.Max()); }
  maxBigInt() { return this.#histogram.Max(); }
  mean() { return this.#histogram.Mean(); }
  stddev() { return this.#histogram.Stddev(); }
  percentile(percentile) { return Number(this.#histogram.Percentile(percentile)); }
  percentileBigInt(percentile) { return this.#histogram.Percentile(percentile); }

  #percentiles(map, convert) {
    // Collected under the lock, set on the Map after releasing it.
    const histogram = this.#histogram;
    const entries = [];
    histogram.Percentiles((key, index) => entries.push([key, index < 0 ? 0n : valueAtIndexBig(histogram.h, index)]));
    for (const [key, value] of entries) map.set(key, convert(value));
  }

  percentiles(map) { this.#percentiles(map, toNumber); }
  percentilesBigInt(map) { this.#percentiles(map, value => value); }
  skewness() { return this.#histogram.Skewness(); }
  kurtosis() { return this.#histogram.Kurtosis(); }
  cdf(value) { return this.#histogram.Cdf(Math.trunc(value)); }
  countAt(value) { return Number(this.#histogram.CountAt(Math.trunc(value))); }
  ksTest(other) { return this.#histogram.KsTest(other.#histogram); }

  percentilesAt(map, input) {
    const length = input.length;
    const values = new Array(length);
    this.#histogram.PercentilesAt(input, values, length);
    for (let i = 0; i < length; i++) map.set(input[i], values[i]);
  }

  linearBuckets(stepSize, map) {
    const entries = [];
    this.#histogram.LinearBuckets(Math.trunc(stepSize), (value, count) => entries.push([value, count]));
    for (const [value, count] of entries) map.set(value, count);
  }

  logBuckets(firstBucket, logBase, map) {
    const entries = [];
    this.#histogram.LogBuckets(Math.trunc(firstBucket), logBase, (value, count) => entries.push([value, count]));
    for (const [value, count] of entries) map.set(value, count);
  }

  meanCI(confidence) { return this.#histogram.MeanCI(confidence); }
  welchTest(other, confidence) { return this.#histogram.WelchTest(other.#histogram, confidence); }
  mannWhitneyTest(other) { return this.#histogram.MannWhitneyTest(other.#histogram); }
  cohensD(other) { return this.#histogram.CohensD(other.#histogram); }
  cliffsD(other) { return this.#histogram.CliffsD(other.#histogram); }
  percentileCI(percentile, confidence) { return this.#histogram.PercentileCI(percentile, confidence).map(toNumber); }

  // QrdeJob: the snapshot source is taken now, under the lock; the snapshot
  // and the estimate are built later, off this call, as Node's thread-pool
  // job does, and the promise settles from the event loop.
  qrde(input, dequantization, cacheSnapshot) {
    const histogram = this.#histogram;
    const probabilities = Array.from(input);
    const source = histogram.GetRecordedSnapshotSource(cacheSnapshot);
    const cacheTarget = cacheSnapshot && !source.cacheHit ? histogram : undefined;
    return new Promise(resolve => {
      host.enqueueIOCompletion(() => {
        let snapshot = source.snapshot;
        if (snapshot === undefined) snapshot = NativeHistogram.BuildRecordedSnapshot(source.histogram);
        cacheTarget?.CacheRecordedSnapshot(source.generation, snapshot);
        const result = CalculateQrde(snapshot, probabilities, dequantization);
        resolve({
          __proto__: null,
          probabilities: new Float64Array(probabilities),
          quantiles: new Float64Array(result.quantiles),
          densities: new Float64Array(result.densities),
          count: snapshot.totalCountBig,
          bucketCount: snapshot.buckets.length,
          corrections: result.corrections,
          dequantize: ['none', 'hdr', 'all'][dequantization],
        });
      });
    });
  }

  ewmaMean() { return this.#histogram.EwmaMean(); }
  ewmaStddev() { return this.#histogram.EwmaStddev(); }
  ewmaErrorRate() { return this.#histogram.EwmaErrorRate(); }
  export() { return this.#histogram.Export(); }
  reset() { this.#histogram.Reset(); }
}

Object.defineProperty(Histogram, 'name', { value: 'Histogram' });

const kNoGeneration = 18446744073709551615n;

class SlidingWindowHistogram {
  #options;
  #chunks;
  #generations;
  #spare;
  #timeBased;
  #rotateAt;
  #origin;
  #currentGeneration = 0n;
  #recordsInCurrentChunk = 0n;
  #hasCountRecords = false;

  constructor(lowest, highest, figures, chunkCount, timeBased, rotateAt) {
    lowest = bigintOption(lowest, 'options.lowest');
    highest = bigintOption(highest, 'options.highest');
    if (chunkCount === 0) throw nodeError(RangeError, 'ERR_OUT_OF_RANGE', 'options.chunks is out of range');
    if (BigInt.asUintN(64, rotateAt) !== rotateAt || rotateAt === 0n)
      throw nodeError(RangeError, 'ERR_OUT_OF_RANGE', 'rotation interval is out of range');
    this.#options = { lowest, highest, figures };
    const spare = NativeHistogram.Create(this.#options);
    if (spare === undefined) throw nodeError(TypeError, 'ERR_INVALID_ARG_VALUE', 'Invalid histogram options');
    this.#chunks = new Array(chunkCount).fill(undefined);
    this.#generations = new Array(chunkCount).fill(kNoGeneration);
    this.#spare = spare;
    this.#timeBased = timeBased;
    this.#rotateAt = rotateAt;
    this.#origin = host.nowNanoseconds();
  }

  #currentTimeGeneration() {
    return (host.nowNanoseconds() - this.#origin) / this.#rotateAt;
  }

  #getChunk(generation) {
    const index = Number(generation % BigInt(this.#chunks.length));
    if (this.#generations[index] === generation) return this.#chunks[index];
    if (this.#chunks[index] !== undefined) this.#chunks[index].Reset();
    else if (this.#spare !== undefined) {
      this.#chunks[index] = this.#spare;
      this.#spare = undefined;
    } else {
      this.#chunks[index] = NativeHistogram.Create(this.#options);
      if (this.#chunks[index] === undefined) return undefined;
    }
    this.#generations[index] = generation;
    return this.#chunks[index];
  }

  #recordValue(value) {
    let generation;
    if (this.#timeBased) generation = this.#currentTimeGeneration();
    else if (this.#recordsInCurrentChunk === this.#rotateAt) generation = this.#currentGeneration + 1n;
    else generation = this.#currentGeneration;
    const chunk = this.#getChunk(generation);
    if (chunk === undefined) return false;
    chunk.Record(value);
    if (!this.#timeBased) {
      if (generation !== this.#currentGeneration) {
        this.#currentGeneration = generation;
        this.#recordsInCurrentChunk = 0n;
      }
      this.#recordsInCurrentChunk++;
      this.#hasCountRecords = true;
    }
    return true;
  }

  record(value) {
    if (!this.#recordValue(recordValue(value)))
      throw nodeError(Error, 'ERR_MEMORY_ALLOCATION_FAILED', 'Failed to allocate memory');
  }

  snapshot() {
    const snapshot = NativeHistogram.Create(this.#options);
    if (snapshot === undefined) throw nodeError(Error, 'ERR_MEMORY_ALLOCATION_FAILED', 'Failed to allocate memory');
    let currentGeneration;
    if (this.#timeBased) currentGeneration = this.#currentTimeGeneration();
    else if (this.#hasCountRecords) currentGeneration = this.#currentGeneration;
    if (currentGeneration !== undefined) {
      const size = BigInt(this.#chunks.length);
      for (let i = 0; i < this.#chunks.length; i++) {
        const generation = this.#generations[i];
        if (generation === kNoGeneration || generation > currentGeneration || currentGeneration - generation >= size) continue;
        snapshot.Add(this.#chunks[i]);
      }
    }
    return Histogram[kWrap](snapshot);
  }

  reset() {
    this.#generations.fill(kNoGeneration);
    this.#origin = host.nowNanoseconds();
    this.#currentGeneration = 0n;
    this.#recordsInCurrentChunk = 0n;
    this.#hasCountRecords = false;
  }
}

// IntervalHistogram: a repeating unref'd timer records the delay between its
// ticks. IterationHistogram: each loop iteration records the time since the
// previous one.
class IntervalHistogram extends Histogram {
  #interval;
  #enabled = false;
  #stop;

  constructor(interval) {
    super();
    this.#interval = interval;
  }

  start(reset) {
    if (this.#enabled) return;
    this.#enabled = true;
    const histogram = Histogram.histogramOf(this);
    if (reset) histogram.Reset();
    const { setInterval, clearInterval } = require('timers');
    const timer = setInterval(() => histogram.RecordDelta(), this.#interval);
    timer.unref();
    this.#stop = () => clearInterval(timer);
  }

  stop() {
    if (!this.#enabled) return;
    this.#enabled = false;
    this.#stop();
    this.#stop = undefined;
  }
}

class IterationHistogram extends Histogram {
  #enabled = false;
  #stop;
  #checkTime = 0n;

  start(reset) {
    if (this.#enabled) return;
    this.#enabled = true;
    const histogram = Histogram.histogramOf(this);
    if (reset) histogram.Reset();
    this.#checkTime = host.nowNanoseconds();
    this.#stop = host.performanceAddLoopListener(() => {
      const checkTime = host.nowNanoseconds();
      const latency = checkTime - this.#checkTime;
      histogram.Record(latency === 0n ? 1n : latency);
      this.#checkTime = checkTime;
    });
  }

  stop() {
    if (!this.#enabled) return;
    this.#enabled = false;
    this.#stop();
    this.#stop = undefined;
  }
}

function createELDHistogram(interval, samplePerIteration) {
  if (samplePerIteration) return Histogram[kWrap](NativeHistogram.Create({ lowest: 1n, highest: kInt64Max, figures: 3 }), new IterationHistogram());
  return Histogram[kWrap](NativeHistogram.Create({ lowest: 1000n, highest: kInt64Max, figures: 3 }), new IntervalHistogram(interval));
}

module.exports = { Histogram, SlidingWindowHistogram, createELDHistogram };
