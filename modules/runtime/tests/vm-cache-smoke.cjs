'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const source = `(function compute() {
  if (fail) throw new Error('cached execution');
  globalThis.calls = (globalThis.calls || 0) + 1;
  return { total: [2, 3, 5].reduce((a, b) => a + b, bonus), match: /a+/u.test('aaa'), calls };
})()`;
const body = 'return base + offset + value';
const debugSource = `function cachedDebug(argument) {
  let local = 40;
  debugger;
  return local + argument;
}
cachedDebug(2);`;
function produce(directory) {
  const script = new vm.Script(source, { filename: 'producer.js', lineOffset: 7, columnOffset: 9 });
  fs.writeFileSync(path.join(directory, 'script.cache'), script.createCachedData());
  const fn = vm.compileFunction(body, ['value'], {
    filename: 'producer-function.js', parsingContext: vm.createContext({ base: 1 }),
    contextExtensions: [{ offset: 2 }], produceCachedData: true,
  });
  assert.equal(fn(3), 6);
  fs.writeFileSync(path.join(directory, 'function.cache'), fn.cachedData);
  fs.writeFileSync(path.join(directory, 'debug.cache'),
    new vm.Script(debugSource, { filename: 'debug-producer.js' }).createCachedData());
}
function checkScript(cache, expectedRejected = false) {
  const script = new vm.Script(source, {
    filename: 'consumer.js', lineOffset: 3, columnOffset: 5, cachedData: cache,
  });
  assert.equal(script.cachedDataRejected, expectedRejected, 'script cachedData admission');
  const context = vm.createContext({ bonus: 7, fail: false }, { codeGeneration: { strings: false } });
  const result = script.runInContext(context);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { total: 17, match: true, calls: 1 });
  assert.equal(script.runInContext(context).calls, 2);
  context.fail = true;
  assert.throws(() => script.runInContext(context), error => {
    assert.match(error.stack, /consumer\.js:5:/);
    assert.equal(error.stack.includes('producer.js'), false);
    return error.message === 'cached execution';
  });
  return script;
}
function consume(directory, mode) {
  const cache = fs.readFileSync(path.join(directory, 'script.cache'));
  // A live V8 compilation can bypass cachedData inspection altogether. Each
  // rejection case therefore runs in its own process, before any compilation.
  if (mode === 'corrupt') { checkScript(Buffer.alloc(cache.length), true); return; }
  if (mode === 'truncated') { checkScript(cache.subarray(0, 1), true); return; }
  if (mode === 'detached') {
    const detached = new Uint8Array(cache);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    checkScript(detached, true);
    return;
  }
  if (mode === 'changed') {
    const changed = new vm.Script(source + '\n', { cachedData: cache });
    assert.equal(changed.cachedDataRejected, true);
    assert.equal(changed.runInNewContext({ bonus: 2, fail: false }).total, 12);
    return;
  }
  checkScript(Buffer.from(cache));
  const padded = new Uint8Array(cache.length + 32);
  padded.set(cache, 13);
  checkScript(new DataView(padded.buffer, 13, cache.length));
  for (const view of [new Uint8Array(cache), new DataView(padded.buffer, 13, cache.length)]) {
    for (const name of ['buffer', 'byteOffset', 'byteLength'])
      Object.defineProperty(view, name, { get() { throw new Error('cache must use intrinsic view bounds'); } });
    checkScript(view);
  }
  const shared = new Uint8Array(new SharedArrayBuffer(cache.length));
  shared.set(cache);
  const fromShared = checkScript(shared);
  shared.fill(0);
  assert.equal(fromShared.runInNewContext({ bonus: 30, fail: false }).total, 40);

  const extension = { offset: 11 };
  const realm = vm.createContext({ base: 31 });
  const fn = vm.compileFunction(body, ['value'], {
    filename: 'consumer-function.js', parsingContext: realm,
    contextExtensions: [extension], cachedData: fs.readFileSync(path.join(directory, 'function.cache')),
    produceCachedData: true,
  });
  assert.equal(fn.cachedDataRejected, false, 'compileFunction cachedData admission');
  assert.equal(fn(3), 45);
  extension.offset = 20;
  realm.base = 40;
  assert.equal(fn(3), 63);
  assert.equal(fn.cachedDataProduced, true);
  const again = vm.compileFunction(body, ['value'], {
    parsingContext: vm.createContext({ base: 100 }), contextExtensions: [{ offset: 1 }],
    cachedData: Buffer.from(fn.cachedData),
  });
  assert.equal(again.cachedDataRejected, false, 'regenerated compileFunction cachedData admission');
  assert.equal(again(4), 105);
  const inspector = require('node:inspector');
  const session = new inspector.Session();
  let pauses = 0, pauseError;
  session.connect();
  const command = (method, params = {}) => {
    let complete = false, failure, result;
    session.post(method, params, (error, response) => { complete = true; failure = error; result = response; });
    assert.equal(complete, true);
    assert.ifError(failure);
    return result;
  };
  session.on('Debugger.paused', ({ params }) => {
    try {
      pauses++;
      const frame = params.callFrames[0];
      assert.equal(frame.functionName, 'cachedDebug');
      assert.equal(command('Debugger.evaluateOnCallFrame', {
        callFrameId: frame.callFrameId, expression: 'local = 50', returnByValue: true,
      }).result.value, 50);
    } catch (error) { pauseError = error; }
    finally { command('Debugger.resume'); }
  });
  try {
    command('Debugger.enable');
    const debugScript = new vm.Script(debugSource, {
      filename: 'debug-consumer.js', cachedData: fs.readFileSync(path.join(directory, 'debug.cache')),
    });
    assert.equal(debugScript.cachedDataRejected, false, 'debugger cachedData admission');
    assert.equal(debugScript.runInNewContext(), 52);
    assert.ifError(pauseError);
    assert.equal(pauses, 1);
  } finally { session.disconnect(); }
}
if (process.argv[2] === 'produce') produce(process.argv[3]);
else if (process.argv[2]) consume(process.argv[3], process.argv[2]);
else {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-cache-'));
  try {
    for (const mode of ['produce', 'consume', 'corrupt', 'truncated', 'detached', 'changed']) {
      const result = spawnSync(process.execPath, [__filename, mode, directory], {
        encoding: 'utf8', timeout: 20000, env: { ...process.env, NODE_OPTIONS: '' },
      });
      if (result.error) throw result.error;
      assert.equal(result.status, 0, `${mode}: ${result.stdout}\n${result.stderr}`);
    }
    console.log('Fresh-process VM caches, backing ownership, diagnostics and realm binding smoke passed');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
