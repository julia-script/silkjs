'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const turn = () => new Promise(resolve => setImmediate(resolve));

function child(source, args = []) {
  const result = spawnSync(process.execPath, [...args, '-e', source], {
    encoding: 'utf8', timeout: 20000, env: { ...process.env, NODE_OPTIONS: '' },
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
function protocol() {
  for (const operation of ['ref', 'unref']) {
    const symbol = Symbol.for(`nodejs.${operation}`);
    const calls = [];
    const value = {
      [symbol]() { calls.push(this === value ? 'symbol' : 'wrong receiver'); return 42; },
      [operation]() { calls.push('legacy'); },
    };
    assert.equal(process[operation](value), undefined);
    value[symbol] = 0;
    process[operation](value);
    value[symbol] = {};
    process[operation](value);
    assert.deepEqual(calls, ['symbol', 'legacy']);
    for (const empty of [null, undefined, 0, false, '']) assert.equal(process[operation](empty), undefined);
    const failure = new Error('getter');
    assert.throws(() => process[operation]({ get [symbol]() { throw failure; } }), error => error === failure);
    assert.throws(() => process[operation]({ [symbol]: false, get [operation]() { throw failure; } }), error => error === failure);
    assert.throws(() => process[operation]({ [symbol]() { throw failure; } }), error => error === failure);
  }
}
function lifecycle() {
  const output = child(`
    const events = [];
    const keep = [{}, {}, {}];
    process.on('beforeExit', () => events.push('before-first'));
    process.on('exit', () => events.push('exit-first'));
    process.finalization.registerBeforeExit(keep[0], (value, event) => events.push(event + ':' + (value === keep[0])));
    process.finalization.register(keep[0], (value, event) => events.push(event + ':' + (value === keep[0])));
    process.finalization.register(keep[1], () => events.push('unregistered'));
    process.finalization.registerBeforeExit(keep[1], () => events.push('unregistered-before'));
    process.finalization.unregister(keep[1]);
    process.finalization.register(keep[2], () => events.push('duplicate'));
    process.finalization.register(keep[2], () => events.push('duplicate'));
    process.on('exit', () => console.log(JSON.stringify(events)));
  `);
  assert.deepEqual(JSON.parse(output), ['before-first', 'beforeExit:true', 'exit-first', 'exit:true', 'duplicate', 'duplicate']);
  assert.deepEqual(JSON.parse(child(`
    const events = []; const keep = {};
    process.finalization.registerBeforeExit(keep, () => events.push('before'));
    process.finalization.register(keep, (_, event) => events.push(event));
    process.on('exit', () => console.log(JSON.stringify(events)));
    process.exit(0);
  `)), ['exit']);
  const weak = child(`
    const assert = require('node:assert/strict');
    let target = {};
    const weak = new WeakRef(target);
    process.finalization.register(target, () => { throw new Error('collected target finalized at exit'); });
    process.finalization.registerBeforeExit(target, () => { throw new Error('collected target finalized before exit'); });
    target = null;
    let attempts = 0;
    function collect() {
      gc();
      if (weak.deref() === undefined) { console.log('collected'); return; }
      assert.ok(++attempts < 100, 'registration must not own its target');
      setImmediate(collect);
    }
    setImmediate(collect);
  `, ['--expose-gc']);
  assert.equal(weak.trim(), 'collected');
}
async function resources(root) {
  const count = name => process.getActiveResourcesInfo().filter(value => value === name).length;
  const before = count('Timeout');
  const timer = setTimeout(() => { throw new Error('long timer unexpectedly fired'); }, 30000);
  assert.equal(count('Timeout'), before + 1);
  process.unref(timer);
  assert.equal(count('Timeout'), before);
  process.ref(timer);
  assert.equal(count('Timeout'), before + 1);
  clearTimeout(timer);
  assert.equal(count('Timeout'), before);
  const watchBefore = count('FSEventWrap');
  const watch = fs.watch(root, () => {});
  assert.equal(count('FSEventWrap'), watchBefore + 1);
  const live = process.report.getReport();
  assert.ok(live.libuv.some(handle => handle.type === 'fs_event' && handle.is_active && handle.is_referenced));
  watch.unref();
  assert.equal(count('FSEventWrap'), watchBefore);
  assert.ok(process.report.getReport().libuv.some(handle => handle.type === 'fs_event' && handle.is_active && !handle.is_referenced));
  watch.ref();
  watch.close();
  const deadline = performance.now() + 2000;
  while (count('FSEventWrap') !== watchBefore && performance.now() < deadline) await turn();
  assert.equal(count('FSEventWrap'), watchBefore);
  assert.ok(live.libuv.some(handle => handle.type === 'fs_event' && handle.is_active && handle.is_referenced), 'snapshot owns its values after handle close');
  await new Promise((resolve, reject) => fs.stat(__filename, error => {
    if (error) return reject(error);
    try {
      assert.ok(process.getActiveResourcesInfo().includes('FSReqCallback'), 'request remains live while its callback executes');
      resolve();
    } catch (failure) { reject(failure); }
  }));
  const pending = fs.promises.readFile(__filename);
  assert.ok(process.getActiveResourcesInfo().includes('FSReqPromise'), 'pending Promise filesystem request retains its ownership kind');
  await pending;
  await turn();
  assert.equal(process.getActiveResourcesInfo().some(name => /^FSReq/.test(name)), false);
}
async function requestResources() {
  const dns = require('node:dns');
  const lookup = new Promise((resolve, reject) => dns.lookup('localhost', error => error ? reject(error) : resolve()));
  assert.ok(process.getActiveResourcesInfo().includes('GetAddrInfoReqWrap'));
  await lookup;
  await turn();
  assert.equal(process.getActiveResourcesInfo().includes('GetAddrInfoReqWrap'), false);
  const crypto = require('node:crypto');
  const compression = require('node:zlib');
  const work = new Promise((resolve, reject) => crypto.pbkdf2('password', 'salt', 100000, 32, 'sha256', error => error ? reject(error) : resolve()));
  const zipped = new Promise((resolve, reject) => compression.gzip(Buffer.alloc(1024), error => error ? reject(error) : resolve()));
  const workSnapshot = process.report.getReport();
  if (workSnapshot.silkjs) assert.ok(workSnapshot.libuv.some(record => record.type === 'work' && record.is_active));
  await Promise.all([work, zipped]);
  await turn();
  if (workSnapshot.silkjs) assert.equal(process.report.getReport().libuv.some(record => record.type === 'work'), false);
  const net = require('node:net');
  const { once } = require('node:events');
  let acceptedClosed;
  const server = net.createServer(socket => {
    acceptedClosed = once(socket, 'close');
    socket.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let socket;
  try {
    assert.ok(process.getActiveResourcesInfo().includes('TCPServerWrap'));
    server.unref();
    assert.equal(process.getActiveResourcesInfo().includes('TCPServerWrap'), false);
    server.ref();
    socket = net.connect(server.address().port, '127.0.0.1');
    const connected = once(socket, 'connect');
    const closed = once(socket, 'close');
    await new Promise(resolve => process.nextTick(resolve));
    assert.ok(process.getActiveResourcesInfo().includes('ConnectWrap'));
    socket.unref();
    assert.ok(process.getActiveResourcesInfo().includes('ConnectWrap'), 'requests remain live independently of socket reference state');
    socket.ref();
    await connected;
    socket.resume();
    await closed;
    // The listening handle's close delivery is distinct from a later server
    // close event delayed by live accepted sockets. Await both peers explicitly.
    await acceptedClosed;
    await turn();
    assert.equal(process.getActiveResourcesInfo().includes('ConnectWrap'), false);
  } finally {
    socket?.destroy();
    await new Promise((resolve, reject) => server.close(() => {
      try {
        assert.ok(process.getActiveResourcesInfo().includes('TCPServerWrap'), 'server owner remains referenced through close callback delivery');
        resolve();
      } catch (error) { reject(error); }
    }));
  }
}
function reports(root) {
  const report = process.report;
  const error = Object.assign(new Error('diagnostic boundary'), { code: 'TEST_REPORT', detail: 17 });
  const first = report.getReport(error);
  assert.equal(first.header.processId, process.pid);
  assert.equal(first.header.cwd, process.cwd());
  assert.equal(first.header.filename, null);
  assert.match(first.javascriptStack.message, /diagnostic boundary/);
  assert.equal(first.javascriptStack.errorProperties.code, 'TEST_REPORT');
  assert.equal(first.javascriptStack.errorProperties.detail, '17');
  assert.ok(first.resourceUsage.rss > 0);
  assert.ok(first.resourceUsage.total_memory >= first.resourceUsage.free_memory);
  assert.ok(first.javascriptHeap.usedMemory > 0);
  assert.ok(first.userLimits.open_files.soft > 0 || first.userLimits.open_files.soft === 'unlimited');
  first.header.commandLine.push('not-a-real-argument');
  assert.equal(report.getReport().header.commandLine.includes('not-a-real-argument'), false);
  for (const value of [null, 1, [], () => {}]) assert.throws(() => report.getReport(value), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.throws(() => { report.compact = 1; }, { code: 'ERR_INVALID_ARG_TYPE' });
  assert.throws(() => { report.signal = 'SIG_NOT_REAL'; }, { code: 'ERR_UNKNOWN_SIGNAL' });
  assert.throws(() => report.writeReport('bad\0path'), { code: 'ERR_INVALID_ARG_VALUE' });
  report.excludeEnv = true;
  report.excludeNetwork = true;
  const filtered = report.getReport();
  assert.equal(Object.hasOwn(filtered, 'environmentVariables'), false);
  assert.equal(Object.hasOwn(filtered.header, 'networkInterfaces'), false);
  report.directory = root;
  report.compact = true;
  assert.equal(report.writeReport('manual.json', error), 'manual.json');
  const written = fs.readFileSync(path.join(root, 'manual.json'), 'utf8');
  assert.equal(written.trim().split('\n').length, 1);
  assert.equal(JSON.parse(written).javascriptStack.errorProperties.code, 'TEST_REPORT');
  assert.equal(report.writeReport('missing-parent/report.json'), '');
  const signalFile = path.join(root, 'signal.json');
  child(`
    process.report.filename = ${JSON.stringify(signalFile)};
    process.report.reportOnSignal = true;
    const deadline = setTimeout(() => { throw new Error('signal report was not delivered'); }, 5000);
    process.once(process.report.signal, () => {
      clearTimeout(deadline);
      const report = JSON.parse(require('node:fs').readFileSync(${JSON.stringify(signalFile)}, 'utf8'));
      require('node:assert/strict').equal(report.header.trigger, 'Signal');
      process.report.reportOnSignal = false;
    });
    process.kill(process.pid, process.report.signal);
  `);
  const stdio = child(`process.report.compact = true; process.report.writeReport('stdout'); console.log('stdio-still-open');`);
  const lines = stdio.trim().split('\n');
  assert.equal(JSON.parse(lines[0]).header.filename, 'stdout');
  assert.equal(lines[1], 'stdio-still-open');
  const uncaughtFile = path.join(root, 'uncaught.json');
  const uncaught = spawnSync(process.execPath, ['-e', `
    process.report.filename = ${JSON.stringify(uncaughtFile)};
    process.report.reportOnUncaughtException = true;
    setImmediate(() => { throw new Error('unhandled-diagnostic'); });
  `], { encoding: 'utf8', timeout: 20000, env: { ...process.env, NODE_OPTIONS: '' } });
  if (uncaught.error) throw uncaught.error;
  assert.equal(uncaught.status, 1);
  assert.match(JSON.parse(fs.readFileSync(uncaughtFile, 'utf8')).javascriptStack.message, /unhandled-diagnostic/);
  const handledFile = path.join(root, 'handled.json');
  child(`
    process.report.filename = ${JSON.stringify(handledFile)};
    process.report.reportOnUncaughtException = true;
    process.on('uncaughtException', () => console.log('handled'));
    setImmediate(() => { throw new Error('handled-diagnostic'); });
  `);
  assert.equal(fs.existsSync(handledFile), false);
}
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'process-diagnostics-'));
  try {
    protocol();
    lifecycle();
    await resources(root);
    await requestResources();
    reports(root);
    console.log('Process diagnostics smoke passed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
