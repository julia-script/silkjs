'use strict';

// The coverage half of Node's internalBinding('profiler') (src/inspector_profiler.cc):
// NODE_V8_COVERAGE files in the format of V8's Profiler.takePreciseCoverage
// (callCount, detailed), which Node's test runner and tools such as c8 read.
//
// A coverage compile records the block ranges V8's parser does and counts them where
// V8's bytecode generator does (runtime/src/ext/coverage_native.silk). The ranges go
// through V8's own post-processing (src/debug/debug-coverage.cc) here. Offsets are
// UTF-16 positions in the file, as V8's are.

const {
  ArrayPrototypePush,
  ArrayPrototypeSort,
  JSONStringify,
  MapPrototypeDelete,
  MapPrototypeGet,
  MapPrototypeSet,
  SafeMap,
  StringPrototypeCharCodeAt,
  StringPrototypeStartsWith,
} = require('internal/per_context/primordials');
const host = require('internal/host');

let coverageDirectory;
let sourceMapCacheGetter;
let active = false;
// The NODE_V8_COVERAGE connection's mode: counts already written, as a take resets the
// counters (V8's takePreciseCoverage); call counts and block ranges.
let fileMode = preciseMode(true, true);
// Inspector sessions with precise coverage started, and their modes.
const sessions = new SafeMap();
// The engine counts while either kind of consumer is active.
let consumers = 0;

function preciseMode(callCount, detailed) {
  return { written: new SafeMap(), reported: new SafeMap(), callCount, detailed, reset: true };
}

function acquire() {
  if (consumers++ === 0) host.testCoverageStart();
}

function release() {
  if (--consumers === 0) host.testCoverageStop();
}

function setCoverageDirectory(directory) {
  coverageDirectory = `${directory}`;
}

function setSourceMapCacheGetter(getter) {
  sourceMapCacheGetter = getter;
}

function startCoverage() {
  if (active) return;
  // A --test run's own process only hands the coverage directory to the test
  // processes it spawns: Node has no coverage connection there to start.
  if (!fromEnvironment && testOrchestrator()) return;
  acquire();
  active = true;
}

let fromEnvironment = false;
function testOrchestrator() {
  const { getOptionValue } = require('internal/options');
  return getOptionValue('--test') && getOptionValue('--test-isolation') !== 'none';
}

function stopCoverage() {
  if (!active) return;
  release();
  active = false;
  fileMode = preciseMode(true, true);
}

// The inspector's Profiler.startPreciseCoverage, takePreciseCoverage,
// stopPreciseCoverage and getBestEffortCoverage for session.
function startPreciseCoverage(session, callCount, detailed) {
  let mode = MapPrototypeGet(sessions, session);
  if (mode === undefined) {
    acquire();
    mode = preciseMode(false, false);
    MapPrototypeSet(sessions, session, mode);
  }
  mode.callCount = callCount;
  mode.detailed = detailed;
}

function takePreciseCoverage(session) {
  const mode = MapPrototypeGet(sessions, session);
  if (mode === undefined) return undefined;
  return scriptCoverages(host.testCoverageTake(), mode);
}

function stopPreciseCoverage(session) {
  if (MapPrototypeGet(sessions, session) === undefined) return;
  MapPrototypeDelete(sessions, session);
  release();
}

// Best effort coverage reads the counts without resetting them, and only says whether
// a function ran. Without precise coverage nothing is counted, so nothing ran.
function bestEffortCoverage() {
  if (consumers === 0) return [];
  const mode = { written: undefined, reported: undefined, callCount: false, detailed: false, reset: false };
  return scriptCoverages(host.testCoverageTake(), mode);
}

function takeCoverage() {
  if (!active || coverageDirectory === undefined) return false;
  writeCoverage();
  return true;
}

// Node's V8CoverageConnection::End: the last profile, then the connection closes.
function endCoverage() {
  takeCoverage();
  stopCoverage();
}

// NODE_V8_COVERAGE at startup (pre_execution.js setupCoverageHooks): collect from the
// start, with the module source maps, and write when the process ends.
function startFromEnvironment(directory) {
  setCoverageDirectory(require('path').resolve(directory));
  setSourceMapCacheGetter(require('internal/source_maps').sourceMapCacheToObject);
  fromEnvironment = true;
  startCoverage();
}

// Called on every exit path, like the profilers Node ends in its environment cleanup.
function finish() {
  if (!active) return;
  try {
    endCoverage();
  } catch {
    // An unwritable directory loses the profile, as in Node; the exit code stands.
  }
}

