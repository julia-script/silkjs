'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const keys = ['directory', 'filename', 'compact', 'reportOnFatalError', 'signal', 'reportOnSignal', 'reportOnUncaughtException', 'excludeEnv', 'excludeNetwork'];
const snapshot = () => Object.fromEntries(keys.map(key => [key, process.report[key]]));
const workerSnapshot = `Object.fromEntries(${JSON.stringify(keys)}.map(key => [key, process.report[key]]))`;
function worker(source, options = {}) {
  return new Promise((resolve, reject) => {
    let message;
    const child = new Worker(source, { eval: true, ...options });
    child.on('message', value => { message = value; });
    child.on('error', reject);
    child.on('exit', code => {
      try { assert.equal(code, 0); resolve(message); } catch (error) { reject(error); }
    });
  });
}
function child(args, env = process.env) {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', env, timeout: 15000 });
  if (result.error) throw result.error;
  return result;
}
async function main() {
  const original = snapshot();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'report-options-'));
  try {
    for (const [value, expected] of [['a\ud800b', 'a\ufffdb'], ['a\0b', 'a'], ['snow-☃', 'snow-☃']]) {
      process.report.filename = value;
      assert.equal(process.report.filename, expected);
    }
    const parent = {
      directory: 'parent-dir', filename: 'parent.json', compact: true, reportOnFatalError: true,
      signal: 'SIGUSR1', reportOnSignal: false, reportOnUncaughtException: true,
      excludeEnv: true, excludeNetwork: true,
    };
    Object.assign(process.report, parent);
    const changed = {
      directory: 'worker-dir', filename: 'worker.json', compact: false, reportOnFatalError: false,
      signal: 'SIGUSR2', reportOnSignal: true, reportOnUncaughtException: false,
      excludeEnv: false, excludeNetwork: false,
    };
    const observed = await worker(`const { parentPort } = require('node:worker_threads');
      const before = ${workerSnapshot};
      Object.assign(process.report, ${JSON.stringify(changed)});
      parentPort.postMessage({ before, after: ${workerSnapshot} });`);
    assert.deepEqual(observed.before, { ...parent, excludeEnv: false, excludeNetwork: false });
    assert.deepEqual(observed.after, changed);
    assert.deepEqual(snapshot(), { ...parent, directory: changed.directory, filename: changed.filename,
      compact: changed.compact, reportOnFatalError: changed.reportOnFatalError });
    const reset = await worker(`require('node:worker_threads').parentPort.postMessage(${workerSnapshot});`, { execArgv: [] });
    assert.equal(reset.signal, 'SIGUSR2');
    assert.equal(reset.reportOnSignal, false);
    assert.equal(reset.reportOnUncaughtException, false);
    assert.throws(() => new Worker('', { eval: true, execArgv: ['--report-compact'] }), { code: 'ERR_WORKER_INVALID_EXEC_ARGV' });

    const written = child(['--report-directory', root, '--report-filename=compact.json', '--report-compact',
      '--report-exclude-env', '--report-exclude-network', '-e', 'process.report.writeReport(new Error("startup report"));']);
    assert.equal(written.status, 0, written.stderr);
    const compact = fs.readFileSync(path.join(root, 'compact.json'), 'utf8');
    assert.equal(compact.trim().split('\n').length, 1);
    const report = JSON.parse(compact);
    assert.equal(Object.hasOwn(report, 'environmentVariables'), false);
    assert.equal(Object.hasOwn(report.header, 'networkInterfaces'), false);
    assert.match(report.javascriptStack.message, /startup report/);

    const precedence = child(['--no-report-compact', '--report-filename=cli.json', '-e', 'process.report.writeReport();'], {
      ...process.env, NODE_OPTIONS: `--report-compact --report-directory=${JSON.stringify(root)} --report-filename=env.json`,
    });
    assert.equal(precedence.status, 0, precedence.stderr);
    assert.equal(fs.existsSync(path.join(root, 'env.json')), false);
    const expanded = fs.readFileSync(path.join(root, 'cli.json'), 'utf8');
    assert.ok(expanded.trim().split('\n').length > 1);
    assert.equal(JSON.parse(expanded).header.filename, 'cli.json');

    const uncaught = child(['--report-uncaught-exception', '--report-dir', root, '--report-filename=uncaught.json',
      '-e', 'throw new Error("startup uncaught report")']);
    assert.equal(uncaught.status, 1);
    const failureReport = JSON.parse(fs.readFileSync(path.join(root, 'uncaught.json'), 'utf8'));
    assert.equal(failureReport.header.trigger, 'Exception');
    assert.ok([failureReport.javascriptStack.message, ...failureReport.javascriptStack.stack]
      .some(line => line.startsWith('Error: startup uncaught report')));
    for (const args of [['--report-signal='], ['--report-filename']]) assert.equal(child(args).status, 9);
    console.log('Report configuration ownership, inheritance, startup precedence and output smoke passed');
  } finally {
    Object.assign(process.report, original);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
