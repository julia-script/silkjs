'use strict';
// fs.watch, its recursive form and fs/promises watch, after Node's lib/internal/fs/watchers.js
// and lib/internal/fs/recursive_watch.js. Linux has no native recursive watch, so a recursive
// watcher keeps one native watcher per directory and symbolic link, as Node does there.
const c = require('internal/fs_core');
const v = require('internal/validators');
const { AbortError, codes: { ERR_FS_WATCH_QUEUE_OVERFLOW, ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE } } = require('internal/errors');
const { EventEmitter } = require('events');
const { basename, join, relative, resolve, sep } = require('path');
const kFSWatchStart = Symbol('kFSWatchStart');

function isRegExp(value) { return Object.prototype.toString.call(value) === '[object RegExp]'; }
function validateIgnoreOptionElement(value, name) {
  if (typeof value === 'string') {
    if (value.length === 0) throw new ERR_INVALID_ARG_VALUE(name, value, 'must be a non-empty string');
    return;
  }
  if (isRegExp(value) || typeof value === 'function') return;
  throw new ERR_INVALID_ARG_TYPE(name, ['string', 'RegExp', 'Function'], value);
}
function validateIgnoreOption(value, name) {
  if (value == null) return;
  if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) validateIgnoreOptionElement(value[i], `${name}[${i}]`); return; }
  validateIgnoreOptionElement(value, name);
}
function createIgnoreMatcher(ignore) {
  if (ignore == null) return null;
  const compiled = [];
  for (const matcher of Array.isArray(ignore) ? ignore : [ignore]) {
    if (typeof matcher === 'string') {
      const { Minimatch } = require('internal/path_events/minimatch');
      const mm = new Minimatch(matcher, { nocase: process.platform === 'darwin' || process.platform === 'win32', windowsPathsNoEscape: true, nonegate: true, nocomment: true, optimizationLevel: 2, platform: process.platform, matchBase: true });
      compiled.push(filename => mm.match(filename));
    } else if (isRegExp(matcher)) compiled.push(filename => RegExp.prototype.exec.call(matcher, filename) !== null);
    else compiled.push(matcher);
  }
  return filename => { for (let i = 0; i < compiled.length; i++) if (compiled[i](filename)) return true; return false; };
}

class FSWatcher extends EventEmitter {
  constructor() { super(); this._handle = null; this._closed = false; this._ignoreMatcher = null; }
  [kFSWatchStart](filename, persistent, recursive, encoding, ignore, throwIfNoEntry = true) {
    if (this._closed || this._handle) return;
    filename = c.path(filename, 'filename');
    validateIgnoreOption(ignore, 'options.ignore');
    this._ignoreMatcher = createIgnoreMatcher(ignore);
    if (typeof c.host.watch !== 'function') throw c.error('ENOSYS', 'watch', filename);
    try {
      this._handle = c.host.watch(filename, { persistent, recursive, encoding }, (err, eventType, name) => {
        if (this._closed) return;
        if (err) { if (this._handle) { this._handle.close(); this._handle = null; } err.filename = filename; this.emit('error', err); return; }
        if (name != null && this._ignoreMatcher && this._ignoreMatcher(name)) return;
        this.emit('change', eventType, name == null ? null : typeof name === 'string' ? c.encoded(name, encoding) : encoding === 'buffer' ? c.Buffer.from(name) : c.Buffer.from(name).toString(encoding));
      });
    } catch (error) {
      if (!throwIfNoEntry && error.code === 'ENOENT') return;
      error.filename = filename;
      throw error;
    }
    if (!persistent) this._handle.unref();
  }
  close() {
    if (this._closed) return;
    this._closed = true;
    if (this._handle) { this._handle.close(); this._handle = null; }
    process.nextTick(() => this.emit('close'));
  }
  ref() { if (this._handle) this._handle.ref(); return this; }
  unref() { if (this._handle) this._handle.unref(); return this; }
}