let sequence = 0;
function writeCoverage() {
  const result = scriptCoverages(host.testCoverageTake(), fileMode);
  const sourceMapCache = sourceMapCacheGetter ? sourceMapCacheGetter() : undefined;
  const fs = require('fs');
  const path = require('path');
  fs.mkdirSync(coverageDirectory, { recursive: true });
  const { threadId } = require('worker_threads');
  // V8ProfilerConnection::GetFilename: coverage-<pid>-<ms timestamp>-<thread id>.json.
  let name = `coverage-${process.pid}-${Date.now()}-${threadId}.json`;
  if (fs.existsSync(path.join(coverageDirectory, name))) name = `coverage-${process.pid}-${Date.now()}-${threadId}-${++sequence}.json`;
  const profile = { __proto__: null, result };
  if (sourceMapCache !== undefined) profile['source-map-cache'] = sourceMapCache;
  fs.writeFileSync(path.join(coverageDirectory, name), JSONStringify(profile));
}

// A file's text, to turn the engine's UTF-8 offsets into UTF-16 ones.
function sourceInfo(cache, url) {
  let info = MapPrototypeGet(cache, url);
  if (info !== undefined) return info;
  info = null;
  try {
    const { fileURLToPath } = require('url');
    const source = require('fs').readFileSync(fileURLToPath(url), 'utf8');
    let ascii = true;
    for (let index = 0; index < source.length && ascii; index++) {
      if (StringPrototypeCharCodeAt(source, index) > 0x7f) ascii = false;
    }
    info = { source, ascii, byteToChar: undefined };
  } catch {
    // A file that can no longer be read has no offsets; Node leaves it out too.
  }
  MapPrototypeSet(cache, url, info);
  return info;
}

// A UTF-8 byte offset into the file as a UTF-16 offset.
function charOffset(info, byteOffset) {
  if (byteOffset <= 0) return 0;
  if (info.ascii) return byteOffset > info.source.length ? info.source.length : byteOffset;
  if (info.byteToChar === undefined) {
    const table = [];
    const { source } = info;
    for (let index = 0; index < source.length; index++) {
      const code = StringPrototypeCharCodeAt(source, index);
      const bytes = code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code < 0xdc00 ? 4 : code >= 0xdc00 && code < 0xe000 ? 0 : 3;
      for (let byte = 0; byte < bytes; byte++) ArrayPrototypePush(table, index);
    }
    ArrayPrototypePush(table, source.length);
    info.byteToChar = table;
  }
  return byteOffset >= info.byteToChar.length ? info.source.length : info.byteToChar[byteOffset];
}

function scriptURL(name) {
  if (typeof name !== 'string' || name === '') return '';
  if (StringPrototypeStartsWith(name, '/')) return require('url').pathToFileURL(name).href;
  return name;
}

// Engine rows: [scriptId, url, name, entryCount, locations, sourceStart, sourceLength,
// columnOffset, blocks, coverageCompile]; a location is [pc, line, column, sourcePosition, count, taken,
// fallthrough, conditional, statementStart, block], zero-based. blocks are the source
// ranges V8's parser records in a coverage compile ([start, end] UTF-8 byte offsets of
// the compile's input, end -1 for a continuation), and a location with a block is the
// counter V8's bytecode generator places for it.
function scriptCoverages(rows, mode) {
  const sources = new SafeMap();
  const scripts = new SafeMap();
  const order = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const url = scriptURL(row[1]);
    if (!StringPrototypeStartsWith(url, 'file:')) continue;
    const info = sourceInfo(sources, url);
    if (info === null) continue;
    const scriptId = `${row[0]}`;
    let script = MapPrototypeGet(scripts, scriptId);
    if (script === undefined) {
      script = { url, info, functions: [] };
      MapPrototypeSet(scripts, scriptId, script);
      ArrayPrototypePush(order, scriptId);
    }
    ArrayPrototypePush(script.functions, functionCoverage(scriptId, row, info, mode));
  }
  const result = [];
  for (let index = 0; index < order.length; index++) {
    const scriptId = order[index];
    const { url, functions } = MapPrototypeGet(scripts, scriptId);
    // Coverage::Collect: functions by start, the outer first, the script before any
    // function sharing its span. A function is reported when it ran, its parent ran,
    // or it has blocks.
    ArrayPrototypeSort(functions, (a, b) => a.start - b.start || b.end - a.end ||
      (b.topLevel ? 1 : 0) - (a.topLevel ? 1 : 0) || b.count - a.count);
    const out = [];
    const nesting = [];
    // A CJS file is a script and the function its wrapper compiles to, both over the
    // whole file; V8 compiles it as one function. The one with the most block ranges is the
    // file's code.
    let top;
    for (let at = 0; at < functions.length; at++) {
      const fn = functions[at];
      if (!fn.topLevel) continue;
      if (top === undefined) top = fn;
      else {
        if (fn.slots > top.slots) {
          if (top.count > fn.count) fn.count = top.count;
          top.merged = true;
          top = fn;
        } else {
          if (fn.count > top.count) top.count = fn.count;
          fn.merged = true;
        }
      }
    }
    for (let at = 0; at < functions.length; at++) {
      const fn = functions[at];
      if (fn.merged) continue;
      while (nesting.length > 0 && nesting[nesting.length - 1].end <= fn.start) nesting.pop();
      const parentCovered = nesting.length > 0 && nesting[nesting.length - 1].count !== 0;
      if (fn.end <= fn.start) continue;
      if (fn.count === 0 && !parentCovered && fn.blocks.length === 0) continue;
      ArrayPrototypePush(nesting, fn);
      const ranges = [{ startOffset: fn.start, endOffset: fn.end, count: fn.count }];
      for (let block = 0; block < fn.blocks.length; block++) {
        const { start, end, count } = fn.blocks[block];
        ArrayPrototypePush(ranges, { startOffset: start, endOffset: end, count });
      }
      ArrayPrototypePush(out, { functionName: fn.name, isBlockCoverage: fn.isBlockCoverage, ranges });
    }
    result[index] = { scriptId, url, functions: out };
  }
  return result;
}

