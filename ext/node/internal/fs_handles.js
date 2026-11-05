'use strict';
const c = require('internal/fs_core');
const { EventEmitter } = require('events');
function later(callback) { Promise.resolve().then(callback); }
function closedDir() { const e = new Error('Directory handle was closed'); e.code = 'ERR_DIR_CLOSED'; return e; }
class Dir {
  constructor(path, entries) { this.path = path; this._entries = entries; this._index = 0; this._closed = false; this._pending = false; }
  _check() { if (this._closed) throw closedDir(); }
  readSync() { this._check(); if (this._pending) { const e = new Error('Cannot perform synchronous operation while asynchronous operation is pending'); e.code = 'ERR_DIR_CONCURRENT_OPERATION'; throw e; } return this._index < this._entries.length ? this._entries[this._index++] : null; }
  read(callback) {
    if (callback !== undefined) c.callback(callback);
    const operation = Promise.resolve().then(() => { this._check(); return this._index < this._entries.length ? this._entries[this._index++] : null; });
    this._pending = true;
    operation.then(() => { this._pending = false; }, () => { this._pending = false; });
    if (callback) { operation.then(value => callback(null, value), callback); return; }
    return operation;
  }
  closeSync() { this._check(); if (this._pending) { const e = new Error('Directory operation is pending'); e.code = 'ERR_DIR_CONCURRENT_OPERATION'; throw e; } this._closed = true; this._entries = []; }
  close(callback) {
    if (callback !== undefined) c.callback(callback);
    const operation = Promise.resolve().then(() => { this._check(); this._closed = true; this._entries = []; });
    if (callback) { operation.then(() => callback(null), callback); return; }
    return operation;
  }
  async *[Symbol.asyncIterator]() { try { for (;;) { const entry = await this.read(); if (entry === null) return; yield entry; } } finally { if (!this._closed) await this.close(); } }
}
if (Symbol.asyncDispose) Dir.prototype[Symbol.asyncDispose] = async function() { if (!this._closed) await this.close(); };
class FSWatcher extends EventEmitter {
  constructor() { super(); this._handle = null; this._closed = false; this._abort = null; }
  close() { if (this._closed) return; this._closed = true; if (this._abort) this._abort(); if (this._handle) this._handle.close(); later(() => this.emit('close')); }
  ref() { if (!this._closed && this._handle) this._handle.ref(); return this; }
  unref() { if (!this._closed && this._handle) this._handle.unref(); return this; }
  hasRef() { return !this._closed && !!this._handle && this._handle.hasRef(); }
}
function watch(filename, options, listener) {
  if (typeof options === 'function') { listener = options; options = undefined; }
  filename = c.path(filename); options = c.options(options, { persistent: true, recursive: false, encoding: 'utf8' }); c.encoding(options.encoding, 'utf8', true);
  if (listener !== undefined) c.callback(listener);
  const watcher = new FSWatcher(); if (listener) watcher.on('change', listener);
  if (options.signal && options.signal.aborted) { later(() => watcher.close()); return watcher; }
  if (typeof c.host.watch !== 'function') throw c.error('ENOSYS', 'watch', filename);
  watcher._handle = c.host.watch(filename, options, (err, eventType, name) => {
    if (watcher._closed) return;
    if (err) { watcher.close(); watcher.emit('error', err); return; }
    watcher.emit('change', eventType, name === null || name === undefined ? null : typeof name === 'string' ? c.encoded(name, options.encoding) : options.encoding === 'buffer' ? c.Buffer.from(name) : c.Buffer.from(name).toString(options.encoding));
  });
  if (!options.persistent) watcher.unref();
  if (options.signal) { const abort = () => watcher.close(); options.signal.addEventListener('abort', abort, { once: true }); watcher._abort = () => options.signal.removeEventListener('abort', abort); }
  return watcher;
}
class StatWatcher extends FSWatcher {
  stop() { this.close(); }
}
const statWatchers = new Map();
function watchFile(filename, options, listener) {
  if (typeof options === 'function') { listener = options; options = undefined; }
  c.callback(listener); filename = require('path').resolve(c.path(filename)); options = c.options(options, { persistent: true, interval: 5007, bigint: false }); c.integer(options.interval, 'interval', 1);
  let watcher = statWatchers.get(filename);
  if (!watcher) {
    if (typeof c.host.watch !== 'function') throw c.error('ENOSYS', 'watchFile', filename);
    watcher = new StatWatcher(); statWatchers.set(filename, watcher);
    try {
      watcher._handle = c.host.watch(filename, Object.assign({}, options, { stat: true }), (err, current, previous) => {
        if (watcher._closed) return;
        if (err) { watcher.emit('error', err); return; }
        watcher.emit('change', new c.Stats(current, !!options.bigint), new c.Stats(previous, !!options.bigint));
      });
    } catch (e) { statWatchers.delete(filename); throw e; }
    watcher.once('close', () => { if (statWatchers.get(filename) === watcher) statWatchers.delete(filename); });
    if (!options.persistent) watcher.unref();
  }
  watcher.on('change', listener); return watcher;
}
function unwatchFile(filename, listener) {
  filename = require('path').resolve(c.path(filename)); const watcher = statWatchers.get(filename); if (!watcher) return;
  if (listener) watcher.removeListener('change', listener); else watcher.removeAllListeners('change');
  if (watcher.listenerCount('change') === 0) { statWatchers.delete(filename); watcher.stop(); }
}
module.exports = { Dir, FSWatcher, StatWatcher, watch, watchFile, unwatchFile };
