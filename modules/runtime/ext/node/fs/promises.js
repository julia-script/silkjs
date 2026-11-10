'use strict';
const fs = require('fs');
const c = require('internal/fs_core');
const { EventEmitter } = require('events');
const promises = module.exports;
function invoke(name, args, requestKind = 1) { return new Promise((resolve, reject) => { fs[name](...args, c.promiseCallback((err, value) => err ? reject(err) : resolve(value), requestKind)); }); }
for (const name of ['access', 'appendFile', 'chmod', 'chown', 'copyFile', 'cp', 'lchmod', 'lchown', 'link', 'lstat', 'lutimes', 'mkdir', 'mkdtemp', 'readdir', 'readFile', 'readlink', 'realpath', 'rename', 'rm', 'rmdir', 'stat', 'statfs', 'symlink', 'truncate', 'unlink', 'utimes', 'writeFile']) promises[name] = (...args) => invoke(name, args);
// Node's directory API adapts the callback request rather than FSReqPromise.
promises.opendir = (...args) => invoke('opendir', args, 0);
promises.constants = fs.constants;
promises.glob = async function* glob(pattern, options) { yield* new (require('internal/fs_glob').Glob)(pattern, options).glob(); };
function badFd(operation) { return c.error('EBADF', operation); }
class FileHandle extends EventEmitter {
  constructor(fd) { super(); this._fd = fd; this._active = 0; this._closing = false; this._closePromise = null; this._finishClose = null; this._webStream = false; }
  get fd() { return this._fd; }
  _retain(operation) { if (this._fd < 0 || this._closing) throw badFd(operation); this._active++; return this._fd; }
  _release() { this._active--; if (this._active === 0 && this._finishClose) { const finish = this._finishClose; this._finishClose = null; finish(); } }
  _call(name, args, map) {
    return new Promise((resolve, reject) => {
      let fd; try { fd = this._retain(name); } catch (e) { reject(e); return; }
      try { fs[name](fd, ...args, c.promiseCallback((err, ...values) => { this._release(); if (err) reject(err); else { try { resolve(map ? map(values) : values[0]); } catch (e) { reject(e); } } })); }
      catch (e) { this._release(); reject(e); }
    });
  }
  close() {
    if (this._closePromise) return this._closePromise;
    if (this._fd < 0) return Promise.resolve();
    this._closing = true;
    this._closePromise = new Promise((resolve, reject) => {
      const finish = () => {
        const fd = this._fd; this._fd = -1;
        try { fs.close(fd, c.promiseCallback(err => { this.emit('close'); if (err) reject(err); else resolve(); }, 2)); }
        catch (e) { this.emit('close'); reject(e); }
      };
      if (this._active) this._finishClose = finish; else finish();
    });
    return this._closePromise;
  }
  appendFile(data, options) { return this._call('appendFile', [data, options]); }
  chmod(mode) { return this._call('fchmod', [mode]); }
  chown(uid, gid) { return this._call('fchown', [uid, gid]); }
  datasync() { return this._call('fdatasync', []); }
  read(...args) { return this._call('read', args, values => ({ bytesRead: values[0], buffer: values[1] })); }
  readv(buffers, position) { return this._call('readv', [buffers, position], values => ({ bytesRead: values[0], buffers: values[1] })); }
  readFile(options) { return this._call('readFile', [options]); }
  stat(options) { return this._call('fstat', [options]); }
  sync() { return this._call('fsync', []); }
  truncate(length = 0) { return this._call('ftruncate', [length]); }
  utimes(atime, mtime) { return this._call('futimes', [atime, mtime]); }
  write(...args) { return this._call('write', args, values => ({ bytesWritten: values[0], buffer: values[1] })); }
  writev(buffers, position) { return this._call('writev', [buffers, position], values => ({ bytesWritten: values[0], buffers: values[1] })); }
  writeFile(data, options) { return this._call('writeFile', [data, options]); }
  _stream(reading, options) {
    const fd = this._retain(reading ? 'read' : 'write');
    const o = c.options(options); const autoClose = o.autoClose !== false; let released = false;
    const release = () => { if (!released) { released = true; this._release(); } };
    const adapter = Object.create(fs);
    adapter.close = (_fd, callback) => { release(); this.close().then(() => callback(null), callback); };
    try {
      const stream = reading ? fs.createReadStream(undefined, Object.assign(o, { fd, fs: adapter })) : fs.createWriteStream(undefined, Object.assign(o, { fd, fs: adapter }));
      if (!autoClose) { stream.once(reading ? 'end' : 'finish', release); stream.once('error', release); stream.once('close', release); }
      return stream;
    } catch (e) { release(); throw e; }
  }
  createReadStream(options) { return this._stream(true, options); }
  createWriteStream(options) { return this._stream(false, options); }
  readLines(options) {
    options = c.options(options);
    return require('readline').createInterface({ input: this.createReadStream(options), crlfDelay: options.crlfDelay === undefined ? Infinity : options.crlfDelay, terminal: false });
  }
  readableWebStream(options) {
    options = c.options(options);
    if (this._webStream) { const e = new Error('A readable stream has already been created for this FileHandle'); e.code = 'ERR_INVALID_STATE'; throw e; }
    if (this._fd < 0 || this._closing) throw badFd('read');
    const { ReadableStream } = require('stream/web'); this._webStream = true;
    const handle = this;
    return new ReadableStream({
      type: 'bytes',
      async pull(controller) {
        try {
          const buffer = c.Buffer.alloc(65536); const result = await handle.read(buffer, 0, buffer.length, null);
          if (result.bytesRead === 0) { controller.close(); if (controller.byobRequest) controller.byobRequest.respond(0); if (options.autoClose) await handle.close(); }
          else controller.enqueue(new Uint8Array(buffer.buffer, buffer.byteOffset, result.bytesRead));
        } catch (e) { controller.error(e); if (options.autoClose) await handle.close(); }
      },
      async cancel() { if (options.autoClose) await handle.close(); }
    });
  }
}
if (Symbol.asyncDispose) FileHandle.prototype[Symbol.asyncDispose] = FileHandle.prototype.close;
promises.open = async function open(path, flags = 'r', mode) { return new FileHandle(await invoke('open', [path, flags, mode])); };
// FileHandle overloads remain owned by the handle; a borrowed numeric descriptor
// is not accepted by fs/promises readFile/writeFile in place of a path.
for (const name of ['readFile', 'writeFile', 'appendFile']) promises[name] = async function(path, ...args) {
  if (path instanceof FileHandle) return path[name](...args);
  return invoke(name, [c.path(path), ...args]);
};
promises.mkdtempDisposable = async function mkdtempDisposable(prefix, options) {
  const path = await promises.mkdtemp(prefix, options); let removal;
  const result = { path, remove() { if (!removal) removal = promises.rm(path, { recursive: true, force: true }); return removal; } };
  if (Symbol.asyncDispose) result[Symbol.asyncDispose] = result.remove;
  return result;
};
promises.watch = function watch(filename, options) {
  options = c.options(options, { maxQueue: 2048, overflow: 'ignore' }); c.integer(options.maxQueue, 'maxQueue', 1);
  if (options.overflow !== 'ignore' && options.overflow !== 'throw') throw c.invalid('overflow', 'ignore or throw');
  const queue = []; const waiting = []; let done = false; let failure; let watcher;
  function finish(error) { if (done) return; done = true; failure = error; if (watcher) watcher.close(); if (options.signal) options.signal.removeEventListener('abort', abort); while (waiting.length) { const next = waiting.shift(); if (error) next.reject(error); else next.resolve({ done: true, value: undefined }); } }
  function abort() { const e = new Error('The operation was aborted', { cause: options.signal.reason }); e.name = 'AbortError'; e.code = 'ABORT_ERR'; finish(e); }
  if (options.signal && options.signal.aborted) abort();
  else {
    watcher = fs.watch(filename, options, (eventType, filename) => {
      if (done) return;
      const value = { eventType, filename };
      if (waiting.length) waiting.shift().resolve({ done: false, value });
      else if (queue.length < options.maxQueue) queue.push(value);
      else if (options.overflow === 'throw') { const e = new Error('Filesystem watch event queue overflow'); e.code = 'ERR_FS_WATCH_QUEUE_OVERFLOW'; finish(e); }
      else if (typeof process !== 'undefined' && process.emitWarning) process.emitWarning('Filesystem watch event queue overflow; events dropped');
    });
    watcher.on('error', finish); watcher.on('close', () => finish());
    if (options.signal) options.signal.addEventListener('abort', abort, { once: true });
  }
  return {
    [Symbol.asyncIterator]() { return this; },
    next() { if (failure) return Promise.reject(failure); if (done) return Promise.resolve({ done: true, value: undefined }); if (queue.length) return Promise.resolve({ done: false, value: queue.shift() }); return new Promise((resolve, reject) => waiting.push({ resolve, reject })); },
    return() { finish(); queue.length = 0; return Promise.resolve({ done: true, value: undefined }); },
    throw(error) { finish(error); return Promise.reject(error); }
  };
};
