'use strict';

// `--test` entry and the reporters a test run writes to, shared by the CLI runner and by the
// default harness of a test file run directly (both honor --test-reporter and its destination).
const host = require('internal/host');
const util = require('util');

let debug = util.debuglog('test_runner', fn => { debug = fn; });

function reporterOutputs(reporterNames, destinations, defaultReporter) {
  const names = reporterNames.length ? [...reporterNames] : [defaultReporter];
  const targets = [...destinations];
  if (!targets.length && names.length === 1) targets.push('stdout');
  if (names.length !== targets.length) {
    throw Object.assign(new Error('The argument \'--test-reporter\' must match the number of specified \'--test-reporter-destination\'. Received ' + names.length), { code: 'ERR_INVALID_ARG_VALUE' });
  }
  const reporters = require('test/reporters');
  return names.map((name, index) => {
    let reporter = reporters[name];
    if (!reporter) {
      reporter = host.loader.requireFor(require('path').join(process.cwd(), '[test-reporter]'))(name);
      reporter = reporter.default || reporter;
    } else if (name === 'spec' || name === 'lcov') reporter = reporter();
    const destination = targets[index];
    const output = destination === 'stdout' ? process.stdout : destination === 'stderr' ? process.stderr :
      require('fs').createWriteStream(destination);
    return { reporter, output };
  });
}

// Pipes a test event stream through each reporter. Resolves once every destination
// has taken all of its output.
function attachReporters(stream, reporterNames, destinations, defaultReporter, onError) {
  const { PassThrough, finished } = require('stream');
  const pending = [];
  for (const { reporter, output } of reporterOutputs(reporterNames, destinations, defaultReporter)) {
    const branch = new PassThrough({ objectMode: true });
    stream.pipe(branch);
    const formatted = branch.compose(reporter);
    formatted.on('error', onError);
    output.on('error', onError);
    const standard = output === process.stdout || output === process.stderr;
    formatted.pipe(output, { end: !standard });
    pending.push(new Promise(resolve => {
      if (standard) formatted.once('end', resolve);
      else finished(output, () => resolve());
      formatted.once('error', resolve);
    }));
  }
  return Promise.all(pending);
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
  if (files.length) runOptions.files = files;
  const stream = require('test').run(runOptions);
  stream.on('test:summary', summary => { if (!summary.success) process.exitCode = 1; });
  const fail = error => { console.error(error); process.exitCode = 1; };
  stream.on('error', fail);
  const written = attachReporters(stream, reporterNames, destinations, 'spec', fail);
  if (options.forceExit) written.then(() => process.exit());
}

module.exports = { runTestRunner, attachReporters };
