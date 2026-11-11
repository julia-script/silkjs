'use strict';

// `--test` entry and the reporters a test run writes to, shared by the CLI runner and by the
// default harness of a test file run directly (both honor --test-reporter and its destination).
const host = require('internal/host');
const util = require('util');

let debug = util.debuglog('test_runner', fn => { debug = fn; });

const kBuiltinReporters = new Map([
  ['spec', 'internal/test_runner/reporter/spec'],
  ['dot', 'internal/test_runner/reporter/dot'],
  ['tap', 'internal/test_runner/reporter/tap'],
  ['junit', 'internal/test_runner/reporter/junit'],
  ['lcov', 'internal/test_runner/reporter/lcov'],
]);

// Node's parseCommandLine reporter and destination pairing.
function reporterPairs(reporterNames, destinations, defaultReporter) {
  const reporters = [...reporterNames];
  const targets = [...destinations];
  if (!reporters.length && !targets.length) reporters.push(defaultReporter);
  if (reporters.length === 1 && !targets.length) targets.push('stdout');
  if (targets.length !== reporters.length) {
    throw Object.assign(new TypeError('The argument \'--test-reporter\' must match the number of specified ' +
      `'--test-reporter-destination'. Received ${util.inspect(reporters)}`), { code: 'ERR_INVALID_ARG_VALUE' });
  }
  return { reporters, targets };
}

// Node's getReportersMap: built-in reporters by name, anything else through the ESM loader.
async function reporterOutputs(reporters, targets) {
  return Promise.all(reporters.map(async (name, index) => {
    const destination = targets[index];
    const output = destination === 'stdout' ? process.stdout : destination === 'stderr' ? process.stderr :
      require('fs').createWriteStream(destination, { flush: true });
    const builtin = kBuiltinReporters.get(name);
    let reporter;
    if (builtin !== undefined) reporter = require(builtin);
    else {
      const { filename } = host.loader.resolve(name, require('path').join(process.cwd(), '[test-reporter]'), 'import');
      reporter = await import(/^[A-Za-z][A-Za-z\d+.-]*:/.test(filename) ? filename : require('url').pathToFileURL(filename).href);
    }
    if (reporter?.default) reporter = reporter.default;
    if (reporter?.prototype && Object.getOwnPropertyDescriptor(reporter.prototype, 'constructor')) reporter = new reporter();
    if (!reporter) {
      throw Object.assign(new TypeError(`The argument 'reporter' must be one of: stream.Transform, async generator function, or async function. Received ${util.inspect(reporter)}`),
        { code: 'ERR_INVALID_ARG_TYPE' });
    }
    return { reporter, output };
  }));
}

// Pipes a test event stream through each reporter. Resolves once every destination
// has taken all of its output.
async function attachReporters(stream, reporterNames, destinations, defaultReporter, onError) {
  const { reporters, targets } = reporterPairs(reporterNames, destinations, defaultReporter);
  const { PassThrough, finished } = require('stream');
  const branches = reporters.map(() => { const branch = new PassThrough({ objectMode: true }); stream.pipe(branch); return branch; });
  let outputs;
  try { outputs = await reporterOutputs(reporters, targets); } catch (error) { onError(error); return; }
  const pending = [];
  outputs.forEach(({ reporter, output }, index) => {
    const formatted = branches[index].compose(reporter);
    formatted.on('error', onError);
    output.on('error', onError);
    const standard = output === process.stdout || output === process.stderr;
    formatted.pipe(output, { end: !standard });
    pending.push(new Promise(resolve => {
      if (standard) formatted.once('end', resolve);
      else finished(output, () => resolve());
      formatted.once('error', resolve);
    }));
  });
  await Promise.all(pending);
}

function configuration(options, files) {
  const isolation = options.isolation ?? 'process';
  const timeout = options.timeout || Infinity;
  const concurrency = isolation === 'none' ? 1 : options.concurrency || true;
  return {
    __proto__: null,
    isTestRunner: true,
    concurrency,
    coverage: !!options.coverage,
    coverageExcludeGlobs: options.coverageExcludeGlobs,
    coverageIncludeGlobs: options.coverageIncludeGlobs,
    destinations: host.testReporters?.destinations.length ? host.testReporters.destinations : ['stdout'],
    forceExit: !!options.forceExit,
    isolation,
    branchCoverage: options.branchCoverage,
    functionCoverage: options.functionCoverage,
    lineCoverage: options.lineCoverage,
    only: !!options.only,
    reporters: host.testReporters?.names.length ? host.testReporters.names : ['spec'],
    globalSetupPath: options.globalSetupPath ?? '',
    shard: options.shard,
    testNamePatterns: options.testNamePatterns ?? null,
    testSkipPatterns: options.testSkipPatterns ?? null,
    testTagFilters: options.testTagFilters ?? null,
    timeout,
    updateSnapshots: !!host.testUpdateSnapshots,
    watch: false,
    randomize: !!options.randomize,
    randomSeed: options.randomSeed,
    rerunFailuresFilePath: options.rerunFailuresFilePath ?? '',
    globPatterns: files,
  };
}

function runTestRunner(options, files, reporterNames, destinations) {
  const config = configuration(options, files);
  debug('test runner configuration:', config);
  const runOptions = { ...options, concurrency: config.concurrency, timeout: config.timeout };
  delete runOptions.forceExit;
  runOptions.globPatterns = files;
  const { run, kIsTestRunner } = require('internal/test_runner/runner');
  runOptions[kIsTestRunner] = true;
  const stream = run(runOptions);
  stream.on('test:summary', summary => { if (!summary.success) process.exitCode = 1; });
  const fail = error => { console.error(error); process.exitCode = 1; };
  stream.on('error', fail);
  const written = attachReporters(stream, reporterNames, destinations, 'spec', fail);
  if (options.forceExit) written.then(() => process.exit());
}

module.exports = { runTestRunner, attachReporters };
