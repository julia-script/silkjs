'use strict';
const c = require('internal/fs_core');
const p = require('path');
const { Buffer, os, constants, Stats, Dirent, StatFs } = c;
const fs = module.exports;
Object.assign(fs, { constants, Stats, Dirent, StatFs });
for (const name of ['F_OK', 'R_OK', 'W_OK', 'X_OK']) {
  const value = constants[name];
  Object.defineProperty(fs, name, {
    get: require('util').deprecate(() => value, `fs.${name} is deprecated, use fs.constants.${name} instead`, 'DEP0176'),
  });
}
function target(value) { return typeof value === 'number' ? c.fd(value) : c.path(value); }
function opts(value, defaults) { return c.options(value, defaults); }
fs.openSync = function openSync(path, flags = 'r', mode) { return c.native('open', [c.path(path), c.flags(flags), c.mode(mode)]); };
fs.closeSync = function closeSync(fd) { c.native('close', [c.fd(fd)]); };
function readArgs(buffer, offset, length, position) {
  if (!ArrayBuffer.isView(buffer)) { const o = opts(buffer); buffer = o.buffer === undefined ? Buffer.alloc(16384) : o.buffer; offset = o.offset; length = o.length; position = o.position; }
  else if (offset && typeof offset === 'object') { const o = offset; offset = o.offset; length = o.length; position = o.position; }
  const parts = c.slice(buffer, offset, length);
  return [parts[0], parts[1], parts[2], c.position(position)];
}
function writeArgs(buffer, offset, length, position) {
  if (typeof buffer === 'string') { const original = buffer; const enc = typeof length === 'string' ? length : typeof offset === 'string' ? offset : 'utf8'; buffer = Buffer.from(buffer, c.encoding(enc)); return [buffer, 0, buffer.byteLength, c.position(typeof offset === 'number' || typeof offset === 'bigint' ? offset : null), original]; }
  if (offset && typeof offset === 'object') { const o = offset; offset = o.offset; length = o.length; position = o.position; }
  const parts = c.slice(buffer, offset, length);
  return [parts[0], parts[1], parts[2], c.position(position), buffer];
}
function transfer(operation, fd, buffer, offset, length, position) {
  c.fd(fd);
  if (position !== null) return c.native(operation === 'read' ? 'pread' : 'pwrite', [fd, buffer.buffer, buffer.byteOffset + offset, length, position]);
  return c.fail(os[operation](fd, buffer.buffer, buffer.byteOffset + offset, length), operation);
}
fs.readSync = function readSync(fd, buffer, offset, length, position) { return transfer('read', fd, ...readArgs(buffer, offset, length, position)); };
fs.writeSync = function writeSync(fd, buffer, offset, length, position) { return transfer('write', fd, ...writeArgs(buffer, offset, length, position).slice(0, 4)); };
function vector(operation, fd, buffers, position) {
  c.fd(fd); if (!Array.isArray(buffers)) throw c.invalid('buffers', 'an array');
  buffers.forEach(c.bytes); position = c.position(position); let total = 0;
  for (const buffer of buffers) {
    const count = transfer(operation, fd, buffer, 0, buffer.byteLength, position);
    total += count;
    if (position !== null) position += typeof position === 'bigint' ? BigInt(count) : count;
    if (count < buffer.byteLength) break;
  }
  return total;
}
fs.readvSync = (fd, buffers, position) => vector('read', fd, buffers, position);
fs.writevSync = (fd, buffers, position) => vector('write', fd, buffers, position);
function stat(operation, path, options) {
  options = opts(options); path = operation === 'fstat' ? c.fd(path) : c.path(path);
  try { const value = c.native(operation, [path, options]); return value === undefined ? undefined : new Stats(value, !!options.bigint); }
  catch (e) { if (options.throwIfNoEntry === false && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return undefined; throw e; }
}
fs.statSync = (path, options) => stat('stat', path, options);
fs.lstatSync = (path, options) => stat('lstat', path, options);
fs.fstatSync = (fd, options) => stat('fstat', fd, options);
fs.statfsSync = (path, options) => { path = c.path(path); options = opts(options); return new StatFs(c.native('statfs', [path, options]), !!options.bigint); };
fs.existsSync = function existsSync(path) { try { fs.statSync(path); return true; } catch (_) { return false; } };
fs.accessSync = function accessSync(path, mode = constants.F_OK) { c.native('access', [c.path(path), c.integer(mode, 'mode', 0, 7)]); };
fs.renameSync = function renameSync(oldPath, newPath) { oldPath = c.path(oldPath); newPath = c.path(newPath); c.fail(os.rename(oldPath, newPath), 'rename', oldPath, newPath); };
fs.unlinkSync = function unlinkSync(path) { c.native('unlink', [c.path(path)]); };
fs.linkSync = function linkSync(existingPath, newPath) { c.native('link', [c.path(existingPath), c.path(newPath)]); };
fs.symlinkSync = function symlinkSync(target, path, type) { target = c.path(target); path = c.path(path); if (type !== undefined && !['file', 'dir', 'junction'].includes(type)) throw c.invalid('type', 'file, dir, or junction'); c.fail(os.symlink(target, path), 'symlink', target, path); };
fs.readlinkSync = function readlinkSync(path, options) { path = c.path(path); const enc = c.encoding(opts(options).encoding, 'utf8', true); return c.encoded(c.pair(os.readlink(path), 'readlink', path), enc); };
fs.realpathSync = function realpathSync(path, options) { path = c.path(path); const enc = c.encoding(opts(options).encoding, 'utf8', true); return c.encoded(c.pair(os.realpath(path), 'realpath', path), enc); };
fs.realpathSync.native = fs.realpathSync;
for (const operation of ['chmod', 'fchmod', 'lchmod']) fs[`${operation}Sync`] = function(path, mode) { c.native(operation, [operation[0] === 'f' ? c.fd(path) : c.path(path), c.mode(mode)]); };
for (const operation of ['chown', 'fchown', 'lchown']) fs[`${operation}Sync`] = function(path, uid, gid) { c.native(operation, [operation[0] === 'f' ? c.fd(path) : c.path(path), c.integer(uid, 'uid', -1, 0xffffffff), c.integer(gid, 'gid', -1, 0xffffffff)]); };
for (const operation of ['fsync', 'fdatasync']) fs[`${operation}Sync`] = function(fd) { c.native(operation, [c.fd(fd)]); };
fs.truncateSync = function truncateSync(path, length = 0) { c.native(typeof path === 'number' ? 'ftruncate' : 'truncate', [target(path), c.integer(length, 'len')]); };
fs.ftruncateSync = function ftruncateSync(fd, length = 0) { c.native('ftruncate', [c.fd(fd), c.integer(length, 'len')]); };
fs.utimesSync = function utimesSync(path, atime, mtime) { path = c.path(path); c.fail(os.utimes(path, c.time(atime) * 1000, c.time(mtime) * 1000), 'utime', path); };
fs.futimesSync = function futimesSync(fd, atime, mtime) { c.native('futimes', [c.fd(fd), c.time(atime), c.time(mtime)]); };
fs.lutimesSync = function lutimesSync(path, atime, mtime) { c.native('lutimes', [c.path(path), c.time(atime), c.time(mtime)]); };
function mkdirOptions(options) { return typeof options === 'number' || typeof options === 'string' ? { mode: c.mode(options, 0o777), recursive: false } : opts(options, { mode: 0o777, recursive: false }); }
fs.mkdirSync = function mkdirSync(path, options) {
  path = c.path(path); const o = mkdirOptions(options); const mode = c.mode(o.mode, 0o777);
  if (!o.recursive) { c.fail(os.mkdir(path, mode), 'mkdir', path); return; }
  let first;
  function create(current) {
    const result = os.mkdir(current, mode);
    if (result >= 0) { if (first === undefined) first = current; return; }
    try { c.fail(result, 'mkdir', current); } catch (e) {
      if (e.code === 'ENOENT') { const parent = p.dirname(current); if (parent === current) throw e; create(parent); c.fail(os.mkdir(current, mode), 'mkdir', current); if (first === undefined) first = current; }
      else if (e.code !== 'EEXIST' || !fs.statSync(current).isDirectory()) throw e;
    }
  }
  create(path); return first;
};
fs.readdirSync = function readdirSync(path, options) {
  path = c.path(path); const o = opts(options, { encoding: 'utf8', withFileTypes: false, recursive: false }); c.encoding(o.encoding, 'utf8', true);
  const output = [];
  function visit(dir, relative) {
    for (const name of c.native('scandir', [dir])) {
      if (name === '.' || name === '..') continue;
      const full = p.join(dir, name); const rel = relative ? p.join(relative, name) : name;
      const info = o.withFileTypes || o.recursive ? fs.lstatSync(full) : null;
      output.push(o.withFileTypes ? new Dirent(c.encoded(name, o.encoding), info.mode, dir) : c.encoded(rel, o.encoding));
      if (o.recursive && info.isDirectory()) visit(full, rel);
    }
  }
  visit(path, ''); return output;
};
fs.rmdirSync = function rmdirSync(path, options) { path = c.path(path); const o = opts(options); if (o.recursive) { const info = fs.lstatSync(path); if (!info.isDirectory()) throw c.error('ENOTDIR', 'rmdir', path); fs.rmSync(path, { recursive: true }); } else c.native('rmdir', [path]); };
fs.rmSync = function rmSync(path, options) {
  path = c.path(path); const o = opts(options, { recursive: false, force: false }); let info;
  try { info = fs.lstatSync(path); } catch (e) { if (o.force && e.code === 'ENOENT') return; throw e; }
  if (info.isDirectory()) {
    if (!o.recursive) { const e = c.error('ERR_FS_EISDIR', 'rm', path); e.info = { code: 'EISDIR', syscall: 'rm', path }; throw e; }
    for (const name of fs.readdirSync(path)) fs.rmSync(p.join(path, name), o);
    c.native('rmdir', [path]);
  } else fs.unlinkSync(path);
};
fs.readFileSync = function readFileSync(path, options) {
  const o = opts(options, { encoding: null, flag: 'r' }); if (o.encoding != null) c.encoding(o.encoding); c.aborted(o.signal);
  path = target(path); const owned = typeof path !== 'number'; const fd = owned ? fs.openSync(path, o.flag) : path;
  try {
    const chunks = []; let total = 0;
    for (;;) { c.aborted(o.signal); const buffer = Buffer.allocUnsafe(65536); const count = fs.readSync(fd, buffer, 0, buffer.length, null); if (count === 0) break; chunks.push(count === buffer.length ? buffer : buffer.subarray(0, count)); total += count; }
    const result = Buffer.concat(chunks, total); return o.encoding == null ? result : result.toString(o.encoding);
  } finally { if (owned) fs.closeSync(fd); }
};
function writeFile(path, data, options, append) {
  const o = opts(options, { encoding: 'utf8', mode: 0o666, flag: append ? 'a' : 'w', flush: false }); c.encoding(o.encoding); c.aborted(o.signal);
  data = typeof data === 'string' ? Buffer.from(data, o.encoding) : c.bytes(data); path = target(path);
  const owned = typeof path !== 'number'; const fd = owned ? fs.openSync(path, o.flag, o.mode) : path;
  try { let offset = 0; while (offset < data.byteLength) { c.aborted(o.signal); const count = fs.writeSync(fd, data, offset, data.byteLength - offset, null); if (count === 0) throw c.error('EIO', 'write', owned ? path : undefined); offset += count; } if (o.flush) fs.fsyncSync(fd); }
  finally { if (owned) fs.closeSync(fd); }
}
fs.writeFileSync = (path, data, options) => writeFile(path, data, options, false);
fs.appendFileSync = (path, data, options) => writeFile(path, data, options, true);
fs.copyFileSync = function copyFileSync(src, dest, mode = 0) {
  src = c.path(src); dest = c.path(dest); c.integer(mode, 'mode', 0, 7);
  c.native('copyFile', [src, dest, mode]);
};
fs.cpSync = function cpSync(src, dest, options) {
  src = c.path(src); dest = c.path(dest); const o = opts(options, { recursive: false, force: true, errorOnExist: false, dereference: false, preserveTimestamps: false, verbatimSymlinks: false, mode: 0 });
  const rootSource = p.resolve(src); const rootDest = p.resolve(dest);
  if (rootSource === rootDest || rootDest.startsWith(rootSource + p.sep)) throw c.error('ERR_FS_CP_EINVAL', 'cp', src, dest);
  const sourceRootStat = o.dereference ? fs.statSync(src) : fs.lstatSync(src);
  if (sourceRootStat.isDirectory()) {
    const sourceReal = fs.realpathSync(src); let parent = rootDest; const suffix = [];
    for (;;) {
      try {
        const destinationReal = p.resolve(fs.realpathSync(parent), ...suffix);
        if (destinationReal === sourceReal || destinationReal.startsWith(sourceReal.endsWith(p.sep) ? sourceReal : sourceReal + p.sep)) throw c.error('ERR_FS_CP_EINVAL', 'cp', src, dest);
        break;
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        const next = p.dirname(parent); if (next === parent) throw e;
        suffix.unshift(p.basename(parent)); parent = next;
      }
    }
  }
  const ancestors = new Set();
  function copy(from, to) {
    if (o.filter) { const accepted = o.filter(from, to); if (accepted && typeof accepted.then === 'function') throw c.invalid('filter', 'a synchronous boolean-returning function'); if (!accepted) return; }
    const source = o.dereference ? fs.statSync(from) : fs.lstatSync(from);
    const existing = fs.lstatSync(to, { throwIfNoEntry: false });
    if (existing && source.dev === existing.dev && source.ino === existing.ino) throw c.error('ERR_FS_CP_EINVAL', 'cp', from, to);
    if (source.isDirectory()) {
      if (!o.recursive) throw c.error('ERR_FS_EISDIR', 'cp', from, to);
      if (existing && !existing.isDirectory()) throw c.error('ERR_FS_CP_DIR_TO_NON_DIR', 'cp', from, to);
      const identity = `${source.dev}:${source.ino}`; if (ancestors.has(identity)) throw c.error('ELOOP', 'cp', from, to);
      ancestors.add(identity);
      try { if (!existing) fs.mkdirSync(to, { recursive: true, mode: Number(source.mode) & 0o777 }); for (const name of fs.readdirSync(from)) copy(p.join(from, name), p.join(to, name)); if (!existing) fs.chmodSync(to, Number(source.mode) & 0o777); }
      finally { ancestors.delete(identity); }
    } else {
      if (existing) { if (existing.isDirectory()) throw c.error('ERR_FS_CP_NON_DIR_TO_DIR', 'cp', from, to); if (!o.force) { if (o.errorOnExist) throw c.error('EEXIST', 'cp', from, to); return; } fs.unlinkSync(to); }
      fs.mkdirSync(p.dirname(to), { recursive: true });
      if (source.isSymbolicLink()) { let link = fs.readlinkSync(from); if (!o.verbatimSymlinks) link = p.resolve(p.dirname(from), link); fs.symlinkSync(link, to); }
      else if (source.isFile()) { fs.copyFileSync(from, to, o.mode); if (o.preserveTimestamps) fs.utimesSync(to, source.atime, source.mtime); }
      else throw c.error(source.isSocket() ? 'ERR_FS_CP_SOCKET' : source.isFIFO() ? 'ERR_FS_CP_FIFO_PIPE' : 'ERR_FS_CP_UNKNOWN', 'cp', from, to);
    }
  }
  copy(src, dest);
};
fs.mkdtempSync = function mkdtempSync(prefix, options) { prefix = c.path(prefix); const enc = c.encoding(opts(options).encoding, 'utf8', true); return c.encoded(c.native('mkdtemp', [prefix]), enc); };
fs.mkdtempDisposableSync = function mkdtempDisposableSync(prefix, options) {
  const path = fs.mkdtempSync(prefix, options); let removed = false;
  const result = { path, remove() { if (!removed) { fs.rmSync(path, { recursive: true, force: true }); removed = true; } } };
  if (Symbol.dispose) result[Symbol.dispose] = result.remove;
  return result;
};

// Every callback entry point crosses submitIO. The executor owns scheduling and
// performs filesystem work off-thread; these wrappers only normalize JS values.
function asyncSimple(name, normalize, result) {
  fs[name] = function(...args) { const cb = c.callback(args.pop()); const normalized = normalize(args); c.submit(name, normalized, (err, value) => { if (err) { cb(err); return; } cb(null, result ? result(value, normalized) : value); }, cb); };
}
asyncSimple('open', a => [c.path(a[0]), c.flags(a[1]), c.mode(a[2])]);
for (const name of ['close', 'fsync', 'fdatasync']) asyncSimple(name, a => [c.fd(a[0])]);
for (const name of ['stat', 'lstat', 'fstat']) asyncSimple(name, a => [name === 'fstat' ? c.fd(a[0]) : c.path(a[0]), opts(a[1])], (value, a) => value === undefined ? undefined : new Stats(value, !!a[1].bigint));
asyncSimple('statfs', a => [c.path(a[0]), opts(a[1])], (value, a) => new StatFs(value, !!a[1].bigint));
asyncSimple('access', a => [c.path(a[0]), a[1] === undefined ? constants.F_OK : c.integer(a[1], 'mode', 0, 7)]);
for (const name of ['rename', 'link']) asyncSimple(name, a => [c.path(a[0]), c.path(a[1])]);
asyncSimple('unlink', a => [c.path(a[0])]);
asyncSimple('symlink', a => [c.path(a[0]), c.path(a[1]), a[2]]);
for (const name of ['readlink', 'realpath', 'mkdtemp']) asyncSimple(name, a => [c.path(a[0]), Object.assign(opts(a[1]), { encoding: c.encoding(opts(a[1]).encoding, 'utf8', true) })], (value, a) => typeof value === 'string' ? c.encoded(value, a[1].encoding) : a[1].encoding === 'buffer' ? Buffer.from(value) : Buffer.from(value).toString(a[1].encoding));
fs.realpath.native = fs.realpath;
for (const name of ['chmod', 'fchmod', 'lchmod']) asyncSimple(name, a => [name[0] === 'f' ? c.fd(a[0]) : c.path(a[0]), c.mode(a[1])]);
for (const name of ['chown', 'fchown', 'lchown']) asyncSimple(name, a => [name[0] === 'f' ? c.fd(a[0]) : c.path(a[0]), c.integer(a[1], 'uid', -1, 0xffffffff), c.integer(a[2], 'gid', -1, 0xffffffff)]);
for (const name of ['utimes', 'futimes', 'lutimes']) asyncSimple(name, a => [name === 'futimes' ? c.fd(a[0]) : c.path(a[0]), c.time(a[1]), c.time(a[2])]);
for (const name of ['truncate', 'ftruncate']) asyncSimple(name, a => [name === 'ftruncate' ? c.fd(a[0]) : target(a[0]), a[1] === undefined ? 0 : c.integer(a[1], 'len')]);
asyncSimple('mkdir', a => [c.path(a[0]), mkdirOptions(a[1])]);
for (const name of ['rm', 'rmdir']) asyncSimple(name, a => [c.path(a[0]), opts(a[1])]);
asyncSimple('copyFile', a => [c.path(a[0]), c.path(a[1]), a[2] === undefined ? 0 : c.integer(a[2], 'mode', 0, 7)]);
asyncSimple('cp', a => [c.path(a[0]), c.path(a[1]), opts(a[2])]);
asyncSimple('readdir', a => { const o = opts(a[1], { encoding: 'utf8' }); c.encoding(o.encoding, 'utf8', true); return [c.path(a[0]), o]; }, (value, a) => value.map(entry => a[1].withFileTypes ? entry instanceof Dirent ? entry : new Dirent(c.encoded(entry.name, a[1].encoding), entry.mode, entry.parentPath === undefined ? a[0] : entry.parentPath) : typeof entry === 'string' ? c.encoded(entry, a[1].encoding) : Buffer.from(entry)));
asyncSimple('readFile', a => { const o = opts(a[1], { encoding: null, flag: 'r' }); if (o.encoding != null) c.encoding(o.encoding); else o.encoding = null; o.flag = c.flags(o.flag); return [target(a[0]), o]; }, (value, a) => a[1].encoding === null ? Buffer.from(value) : typeof value === 'string' ? value : Buffer.from(value).toString(a[1].encoding));
for (const name of ['writeFile', 'appendFile']) asyncSimple(name, a => { const o = opts(a[2], { encoding: 'utf8', mode: 0o666, flag: name === 'appendFile' ? 'a' : 'w' }); c.encoding(o.encoding); o.flag = c.flags(o.flag); o.mode = c.mode(o.mode); const data = typeof a[1] === 'string' ? Buffer.from(a[1], o.encoding) : c.bytes(a[1]); return [target(a[0]), data, o]; });
fs.read = function read(fd, ...args) { const cb = c.callback(args.pop()); const [buffer, offset, length, position] = readArgs(...args); c.submit('read', [c.fd(fd), buffer, offset, length, position], (err, count) => cb(err || null, count || 0, buffer), cb); };
fs.write = function write(fd, ...args) { const cb = c.callback(args.pop()); const [buffer, offset, length, position, original] = writeArgs(...args); c.submit('write', [c.fd(fd), buffer, offset, length, position], (err, count) => cb(err || null, count || 0, original), cb); };
for (const name of ['readv', 'writev']) fs[name] = function(fd, buffers, position, callback) { if (typeof position === 'function') { callback = position; position = null; } c.callback(callback); if (!Array.isArray(buffers)) throw c.invalid('buffers', 'an array'); buffers.forEach(c.bytes); c.submit(name, [c.fd(fd), buffers, c.position(position)], (err, count) => callback(err || null, count || 0, buffers), callback); };
fs.exists = function exists(path, callback) { c.callback(callback); let normalized; try { normalized = c.path(path); } catch (_) { c.submit('exists', [path], (_err, exists) => callback(!!exists)); return; } c.submit('exists', [normalized], (err, exists) => callback(!err && !!exists)); };

const { Dir, FSWatcher, StatWatcher, watch, watchFile, unwatchFile } = require('internal/fs_handles');
Object.assign(fs, { Dir, FSWatcher, StatWatcher, watch, watchFile, unwatchFile });
fs.opendirSync = function opendirSync(path, options) { path = c.path(path); return new Dir(path, fs.readdirSync(path, Object.assign(opts(options), { withFileTypes: true }))); };
fs.opendir = function opendir(path, options, callback) { if (typeof options === 'function') { callback = options; options = undefined; } c.callback(callback); path = c.path(path); c.submit('opendir', [path, opts(options)], (err, entries) => callback(err || null, err ? undefined : new Dir(path, entries.map(e => e instanceof Dirent ? e : new Dirent(e.name, e.mode, e.parentPath === undefined ? path : e.parentPath)))), callback); };
const streamConstructors = {};
for (const name of ['ReadStream', 'WriteStream', 'FileReadStream', 'FileWriteStream']) {
  Object.defineProperty(fs, name, {
    enumerable: true, configurable: true,
    get() {
      if (!streamConstructors.ReadStream) {
        const { ReadStream, WriteStream } = require('internal/fs_streams');
        Object.assign(streamConstructors, { ReadStream, WriteStream, FileReadStream: ReadStream, FileWriteStream: WriteStream });
      }
      return streamConstructors[name];
    },
    set(value) { streamConstructors[name] = value; },
  });
}
fs.createReadStream = (path, options) => new fs.ReadStream(path, options);
fs.createWriteStream = (path, options) => new fs.WriteStream(path, options);
Object.defineProperty(fs, 'Utf8Stream', { enumerable: true, configurable: true, get() { return require('internal/fs_utf8_stream'); } });
fs.globSync = function globSync(pattern, options) { return new (require('internal/fs_glob').Glob)(pattern, options).globSync(); };
fs.glob = function glob(pattern, options, callback) {
  if (typeof options === 'function') { callback = options; options = undefined; }
  c.callback(callback);
  const iterator = new (require('internal/fs_glob').Glob)(pattern, options).glob();
  (async () => { const results = []; for await (const entry of iterator) results.push(entry); return results; })().then(results => callback(null, results), callback);
};
fs.openAsBlob = function openAsBlob(path, options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw c.invalid('options', 'an object');
  const type = options.type || '';
  if (typeof type !== 'string') throw c.invalid('options.type', 'a string');
  path = c.path(path);
  const stat = fs.statSync(path, { bigint: true });
  return Promise.resolve(require('internal/web/blob')._fromFile(path, stat, type));
};
Object.defineProperty(fs, 'promises', { enumerable: true, get() { return require('fs/promises'); } });
