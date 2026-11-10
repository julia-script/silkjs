'use strict';
// Compile the sibling .wat files to .wasm with wat2wasm before running this file.
// Run with --exit-host in a separate runtime process; its exit status must be 23.
// This driver never launches another JS or WebAssembly implementation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WASI } = require('node:wasi');
function guest(name, wasi) {
  const bytes = fs.readFileSync(path.join(__dirname, `${name}.wasm`));
  return new WebAssembly.Instance(new WebAssembly.Module(bytes), wasi.getImportObject());
}
function started(wasi, instance) {
  assert.throws(() => wasi.start(instance), { code: 'ERR_WASI_ALREADY_STARTED' });
  assert.throws(() => wasi.initialize(instance), { code: 'ERR_WASI_ALREADY_STARTED' });
}
if (process.argv.includes('--exit-host')) {
  const wasi = new WASI({ version: 'preview1', returnOnExit: false });
  wasi.start(guest('exit', wasi));
  throw new Error('proc_exit returned instead of terminating the process');
}
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'silk-wasi-'));
try {
  assert.throws(() => new WASI(), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.throws(() => new WASI({ version: 'preview2' }), { code: 'ERR_INVALID_ARG_VALUE' });
  for (const fd of [-1, 2147483648, 1.5]) assert.throws(() => new WASI({ version: 'preview1', stdin: fd }), { code: 'ERR_OUT_OF_RANGE' });
  const unstable = new WASI({ version: 'unstable' });
  assert.deepEqual(Object.keys(unstable.getImportObject()), ['wasi_unstable']);

  const args = new WASI({ version: 'preview1', args: ['guest', 'hello'], env: { TEST: 'value', OMIT: undefined } });
  const argsInstance = guest('args-env', args);
  assert.equal(args.start(argsInstance), 0);
  started(args, argsInstance);

  fs.writeFileSync(path.join(directory, 'input'), 'input');
  const stdin = fs.openSync(path.join(directory, 'input'), 'r');
  const stdout = fs.openSync(path.join(directory, 'output'), 'w');
  const stderr = fs.openSync(path.join(directory, 'error'), 'w');
  const stdio = new WASI({ version: 'preview1', stdin, stdout, stderr });
  try {
    assert.equal(stdio.start(guest('stdio', stdio)), 0);
    assert.equal(fs.readFileSync(path.join(directory, 'output'), 'utf8'), 'input');
    assert.equal(fs.readFileSync(path.join(directory, 'error'), 'utf8'), 'input');
  } finally {
    fs.closeSync(stdin); fs.closeSync(stdout); fs.closeSync(stderr);
  }

  const preopen = new WASI({ version: 'preview1', preopens: { '/sandbox': directory } });
  assert.equal(preopen.start(guest('preopen', preopen)), 0);
  assert.equal(fs.existsSync(path.join(directory, 'wasi-smoke.txt')), false);
  assert.equal(fs.existsSync(path.join(directory, 'subdir')), false);

  const invalid = new WASI({ version: 'preview1' });
  assert.equal(invalid.start(guest('invalid-pointers', invalid)), 0);
  const exits = new WASI({ version: 'preview1' });
  const exitInstance = guest('exit', exits);
  assert.equal(exits.start(exitInstance), 23);
  started(exits, exitInstance);

  for (const name of ['reactor', 'empty-reactor']) {
    const reactor = new WASI({ version: 'preview1' });
    const instance = guest(name, reactor);
    assert.equal(reactor.initialize(instance), undefined);
    if (name === 'reactor') assert.equal(new DataView(instance.exports.memory.buffer).getUint32(0, true), 42);
    started(reactor, instance);
  }
  // All lifecycle probes use a real executor-owned Memory, never a mock.
  const memory = new WebAssembly.Memory({ initial: 1 });
  const original = new Error('original guest import error');
  const throws = new WASI({ version: 'preview1' });
  assert.throws(() => throws.start({ exports: { memory, _start() { throw original; } } }), e => e === original);
  const badExport = new WASI({ version: 'preview1' });
  const malformed = { exports: { memory } };
  assert.throws(() => badExport.start(malformed), { code: 'ERR_INVALID_ARG_TYPE' });
  started(badExport, malformed);
  const badMemory = new WASI({ version: 'preview1' });
  assert.throws(() => badMemory.start({ exports: { memory: { buffer: new ArrayBuffer(65536) }, _start() {} } }), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.equal(badMemory.start({ exports: { memory, _start() {} } }), 0);
  const hiddenBuffer = new WebAssembly.Memory({ initial: 1 });
  Object.defineProperty(hiddenBuffer, 'buffer', { get() { throw new Error('user buffer getter must not run'); } });
  const branded = new WASI({ version: 'preview1', args: ['guest'] });
  assert.equal(branded.start({ exports: { memory: hiddenBuffer, _start() { assert.equal(branded.wasiImport.args_sizes_get(0, 4), 0); } } }), 0);
  console.log('WASI guest and lifecycle smoke fixtures passed');
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