function isPathMissingForWatch(error) { return error.code === 'ENOENT'; }
// Inotify reports a directory's entries, with their names, on the directory's own watch.
const kDirectoryWatchReportsEntries = process.platform === 'linux';

class RecursiveFSWatcher extends EventEmitter {
  #options = null;
  #closed = false;
  #entries = new Set();
  #watchers = new Map();
  #symbolicLinks = new Set();
  #rootPath = resolve();
  #ignoreMatcher = null;
  constructor(options = {}) {
    super();
    const { persistent, recursive, signal, encoding, ignore } = options;
    let { throwIfNoEntry } = options;
    if (recursive != null) v.validateBoolean(recursive, 'options.recursive');
    if (persistent != null) v.validateBoolean(persistent, 'options.persistent');
    if (signal != null) v.validateAbortSignal(signal, 'options.signal');
    if (throwIfNoEntry != null) v.validateBoolean(throwIfNoEntry, 'options.throwIfNoEntry');
    else throwIfNoEntry = true;
    if (encoding != null && typeof encoding !== 'string') throw new ERR_INVALID_ARG_VALUE('options.encoding', encoding);
    validateIgnoreOption(ignore, 'options.ignore');
    this.#ignoreMatcher = createIgnoreMatcher(ignore);
    this.#options = { persistent, recursive, signal, encoding, throwIfNoEntry };
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const watcher of this.#watchers.values()) watcher.close();
    this.#watchers.clear(); this.#entries.clear(); this.#symbolicLinks.clear();
    this.emit('close');
  }
  #emit(eventType, file) { this.emit('change', eventType, relative(this.#rootPath, file)); }
  #ignored(file) { return this.#ignoreMatcher !== null && this.#ignoreMatcher(relative(this.#rootPath, file)); }
  #forget(file) {
    const watcher = this.#watchers.get(file);
    if (watcher !== undefined) { watcher.close(); this.#watchers.delete(file); }
    this.#entries.delete(file); this.#symbolicLinks.delete(file);
    const childPrefix = file + sep;
    for (const entry of this.#entries) {
      if (!entry.startsWith(childPrefix)) continue;
      this.#entries.delete(entry); this.#symbolicLinks.delete(entry);
      const childWatcher = this.#watchers.get(entry);
      if (childWatcher !== undefined) { childWatcher.close(); this.#watchers.delete(entry); }
    }
  }
  // False when the entry vanished between being listed and being watched.
  #watch(file, onChange) {
    if (this.#closed) return false;
    if (this.#watchers.has(file)) return true;
    let watcher;
    try { watcher = require('fs').watch(file, { persistent: this.#options.persistent }, onChange); } catch (err) {
      if (isPathMissingForWatch(err) && (file !== this.#rootPath || !this.#options.throwIfNoEntry)) return false;
      throw err;
    }
    this.#watchers.set(file, watcher);
    return true;
  }
  #scanFolder(folder, initial) {
    if (!this.#watch(folder, (eventType, filename) => this.#onFolderEvent(folder, filename))) { this.#forget(folder); return; }
    let entries;
    try { entries = require('fs').readdirSync(folder, { withFileTypes: true }); } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        if (folder === this.#rootPath && initial && (error.code !== 'ENOENT' || this.#options.throwIfNoEntry)) throw error;
        if (!initial && !this.#closed) this.#emit('rename', folder);
        this.#forget(folder);
      } else this.emit('error', error);
      return;
    }
    for (const entry of entries) {
      if (this.#closed) break;
      const file = join(folder, entry.name);
      if (!this.#entries.has(file) && !this.#ignored(file)) this.#addEntry(file, entry, initial);
    }
  }
  // `entry` is the Dirent or the lstat() Stats of `file`.
  #addEntry(file, entry, initial) {
    this.#entries.add(file);
    if (!initial) this.#emit('rename', file);
    if (entry.isSymbolicLink()) {
      this.#symbolicLinks.add(file);
      if (!this.#watch(file, () => this.#emit('rename', file))) this.#forget(file);
    } else if (entry.isDirectory()) this.#scanFolder(file, initial);
    else if (!kDirectoryWatchReportsEntries && !this.#watch(file, () => this.#onEntryEvent(file))) this.#forget(file);
  }
  #onFolderEvent(folder, filename) {
    if (this.#closed) return;
    const fs = require('fs');
    if (!kDirectoryWatchReportsEntries || filename == null) {
      if (fs.statSync(folder, { throwIfNoEntry: false }) === undefined) { this.#emit('rename', folder); this.#forget(folder); } else this.#scanFolder(folder, false);
      return;
    }
    const file = join(folder, filename);
    if (!this.#entries.has(file)) {
      if (this.#ignored(file)) return;
      const entry = fs.lstatSync(file, { throwIfNoEntry: false });
      if (entry !== undefined) this.#addEntry(file, entry, false);
      else if (folder === this.#rootPath && fs.statSync(folder, { throwIfNoEntry: false }) === undefined) { this.#emit('rename', folder); this.#forget(folder); }
      return;
    }
    this.#onEntryEvent(file);
  }
  #onEntryEvent(file) {
    if (this.#closed) return;
    const stats = require('fs').statSync(file, { throwIfNoEntry: false });
    if (stats === undefined) { this.#emit('rename', file); this.#forget(file); } else if (this.#symbolicLinks.has(file)) this.#emit('rename', file);
    else if (stats.isDirectory()) this.#scanFolder(file, false);
    else this.#emit('change', file);
  }
  #watchRootFile(file) {
    this.#entries.add(file);
    if (!this.#watch(file, () => {
      if (this.#closed) return;
      if (require('fs').statSync(file, { throwIfNoEntry: false }) === undefined) { this.#emit('rename', file); this.#forget(file); } else this.emit('change', 'change', basename(file));
    })) this.#forget(file);
  }
  [kFSWatchStart](filename) {
    filename = resolve(c.path(filename));
    try {
      const file = require('fs').statSync(filename);
      this.#rootPath = filename; this.#closed = false;
      if (file.isDirectory()) this.#scanFolder(filename, true); else this.#watchRootFile(filename);
    } catch (error) {
      if (this.#options.throwIfNoEntry || error.code !== 'ENOENT') { error.filename = filename; this.close(); throw error; }
    }
  }
  ref() { for (const watcher of this.#watchers.values()) watcher.ref(); return this; }
  unref() { for (const watcher of this.#watchers.values()) watcher.unref(); return this; }
  [Symbol.asyncIterator]() {
    const { signal } = this.#options;
    const executor = signal == null ? resolve => { this.once('change', (eventType, filename) => resolve({ value: { eventType, filename } })); } : (resolve, reject) => {
      const onAbort = () => { this.close(); reject(new AbortError(undefined, { cause: signal?.reason })); };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      this.once('change', (eventType, filename) => { signal.removeEventListener('abort', onAbort); resolve({ value: { eventType, filename } }); });
    };
    return {
      next: () => (this.#closed ? { done: true } : new Promise(executor)),
      return: () => { this.close(); return { done: true }; },
      [Symbol.asyncIterator]() { return this; },
    };
  }
}

function watch(filename, options, listener) {
  if (typeof options === 'function') listener = options;
  options = { ...c.options(options) };
  if (options.persistent === undefined) options.persistent = true;
  if (options.recursive === undefined) options.recursive = false;
  if (options.throwIfNoEntry === undefined) options.throwIfNoEntry = true;
  const path = c.path(filename);
  let watcher;
  if (options.recursive && process.platform !== 'darwin' && process.platform !== 'win32') {
    watcher = new RecursiveFSWatcher(options);
    watcher[kFSWatchStart](path);
  } else {
    watcher = new FSWatcher();
    watcher[kFSWatchStart](path, options.persistent, options.recursive, options.encoding, options.ignore, options.throwIfNoEntry);
  }
  if (listener) watcher.addListener('change', listener);
  if (options.signal) {
    if (options.signal.aborted) process.nextTick(() => watcher.close());
    else {
      const onAbort = () => watcher.close();
      options.signal.addEventListener('abort', onAbort);
      watcher.once('close', () => options.signal.removeEventListener('abort', onAbort));
    }
  }
  return watcher;
}

function queueOverflow(maxQueue) {
  return new ERR_FS_WATCH_QUEUE_OVERFLOW(maxQueue);
}
async function* nativeWatch(filename, options = {}) {
  const path = c.path(filename);
  v.validateObject(options, 'options');
  const { persistent = true, recursive = false, encoding = 'utf8', maxQueue = 2048, overflow = 'ignore', signal, ignore } = options;
  v.validateBoolean(persistent, 'options.persistent');
  v.validateBoolean(recursive, 'options.recursive');
  v.validateInteger(maxQueue, 'options.maxQueue');
  v.validateOneOf(overflow, 'options.overflow', ['ignore', 'error']);
  v.validateAbortSignal(signal, 'options.signal');
  validateIgnoreOption(ignore, 'options.ignore');
  if (encoding && !Buffer.isEncoding(encoding)) throw new ERR_INVALID_ARG_VALUE('encoding', encoding, 'is invalid encoding');
  if (signal && signal.aborted) throw new AbortError(undefined, { cause: signal?.reason });
  const ignoreMatcher = createIgnoreMatcher(ignore);
  let { promise, resolve: wake } = Promise.withResolvers();
  const queue = [];
  let handle = null;
  const oncancel = () => { if (handle) handle.close(); wake(); };
  try {
    if (signal) signal.addEventListener('abort', oncancel, { once: true });
    if (typeof c.host.watch !== 'function') throw c.error('ENOSYS', 'watch', path);
    try {
      handle = c.host.watch(path, { persistent, recursive, encoding }, (err, eventType, name) => {
        if (err) { err.filename = filename; handle.close(); queue.push(err); wake(); return; }
        if (name != null && ignoreMatcher && ignoreMatcher(name)) return;
        if (queue.length < maxQueue) {
          const value = name == null ? null : typeof name === 'string' ? c.encoded(name, encoding) : encoding === 'buffer' ? c.Buffer.from(name) : c.Buffer.from(name).toString(encoding);
          queue.push({ eventType, filename: value }); wake();
        } else if (overflow === 'error') { queue.length = 0; queue.push(queueOverflow(maxQueue)); wake(); } else process.emitWarning('fs.watch maxQueue exceeded');
      });
    } catch (error) { error.filename = filename; throw error; }
    if (!persistent) handle.unref();
    while (!(signal && signal.aborted)) {
      await promise;
      while (queue.length) {
        const item = queue.shift();
        if (item instanceof Error) throw item;
        yield item;
      }
      ({ promise, resolve: wake } = Promise.withResolvers());
    }
    if (signal && signal.aborted) throw new AbortError(undefined, { cause: signal?.reason });
  } finally {
    if (handle) handle.close();
    if (signal) signal.removeEventListener('abort', oncancel);
  }
}
async function* promisesWatch(filename, options = {}) {
  v.validateObject(options, 'options');
  if (options.recursive != null) {
    v.validateBoolean(options.recursive, 'options.recursive');
    if (options.recursive && process.platform !== 'darwin' && process.platform !== 'win32') {
      const watcher = new RecursiveFSWatcher(options);
      watcher[kFSWatchStart](filename);
      yield* watcher;
      return;
    }
  }
  yield* nativeWatch(filename, options);
}
Object.defineProperty(promisesWatch, 'name', { value: 'watch' });

module.exports = { FSWatcher, RecursiveFSWatcher, watch, promisesWatch, createIgnoreMatcher, validateIgnoreOption, kFSWatchStart };
