'use strict';
// Native callbacks are dispatched only by pollIO on the context's owning thread.
// The primitive callback is (negativeUvStatus, value, uvErrorName).
module.exports = function createAsyncFS(native) {
  const host = require('internal/host');
  let core;
  const c = () => core || (core = require('internal/fs_core'));
  const path = () => require('path');
  function primitive(requestKind, operation, args) {
    return new Promise((resolve, reject) => {
      native.submit(operation, args, (status, value, code) => {
        if (status < 0) reject(c().error(code || 'UNKNOWN', operation === 'copyFile' ? 'copyfile' : operation,
          typeof args[0] === 'string' ? args[0] : undefined,
          ['rename', 'link', 'symlink', 'copyFile'].includes(operation) ? args[1] : undefined, status));
        else resolve(value);
        host.checkpoint();
      }, requestKind);
    });
  }
  async function stat(requestKind, operation, filename, options = {}) {
    try { return await primitive(requestKind, operation, [filename, !!options.bigint]); }
    catch (error) { if (options.throwIfNoEntry === false && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return; throw error; }
  }
  function kind(info, type) { return (Number(info.mode) & 0o170000) === type; }
  async function withFD(requestKind, filename, flags, mode, action) {
    if (typeof filename === 'number') return action(filename);
    const fd = await primitive(requestKind, 'open', [filename, flags, mode]);
    let failure;
    try { return await action(fd); } catch (error) { failure = error; throw error; }
    finally { try { await primitive(requestKind, 'close', [fd]); } catch (error) { if (!failure) throw error; } }
  }
  async function transfer(requestKind, operation, fd, view, offset, length, position) {
    // Keep the complete view rooted by the promise until the native request ends.
    return primitive(requestKind, operation, [fd, view.buffer, view.byteOffset + offset, length, position == null ? -1 : position]);
  }
  async function mkdir(requestKind, filename, options = {}) {
    const mode = c().mode(options.mode, 0o777);
    if (!options.recursive) { await primitive(requestKind, 'mkdir', [filename, mode]); return; }
    let first;
    async function create(current) {
      try { await primitive(requestKind, 'mkdir', [current, mode]); if (first === undefined) first = current; }
      catch (error) {
        if (error.code === 'ENOENT') {
          const parent = path().dirname(current); if (parent === current) throw error;
          await create(parent);
          try { await primitive(requestKind, 'mkdir', [current, mode]); if (first === undefined) first = current; }
          catch (race) { if (race.code !== 'EEXIST' || !kind(await stat(requestKind, 'stat', current), 0o040000)) throw race; }
        } else if (error.code !== 'EEXIST' || !kind(await stat(requestKind, 'stat', current), 0o040000)) throw error;
      }
    }
    await create(filename); return first;
  }
  async function readdir(requestKind, filename, options = {}) {
    const result = [];
    async function visit(directory, relative) {
      const entries = await primitive(requestKind, 'scandir', [directory]);
      for (const entry of entries) {
        const name = typeof entry === 'string' ? entry : entry.name;
        if (name === '.' || name === '..') continue;
        const full = path().join(directory, name), rel = relative ? path().join(relative, name) : name;
        let mode = typeof entry === 'string' ? 0 : entry.mode;
        if ((options.withFileTypes || options.recursive) && !mode) mode = (await stat(requestKind, 'lstat', full)).mode;
        result.push(options.withFileTypes ? { name, mode, parentPath: directory } : rel);
        if (options.recursive && (Number(mode) & 0o170000) === 0o040000) await visit(full, rel);
      }
    }
    await visit(filename, ''); return result;
  }
  const retryable = new Set(['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM']);
  async function remove(requestKind, filename, options = {}) {
    async function attempt(current) {
      let info;
      try { info = await stat(requestKind, 'lstat', current); }
      catch (error) { if (options.force && error.code === 'ENOENT') return; throw error; }
      if (kind(info, 0o040000)) {
        if (!options.recursive) { const error = c().error('ERR_FS_EISDIR', 'rm', current); error.info = { code: 'EISDIR', syscall: 'rm', path: current }; throw error; }
        for (const name of await readdir(requestKind, current)) await remove(requestKind, path().join(current, name), options);
        await primitive(requestKind, 'rmdir', [current]);
      } else await primitive(requestKind, 'unlink', [current]);
    }
    for (let count = 0;; count++) {
      try { return await attempt(filename); }
      catch (error) {
        if (options.force && error.code === 'ENOENT') return;
        if (!options.recursive || !retryable.has(error.code) || count >= (options.maxRetries || 0)) throw error;
        await new Promise(resolve => setTimeout(resolve, (options.retryDelay === undefined ? 100 : options.retryDelay) * (count + 1)));
      }
    }
  }
  async function copy(requestKind, source, destination, options = {}) {
    const o = Object.assign({ recursive: false, force: true, errorOnExist: false, dereference: false, preserveTimestamps: false, verbatimSymlinks: false, mode: 0 }, options);
    const rootSource = path().resolve(source), rootDest = path().resolve(destination);
    if (rootSource === rootDest || rootDest.startsWith(rootSource + path().sep)) throw c().error('ERR_FS_CP_EINVAL', 'cp', source, destination);
    // Resolve the nearest existing destination ancestor to reject aliases into source.
    const rootInfo = await stat(requestKind, o.dereference ? 'stat' : 'lstat', source);
    if (kind(rootInfo, 0o040000)) {
      const realSource = await primitive(requestKind, 'realpath', [source]);
      let parent = rootDest; const suffix = [];
      for (;;) {
        try {
          const realDest = path().resolve(await primitive(requestKind, 'realpath', [parent]), ...suffix);
          if (realDest === realSource || realDest.startsWith(realSource.endsWith(path().sep) ? realSource : realSource + path().sep)) throw c().error('ERR_FS_CP_EINVAL', 'cp', source, destination);
          break;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          const next = path().dirname(parent); if (next === parent) throw error;
          suffix.unshift(path().basename(parent)); parent = next;
        }
      }
    }
    const ancestors = new Set();
    async function visit(from, to) {
      if (o.filter && !await o.filter(from, to)) return;
      const info = await stat(requestKind, o.dereference ? 'stat' : 'lstat', from);
      const existing = await stat(requestKind, 'lstat', to, { throwIfNoEntry: false });
      if (existing && info.dev === existing.dev && info.ino === existing.ino) throw c().error('ERR_FS_CP_EINVAL', 'cp', from, to);
      if (kind(info, 0o040000)) {
        if (!o.recursive) throw c().error('ERR_FS_EISDIR', 'cp', from, to);
        if (existing && !kind(existing, 0o040000)) throw c().error('ERR_FS_CP_DIR_TO_NON_DIR', 'cp', from, to);
        const identity = `${info.dev}:${info.ino}`;
        if (ancestors.has(identity)) throw c().error('ELOOP', 'cp', from, to);
        ancestors.add(identity);
        try {
          if (!existing) await mkdir(requestKind, to, { recursive: true, mode: Number(info.mode) & 0o777 });
          for (const name of await readdir(requestKind, from)) await visit(path().join(from, name), path().join(to, name));
          if (!existing) await primitive(requestKind, 'chmod', [to, Number(info.mode) & 0o777]);
        } finally { ancestors.delete(identity); }
      } else {
        if (existing) {
          if (kind(existing, 0o040000)) throw c().error('ERR_FS_CP_NON_DIR_TO_DIR', 'cp', from, to);
          if (!o.force) { if (o.errorOnExist) throw c().error('EEXIST', 'cp', from, to); return; }
          await primitive(requestKind, 'unlink', [to]);
        }
        await mkdir(requestKind, path().dirname(to), { recursive: true });
        if (kind(info, 0o120000)) {
          let link = await primitive(requestKind, 'readlink', [from]);
          if (!o.verbatimSymlinks) link = path().resolve(path().dirname(from), link);
          await primitive(requestKind, 'symlink', [link, to, 0]);
        } else if (kind(info, 0o100000)) {
          await primitive(requestKind, 'copyFile', [from, to, o.mode]);
          if (o.preserveTimestamps) {
            const mode = Number(info.mode) & 0o777;
            if (!(mode & 0o200)) await primitive(requestKind, 'chmod', [to, mode | 0o200]);
            try { await primitive(requestKind, 'utimes', [to, Number(info.atimeMs) / 1000, Number(info.mtimeMs) / 1000]); }
            finally { if (!(mode & 0o200)) await primitive(requestKind, 'chmod', [to, mode]); }
          }
        } else throw c().error(kind(info, 0o140000) ? 'ERR_FS_CP_SOCKET' : kind(info, 0o010000) ? 'ERR_FS_CP_FIFO_PIPE' : 'ERR_FS_CP_UNKNOWN', 'cp', from, to);
      }
    }
    await visit(source, destination);
  }
  async function execute(requestKind, operation, args) {
    switch (operation) {
      case 'read': case 'write': return transfer(requestKind, operation, ...args);
      case 'readv': case 'writev': {
        // A single transfer preserves the descriptor-position/append atomicity
        // of vectored IO; issuing one request per view would allow interleaving.
        const [fd, buffers, position] = args;
        const views = buffers.map(view => new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
        const total = views.reduce((sum, view) => sum + view.byteLength, 0);
        if (!total) return 0;
        if (views.length === 1) return transfer(requestKind, operation === 'readv' ? 'read' : 'write', fd, views[0], 0, total, position);
        const packed = c().Buffer.allocUnsafe(total);
        if (operation === 'writev') {
          let offset = 0;
          for (const view of views) { packed.set(view, offset); offset += view.byteLength; }
        }
        const count = await transfer(requestKind, operation === 'readv' ? 'read' : 'write', fd, packed, 0, total, position);
        if (operation === 'readv') {
          let offset = 0;
          for (const view of views) {
            const length = Math.min(view.byteLength, count - offset);
            if (length <= 0) break;
            view.set(packed.subarray(offset, offset + length)); offset += length;
          }
        }
        return count;
      }
      case 'stat': case 'lstat': case 'fstat': return stat(requestKind, operation, ...args);
      case 'statfs': return primitive(requestKind, operation, [args[0], !!(args[1] && args[1].bigint)]);
      case 'exists': try { await stat(requestKind, 'stat', c().path(args[0])); return true; } catch (_) { return false; }
      case 'mkdir': return mkdir(requestKind, ...args);
      case 'rm': return remove(requestKind, ...args);
      case 'rmdir':
        if (args[1] && args[1].recursive) {
          if (!kind(await stat(requestKind, 'lstat', args[0]), 0o040000)) throw c().error('ENOTDIR', 'rmdir', args[0]);
          return remove(requestKind, args[0], Object.assign({}, args[1], { recursive: true, force: false }));
        }
        await primitive(requestKind, 'rmdir', [args[0]]); return;
      case 'readdir': return readdir(requestKind, ...args);
      case 'opendir': {
        const o = Object.assign({}, args[1], { withFileTypes: true });
        const entries = await readdir(requestKind, args[0], o);
        return entries.map(entry => Object.assign(entry, { name: c().encoded(entry.name, c().encoding(o.encoding, 'utf8', true)) }));
      }
      case 'cp': return copy(requestKind, ...args);
      case 'truncate':
        if (typeof args[0] === 'number') { await primitive(requestKind, 'ftruncate', args); return; }
        return withFD(requestKind, args[0], c().flags('r+'), 0o666, async fd => { await primitive(requestKind, 'ftruncate', [fd, args[1]]); });
      case 'readFile': {
        const [filename, o] = args; c().aborted(o.signal);
        return withFD(requestKind, filename, o.flag, 0o666, async fd => {
          // As Node: a regular file over 2 GiB fails before any read.
          const info = await stat(requestKind, 'fstat', fd);
          if ((info.mode & 0o170000) === 0o100000 && info.size > 2 ** 31 - 1) throw c().v.makeError(RangeError, 'ERR_FS_FILE_TOO_LARGE', `File size (${info.size}) is greater than 2 GiB`);
          const chunks = []; let total = 0;
          for (;;) {
            c().aborted(o.signal);
            const buffer = c().Buffer.allocUnsafe(65536);
            const count = await transfer(requestKind, 'read', fd, buffer, 0, buffer.byteLength, null);
            c().aborted(o.signal); if (!count) break;
            chunks.push(count === buffer.byteLength ? buffer : buffer.subarray(0, count)); total += count;
          }
          return c().Buffer.concat(chunks, total);
        });
      }
      case 'writeFile': case 'appendFile': {
        const [filename, data, o] = args; c().aborted(o.signal);
        return withFD(requestKind, filename, o.flag, o.mode, async fd => {
          let offset = 0;
          while (offset < data.byteLength) {
            c().aborted(o.signal);
            const count = await transfer(requestKind, 'write', fd, data, offset, data.byteLength - offset, null);
            if (!count) throw c().error('EIO', 'write', typeof filename === 'string' ? filename : undefined);
            offset += count;
          }
          c().aborted(o.signal); if (o.flush) await primitive(requestKind, 'fsync', [fd]);
        });
      }
      case 'symlink': return primitive(requestKind, operation, [args[0], args[1], args[2] === 'dir' ? 1 : args[2] === 'junction' ? 2 : 0]).then(() => undefined);
      case 'mkdtemp': return primitive(requestKind, operation, [args[0] + 'XXXXXX']);
      case 'readlink': case 'realpath': return primitive(requestKind, operation, [args[0]]);
      case 'open': return primitive(requestKind, operation, args);
      default: await primitive(requestKind, operation, args); return;
    }
  }
  // read and write of one view finish straight from the native callback: no promise
  // hops, which cost more than the system call for a 64 KiB chunk.
  function transferIO(operation, args, callback, requestKind) {
    const fd = args[0], view = args[1], position = args[4];
    const done = (status, value, code) => {
      // The native request holds view.buffer until it ends.
      const error = status < 0 ? c().error(code || 'UNKNOWN', operation, undefined, undefined, status) : null;
      host.enqueueIOCompletion(error === null ? () => callback(null, value) : () => callback(error));
      host.checkpoint();
    };
    try { native.submit(operation, [fd, view.buffer, view.byteOffset + args[2], args[3], position == null ? -1 : position], done, requestKind); }
    catch (error) { Promise.resolve().then(() => host.enqueueIOCompletion(() => callback(error))); }
  }
  function submitIO(operation, args, callback, requestKind) {
    if (operation === 'read' || operation === 'write') { transferIO(operation, args, callback, requestKind); return; }
    // execute is async: preparation starts now, failures reject asynchronously.
    // Dispatch outside the Promise queue: callback exceptions are uncaught
    // exceptions, and each completion gets its own nextTick/microtask boundary.
    execute(requestKind, operation, args).then(
      value => host.enqueueIOCompletion(() => callback(null, value)),
      error => host.enqueueIOCompletion(() => callback(error)));
  }
  function watch(filename, options, callback) {
    const id = native.watch(filename, !!options.stat, options.stat ? options.interval : options.recursive ? 4 : 0, !!options.bigint,
      (status, first, second, code) => {
        if (status < 0) {
          if (options.stat && code === 'ENOENT') { callback(null, first || {}, second || {}); return; }
          callback(c().error(code || 'UNKNOWN', options.stat ? 'watchFile' : 'watch', filename, undefined, status));
        } else callback(null, options.stat ? first : first & 1 ? 'rename' : 'change', second);
      });
    let closed = false;
    const handle = {
      close() { if (!closed) { closed = true; native.watchControl(id, 0); } },
      ref() { if (!closed) native.watchControl(id, 1); return handle; },
      unref() { if (!closed) native.watchControl(id, 2); return handle; },
      hasRef() { return !closed && native.watchControl(id, 3); }
    };
    if (options.persistent === false) handle.unref();
    return handle;
  }
  return { submitIO, watch };
};
