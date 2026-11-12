'use strict';
// FileHandle.prototype.pull, pullSync and writer for --experimental-stream-iter, after
// Node's lib/internal/fs/promises.js (v24).
const { Buffer } = require('buffer');
const fs = require('fs');
const c = require('internal/fs/utils');
const v = require('internal/validators');
const { validateAbortSignal, validateBoolean, validateInteger, validateObject } = v;
const { codes: { ERR_OPERATION_FAILED, ERR_OUT_OF_RANGE } } = require('internal/errors');
const kNullPrototo = { __proto__: null };
const kDefaultChunkSize = 131072;
const kNone = -1;
function binding(operation, args) {
  return new Promise((resolve, reject) => { c.submit(operation, args, c.promiseCallback((err, value) => err ? reject(err) : resolve(value), 1)); });
}
const position = pos => pos >= 0 ? pos : null;
function installOn(FileHandle, { kFd, kLocked, kRef, kUnref, kClosePromise, kCloseSync, invalidState }) {
  const { pull: newStreamsPull, pullSync: newStreamsPullSync } = require('internal/streams/iter/pull');
  const { parsePullArgs, toUint8Array, convertChunks } = require('internal/streams/iter/utils');
  const operationFailed = message => new ERR_OPERATION_FAILED(message);
  function checkUsable(handle) {
    if (handle[kFd] === kNone) throw invalidState('The FileHandle is closed');
    if (handle[kClosePromise]) throw invalidState('The FileHandle is closing');
    if (handle[kLocked]) throw invalidState('The FileHandle is locked');
  }
  function readOptions(options, withSignal) {
    const { autoClose = false, chunkSize: readSize = kDefaultChunkSize, signal } = options;
    const { start: pos = kNone, limit: remaining = kNone } = options;
    validateBoolean(autoClose, 'options.autoClose');
    if (pos !== kNone) validateInteger(pos, 'options.start', 0);
    if (remaining !== kNone) validateInteger(remaining, 'options.limit', 1);
    if (readSize !== undefined) validateInteger(readSize, 'options.chunkSize', 1);
    if (withSignal && signal !== undefined) validateAbortSignal(signal, 'options.signal');
    return { autoClose, readSize, signal, pos, remaining };
  }
  FileHandle.prototype.pull = function pull(...args) {
    checkUsable(this);
    const { transforms, options = kNullPrototo } = parsePullArgs(args);
    let { autoClose, readSize, signal, pos, remaining } = readOptions(options, true);
    const handle = this; const fd = this[kFd];
    this[kLocked] = true;
    const source = {
      __proto__: null,
      async *[Symbol.asyncIterator]() {
        handle[kRef]();
        try {
          while (remaining !== 0) {
            if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
            const toRead = remaining > 0 ? Math.min(readSize, remaining) : readSize;
            const buf = Buffer.allocUnsafe(toRead);
            const bytesRead = (await binding('read', [fd, buf, 0, toRead, position(pos)])) || 0;
            if (bytesRead === 0) break;
            if (pos >= 0) pos += bytesRead;
            if (remaining > 0) remaining -= bytesRead;
            yield [bytesRead < toRead ? buf.subarray(0, bytesRead) : buf];
          }
        } finally {
          handle[kLocked] = false;
          handle[kUnref]();
          if (autoClose) await handle.close();
        }
      },
    };
    if (transforms.length > 0) {
      const pullArgs = [...transforms];
      if (options) pullArgs.push(options);
      return newStreamsPull(source, ...pullArgs);
    }
    return source;
  };
  FileHandle.prototype.pullSync = function pullSync(...args) {
    checkUsable(this);
    const { transforms, options = kNullPrototo } = parsePullArgs(args);
    let { autoClose, readSize, pos, remaining } = readOptions(options, false);
    const handle = this; const fd = this[kFd];
    this[kLocked] = true;
    handle[kRef]();
    function cleanup() { handle[kLocked] = false; handle[kUnref](); if (autoClose) handle[kCloseSync](); }
    const source = {
      __proto__: null,
      [Symbol.iterator]() {
        let done = false;
        return {
          __proto__: null,
          next() {
            if (done || remaining === 0) { if (!done) { done = true; cleanup(); } return { value: undefined, done: true }; }
            const toRead = remaining > 0 ? Math.min(readSize, remaining) : readSize;
            const buf = Buffer.allocUnsafe(toRead);
            let bytesRead;
            try { bytesRead = fs.readSync(fd, buf, 0, toRead, position(pos)) || 0; }
            catch (err) { done = true; cleanup(); throw err; }
            if (bytesRead === 0) { done = true; cleanup(); return { value: undefined, done: true }; }
            if (pos >= 0) pos += bytesRead;
            if (remaining > 0) remaining -= bytesRead;
            return { value: [bytesRead < toRead ? buf.subarray(0, bytesRead) : buf], done: false };
          },
          return() { if (!done) { done = true; cleanup(); } return { value: undefined, done: true }; },
        };
      },
    };
    if (transforms.length > 0) return newStreamsPullSync(source, ...transforms);
    return source;
  };
  FileHandle.prototype.writer = function writer(options = kNullPrototo) {
    checkUsable(this);
    validateObject(options, 'options');
    const { autoClose = false, chunkSize: syncWriteThreshold = kDefaultChunkSize } = options;
    let { start: pos = kNone, limit: bytesRemaining = kNone } = options;
    const handle = this; const fd = this[kFd];
    let totalBytesWritten = 0; let closed = false; let closing = false; let pendingEndPromise = null; let error = null; let asyncPending = false;
    validateBoolean(autoClose, 'options.autoClose');
    if (pos !== kNone) validateInteger(pos, 'options.start', 0);
    if (bytesRemaining !== kNone) validateInteger(bytesRemaining, 'options.limit', 1);
    if (syncWriteThreshold !== undefined) validateInteger(syncWriteThreshold, 'options.chunkSize', 1);
    this[kLocked] = true;
    handle[kRef]();
    async function writeAll(buf, offset, length, at, signal) {
      asyncPending = true;
      try {
        let retries = 0;
        while (length > 0) {
          const bytesWritten = (await binding('write', [fd, buf, offset, length, position(at)])) || 0;
          signal?.throwIfAborted();
          if (bytesWritten === 0) { if (++retries > 5) throw operationFailed('write failed after retries'); } else retries = 0;
          totalBytesWritten += bytesWritten; offset += bytesWritten; length -= bytesWritten;
          if (at >= 0) at += bytesWritten;
        }
      } finally { asyncPending = false; }
    }
    async function writevAll(buffers, at, signal) {
      asyncPending = true;
      try {
        let totalSize = 0;
        for (let i = 0; i < buffers.length; i++) totalSize += buffers[i].byteLength;
        let retries = 0;
        while (totalSize > 0) {
          const bytesWritten = (await binding('writev', [fd, buffers, position(at)])) || 0;
          signal?.throwIfAborted();
          if (bytesWritten === 0) { if (++retries > 5) throw operationFailed('writev failed after retries'); } else retries = 0;
          totalBytesWritten += bytesWritten; totalSize -= bytesWritten;
          if (at >= 0) at += bytesWritten;
          if (totalSize > 0) {
            const remaining = Buffer.concat(buffers);
            await writeAll(remaining, bytesWritten, remaining.length - bytesWritten, at, signal);
            return;
          }
        }
      } finally { asyncPending = false; }
    }
    function writeSyncAll(buf, offset, length, at) {
      let retries = 0;
      while (length > 0) {
        const bytesWritten = fs.writeSync(fd, buf, offset, length, position(at)) || 0;
        if (bytesWritten === 0) { if (++retries > 5) throw operationFailed('write failed after retries'); } else retries = 0;
        totalBytesWritten += bytesWritten; offset += bytesWritten; length -= bytesWritten;
        if (at >= 0) at += bytesWritten;
      }
    }
    async function cleanup() {
      if (closed) return;
      closed = true; handle[kLocked] = false; handle[kUnref]();
      if (autoClose) await handle.close();
    }
    function signalOf(options) {
      validateObject(options, 'options');
      const { signal } = options;
      if (signal !== undefined) validateAbortSignal(signal, 'options.signal');
      return signal;
    }
    return {
      __proto__: null,
      write(chunk, options = kNullPrototo) {
        if (error) return Promise.reject(error);
        if (closed) return Promise.reject(invalidState('The writer is closed', TypeError));
        const signal = signalOf(options);
        if (signal?.aborted) return Promise.reject(signal.reason);
        chunk = toUint8Array(chunk);
        if (bytesRemaining >= 0 && chunk.byteLength > bytesRemaining) return Promise.reject(new ERR_OUT_OF_RANGE('write', `<= ${bytesRemaining} bytes`, chunk.byteLength));
        if (bytesRemaining > 0) bytesRemaining -= chunk.byteLength;
        const at = pos;
        if (pos >= 0) pos += chunk.byteLength;
        return writeAll(chunk, 0, chunk.byteLength, at, signal);
      },
      writev(chunks, options = kNullPrototo) {
        if (error) return Promise.reject(error);
        if (closed) return Promise.reject(invalidState('The writer is closed', TypeError));
        const signal = signalOf(options);
        if (signal?.aborted) return Promise.reject(signal.reason);
        chunks = convertChunks(chunks);
        let totalSize = 0;
        for (let i = 0; i < chunks.length; i++) totalSize += chunks[i].byteLength;
        if (bytesRemaining >= 0 && totalSize > bytesRemaining) return Promise.reject(new ERR_OUT_OF_RANGE('writev', `<= ${bytesRemaining} bytes`, totalSize));
        if (bytesRemaining > 0) bytesRemaining -= totalSize;
        const at = pos;
        if (pos >= 0) pos += totalSize;
        return writevAll(chunks, at, signal);
      },
      writeSync(chunk) {
        if (error || closed || asyncPending) return false;
        chunk = toUint8Array(chunk);
        const length = chunk.byteLength;
        if (length > syncWriteThreshold) return false;
        if (length === 0) return true;
        if (bytesRemaining >= 0 && length > bytesRemaining) return false;
        const at = pos;
        let bytesWritten;
        try { bytesWritten = fs.writeSync(fd, chunk, 0, length, position(at)) || 0; } catch { return false; }
        totalBytesWritten += bytesWritten;
        if (at >= 0) pos = at + bytesWritten;
        if (bytesWritten === length) { if (bytesRemaining > 0) bytesRemaining -= length; return true; }
        writeSyncAll(chunk, bytesWritten, length - bytesWritten, at >= 0 ? at + bytesWritten : -1);
        if (bytesRemaining > 0) bytesRemaining -= length;
        return true;
      },
      writevSync(chunks) {
        if (error || closed || asyncPending) return false;
        chunks = convertChunks(chunks);
        let totalSize = 0;
        for (let i = 0; i < chunks.length; i++) totalSize += chunks[i].byteLength;
        if (totalSize > syncWriteThreshold) return false;
        if (totalSize === 0) return true;
        if (bytesRemaining >= 0 && totalSize > bytesRemaining) return false;
        const at = pos;
        let bytesWritten;
        try { bytesWritten = fs.writevSync(fd, chunks, position(at)) || 0; } catch { return false; }
        totalBytesWritten += bytesWritten;
        if (at >= 0) pos = at + bytesWritten;
        if (bytesWritten === totalSize) { if (bytesRemaining > 0) bytesRemaining -= totalSize; return true; }
        const rest = Buffer.concat(chunks);
        writeSyncAll(rest, bytesWritten, rest.byteLength - bytesWritten, at >= 0 ? at + bytesWritten : -1);
        if (bytesRemaining > 0) bytesRemaining -= totalSize;
        return true;
      },
      end(options = kNullPrototo) {
        if (error) return Promise.reject(error);
        if (closed) return Promise.resolve(totalBytesWritten);
        if (closing) return pendingEndPromise;
        const signal = signalOf(options);
        if (signal?.aborted) return Promise.reject(signal.reason);
        closing = true;
        pendingEndPromise = cleanup().then(() => totalBytesWritten);
        return pendingEndPromise;
      },
      endSync() {
        if (error) return -1;
        if (closed) return totalBytesWritten;
        if (asyncPending) return -1;
        closed = true; handle[kLocked] = false; handle[kUnref]();
        if (autoClose) handle[kCloseSync]();
        return totalBytesWritten;
      },
      fail(reason) {
        if (closed || error) return;
        error = reason ?? invalidState('Failed');
        closed = true; handle[kLocked] = false; handle[kUnref]();
        if (autoClose) handle[kCloseSync]();
      },
      [Symbol.asyncDispose]() {
        if (closing) return pendingEndPromise ?? Promise.resolve();
        if (!closed && !error) this.fail();
        return Promise.resolve();
      },
      [Symbol.dispose]() { this.fail(); },
    };
  };
}
// fs/promises registers FileHandle here when it loads, which can be while the startup heap
// image is built, before any flag is parsed; bootstrap installs once --experimental-stream-iter is seen.
let registered = null;
function register(FileHandle, internals) { registered = { FileHandle, internals }; }
function install() { if (registered !== null) { installOn(registered.FileHandle, registered.internals); registered = null; } }
module.exports = { register, install };
