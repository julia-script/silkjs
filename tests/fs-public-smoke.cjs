'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');
const { pathToFileURL } = require('node:url');
const { Worker, isMainThread, workerData, parentPort } = require('node:worker_threads');

const sorted = values => values.slice().sort();
const collect = async iterable => { const values = []; for await (const value of iterable) values.push(value); return values; };
const finish = stream => { const closed = once(stream, 'close'); stream.end(); return closed; };
const flush = stream => new Promise((resolve, reject) => stream.flush(error => error ? reject(error) : resolve()));

async function globChecks(root) {
  const cwd = path.join(root, 'glob');
  fs.mkdirSync(path.join(cwd, 'sub'), { recursive: true });
  for (const file of ['a.txt', '.hidden', 'sub/b.txt', 'sub/c.js']) fs.writeFileSync(path.join(cwd, file), file);
  fs.symlinkSync('sub', path.join(cwd, 'link'));
  fs.symlinkSync('missing', path.join(cwd, 'broken'));
  assert.deepEqual(sorted(fs.globSync('*', { cwd })), ['a.txt', 'broken', 'link', 'sub']);
  assert.deepEqual(sorted(fs.globSync('**/*.txt', { cwd })), ['a.txt', 'sub/b.txt']);
  assert.deepEqual(sorted(fs.globSync(['*.txt', '**/*.txt'], { cwd })), ['a.txt', 'sub/b.txt']);
  assert.deepEqual(sorted(fs.globSync('{a,sub/b}.txt', { cwd })), ['a.txt', 'sub/b.txt']);
  assert.deepEqual(sorted(fs.globSync('sub/?.[jt]s', { cwd })), ['sub/c.js']);
  assert.deepEqual(fs.globSync('.*', { cwd }), ['.hidden']);
  assert.deepEqual(sorted(fs.globSync('link/*', { cwd })), ['link/b.txt', 'link/c.js']);
  assert.deepEqual(sorted(fs.globSync('**/*.txt', { cwd, followSymlinks: true })), ['a.txt', 'link/b.txt', 'sub/b.txt']);
  fs.symlinkSync('..', path.join(cwd, 'sub', 'loop'));
  const followed = fs.globSync('**/*.txt', { cwd, followSymlinks: true });
  assert.deepEqual(sorted(followed), ['a.txt', 'link/b.txt', 'sub/b.txt']);
  assert.deepEqual(fs.globSync('sub/', { cwd }), ['sub']);
  assert.deepEqual(fs.globSync('missing/**/*', { cwd }), []);
  assert.deepEqual(fs.globSync(path.join(cwd, '*.txt')), [path.join(cwd, 'a.txt')]);
  assert.deepEqual(fs.globSync('*.txt', { cwd: pathToFileURL(cwd + path.sep) }), ['a.txt']);
  assert.deepEqual(sorted(fs.globSync('**/*.txt', { cwd, exclude: ['sub/**'] })), ['a.txt']);
  assert.deepEqual(sorted(fs.globSync('**/*.txt', { cwd, exclude: name => name === 'sub' })), ['a.txt']);
  const entries = fs.globSync('*', { cwd, withFileTypes: true });
  assert(entries.every(entry => entry instanceof fs.Dirent && entry.parentPath === cwd));
  assert(entries.find(entry => entry.name === 'link').isSymbolicLink());
  assert(entries.find(entry => entry.name === 'sub').isDirectory());
  assert(entries.find(entry => entry.name === 'a.txt').isFile());
  const filtered = fs.globSync('**/*.txt', { cwd, withFileTypes: true, exclude: entry => entry.name === 'sub' });
  assert.deepEqual(filtered.map(entry => entry.name), ['a.txt']);
  let synchronous = true;
  const callbackResult = new Promise((resolve, reject) => fs.glob('**/*.txt', { cwd }, (error, files) => {
    assert.equal(synchronous, false);
    if (error) reject(error); else resolve(files);
  }));
  synchronous = false;
  assert.deepEqual(sorted(await callbackResult), ['a.txt', 'sub/b.txt']);
  assert.deepEqual(sorted(await collect(fs.promises.glob('**/*.txt', { cwd }))), ['a.txt', 'sub/b.txt']);
  const iterator = fs.promises.glob('**/*', { cwd });
  assert.equal(iterator[Symbol.asyncIterator](), iterator);
  assert.equal((await iterator.next()).done, false);
  assert.equal((await iterator.return()).done, true);
  assert.equal((await iterator.next()).done, true);
  const neverStarted = fs.promises.glob('**/*', { cwd });
  await neverStarted.return();
  assert.equal((await neverStarted.next()).done, true);
  assert.throws(() => fs.globSync(4), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.throws(() => fs.globSync('*', { exclude: 'sub' }), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.throws(() => fs.glob('*', { cwd }), { code: 'ERR_INVALID_ARG_TYPE' });
  await assert.rejects(fs.promises.glob(4).next(), { code: 'ERR_INVALID_ARG_TYPE' });
}

async function blobChecks(root) {
  const file = path.join(root, 'blob');
  fs.writeFileSync(file, 'abcdef');
  const blob = await fs.openAsBlob(pathToFileURL(file), { type: 'TeXT/Plain' });
  assert(blob instanceof Blob);
  assert.equal(blob.size, 6);
  assert.equal(blob.type, 'TeXT/Plain');
  assert.equal(await blob.text(), 'abcdef');
  assert.equal(await blob.text(), 'abcdef');
  assert.deepEqual(Array.from(await blob.bytes()), [97, 98, 99, 100, 101, 102]);
  assert.deepEqual(Array.from(new Uint8Array(await blob.arrayBuffer())), [97, 98, 99, 100, 101, 102]);
  assert.equal(await blob.slice(-4, -1, 'TEXT/X').text(), 'cde');
  assert.equal(blob.slice(0, 1, 'TEXT/X').type, 'text/x');
  assert.throws(() => structuredClone(blob), { name: 'TypeError', code: 'ERR_INVALID_STATE' });
  assert.throws(() => new Worker(__filename, { workerData: { blob } }), { name: 'TypeError', code: 'ERR_INVALID_STATE' });
  const slice = structuredClone(blob.slice(1, 4));
  const compound = structuredClone(new Blob(['[', blob, ']']));
  assert.equal(await slice.text(), 'bcd');
  assert.equal(await compound.text(), '[abcdef]');
  assert.equal(await structuredClone(blob.slice(0, 0)).text(), '');
  const byob = blob.stream().getReader({ mode: 'byob' });
  assert.deepEqual(Array.from((await byob.read(new Uint8Array(3))).value), [97, 98, 99]);
  await byob.cancel();
  assert.equal(await blob.text(), 'abcdef');
  fs.writeFileSync(file, 'changed size');
  for (const value of [blob, slice, compound]) await assert.rejects(value.text(), { name: 'NotReadableError' });
  // Cloning is metadata-only, even after the file has become unreadable.
  const afterMutation = structuredClone(blob.slice(1));
  await assert.rejects(afterMutation.bytes(), { name: 'NotReadableError' });
  for (const operation of ['rename', 'unlink', 'replace']) {
    const source = path.join(root, 'blob-' + operation);
    fs.writeFileSync(source, 'initial');
    const value = await fs.openAsBlob(source);
    if (operation === 'rename') fs.renameSync(source, source + '-moved');
    else fs.unlinkSync(source);
    if (operation === 'replace') fs.writeFileSync(source, 'different length');
    await assert.rejects(value.text(), { name: 'NotReadableError' });
  }
  // Node compares only size and the nanosecond component of mtime.
  fs.writeFileSync(file, 'abcdef'); fs.utimesSync(file, 1000, 1000);
  const restored = await fs.openAsBlob(file);
  fs.unlinkSync(file); fs.writeFileSync(file, 'ghijkl'); fs.utimesSync(file, 1000, 1001);
  assert.equal(await restored.text(), 'ghijkl');
  const large = path.join(root, 'blob-large');
  fs.writeFileSync(large, Buffer.alloc(200000, 97));
  const largeBlob = await fs.openAsBlob(large);
  const reader = largeBlob.stream().getReader();
  assert.equal((await reader.read()).value.length, 65536);
  fs.renameSync(large, large + '-moved');
  assert.equal((await reader.read()).value.length, 65536);
  await reader.cancel();
  await assert.rejects(largeBlob.text(), { name: 'NotReadableError' });
  const mutablePath = path.join(root, 'blob-mutable');
  fs.writeFileSync(mutablePath, Buffer.alloc(200000, 97));
  const mutable = await fs.openAsBlob(mutablePath);
  const mutableReader = mutable.stream().getReader();
  await mutableReader.read();
  fs.truncateSync(mutablePath, 1);
  await assert.rejects(mutableReader.read(), { name: 'NotReadableError' });
  const cancelBlob = await fs.openAsBlob(large + '-moved');
  for (let index = 0; index < 64; index++) {
    const cancelled = cancelBlob.stream().getReader();
    await cancelled.read();
    await cancelled.cancel();
  }
  const empty = path.join(root, 'blob-empty');
  fs.writeFileSync(empty, '');
  const emptyBlob = await fs.openAsBlob(empty);
  fs.writeFileSync(empty, 'x');
  await assert.rejects(emptyBlob.text(), { name: 'NotReadableError' });
  assert.equal(await emptyBlob.slice().text(), '');
  assert.throws(() => fs.openAsBlob(path.join(root, 'missing')), { code: 'ENOENT' });
  assert.throws(() => fs.openAsBlob(file, null), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.throws(() => fs.openAsBlob(file, { type: 1 }), { code: 'ERR_INVALID_ARG_TYPE' });
  // Node 24.22.2 aborts in FdEntry::get_reader on this worker path. Keep it
  // enabled by default; the reference run can explicitly omit only this case.
  if (!process.argv.includes('--skip-worker-blob')) {
    const worker = new Worker(__filename, { workerData: { blob: restored.slice(1, 4) } });
    const response = once(worker, 'message');
    const exited = once(worker, 'exit');
    assert.deepEqual((await response)[0], { text: 'hij', size: 3 });
    assert.equal((await exited)[0], 0);
  }
}

async function utf8Checks(root) {
  const first = path.join(root, 'utf8-first');
  const second = path.join(root, 'utf8-second');
  const stream = new fs.Utf8Stream({ dest: first, sync: true, minLength: 16, maxLength: 32, append: false, fsync: true });
  await once(stream, 'ready');
  assert.equal(stream.write('é'), true);
  assert.equal(fs.readFileSync(first, 'utf8'), '');
  stream.flushSync();
  assert.equal(fs.readFileSync(first, 'utf8'), 'é');
  let dropped;
  stream.once('drop', data => { dropped = data; });
  stream.write('z'.repeat(33));
  assert.equal(dropped, 'z'.repeat(33));
  assert.throws(() => stream.write(Buffer.from('x')), { code: 'ERR_INVALID_ARG_TYPE' });
  stream.write('one');
  await flush(stream);
  assert.equal(fs.readFileSync(first, 'utf8'), 'éone');
  const ready = once(stream, 'ready');
  stream.reopen(second);
  await ready;
  stream.write('two');
  const events = [];
  stream.on('finish', () => events.push('finish'));
  stream.on('close', () => events.push('close'));
  await finish(stream);
  assert.deepEqual(events, ['finish', 'close']);
  assert.equal(fs.readFileSync(second, 'utf8'), 'two');
  assert.equal(fs.readFileSync(first, 'utf8'), 'éone');
  for (const method of [() => stream.write('x'), () => stream.flushSync(), () => stream.reopen(), () => stream.end()]) assert.throws(method, { code: 'ERR_INVALID_STATE' });
  await assert.rejects(flush(stream), { code: 'ERR_INVALID_STATE' });
  stream.destroy();
  const asyncFile = path.join(root, 'utf8-async');
  const asynchronous = new fs.Utf8Stream({ dest: asyncFile, minLength: 8 });
  const drained = once(asynchronous, 'drain');
  assert.equal(asynchronous.write('x'.repeat(20000)), false);
  await drained;
  asynchronous.write('tail');
  await flush(asynchronous);
  await finish(asynchronous);
  assert.equal(fs.readFileSync(asyncFile, 'utf8'), 'x'.repeat(20000) + 'tail');
  const bufferFile = path.join(root, 'utf8-buffer');
  const bufferStream = new fs.Utf8Stream({ dest: bufferFile, contentMode: 'buffer', sync: true, minLength: 8 });
  await once(bufferStream, 'ready');
  assert.throws(() => bufferStream.write('x'), { code: 'ERR_INVALID_ARG_TYPE' });
  bufferStream.write(Buffer.from([0, 255, 42]));
  bufferStream.flushSync();
  await finish(bufferStream);
  assert.deepEqual(Array.from(fs.readFileSync(bufferFile)), [0, 255, 42]);
  const nested = new fs.Utf8Stream({ dest: path.join(root, 'nested', 'log'), mkdir: true });
  const nestedClosed = once(nested, 'close');
  nested.write('before-ready'); nested.end();
  await nestedClosed;
  assert.equal(fs.readFileSync(path.join(root, 'nested', 'log'), 'utf8'), 'before-ready');
  const borrowedFd = fs.openSync(path.join(root, 'fd-owned'), 'w');
  const borrowed = new fs.Utf8Stream({ fd: borrowedFd, sync: true });
  await once(borrowed, 'ready');
  assert.throws(() => borrowed.reopen(), { code: 'ERR_OPERATION_FAILED' });
  borrowed.write('owned');
  await finish(borrowed);
  assert.throws(() => fs.fstatSync(borrowedFd), { code: 'EBADF' });
  const discardedFile = path.join(root, 'discarded');
  const discarded = new fs.Utf8Stream({ dest: discardedFile, sync: true, minLength: 16 });
  await once(discarded, 'ready');
  discarded.write('discard');
  const discardedClosed = once(discarded, 'close'); discarded.destroy(); await discardedClosed;
  assert.equal(fs.readFileSync(discardedFile, 'utf8'), '');
  const recoveredFile = path.join(root, 'utf8-recovered');
  let failWrite = true;
  const recovered = new fs.Utf8Stream({
    dest: recoveredFile, minLength: 8,
    fs: { write(...args) {
      const callback = args.pop();
      if (failWrite) { failWrite = false; process.nextTick(callback, Object.assign(new Error('write failure'), { code: 'EIO' })); }
      else fs.write(...args, callback);
    } },
  });
  const writeErrors = [];
  recovered.on('error', error => writeErrors.push(error.code));
  await once(recovered, 'ready');
  recovered.write('data');
  await assert.rejects(flush(recovered), { code: 'EIO' });
  assert.equal(recovered.writing, false);
  await flush(recovered);
  await finish(recovered);
  assert.deepEqual(writeErrors, ['EIO']);
  assert.equal(fs.readFileSync(recoveredFile, 'utf8'), 'data');
  const failed = new fs.Utf8Stream({ dest: path.join(root, 'does-not-exist', 'log') });
  const [error] = await once(failed, 'error');
  assert.equal(error.code, 'ENOENT');
  assert.equal(failed.fd, -1);
  assert.equal(failed.writing, false);
  assert.throws(() => failed.flushSync(), { code: 'ERR_INVALID_STATE' });
  assert.throws(() => new fs.Utf8Stream(), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.throws(() => new fs.Utf8Stream({ dest: first, sync: 'yes' }), { code: 'ERR_INVALID_ARG_TYPE' });
}

async function main() {
  if (!isMainThread) {
    parentPort.postMessage({ text: await workerData.blob.text(), size: workerData.blob.size });
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'silk-fs-public-'));
  try {
    await globChecks(root);
    await blobChecks(root);
    await utf8Checks(root);
    console.log('Filesystem glob, lazy Blob, ownership and Utf8Stream contracts passed' +
      (process.argv.includes('--skip-worker-blob') ? ' (worker Blob omitted)' : ''));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
