'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Worker, isMainThread, parentPort } = require('node:worker_threads');

const mode = process.argv[2];
const file = process.argv[3];
const flag = '--experimental-webstorage';
function childMode(mode, file, flags = [flag, `--localstorage-file=${file}`]) {
  const result = spawnSync(process.execPath, [...flags, __filename, mode, file || ''], {
    encoding: 'utf8', timeout: 30000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${mode}: ${result.stdout}\n${result.stderr}`);
  return result;
}
function writer(file, prefix) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [flag, `--localstorage-file=${file}`, __filename, 'concurrent', prefix], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`writer ${prefix}: ${code}: ${stderr}`)));
  });
}
function propertyChecks(s) {
  assert.equal(s instanceof Storage, true);
  assert.equal(Object.getPrototypeOf(s), Storage.prototype);
  assert.equal(Object.prototype.toString.call(s), '[object Object]');
  assert.throws(() => new Storage(), { code: 'ERR_ILLEGAL_CONSTRUCTOR' });
  assert.equal(require('node:util').types.isProxy(s), false);
  assert.throws(() => structuredClone(s), { name: 'DataCloneError' });
  assert.throws(() => Storage(), { code: 'ERR_ILLEGAL_CONSTRUCTOR' });
  for (const name of ['getItem', 'setItem', 'removeItem', 'key', 'clear']) {
    assert.equal(Storage.prototype[name].length, 0);
    assert.throws(() => Storage.prototype[name].call({}), { name: 'TypeError', message: 'Illegal invocation' });
    if (name !== 'clear') assert.throws(() => s[name](), { code: 'ERR_MISSING_ARGS' });
  }
  assert.throws(() => Object.getOwnPropertyDescriptor(Storage.prototype, 'length').get.call({}), { name: 'TypeError' });
  assert.deepEqual(Object.keys(Storage.prototype), ['length', 'clear', 'getItem', 'key', 'removeItem', 'setItem']);
  assert.equal(Object.getOwnPropertyDescriptor(Storage.prototype, 'length').configurable, false);
  s.clear();
  assert.equal(s.getItem('missing'), null);
  assert.equal(s.missing, undefined);
  assert.equal('missing' in s, false);
  s.setItem(undefined, null);
  assert.equal(s.undefined, 'null');
  const calls = [];
  s.setItem({ toString() { calls.push('key'); return 'coerced'; } }, { toString() { calls.push('value'); return 'value'; } });
  assert.deepEqual(calls, ['key', 'value']);
  assert.equal(s.coerced, 'value');
  assert.throws(() => s.setItem(Symbol(), 1), TypeError);
  assert.throws(() => s.setItem('symbol', Symbol()), TypeError);
  s.setItem('\ud800\0', '\udfff\0');
  assert.equal(s.getItem('\ud800\0'), '\udfff\0');
  s.setItem('', '');
  assert.equal(s.getItem(''), '');
  s.clear();
  for (const key of ['z', 'a', '10', '2', 'length', 'getItem', '__proto__', 'constructor']) s[key] = key;
  assert.equal(s.length, 8);
  assert.equal(typeof s.getItem, 'function');
  assert.equal(s.getItem('getItem'), 'getItem');
  assert.equal(s.getItem('length'), 'length');
  assert.equal(s.__proto__, Storage.prototype);
  assert.equal(s.constructor, Storage);
  const names = ['10', '2', '__proto__', 'a', 'constructor', 'getItem', 'length', 'z'];
  assert.deepEqual(Reflect.ownKeys(s), names);
  assert.deepEqual(Object.keys(s), ['10', '2', 'a', 'z']);
  assert.deepEqual(names.map((_, i) => s.key(i)), names);
  assert.equal(s.key(-1), null);
  assert.equal(s.key(0x100000000), '10');
  assert.equal(s.key(NaN), '10');
  assert.equal(s.key(1.9), '2');
  assert.throws(() => s.key(1n), TypeError);
  assert.equal(Object.getOwnPropertyDescriptor(s, 'length'), undefined);
  assert.deepEqual(Object.getOwnPropertyDescriptor(s, 'a'), { value: 'a', writable: true, configurable: true, enumerable: true });
  assert.equal(Reflect.defineProperty(s, 'defined', { value: 7, configurable: false, writable: false, enumerable: false }), true);
  assert.deepEqual(Object.getOwnPropertyDescriptor(s, 'defined'), { value: '7', writable: true, configurable: true, enumerable: true });
  Object.defineProperty(s, 'accessor', { get() { throw new Error('Storage must ignore accessors'); } });
  assert.equal(s.accessor, undefined);
  assert.equal(s.getItem('accessor'), null);
  Object.defineProperty(s, 'a', { writable: false });
  s.a = 'changed';
  assert.equal(s.a, 'changed');
  delete s.length;
  assert.equal(s.getItem('length'), null);
  assert.equal(typeof s.length, 'number');
  const symbol = Symbol('private');
  const payload = {};
  s[symbol] = payload;
  assert.equal(s[symbol], payload);
  assert.equal(Reflect.ownKeys(s).includes(symbol), false);
  const absentSymbol = Symbol('absent');
  assert.equal(absentSymbol in s, true);
  assert.deepEqual(Object.getOwnPropertyDescriptor(s, absentSymbol), { value: undefined, writable: true, enumerable: true, configurable: true });
  s[symbol] = null;
  assert.equal(s[symbol], undefined);
  assert.equal(symbol in s, false);
  s[symbol] = payload;
  s.clear();
  assert.equal(s[symbol], payload);
  assert.equal(s.length, 0);
  assert.equal(Reflect.preventExtensions(s), false);
  assert.equal(Object.isExtensible(s), true);
  assert.throws(() => Object.freeze(s), TypeError);
}
function quotaChecks(s) {
  s.clear();
  s.setItem('k', 'x'.repeat(5242879));
  const quota = { name: 'QuotaExceededError', code: 22, message: 'Setting the value exceeded the quota' };
  assert.throws(() => s.setItem('z', ''), quota);
  assert.throws(() => { s.k += 'x'; }, quota);
  assert.equal(s.length, 1);
  assert.equal(s.k.length, 5242879);
  s.k = 'short';
  s.z = '';
  assert.equal(s.length, 2);
  s.removeItem('k');
  s.removeItem('z');
  s.setItem('', 'x'.repeat(5242880));
  assert.throws(() => s.setItem('k', ''), quota);
  s.clear();
  assert.equal(s.length, 0);
}
async function main() {
  if (!isMainThread) {
    assert.equal(sessionStorage.getItem('main'), null);
    assert.equal(localStorage.getItem('main'), 'persistent');
    sessionStorage.main = 'worker-session';
    localStorage.worker = 'worker-persistent';
    parentPort.postMessage('ok');
    return;
  }
  if (mode === 'disabled') {
    for (const name of ['Storage', 'localStorage', 'sessionStorage']) assert.equal(name in globalThis, false);
    return;
  }
  if (mode === 'no-access') {
    assert.equal('Storage' in globalThis, true);
    assert.equal('localStorage' in globalThis, true);
    return;
  }
  if (mode === 'metadata') {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Storage');
    assert.equal(typeof descriptor.value, 'function');
    assert.equal(descriptor.writable, true);
    assert.equal(descriptor.configurable, true);
    assert.equal(descriptor.enumerable, false);
    assert.equal(descriptor.value, Storage);
    return;
  }
  if (mode === 'override') {
    Storage = 9;
    assert.equal(Storage, 9);
    sessionStorage = undefined;
    localStorage = 7;
    assert.equal(sessionStorage, undefined);
    assert.equal(localStorage, 7);
    return;
  }
  if (mode === 'missing') {
    assert.throws(() => localStorage, { code: 'ERR_INVALID_ARG_VALUE' });
    assert.equal(sessionStorage.length, 0);
    return;
  }
  if (mode === 'bad-path') {
    const s = localStorage;
    assert.equal(s.key(-1), null);
    assert.throws(() => s.length, { code: 'ERR_INVALID_STATE' });
    assert.throws(() => s.getItem('a'), { code: 'ERR_INVALID_STATE' });
    return;
  }
  if (mode === 'persist-read') {
    assert.equal(localStorage.getItem('main'), 'persistent');
    assert.equal(localStorage.worker, 'worker-persistent');
    assert.equal(sessionStorage.getItem('main'), null);
    localStorage.child = 'child-persistent';
    return;
  }
  if (mode === 'concurrent') {
    assert.equal(sessionStorage.length, 0);
    for (let i = 0; i < 32; i++) localStorage.setItem(`${file}:${i}`, `${i}`);
    return;
  }
  if (mode === 'exercise') {
    const warnings = [];
    process.on('warning', warning => warnings.push(warning));
    assert.equal(fs.existsSync(file), false);
    const s = localStorage;
    assert.equal(fs.existsSync(file), false, 'reading the global must not open SQLite');
    const C = Storage;
    assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'Storage'), { value: C, writable: true, configurable: true, enumerable: false });
    for (const name of ['localStorage', 'sessionStorage']) {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
      assert.equal(descriptor.enumerable, true);
      assert.equal(descriptor.configurable, true);
      assert.equal(typeof descriptor.get, 'function');
      assert.equal(typeof descriptor.set, 'function');
    }
    propertyChecks(s);
    propertyChecks(sessionStorage);
    quotaChecks(s);
    quotaChecks(sessionStorage);
    s.main = 'persistent';
    sessionStorage.main = 'main-session';
    const worker = new Worker(__filename);
    let message;
    worker.on('message', value => { message = value; });
    await new Promise((resolve, reject) => {
      worker.on('error', reject);
      worker.on('exit', code => code === 0 ? resolve() : reject(new Error(`worker exit ${code}`)));
    });
    assert.equal(message, 'ok');
    assert.equal(s.worker, 'worker-persistent');
    assert.equal(sessionStorage.main, 'main-session');
    childMode('persist-read', file);
    assert.equal(s.child, 'child-persistent', 'already-open connection must observe another process');
    await Promise.all([writer(file, 'left'), writer(file, 'right')]);
    for (let i = 0; i < 32; i++) {
      assert.equal(s.getItem(`left:${i}`), `${i}`);
      assert.equal(s.getItem(`right:${i}`), `${i}`);
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(warnings.filter(w => w.name === 'ExperimentalWarning' && /Web Storage/.test(w.message)).length, 1);
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'silk-webstorage-'));
  try {
    const database = path.join(root, 'storage.sqlite');
    childMode('disabled', '', []);
    // These standalone programs isolate capture/declaration from a property read.
    // An unused closure must not initialize a lazy global before its body runs.
    for (const source of [
      'const unused = () => Storage;',
      'const read = () => Storage; Storage = 9; require("node:assert/strict").equal(read(), 9);',
      'require("node:vm").runInThisContext("var Storage;");',
      'require("node:vm").runInThisContext("function Storage() { return 9; }"); require("node:assert/strict").equal(Storage(), 9);',
    ]) {
      const lazy = spawnSync(process.execPath, [flag, '-e', source], { encoding: 'utf8', timeout: 30000 });
      if (lazy.error) throw lazy.error;
      assert.equal(lazy.status, 0, `${source}: ${lazy.stdout}\n${lazy.stderr}`);
      assert.equal(lazy.stderr.includes('Web Storage'), false, source);
    }
    assert.equal(childMode('no-access', '', [flag]).stderr.includes('Web Storage'), false);
    assert.equal(childMode('override', '', [flag]).stderr.includes('Web Storage'), false);
    assert.equal(childMode('metadata', '', [flag]).stderr.includes('Web Storage'), true);
    childMode('missing', '', [flag]);
    const emptyFlag = spawnSync(process.execPath, [flag, '--localstorage-file=', '-e', 'throw new Error("must not execute")'], { encoding: 'utf8', timeout: 30000 });
    assert.equal(emptyFlag.status, 9);
    childMode('bad-path', path.join(root, 'missing', 'storage.sqlite'));
    const invalid = path.join(root, 'invalid.sqlite');
    fs.writeFileSync(invalid, 'not a sqlite database');
    childMode('bad-path', invalid);
    childMode('exercise', database);
    childMode('persist-read', database);
    assert.equal(fs.readFileSync(database).subarray(0, 16).toString(), 'SQLite format 3\0');
    console.log('Web Storage persistence, properties, quota, workers and concurrent processes smoke passed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
