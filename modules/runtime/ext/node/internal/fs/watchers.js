'use strict';
// fs.watch and fs/promises watch, after Node's lib/internal/fs/watchers.js. The recursive
// watcher lives in internal/fs/recursive_watch, loaded on first use as in Node.
const c = require('internal/fs/utils');
const v = require('internal/validators');
const { AbortError, codes: { ERR_FS_WATCH_QUEUE_OVERFLOW, ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE } } = require('internal/errors');
const { EventEmitter } = require('events');
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


function watch(filename, options, listener) {
  if (typeof options === 'function') listener = options;
  options = { ...c.options(options) };
  if (options.persistent === undefined) options.persistent = true;
  if (options.recursive === undefined) options.recursive = false;
  if (options.throwIfNoEntry === undefined) options.throwIfNoEntry = true;
  const path = c.path(filename);
  let watcher;
  if (options.recursive && process.platform !== 'darwin' && process.platform !== 'win32') {
    watcher = new (require('internal/fs/recursive_watch').FSWatcher)(options);
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
      const watcher = new (require('internal/fs/recursive_watch').FSWatcher)(options);
      watcher[kFSWatchStart](filename);
      yield* watcher;
      return;
    }
  }
  yield* nativeWatch(filename, options);
}
Object.defineProperty(promisesWatch, 'name', { value: 'watch' });

module.exports = { FSWatcher, watch, promisesWatch, createIgnoreMatcher, validateIgnoreOption, kFSWatchStart };