function delta(mode, key, count) {
  if (!mode.reset) return count;
  const before = MapPrototypeGet(mode.written, key) ?? 0;
  MapPrototypeSet(mode.written, key, count);
  return count >= before ? count - before : count;
}

function functionCoverage(scriptId, row, info, mode) {
  const { 2: rawName, 4: locations, 5: sourceStart, 6: sourceLength, 7: columnOffset, 8: ranges, 9: coverageCompile } = row;
  let start = 0;
  let end = info.source.length;
  if (sourceStart >= 0) {
    start = charOffset(info, sourceStart - columnOffset);
    end = charOffset(info, sourceStart - columnOffset + sourceLength);
  }
  // The script, or the function a CJS wrapper compiles to, spans the whole file.
  // '<eval>' is the engine's name for a compile's top-level code.
  const topLevel = rawName === '<eval>' || (start <= 0 && end >= info.source.length);
  const name = topLevel ? '' : rawName;
  if (topLevel) {
    start = 0;
    end = info.source.length;
  }
  // The script and a CJS wrapper share a span once both are top level: key by the row.
  const key = `${scriptId}:${sourceStart}:${sourceLength}:${rawName}`;
  const counts = [];
  for (let index = 0; index < ranges.length; index++) counts[index] = 0;
  for (let index = 0; index < locations.length; index++) {
    const location = locations[index];
    const block = location[9];
    if (block >= 0) counts[block] += location[4];
  }
  const blocks = [];
  // V8's function-scope counter, when the function has one, is its count
  // (RewriteFunctionScopeCounter); else the engine's entry count is.
  let entries = row[3];
  for (let index = 0; index < ranges.length; index++) {
    const range = ranges[index];
    if (range[0] === FUNCTION_RANGE) {
      entries = counts[index];
      continue;
    }
    // A take resets the counts, as V8's ResetAllBlockCounts does.
    let count = delta(mode, `${key}:${index}`, counts[index]);
    // ClampToBinary.
    if (!mode.callCount && count > 0) count = 1;
    ArrayPrototypePush(blocks, {
      start: charOffset(info, range[0] - columnOffset),
      end: range[1] < 0 ? -1 : charOffset(info, range[1] - columnOffset),
      count,
    });
  }
  let count = delta(mode, key, entries);
  if (count !== 0 && !mode.callCount) {
    // Binary modes report a function once (has_reported_binary_coverage), best effort
    // always.
    if (mode.reported === undefined) count = 1;
    else {
      count = MapPrototypeGet(mode.reported, key) ? 0 : 1;
      MapPrototypeSet(mode.reported, key, true);
    }
  }
  // V8 compiles a function lazily, on its first call: one that never ran has no
  // coverage info, and so no block coverage.
  const detailed = mode.detailed && coverageCompile && entries > 0;
  const fn = { start, end, count, name, topLevel, slots: ranges.length, blocks: detailed ? blocks : [], isBlockCoverage: detailed };
  if (detailed) blockCoverage(fn);
  return fn;
}

// V8's CoverageBlockIterator (src/debug/debug-coverage.cc): walks blocks sorted by
// nesting, with the parent of each, deleting in place.
// js_debugger_metadata.FUNCTION_RANGE: the range of a function's body counter.
const FUNCTION_RANGE = 4294967294;

function compareBlocks(a, b) {
  if (a.start === b.start) return b.end - a.end;
  return a.start - b.start;
}

