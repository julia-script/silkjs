'use strict';
const c = require('internal/fs/utils');
const { EventEmitter } = require('events');
const { join } = require('path');
const v = require('internal/validators');
const { codes: { ERR_DIR_CLOSED, ERR_DIR_CONCURRENT_OPERATION, ERR_INVALID_THIS, ERR_MISSING_ARGS } } = require('internal/errors');
const { promisify } = require('util');
// A directory handle over entries already listed: read() hands out up to bufferSize Dirents,
// then null; with a request it completes on a later tick, as a libuv read does.
class DirHandle {
  constructor(entries) { this.entries = entries; this.index = 0; }
  read(encoding, bufferSize, req) {
    const result = this.index < this.entries.length ? this.entries.slice(this.index, this.index += bufferSize) : null;
    if (req === undefined) return result;
    process.nextTick(() => req.oncomplete(null, result));
  }
  close(req) { this.entries = []; if (req !== undefined) process.nextTick(() => req.oncomplete(null)); }
}
function openDirHandle(path, encoding) { return new DirHandle(require('fs').readdirSync(path, { encoding, withFileTypes: true })); }
// Node's lib/internal/fs/dir.js.
class Dir {
  #handle;
  #path;
  #bufferedEntries = [];
  #closed = false;
  #options;
  #readPromisified;
  #closePromisified;
  #operationQueue = null;
  #handlerQueue = [];
  constructor(handle, path, options) {
    if (handle == null) throw new ERR_MISSING_ARGS('handle');
    this.#handle = handle;
    this.#path = path;
    this.#options = { bufferSize: 32, ...c.options(options, { encoding: 'utf8' }) };
    try { v.validateUint32(this.#options.bufferSize, 'options.bufferSize', true); } catch (validationError) { this.#handle.close(); throw validationError; }
    this.#readPromisified = promisify(this.#readImpl).bind(this, false);
    this.#closePromisified = promisify(this.close).bind(this);
  }
  get path() {
    if (!(#path in this)) throw new ERR_INVALID_THIS('Dir');
    return this.#path;
  }
  #processHandlerQueue() {
    while (this.#handlerQueue.length > 0) {
      const handler = this.#handlerQueue.shift();
      const result = handler.handle.read(this.#options.encoding, this.#options.bufferSize);
      if (result !== null) { this.#bufferedEntries.push(...result); if (result.length > 0) this.#handlerQueue.push(handler); } else handler.handle.close();
      if (this.#bufferedEntries.length > 0) break;
    }
    return this.#bufferedEntries.length > 0;
  }
  read(callback) { return arguments.length === 0 ? this.#readPromisified() : this.#readImpl(true, callback); }
  #readImpl(maybeSync, callback) {
    if (this.#closed === true) throw new ERR_DIR_CLOSED();
    if (callback === undefined) return this.#readPromisified();
    v.validateFunction(callback, 'callback');
    if (this.#operationQueue !== null) { this.#operationQueue.push(() => { this.#readImpl(maybeSync, callback); }); return; }
    if (this.#processHandlerQueue()) {
      try {
        const dirent = this.#bufferedEntries.shift();
        if (this.#options.recursive && dirent.isDirectory()) this.#readSyncRecursive(dirent);
        if (maybeSync) process.nextTick(callback, null, dirent); else callback(null, dirent);
        return;
      } catch (error) { return callback(error); }
    }
    const req = { oncomplete: (err, result) => {
      process.nextTick(() => { const queue = this.#operationQueue; this.#operationQueue = null; for (const op of queue) op(); });
      if (err || result === null) return callback(err, result);
      try {
        this.#bufferedEntries.push(...result);
        const dirent = this.#bufferedEntries.shift();
        if (this.#options.recursive && dirent.isDirectory()) this.#readSyncRecursive(dirent);
        callback(null, dirent);
      } catch (error) { callback(error); }
    } };
    this.#operationQueue = [];
    this.#handle.read(this.#options.encoding, this.#options.bufferSize, req);
  }
  #readSyncRecursive(dirent) {
    const path = join(dirent.parentPath, dirent.name);
    this.#handlerQueue.push({ handle: openDirHandle(path, this.#options.encoding), path });
  }
  readSync() {
    if (this.#closed === true) throw new ERR_DIR_CLOSED();
    if (this.#operationQueue !== null) throw new ERR_DIR_CONCURRENT_OPERATION();
    if (!this.#processHandlerQueue()) {
      const result = this.#handle.read(this.#options.encoding, this.#options.bufferSize);
      if (result === null) return result;
      this.#bufferedEntries.push(...result);
    }
    const dirent = this.#bufferedEntries.shift();
    if (this.#options.recursive && dirent.isDirectory()) this.#readSyncRecursive(dirent);
    return dirent;
  }
  close(callback) {
    if (callback === undefined) {
      if (this.#closed === true) return Promise.reject(new ERR_DIR_CLOSED());
      return this.#closePromisified();
    }
    v.validateFunction(callback, 'callback');
    if (this.#closed === true) { process.nextTick(callback, new ERR_DIR_CLOSED()); return; }
    if (this.#operationQueue !== null) { this.#operationQueue.push(() => { this.close(callback); }); return; }
    while (this.#handlerQueue.length > 0) this.#handlerQueue.shift().handle.close();
    this.#closed = true;
    this.#handle.close({ oncomplete: callback });
  }
  closeSync() {
    if (this.#closed === true) throw new ERR_DIR_CLOSED();
    if (this.#operationQueue !== null) throw new ERR_DIR_CONCURRENT_OPERATION();
    while (this.#handlerQueue.length > 0) this.#handlerQueue.shift().handle.close();
    this.#closed = true;
    this.#handle.close();
  }
  async *entries() {
    try {
      while (true) { const result = await this.#readPromisified(); if (result === null) break; yield result; }
    } finally { await this.#closePromisified(); }
  }
  [Symbol.dispose]() { if (this.#closed) return; this.closeSync(); }
  async [Symbol.asyncDispose]() { if (this.#closed) return; await this.#closePromisified(); }
}
Object.defineProperty(Dir.prototype, Symbol.asyncIterator, { enumerable: false, writable: true, configurable: true, value: Dir.prototype.entries });
const { FSWatcher, watch } = require('internal/fs/watchers');
class StatWatcher extends EventEmitter {
  constructor() { super(); this._handle = null; this._closed = false; }
  stop() { if (this._closed) return; this._closed = true; if (this._handle) { this._handle.close(); this._handle = null; } process.nextTick(() => this.emit('stop')); }
  close() { this.stop(); }
  ref() { if (this._handle) this._handle.ref(); return this; }
  unref() { if (this._handle) this._handle.unref(); return this; }
}
const statWatchers = new Map();
function watchFile(filename, options, listener) {
  filename = require('path').resolve(c.path(filename));
  if (options === null || typeof options !== 'object') { listener = options; options = null; }
  options = { interval: 5007, persistent: true, ...options };
  c.v.validateFunction(listener, 'listener');
  let watcher = statWatchers.get(filename);
  if (!watcher) {
    if (typeof c.host.watch !== 'function') throw c.error('ENOSYS', 'watchFile', filename);
    c.v.validateUint32(options.interval, 'interval');
    watcher = new StatWatcher(); statWatchers.set(filename, watcher);
    try {
      watcher._handle = c.host.watch(filename, Object.assign({}, options, { stat: true }), (err, current, previous) => {
        if (watcher._closed) return;
        if (err) { watcher.emit('error', err); return; }
        watcher.emit('change', c.makeStats(current, !!options.bigint), c.makeStats(previous, !!options.bigint));
      });
    } catch (e) { statWatchers.delete(filename); throw e; }
    watcher.once('stop', () => { if (statWatchers.get(filename) === watcher) statWatchers.delete(filename); });
    if (!options.persistent) watcher.unref();
  }
  watcher.on('change', listener); return watcher;
}
function unwatchFile(filename, listener) {
  filename = require('path').resolve(c.path(filename)); const watcher = statWatchers.get(filename); if (!watcher) return;
  if (listener) watcher.removeListener('change', listener); else watcher.removeAllListeners('change');
  if (watcher.listenerCount('change') === 0) { statWatchers.delete(filename); watcher.stop(); }
}
module.exports = { Dir, DirHandle, openDirHandle, FSWatcher, StatWatcher, watch, watchFile, unwatchFile };
