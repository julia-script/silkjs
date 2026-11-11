'use strict';

const { createHarness, withHarness, TestsStream, failure, unsupported, seededGenerator, createRandomSeed, loadGlobalHooks, reportSetupFailure, publishCounts, isCountDiagnostic } = require('internal/test_runner/harness');
const { validateBoolean } = require('internal/path_events/support');
const path = require('path');
const fs = require('fs');
const host = require('internal/host');
const nativeSetImmediate = globalThis.setImmediate;
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const now = Date.now.bind(Date);
const supported = new Set(['globalSetupPath', 'randomize', 'randomSeed', 'testTagFilters', 'files', 'cwd', 'concurrency', 'timeout', 'signal', 'isolation', 'setup', 'only', 'testNamePatterns', 'testSkipPatterns', 'shard', 'execArgv', 'argv', 'env', 'coverage', 'coverageIncludeGlobs', 'coverageExcludeGlobs', 'lineCoverage', 'branchCoverage', 'functionCoverage']);
function invalid(message) { return Object.assign(new TypeError(message), { code: 'ERR_INVALID_ARG_VALUE' }); }
function discover(directory, files = [], inTest = false) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) discover(file, files, inTest || entry.name === 'test');
    else if (entry.isFile() && /\.(?:cjs|mjs|js)$/.test(entry.name) && (inTest || /(?:^test(?:[-.]|$)|[._-]test\.|\.test\.)/.test(entry.name))) files.push(file);
  }
  return files.sort();
}
function validate(options) {
  if (!options || typeof options !== 'object') throw invalid('options must be an object');
  for (const key of Object.keys(options)) if (!supported.has(key) && options[key] !== undefined) unsupported(`run option ${key}`);
  if (options.files !== undefined && (!Array.isArray(options.files) || options.files.some(file => typeof file !== 'string'))) throw invalid('files must be an array of paths');
  if (options.isolation !== undefined && !['process', 'none'].includes(options.isolation)) throw invalid('isolation must be process or none');
  if (options.globalSetupPath != null && typeof options.globalSetupPath !== 'string') throw new (require('internal/path_events/support').codes.ERR_INVALID_ARG_TYPE)('options.globalSetupPath', 'string', options.globalSetupPath);
  if (options.setup !== undefined && typeof options.setup !== 'function') throw invalid('setup must be a function');
  if (options.signal !== undefined && typeof options.signal?.addEventListener !== 'function') throw invalid('signal must be an AbortSignal');
  if (options.concurrency !== undefined && typeof options.concurrency !== 'boolean' && (!Number.isInteger(options.concurrency) || options.concurrency < 1)) throw invalid('Invalid concurrency');
  if (options.timeout !== undefined && (typeof options.timeout !== 'number' || options.timeout < 0 || Number.isNaN(options.timeout))) throw invalid('Invalid timeout');
  if (options.only !== undefined && typeof options.only !== 'boolean') throw invalid('only must be a boolean');
  for (const key of ['argv', 'execArgv']) if (options[key] !== undefined && (!Array.isArray(options[key]) || options[key].some(arg => typeof arg !== 'string'))) throw invalid(`${key} must be a string array`);
  if (options.env !== undefined && (!options.env || typeof options.env !== 'object' || Array.isArray(options.env))) throw invalid('env must be an object');
  if (options.isolation === 'none' && options.env !== undefined) throw invalid('env is not supported with isolation: none');
  if (options.coverage !== undefined && typeof options.coverage !== 'boolean') throw invalid('coverage must be a boolean');
  for (const key of ['coverageIncludeGlobs', 'coverageExcludeGlobs']) {
    const value = options[key];
    if (value !== undefined && typeof value !== 'string' && (!Array.isArray(value) || value.some(item => typeof item !== 'string'))) throw invalid(`${key} must contain strings`);
  }
  for (const key of ['lineCoverage', 'branchCoverage', 'functionCoverage']) if (options[key] !== undefined && (!Number.isInteger(options[key]) || options[key] < 0 || options[key] > 100)) throw invalid(`${key} must be an integer between 0 and 100`);
  for (const key of ['testNamePatterns', 'testSkipPatterns']) if (options[key] !== undefined) {
    const patterns = Array.isArray(options[key]) ? options[key] : [options[key]];
    if (patterns.some(value => typeof value !== 'string' && !(value instanceof RegExp))) throw invalid(`${key} must contain strings or regular expressions`);
    serializablePatterns(patterns).forEach(value => new RegExp(value.source, value.flags));
  }
  if (options.testTagFilters !== undefined) {
    const { tagFilter } = require('internal/test_runner/harness');
    [options.testTagFilters].flat().forEach((value, i) => tagFilter(value, `options.testTagFilters[${i}]`));
  }
  if (options.shard !== undefined) {
    const { index, total } = options.shard;
    if (!Number.isInteger(index) || !Number.isInteger(total) || index < 1 || index > total) throw invalid('shard requires 1 <= index <= total');
  }
}
function validateRandom(options) {
  if (options.randomize != null) validateBoolean(options.randomize, 'options.randomize');
  if (options.randomSeed != null) {
    const seed = options.randomSeed;
    if (typeof seed !== 'number') throw new (require('internal/path_events/support').codes.ERR_INVALID_ARG_TYPE)('options.randomSeed', 'number', seed);
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xFFFF_FFFF)
      throw Object.assign(new RangeError(`The value of "options.randomSeed" is out of range. It must be >= 0 && <= 4294967295. Received ${seed}`), { code: 'ERR_OUT_OF_RANGE' });
  }
  const randomize = options.randomSeed != null || options.randomize === true;
  return randomize ? options.randomSeed ?? createRandomSeed() : undefined;
}
function run(options = {}) {
  validate(options);
  const randomSeed = validateRandom(options);
  options = { ...options, randomize: randomSeed !== undefined, randomSeed };
  const stream = new TestsStream();
  nativeSetImmediate(async () => {
    try {
      const cwd = path.resolve(options.cwd || process.cwd());
      let files = options.files ? options.files.map(file => path.resolve(cwd, file)) : discover(cwd);
      // File-level results are named as the caller gave the path, or relative to cwd.
      const names = new Map(files.map((file, index) => [file, options.files ? options.files[index] : path.relative(cwd, file)]));
      if (options.shard) files = files.filter((_, index) => index % options.shard.total === options.shard.index - 1);
      await options.setup?.(stream);
      let teardown;
      if (options.globalSetupPath) {
        const hooks = await loadGlobalHooks(options.globalSetupPath, cwd);
        try { await hooks.setup?.(); }
        catch (error) {
          reportSetupFailure(error);
          stream.publish('test:plan', { nesting: 0, count: 0 });
          stream.publish('test:summary', { nesting: 0, success: false, counts: { tests: 0, suites: 0, passed: 0, failed: 0, cancelled: 0, skipped: 0, todo: 0, topLevel: 0 }, duration_ms: 0 });
          stream.push(null);
          return;
        }
        teardown = hooks.teardown;
      }
      const local = { ...options, globalSetupPath: undefined };
      try {
        if (options.isolation === 'none') await runLocal(files, local, stream, cwd);
        else await runProcesses(files, local, stream, cwd, names);
      } finally {
        if (teardown) { try { await teardown(); } catch (error) { reportSetupFailure(error); } }
      }
    } catch (error) { stream.destroy(error); }
  });
  return stream;
}
async function runLocal(files, options, stream, cwd) {
  const harness = createHarness({ ...options, setExitCode: false });
  if (options.randomSeed !== undefined) harness.root.ctx.diagnostic(`Randomized test order seed: ${options.randomSeed}`);
  let summary;
  harness.stream.on('data', event => {
    if (event.type === 'test:summary') summary = event.data;
    else stream.publish(event.type, event.data);
  });
  // start() completes when events are queued, not when the Readable drains them.
  const drained = new Promise((resolve, reject) => {
    harness.stream.once('end', resolve);
    harness.stream.once('error', reject);
  });
  const release = harness.deferCompletion();
  if (options.coverage) host.testCoverageStart();
  try {
    const loading = (async () => {
      try {
        for (const file of files) {
          if (options.signal?.aborted) break;
          harness.file = file;
          try { await withHarness(harness, () => host.loader.runMain(file)); }
          catch (error) { harness.add('test', { name: file, options: {}, fn() { throw error; } }); }
        }
      } finally { release(); }
    })();
    await Promise.all([loading, harness.start(), drained]);
    if (options.coverage) {
      const coverage = require('internal/test_runner/coverage');
      if (!coverage.publish(stream, coverage.take(options, cwd))) summary.success = false;
    }
    stream.publish('test:summary', summary);
    stream.push(null);
  } finally { if (options.coverage) host.testCoverageStop(); }
}
function serializablePatterns(patterns) {
  if (patterns === undefined) return undefined;
  return (Array.isArray(patterns) ? patterns : [patterns]).map(value => value instanceof RegExp ? { source: value.source, flags: value.flags } : { source: String(value), flags: '' });
}
// The child's default harness reads these the way a test file run by hand does, and
// reports its events over IPC because NODE_TEST_CONTEXT is child-v8.
function childFlags(options) {
  const flags = [];
  if (options.only) flags.push('--test-only');
  if (Number.isFinite(options.timeout)) flags.push(`--test-timeout=${options.timeout}`);
  for (const key of ['testNamePatterns', 'testSkipPatterns']) {
    const name = key === 'testNamePatterns' ? '--test-name-pattern' : '--test-skip-pattern';
    for (const { source, flags: reFlags } of serializablePatterns(options[key]) || [])
      flags.push(`${name}=${reFlags || source.startsWith('/') ? `/${source}/${reFlags}` : source}`);
  }
  if (options.randomSeed !== undefined) flags.push('--test-randomize', `--test-random-seed=${options.randomSeed}`);
  for (const tag of [options.testTagFilters ?? []].flat()) flags.push(`--experimental-test-tag-filter=${tag}`);
  if (options.coverage) {
    flags.push('--experimental-test-coverage');
    for (const glob of [options.coverageIncludeGlobs ?? []].flat()) flags.push(`--test-coverage-include=${glob}`);
    for (const glob of [options.coverageExcludeGlobs ?? []].flat()) flags.push(`--test-coverage-exclude=${glob}`);
  }
  return flags;
}
function inheritedExecArgv() {
  const result = [];
  const takesValue = new Set(['--test-concurrency', '--test-timeout', '--test-isolation', '--test-name-pattern', '--test-skip-pattern', '--test-reporter', '--test-reporter-destination', '--test-shard', '--test-coverage-include', '--test-coverage-exclude', '--test-coverage-lines', '--test-coverage-branches', '--test-coverage-functions', '--watch-path', '--eval', '--print', '-e', '-p']);
  const args = process.execArgv || [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (/^--(?:test(?:-|$)|experimental-test-coverage(?:=|$)|watch(?:-|$))/.test(arg) || /^(?:-e|-p|-c|--eval|--print|--check)(?:=|$)/.test(arg)) {
      if (takesValue.has(arg)) index++;
    } else result.push(arg);
  }
  return result;
}
async function runProcesses(files, options, stream, cwd, names) {
  const { spawn } = require('child_process');
  const start = now();
  const counts = { tests: 0, suites: 0, passed: 0, failed: 0, cancelled: 0, skipped: 0, todo: 0, topLevel: 0 };
  let successful = true;
  let next = 0;
  let flushed = 0;
  let sequence = 0;
  let eventId = 1;
  const completed = new Map();
  const durations = new Map();
  const exitStatus = new Map();
  const coverages = [];
  // Each file is a test of its own, like Node's FileTest: queued, dequeued and completed
  // around the events of the process that ran it.
  const fileData = index => ({ nesting: 0, name: names.get(files[index]) ?? files[index], type: 'test', line: 1, column: 1, file: files[index] });
  function flush() {
    while (completed.has(flushed)) {
      const { events, summary, error, ids = new Map() } = completed.get(flushed);
      completed.delete(flushed);
      const id = original => { if (!ids.has(original)) ids.set(original, eventId++); return ids.get(original); };
      for (const event of events) {
        const data = { ...event.data };
        if (data.testId !== undefined) data.testId = id(data.testId);
        if (data.parentId !== undefined) data.parentId = id(data.parentId);
        if (data.nesting === 0 && ['test:pass', 'test:fail'].includes(event.type)) {
          data.testNumber = ++sequence;
        }
        stream.publish(event.type, data);
      }
      if (summary) {
        stream.publish('test:summary', { ...summary, file: files[flushed] });
        for (const key of Object.keys(counts)) counts[key] += summary.counts[key] || 0;
        successful &&= summary.success;
      }
      const { type: _type, ...fileReport } = fileData(flushed);
      const fileFailed = !!error || (summary && !summary.success) || exitStatus.get(flushed);
      const fileError = error ?? (fileFailed ? Object.assign(failure('test failed', summary && !summary.success ? 'subtestsFailed' : 'testCodeFailure'), exitStatus.get(flushed) ?? {}) : undefined);
      stream.publish('test:complete', { ...fileReport, testNumber: 1,
        details: { duration_ms: durations.get(flushed) ?? 0, type: 'test', ...(fileError ? { error: fileError } : {}), passed: !fileFailed } });
      if (error || (!summary && events.length === 0)) {
        const failed = !!error;
        const data = { name: names.get(files[flushed]) ?? files[flushed], nesting: 0, line: 1, column: 1, file: files[flushed], testId: eventId++, testNumber: ++sequence,
          details: { type: 'test', duration_ms: now() - start, ...(error ? { error } : {}) } };
        stream.publish('test:start', data); stream.publish(failed ? 'test:fail' : 'test:pass', data);
        counts.tests++; counts.topLevel++;
        counts[failed ? (['testAborted', 'testTimeoutFailure', 'cancelledByParent'].includes(error.failureType) ? 'cancelled' : 'failed') : 'passed']++;
        if (failed) successful = false;
      }
      flushed++;
    }
  }
  async function execute(index) {
    const file = files[index];
    stream.publish('test:dequeue', fileData(index));
    const fileStart = now();
    if (options.signal?.aborted) {
      completed.set(index, { events: [], error: failure('test run aborted', 'testAborted', options.signal.reason) });
      flush(); return;
    }
    const flags = childFlags(options);
    const events = [];
    let summary;
    let error;
    let timer;
    let child;
    let onAbort;
    const ids = new Map();
    const id = original => { if (!ids.has(original)) ids.set(original, eventId++); return ids.get(original); };
    await new Promise(resolve => {
      let closed = false;
      const finish = () => { if (closed) return; closed = true; resolve(); };
      try {
        const snapshotFlags = host.testUpdateSnapshots === undefined ? [] :
          [host.testUpdateSnapshots ? '--test-update-snapshots' : '--no-test-update-snapshots'];
        child = spawn(process.execPath, [...inheritedExecArgv(), ...snapshotFlags, ...flags, ...(options.execArgv || []), file, ...(options.argv || [])], {
          cwd, env: { NODE_TEST_CONTEXT: 'child-v8', ...(options.env || process.env) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced',
        });
      } catch (cause) { error = failure('test process failed to start', 'testCodeFailure', cause); finish(); return; }
      child.stdout?.on('data', chunk => events.push({ type: 'test:stdout', data: { file, message: String(chunk) } }));
      child.stderr?.on('data', chunk => events.push({ type: 'test:stderr', data: { file, message: String(chunk) } }));
      child.on('message', event => {
        if (event && typeof event === 'object') {
          for (const key of ['watch:require', 'watch:import']) if (Array.isArray(event[key])) {
            const { report } = require('internal/watch_mode/dependencies');
            for (const filename of event[key]) report(filename);
          }
        }
        if (!event || typeof event.type !== 'string') return;
        if (event.data?.details?.error !== undefined) event.data.details.error = require('internal/error_serdes').deserializeError(event.data.details.error);
        if (event.type === 'test:summary') summary = event.data;
        else if (event.type === 'test:coverage') coverages.push(event.data.summary);
        else if (['test:enqueue', 'test:dequeue', 'test:complete'].includes(event.type)) {
          const data = { ...event.data };
          if (data.testId !== undefined) data.testId = id(data.testId);
          if (data.parentId !== undefined) data.parentId = id(data.parentId);
          stream.publish(event.type, data);
        } else if (event.type === 'test:diagnostic' && event.data.nesting === 0 && isCountDiagnostic(event.data.message)) return;
        else if (!(event.type === 'test:plan' && event.data.nesting === 0)) events.push(event);
      });
      child.on('error', cause => { error ||= failure('test process failed', 'testCodeFailure', cause); if (!child.pid) finish(); });
      child.on('close', (code, signal) => {
        if (code !== 0 || signal) exitStatus.set(index, { exitCode: code, signal: signal ?? null });
        if ((code !== 0 || signal) && (!summary || summary.success)) error ||= failure(`test process exited with ${signal || code}`, 'testCodeFailure');
        if (!summary && !error && events.length) error = failure('test process exited without completing its test run', 'testUnfinished');
        finish();
      });
      onAbort = () => { error ||= failure('test run aborted', 'testAborted', options.signal.reason); child.kill(); };
      if (options.signal?.aborted) onAbort(); else options.signal?.addEventListener('abort', onAbort, { once: true });
      if (Number.isFinite(options.timeout)) timer = nativeSetTimeout(() => { error ||= failure(`test process timed out after ${options.timeout}ms`, 'testTimeoutFailure'); child.kill(); }, options.timeout);
    });
    if (timer !== undefined) nativeClearTimeout(timer);
    if (onAbort) options.signal?.removeEventListener('abort', onAbort);
    durations.set(index, now() - fileStart);
    completed.set(index, { events, summary, error, ids }); flush();
  }
  if (options.randomSeed !== undefined) {
    const random = seededGenerator(options.randomSeed), pending = [...files];
    files = [];
    while (pending.length) files.push(pending.splice(pending.length > 1 ? Math.floor(random() * pending.length) : 0, 1)[0]);
  }
  for (let index = 0; index < files.length; index++) stream.publish('test:enqueue', fileData(index));
  const concurrency = options.concurrency === false ? 1 : options.concurrency === true || options.concurrency === undefined ? Math.max(1, (require('os').availableParallelism?.() || 2) - 1) : options.concurrency;
  await Promise.all(Array.from({ length: Math.min(files.length, concurrency) }, async () => {
    while (next < files.length) { const index = next++; await execute(index); }
  }));
  stream.publish('test:plan', { nesting: 0, count: sequence });
  if (options.randomSeed !== undefined) stream.publish('test:diagnostic', { nesting: 0, message: `Randomized test order seed: ${options.randomSeed}`, level: 'info' });
  const duration = now() - start;
  publishCounts((type, data) => stream.publish(type, data), counts, duration);
  if (options.coverage) {
    const coverage = require('internal/test_runner/coverage');
    if (!coverage.publish(stream, coverage.merge(coverages, options, cwd))) successful = false;
  }
  stream.publish('test:summary', { nesting: 0, success: successful, counts, duration_ms: duration });
  stream.push(null);
}
module.exports = { run };
