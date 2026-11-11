'use strict';
// A release executable starts from a heap image that tools/build.py took of the
// bootstrapped runtime in another process, with no environment. Everything a
// process has of its own must be this process's, not the build's. The same
// checks hold for an executable without an image.
const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function child() {
  const report = {
    pid: process.pid, argv: process.argv.slice(2), argv0: process.argv0, execPath: process.execPath,
    env: { ...process.env }, has: 'IMAGE_SMOKE' in process.env, keys: Object.keys(process.env),
    cwd: process.cwd(), random: Math.random(), uuid: require('crypto').randomUUID(),
    uptime: process.uptime(), now: performance.now(), origin: performance.timeOrigin, date: Date.now(),
    hrtime: process.hrtime()[0] >= 0, globalPaths: require('module').globalPaths,
    home: os.homedir(), stdoutTTY: !!process.stdout.isTTY, connected: !!process.connected,
    milestones: [performance.nodeTiming.bootstrapComplete, performance.nodeTiming.environment],
  };
  process.stdout.write(JSON.stringify(report));
}

function run(executable, env, args = [], options = {}) {
  const result = spawnSync(executable, [__filename, '--child', ...args], { encoding: 'utf8', env, ...options });
  assert.strictEqual(result.status, 0, result.stderr);
  return { report: JSON.parse(result.stdout), pid: result.pid };
}

function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'silk-heap-image-'));
  try {
    // The image belongs to the executable, wherever it is copied.
    const executable = path.join(root, 'bin', 'runtime-copy');
    fs.mkdirSync(path.dirname(executable));
    fs.copyFileSync(process.execPath, executable);
    fs.chmodSync(executable, 0o755);
    const home = path.join(root, 'home');
    const env = { HOME: home, IMAGE_SMOKE: 'one', NODE_PATH: path.join(root, 'extra'), TZ: 'UTC' };
    const before = Date.now();
    const first = run(executable, env, ['a', 'b'], { cwd: root });
    const second = run(executable, { ...env, IMAGE_SMOKE: 'two' }, [], { cwd: root });
    const after = Date.now();
    const a = first.report, b = second.report;

    assert.strictEqual(a.pid, first.pid);
    assert.strictEqual(b.pid, second.pid);
    assert.deepStrictEqual(a.argv, ['--child', 'a', 'b']);
    assert.deepStrictEqual(b.argv, ['--child']);
    assert.strictEqual(a.execPath, fs.realpathSync(executable));
    assert.strictEqual(a.argv0, executable);
    assert.strictEqual(a.cwd, fs.realpathSync(root));

    assert.strictEqual(a.env.IMAGE_SMOKE, 'one');
    assert.strictEqual(b.env.IMAGE_SMOKE, 'two');
    assert.strictEqual(a.has, true);
    assert.deepStrictEqual(a.keys.sort(), Object.keys(env).sort());
    assert.strictEqual(a.home, home);
    assert(a.globalPaths.includes(path.join(home, '.node_modules')), a.globalPaths.join(' '));
    assert(a.globalPaths.includes(path.join(root, 'extra')), a.globalPaths.join(' '));
    assert(a.globalPaths.includes(path.join(fs.realpathSync(root), 'lib', 'node')), a.globalPaths.join(' '));

    assert.notStrictEqual(a.random, b.random);
    assert.notStrictEqual(a.uuid, b.uuid);
    for (const report of [a, b]) {
      assert(report.uptime >= 0 && report.uptime < 30, `uptime ${report.uptime}`);
      assert(report.now >= 0 && report.now < 30000, `performance.now ${report.now}`);
      assert(report.origin >= before - 1000 && report.origin <= after + 1000, `timeOrigin ${report.origin}`);
      assert(report.date >= before && report.date <= after);
      for (const milestone of report.milestones) assert(milestone >= 0 && milestone < 30000, `milestone ${milestone}`);
      assert.strictEqual(report.stdoutTTY, false);
      assert.strictEqual(report.connected, false);
    }

    // A forked child finds its channel, which the environment names.
    const forked = spawnSync(executable, ['-e', `
      const child = require('child_process').fork(${JSON.stringify(__filename)}, ['--echo']);
      child.on('message', message => { console.log(JSON.stringify(message)); child.disconnect(); });
      child.send({ ping: 1 });`], { encoding: 'utf8', env });
    assert.strictEqual(forked.status, 0, forked.stderr);
    assert.deepStrictEqual(JSON.parse(forked.stdout), { pong: { ping: 1 } });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  console.log('heap-image-smoke ok');
}

if (process.argv[2] === '--child') child();
else if (process.argv[2] === '--echo') process.on('message', message => { process.send({ pong: message }); });
else main();
