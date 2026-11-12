'use strict';

const { createHarness, withHarness, TestsStream, failure, unsupported, seededGenerator, createRandomSeed, loadGlobalHooks, reportSetupFailure, publishCounts, isCountDiagnostic } = require('internal/test_runner/harness');
const { codes: { ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE } } = require('internal/errors');
const { validateArray, validateBoolean, validateFunction, validateInteger, validateObject, validateOneOf, validatePath, validateString, validateUint32 } = require('internal/validators');
const path = require('path');
const fs = require('fs');
const host = require('internal/host');
const nativeSetImmediate = globalThis.setImmediate;
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const now = Date.now.bind(Date);
const kIsTestRunner = Symbol('kIsTestRunner');
// Node's createTestFileList: the default pattern, or the caller's globs relative to cwd.
const kPatterns = ['test', 'test/**/*', 'test-*', '*[._-]test'];
function createTestFileList(patterns, cwd) {
  const hasUserSuppliedPattern = patterns.length > 0;
  const extensions = host.typeScriptMode ? 'js,mjs,cjs,ts,mts,cts' : 'js,mjs,cjs';
  if (!hasUserSuppliedPattern) patterns = [`**/{${kPatterns.join(',')}}.{${extensions}}`];
  const { Glob } = require('internal/fs/glob');
  const glob = new Glob(patterns, { __proto__: null, cwd, exclude: name => name === 'node_modules' });
  const results = glob.globSync();
  if (hasUserSuppliedPattern && results.length === 0 && glob.matchers.every(matcher => !matcher.hasMagic())) {
    console.error(`Could not find '${patterns.join(', ')}'`);
    process.exit(1);
  }
  return results.sort();
}
// Node's run() argument checks, in Node's order.
function convertStringToRegExp(str, name) {
  const match = /^\/(.*)\/([a-z]*)$/s.exec(str);
  try { return new RegExp(match?.[1] ?? str, match?.[2] || ''); }
  catch (err) { throw new ERR_INVALID_ARG_VALUE(name, str, `is an invalid regular expression.${err?.message ? ` ${err.message}` : ''}`); }
}
function validatePatterns(value, key) {
  [value].flat().forEach((item, i) => {
    const name = `options.${key}[${i}]`;
    if (item instanceof RegExp) return;
    if (typeof item === 'string') convertStringToRegExp(item, name);
    else throw new ERR_INVALID_ARG_TYPE(name, ['string', 'RegExp'], item);
  });
}
function validateStringArray(value, name) {
  validateArray(value, name);
  value.forEach((item, i) => validateString(item, `${name}[${i}]`));
}
function validate(options) {
  validateObject(options, 'options');
  const { files, only, globPatterns, setup, shard, isolation = 'process', coverage = false, globalSetupPath, env, watch, forceExit, rerunFailuresFilePath } = options;
  if (files != null) validateArray(files, 'options.files');
  if (watch != null) validateBoolean(watch, 'options.watch');
  if (forceExit != null) {
    validateBoolean(forceExit, 'options.forceExit');
    if (forceExit && watch) throw new ERR_INVALID_ARG_VALUE('options.forceExit', watch, 'is not supported with watch mode');
  }
  if (options.randomize != null) validateBoolean(options.randomize, 'options.randomize');
  if (options.randomSeed != null) validateUint32(options.randomSeed, 'options.randomSeed');
  const randomize = options.randomSeed != null || !!options.randomize;
  for (const [mode, active] of [['watch mode', watch], ['rerun failures mode', rerunFailuresFilePath]]) {
    if (!active) continue;
    if (mode !== 'watch mode') validatePath(rerunFailuresFilePath, 'options.rerunFailuresFilePath');
    if (options.randomSeed != null) throw new ERR_INVALID_ARG_VALUE('options.randomSeed', options.randomSeed, `is not supported with ${mode}`);
    if (randomize) throw new ERR_INVALID_ARG_VALUE('options.randomize', randomize, `is not supported with ${mode}`);
  }
  if (only != null) validateBoolean(only, 'options.only');
  if (globPatterns != null) validateArray(globPatterns, 'options.globPatterns');
  if (options.cwd !== undefined) validateString(options.cwd, 'options.cwd');
  if (globPatterns?.length > 0 && files?.length > 0) {
    throw new ERR_INVALID_ARG_VALUE('options.globPatterns', globPatterns, 'is not supported when specifying \'options.files\'');
  }
  if (shard != null) {
    validateObject(shard, 'options.shard');
    validateInteger(shard.total, 'options.shard.total', 1);
    validateInteger(shard.index, 'options.shard.index', 1, shard.total);
    if (watch) throw new ERR_INVALID_ARG_VALUE('options.shard', watch, 'shards not supported with watch mode');
  }
  if (setup != null) validateFunction(setup, 'options.setup');
  if (options.testNamePatterns != null) validatePatterns(options.testNamePatterns, 'testNamePatterns');
  if (options.testSkipPatterns != null) validatePatterns(options.testSkipPatterns, 'testSkipPatterns');
  if (options.testTagFilters != null) {
    const { tagFilter } = require('internal/test_runner/harness');
    [options.testTagFilters].flat().forEach((value, i) => tagFilter(value, `options.testTagFilters[${i}]`));
  }
  validateOneOf(isolation, 'options.isolation', ['process', 'none']);
  validateBoolean(coverage, 'options.coverage');
  for (const key of ['coverageExcludeGlobs', 'coverageIncludeGlobs']) {
    if (options[key] != null) validateStringArray([options[key]].flat(), `options.${key}`);
  }
  for (const key of ['lineCoverage', 'branchCoverage', 'functionCoverage']) validateInteger(options[key] ?? 0, `options.${key}`, 0, 100);
  validateStringArray(options.argv ?? [], 'options.argv');
  validateStringArray(options.execArgv ?? [], 'options.execArgv');
  if (globalSetupPath != null) validatePath(globalSetupPath, 'options.globalSetupPath');
  if (env != null) {
    validateObject(env, 'options.env');
    if (isolation === 'none') throw new ERR_INVALID_ARG_VALUE('options.env', env, 'is not supported with isolation=\'none\'');
  }
  // Node ignores options it does not know; these it knows and this runner does not implement.
  for (const key of ['watch', 'forceExit', 'inspectPort', 'rerunFailuresFilePath']) if (options[key] != null && options[key] !== false) unsupported(`run option ${key}`);
}
function validateRandom(options) {
  if (options.randomize != null) validateBoolean(options.randomize, 'options.randomize');
  if (options.randomSeed != null) validateUint32(options.randomSeed, 'options.randomSeed');
  const randomize = options.randomSeed != null || options.randomize === true;
  return randomize ? options.randomSeed ?? createRandomSeed() : undefined;
}
function run(options = {}) {
  validate(options);
  const randomSeed = validateRandom(options);
  options = { ...options, randomize: randomSeed !== undefined, randomSeed };
  const stream = new TestsStream();
  // Like Node's setupProcessState, the CLI runner takes SIGINT and SIGTERM from the start.
  if (options[kIsTestRunner]) {
    const termination = options[kIsTestRunner] = { handler: null, pending: false };
    const onSignal = () => { if (termination.handler) termination.handler(); else termination.pending = true; };
    process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  }
  nativeSetImmediate(async () => {
    try {
      const cwd = path.resolve(options.cwd || process.cwd());
      // File-level results are named as the caller gave the path, or as the glob found it.
      const given = options.files ?? createTestFileList(options.globPatterns ?? [], cwd);
      let files = given.map(file => path.resolve(cwd, file));
      const names = new Map(files.map((file, index) => [file, given[index]]));
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
        if (options.isolation === 'none') await runLocal(files, local, stream, cwd, names);
        else if (process.env.NODE_TEST_CONTEXT !== undefined) {
          // Node's guard against a test file calling run() inside its own process tree.
          process.emitWarning('node:test run() is being called recursively within a test file. skipping running files.');
          await runProcesses([], local, stream, cwd, names);
        } else await runProcesses(files, local, stream, cwd, names);
      } finally {
        if (teardown) { try { await teardown(); } catch (error) { reportSetupFailure(error); } }
      }
    } catch (error) { stream.destroy(error); }
  });
  return stream;
}
async function runLocal(files, options, stream, cwd, names) {
  process.env.NODE_TEST_WORKER_ID = '1';
  const harness = createHarness({ ...options, setExitCode: false, filterByOnly: true });
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
          const before = harness.root.children.length;
          let threw = false, importError;
          try { await withHarness(harness, () => host.loader.runMain(file)); }
          catch (error) { threw = true; importError = error; }
          // Node's placeholder for a file that declared no top-level tests.
          if (harness.root.children.length === before) {
            harness.add('test', { name: names.get(file) ?? file, options: { __proto__: null }, loc: { line: 1, column: 1, file },
              fn() { if (threw) throw importError; } });
          }
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
// The child's default harness reads these the way a test file run by hand does, and
// reports its events over IPC because NODE_TEST_CONTEXT is child-v8.
function childFlags(options) {
  const flags = [];
  if (options.only) flags.push('--test-only');
  if (Number.isFinite(options.timeout)) flags.push(`--test-timeout=${options.timeout}`);
  for (const key of ['testNamePatterns', 'testSkipPatterns']) {
    const name = key === 'testNamePatterns' ? '--test-name-pattern' : '--test-skip-pattern';
    for (const value of [options[key] ?? []].flat())
      flags.push(`${name}=${value instanceof RegExp ? `/${value.source}/${value.flags}` : value}`);
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
  const fileData = index => ({ nesting: 0, name: names.get(files[index]) ?? files[index], type: 'test', line: 1, column: 1, file: files[index], tags: [] });
  // Events of the file at the head of the report order go out as they arrive, like Node's
  // FileTest; the others wait in their buffer until every earlier file has completed.
  const buffers = new Map();
  // Each child numbers its tests from 1; the parent renumbers them across files.
  const fileIds = new Map();
  const idFor = (index, original) => {
    if (!fileIds.has(index)) fileIds.set(index, new Map());
    const ids = fileIds.get(index);
    if (!ids.has(original)) ids.set(original, eventId++);
    return ids.get(original);
  };
  const reported = new Map();
  const publishEvent = (index, event) => {
    // Like Node's FileTest, events from a child carry the file that process ran.
    const data = { ...event.data, entryFile: files[index] };
    if (data.testId !== undefined) data.testId = idFor(index, data.testId);
    if (data.parentId !== undefined) data.parentId = idFor(index, data.parentId);
    if (data.nesting === 0 && ['test:pass', 'test:fail'].includes(event.type)) {
      data.testNumber = ++sequence;
    }
    reported.set(index, (reported.get(index) ?? false) || (event.type !== 'test:stdout' && event.type !== 'test:stderr'));
    stream.publish(event.type, data);
  };
  const record = (index, event) => {
    if (index === flushed) publishEvent(index, event);
    else { if (!buffers.has(index)) buffers.set(index, []); buffers.get(index).push(event); }
  };
  const drain = index => {
    for (const event of buffers.get(index) ?? []) publishEvent(index, event);
    buffers.delete(index);
  };
  function flush() {
    while (completed.has(flushed)) {
      const { summary, error } = completed.get(flushed);
      completed.delete(flushed);
      drain(flushed);
      const hasTests = reported.get(flushed) ?? false;
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
      if (error || (!summary && !hasTests)) {
        const failed = !!error;
        const data = { name: names.get(files[flushed]) ?? files[flushed], nesting: 0, line: 1, column: 1, file: files[flushed], testId: eventId++, testNumber: ++sequence,
          details: { type: 'test', duration_ms: now() - start, ...(error ? { error } : {}) } };
        stream.publish('test:start', data); stream.publish(failed ? 'test:fail' : 'test:pass', data);
        counts.tests++; counts.topLevel++;
        counts[failed ? (['testAborted', 'testTimeoutFailure', 'cancelledByParent'].includes(error.failureType) ? 'cancelled' : 'failed') : 'passed']++;
        if (failed) successful = false;
      }
      flushed++;
      drain(flushed);
    }
  }
  async function execute(index) {
    const file = files[index];
    stream.publish('test:dequeue', fileData(index));
    const fileStart = now();
    if (options.signal?.aborted || interrupted) {
      completed.set(index, { error: interrupted ? cancelledByInterrupt() : failure('test run aborted', 'testAborted', options.signal.reason) });
      flush(); return;
    }
    const flags = childFlags(options);
    let reportedEvents = 0;
    const push = event => { reportedEvents++; record(index, event); };
    let summary;
    let error;
    let timer;
    let child;
    let onAbort;
    // Like Node's FileTest, a file counts as running from the moment it is dequeued.
    running.set(index, () => { error ||= cancelledByInterrupt(); child?.kill(); });
    await new Promise(resolve => {
      let closed = false;
      const finish = () => { if (closed) return; closed = true; resolve(); };
      if (error) { finish(); return; }
      try {
        const snapshotFlags = host.testUpdateSnapshots === undefined ? [] :
          [host.testUpdateSnapshots ? '--test-update-snapshots' : '--no-test-update-snapshots'];
        child = spawn(process.execPath, [...inheritedExecArgv(), ...snapshotFlags, ...flags, ...(options.execArgv || []), file, ...(options.argv || [])], {
          cwd, env: { NODE_TEST_CONTEXT: 'child-v8', ...(options.env || process.env), NODE_TEST_WORKER_ID: String((workers++ % concurrency) + 1) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced',
        });
      } catch (cause) { error = failure('test process failed to start', 'testCodeFailure', cause); finish(); return; }
      child.stdout?.on('data', chunk => push({ type: 'test:stdout', data: { file, message: String(chunk) } }));
      child.stderr?.on('data', chunk => push({ type: 'test:stderr', data: { file, message: String(chunk) } }));
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
          const data = { ...event.data, entryFile: file };
          if (data.testId !== undefined) data.testId = idFor(index, data.testId);
          if (data.parentId !== undefined) data.parentId = idFor(index, data.parentId);
          stream.publish(event.type, data);
        } else if (event.type === 'test:diagnostic' && event.data.nesting === 0 && isCountDiagnostic(event.data.message)) return;
        else if (!(event.type === 'test:plan' && event.data.nesting === 0)) push(event);
      });
      child.on('error', cause => { error ||= failure('test process failed', 'testCodeFailure', cause); if (!child.pid) finish(); });
      child.on('close', (code, signal) => {
        if (code !== 0 || signal) exitStatus.set(index, { exitCode: code, signal: signal ?? null });
        if ((code !== 0 || signal) && (!summary || summary.success)) error ||= failure(`test process exited with ${signal || code}`, 'testCodeFailure');
        // A child that exits cleanly without reporting tests (like `-p` in execArgv) passes, as in Node.
        if (!summary && !error && code !== 0 && reportedEvents) error = failure('test process exited without completing its test run', 'testUnfinished');
        finish();
      });
      onAbort = () => { error ||= failure('test run aborted', 'testAborted', options.signal.reason); child.kill(); };
      if (options.signal?.aborted) onAbort(); else options.signal?.addEventListener('abort', onAbort, { once: true });
      if (Number.isFinite(options.timeout)) timer = nativeSetTimeout(() => { error ||= failure(`test process timed out after ${options.timeout}ms`, 'testTimeoutFailure'); child.kill(); }, options.timeout);
    });
    running.delete(index);
    if (timer !== undefined) nativeClearTimeout(timer);
    if (onAbort) options.signal?.removeEventListener('abort', onAbort);
    durations.set(index, now() - fileStart);
    completed.set(index, { summary, error }); flush();
  }
  if (options.randomSeed !== undefined) {
    const random = seededGenerator(options.randomSeed), pending = [...files];
    files = [];
    while (pending.length) files.push(pending.splice(pending.length > 1 ? Math.floor(random() * pending.length) : 0, 1)[0]);
  }
  for (let index = 0; index < files.length; index++) stream.publish('test:enqueue', fileData(index));
  // Node's test runner CLI reports the files still running on SIGINT or SIGTERM, then
  // cancels them; the run ends and exits through its failed summary.
  const running = new Map();
  let interrupted = false;
  const cancelledByInterrupt = () => failure('Promise resolution is still pending but the event loop has already resolved', 'cancelledByParent');
  const onInterrupt = () => {
    if (interrupted) return;
    interrupted = true;
    const tests = [...running.keys()].map(index => ({ __proto__: null, name: names.get(files[index]) ?? files[index], nesting: 0, file: undefined, line: undefined, column: undefined }));
    if (tests.length) stream.publish('test:interrupted', { tests });
    for (const cancel of running.values()) cancel();
  };
  const termination = options[kIsTestRunner];
  if (termination) { termination.handler = onInterrupt; if (termination.pending) onInterrupt(); }
  // Node's WorkerIdPool hands out ids round-robin over the concurrency.
  let workers = 0;
  const concurrency = options.concurrency === false ? 1 : options.concurrency === true || options.concurrency === undefined ? Math.max(1, (require('os').availableParallelism?.() || 2) - 1) : options.concurrency;
  await Promise.all(Array.from({ length: Math.min(files.length, concurrency) }, async () => {
    while (next < files.length) { const index = next++; await execute(index); }
  }));
  if (termination) termination.handler = null;
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
module.exports = { run, kIsTestRunner };
