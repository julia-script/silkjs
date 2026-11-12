'use strict';
// The recursive fs.watch watcher, after Node's lib/internal/fs/recursive_watch.js. Linux has no
// native recursive watch, so the watcher keeps one native watcher per directory and symbolic
// link, as Node does there.
const c = require('internal/fs/utils');
const v = require('internal/validators');
const { AbortError, codes: { ERR_INVALID_ARG_VALUE } } = require('internal/errors');
const { EventEmitter } = require('events');
const { basename, join, relative, resolve, sep } = require('path');
const { kFSWatchStart, createIgnoreMatcher, validateIgnoreOption } = require('internal/fs/watchers');
function isPathMissingForWatch(error) { return error.code === 'ENOENT'; }
// Inotify reports a directory's entries, with their names, on the directory's own watch.
const kDirectoryWatchReportsEntries = process.platform === 'linux';

class FSWatcher extends EventEmitter {
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

module.exports = { FSWatcher };
