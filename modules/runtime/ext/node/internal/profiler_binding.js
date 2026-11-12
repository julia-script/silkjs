'use strict';

// The coverage half of Node's internalBinding('profiler') (src/inspector_profiler.cc):
// NODE_V8_COVERAGE files in the format of V8's Profiler.takePreciseCoverage
// (callCount, detailed), which Node's test runner and tools such as c8 read.
//
// The counts are the engine's own bytecode counters (runtime/src/ext/coverage_native.silk):
// how often each function was entered and each statement ran. A V8 ScriptCoverage is
// built from them per script: a function's first range is its source span with its
// entry count, and a run of statements whose count differs from the function's is a
// block range, as V8 reports a block whose count differs from its parent. Offsets are
// UTF-16 positions in the file, as V8's are.

const {
  ArrayPrototypePush,
  ArrayPrototypeSort,
  JSONStringify,
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
// Counts already written: a take resets the counters, as V8's takePreciseCoverage does.
let written = new SafeMap();

function setCoverageDirectory(directory) {
  coverageDirectory = `${directory}`;
}

function setSourceMapCacheGetter(getter) {
  sourceMapCacheGetter = getter;
}

function startCoverage() {
  if (active) return;
  host.testCoverageStart();
  active = true;
}

function stopCoverage() {
  if (!active) return;
  host.testCoverageStop();
  active = false;
  written = new SafeMap();
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
  const result = scriptCoverages(host.testCoverageTake());
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

// A file's text and its line starts, to turn engine (line, column) pairs into offsets.
function sourceInfo(cache, url) {
  let info = MapPrototypeGet(cache, url);
  if (info !== undefined) return info;
  info = null;
  try {
    const { fileURLToPath } = require('url');
    const source = require('fs').readFileSync(fileURLToPath(url), 'utf8');
    const lineStarts = [0];
    let ascii = true;
    for (let index = 0; index < source.length; index++) {
      const code = StringPrototypeCharCodeAt(source, index);
      if (code === 10) ArrayPrototypePush(lineStarts, index + 1);
      else if (code > 0x7f) ascii = false;
    }
    info = { source, lineStarts, ascii, byteToChar: undefined };
  } catch {
    // A file that can no longer be read has no offsets; Node leaves it out too.
  }
  MapPrototypeSet(cache, url, info);
  return info;
}

function offsetOf(info, line, column, columnOffset) {
  if (line < 0) return 0;
  if (line >= info.lineStarts.length) return info.source.length;
  // The first line of a wrapped compile starts after the wrapper's prefix.
  if (line === 0) column -= columnOffset;
  const offset = info.lineStarts[line] + (column < 0 ? 0 : column);
  return offset > info.source.length ? info.source.length : offset;
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
// columnOffset]; a location is [pc, line, column, sourcePosition, count, taken,
// fallthrough, conditional, statementStart], zero-based.
function scriptCoverages(rows) {
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
    ArrayPrototypePush(script.functions, functionCoverage(scriptId, row, info));
  }
  const result = [];
  for (let index = 0; index < order.length; index++) {
    const scriptId = order[index];
    const { url, info, functions } = MapPrototypeGet(scripts, scriptId);
    ArrayPrototypeSort(functions, (a, b) => a.start - b.start || b.end - a.end);
    const length = info.source.length;
    // V8's first function of a script is the script itself, over the whole text. The
    // function a CJS wrapper compiles to spans the whole file too and is that script.
    // Its block ranges are those of that top-level code.
    let topCount = 0;
    const out = [];
    const blocks = [];
    for (let at = 0; at < functions.length; at++) {
      const fn = functions[at];
      // '<eval>' is the engine's name for a compile's top-level code.
      if ((fn.start <= 0 && fn.end >= length) || fn.name === '<eval>') {
        if (fn.count > topCount) topCount = fn.count;
        const { ranges } = fn.coverage;
        for (let range = 1; range < ranges.length; range++) ArrayPrototypePush(blocks, ranges[range]);
        continue;
      }
      ArrayPrototypePush(out, fn.coverage);
    }
    const script = {
      functionName: '', isBlockCoverage: true,
      ranges: [{ startOffset: 0, endOffset: length, count: topCount > 0 ? topCount : 1 }, ...blocks],
    };
    result[index] = { scriptId, url, functions: [script, ...out] };
  }
  return result;
}

function lineOf(info, offset) {
  const { lineStarts } = info;
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (lineStarts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

function isBlank(code) {
  return code === 32 || code === 9 || code === 13;
}

function lineStartIfLeading(info, offset) {
  const lineStart = info.lineStarts[lineOf(info, offset)];
  for (let index = lineStart; index < offset; index++) {
    if (!isBlank(StringPrototypeCharCodeAt(info.source, index))) return offset;
  }
  return lineStart;
}

// Where the line holding only the function's closing brace starts, or end.
function closingLineStart(info, start, end) {
  if (end <= start) return end;
  const lineStart = info.lineStarts[lineOf(info, end - 1)];
  if (lineStart <= start) return end;
  for (let index = lineStart; index < end - 1; index++) {
    if (!isBlank(StringPrototypeCharCodeAt(info.source, index))) return end;
  }
  return StringPrototypeCharCodeAt(info.source, end - 1) === 125 ? lineStart : end;
}

function delta(key, count) {
  const before = MapPrototypeGet(written, key) ?? 0;
  MapPrototypeSet(written, key, count);
  return count >= before ? count - before : count;
}

function functionCoverage(scriptId, row, info) {
  const { 2: name, 4: locations, 5: sourceStart, 6: sourceLength, 7: columnOffset } = row;
  const statements = [];
  let first = Infinity;
  let last = 0;
  for (let index = 0; index < locations.length; index++) {
    const location = locations[index];
    const offset = offsetOf(info, location[1], location[2], columnOffset);
    if (offset < first) first = offset;
    if (offset > last) last = offset;
    if (location[8]) ArrayPrototypePush(statements, { offset, count: location[4], pc: location[0] });
  }
  let start, end;
  if (sourceStart >= 0) {
    start = charOffset(info, sourceStart - columnOffset);
    end = charOffset(info, sourceStart - columnOffset + sourceLength);
  } else {
    start = first === Infinity ? 0 : first;
    end = last;
  }
  const key = `${scriptId}:${start}:${end}:${name}`;
  const count = delta(key, row[3]);
  const ranges = [{ startOffset: start, endOffset: end, count }];
  ArrayPrototypeSort(statements, (a, b) => a.offset - b.offset);
  // A statement that begins its line takes the line with it, as the block V8 counts
  // starts before it; and the line that only closes the function stays the function's.
  for (let index = 0; index < statements.length; index++) {
    statements[index].offset = lineStartIfLeading(info, statements[index].offset);
  }
  const blockEnd = closingLineStart(info, start, end);
  // Runs of statements by count; a run that differs from the function is a block.
  let runStart = -1;
  let runCount = count;
  for (let index = 0; index <= statements.length; index++) {
    const statement = statements[index];
    const offset = statement === undefined ? blockEnd : statement.offset;
    const statementCount = statement === undefined ? count : delta(`${key}:${statement.pc}`, statement.count);
    if (statement !== undefined && index > 0 && offset === statements[index - 1].offset) continue;
    if (statementCount === runCount && statement !== undefined) continue;
    if (runStart >= 0 && runCount !== count && offset > runStart) {
      ArrayPrototypePush(ranges, { startOffset: runStart, endOffset: offset, count: runCount });
    }
    runStart = offset;
    runCount = statementCount;
  }
  return {
    start, end, count, name,
    coverage: { functionName: name, isBlockCoverage: count > 0, ranges },
  };
}

module.exports = {
  endCoverage,
  finish,
  setCoverageDirectory,
  setSourceMapCacheGetter,
  startCoverage,
  startFromEnvironment,
  stopCoverage,
  takeCoverage,
};