class BlockIterator {
  constructor(fn) {
    this.fn = fn;
    this.stack = [];
    this.ended = false;
    this.deleteCurrent = false;
    this.read = -1;
    this.write = -1;
  }
  hasNext() { return this.read + 1 < this.fn.blocks.length; }
  next() {
    if (!this.hasNext()) {
      if (!this.ended) this.maybeWriteCurrent();
      this.ended = true;
      return false;
    }
    this.maybeWriteCurrent();
    if (this.read === -1) {
      ArrayPrototypePush(this.stack, { start: this.fn.start, end: this.fn.end, count: this.fn.count });
    } else if (!this.deleteCurrent) {
      // V8 keeps a copy of the parent.
      const { start, end, count } = this.block();
      ArrayPrototypePush(this.stack, { start, end, count });
    }
    this.deleteCurrent = false;
    this.read++;
    const block = this.block();
    while (this.stack.length > 1 && this.stack[this.stack.length - 1].end <= block.start) this.stack.pop();
    return true;
  }
  block() { return this.fn.blocks[this.read]; }
  nextBlock() { return this.fn.blocks[this.read + 1]; }
  previousBlock() { return this.fn.blocks[this.read - 1]; }
  parent() { return this.stack[this.stack.length - 1]; }
  hasSiblingOrChild() { return this.hasNext() && this.nextBlock().start < this.parent().end; }
  isTopLevel() { return this.stack.length === 1; }
  deleteBlock() { this.deleteCurrent = true; }
  maybeWriteCurrent() {
    if (this.deleteCurrent) return;
    if (this.read >= 0 && this.write !== this.read) this.fn.blocks[this.write] = this.fn.blocks[this.read];
    this.write++;
  }
  finish() {
    while (this.next()) {
      // To the end.
    }
    this.fn.blocks.length = this.write;
  }
}

function forEachBlock(fn, visit) {
  const iterator = new BlockIterator(fn);
  while (iterator.next()) visit(iterator);
  iterator.finish();
}

// CollectBlockCoverageInternal's passes, in its order.
function blockCoverage(fn) {
  ArrayPrototypeSort(fn.blocks, compareBlocks);
  // FilterAliasedSingletons: a continuation starting where a full range does.
  {
    const iterator = new BlockIterator(fn);
    iterator.next();
    while (iterator.next()) {
      const block = iterator.block();
      if (block.end === -1 && block.start === iterator.previousBlock().start) iterator.deleteBlock();
    }
    iterator.finish();
  }
  // RewritePositionSingletonsToRanges.
  forEachBlock(fn, (iterator) => {
    const block = iterator.block();
    if (block.start >= fn.end) iterator.deleteBlock();
    else if (block.end === -1) {
      if (iterator.hasSiblingOrChild()) block.end = iterator.nextBlock().start;
      else if (iterator.isTopLevel()) block.end = iterator.parent().end - 1;
      else block.end = iterator.parent().end;
    }
  });
  mergeConsecutiveRanges(fn);
  ArrayPrototypeSort(fn.blocks, compareBlocks);
  // MergeDuplicateRanges.
  {
    const iterator = new BlockIterator(fn);
    while (iterator.next() && iterator.hasNext()) {
      const block = iterator.block();
      const next = iterator.nextBlock();
      if (block.start !== next.start || block.end !== next.end) continue;
      if (block.count > next.count) next.count = block.count;
      iterator.deleteBlock();
    }
    iterator.finish();
  }
  // MergeNestedRanges.
  forEachBlock(fn, (iterator) => {
    if (iterator.parent().count === iterator.block().count) iterator.deleteBlock();
  });
  mergeConsecutiveRanges(fn);
  // FilterUncoveredRanges.
  forEachBlock(fn, (iterator) => {
    if (iterator.block().count === 0 && iterator.parent().count === 0) iterator.deleteBlock();
  });
  // FilterEmptyRanges.
  forEachBlock(fn, (iterator) => {
    const block = iterator.block();
    if (block.start === block.end) iterator.deleteBlock();
  });
}

function mergeConsecutiveRanges(fn) {
  forEachBlock(fn, (iterator) => {
    const block = iterator.block();
    if (iterator.hasSiblingOrChild()) {
      const sibling = iterator.nextBlock();
      if (sibling.start === block.end && sibling.count === block.count) {
        sibling.start = block.start;
        iterator.deleteBlock();
      }
    }
  });
}

module.exports = {
  bestEffortCoverage,
  endCoverage,
  finish,
  setCoverageDirectory,
  setSourceMapCacheGetter,
  startCoverage,
  startFromEnvironment,
  startPreciseCoverage,
  stopCoverage,
  stopPreciseCoverage,
  takeCoverage,
  takePreciseCoverage,
};
