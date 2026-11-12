'use strict';
const host = require('internal/host');
const { Buffer } = require('buffer');
const trace = require('internal/trace_events');
// fs's view of the os functions. Lookups fall through to host.rawOS, so they see the
// permission model's wrappers; sync tracing shadows a few with own properties while on.
const rawOS = host.rawOS;
const os = Object.create(rawOS);
const std = host.rawStd;
// fs.constants as Node builds it (src/node_constants.cc): the names Node exports, in its order,
// with values from the platform and libuv's own UV_* definitions.
const constants = (() => {
  const uv = { UV_FS_SYMLINK_DIR: 1, UV_FS_SYMLINK_JUNCTION: 2, UV_DIRENT_UNKNOWN: 0, UV_DIRENT_FILE: 1, UV_DIRENT_DIR: 2, UV_DIRENT_LINK: 3, UV_DIRENT_FIFO: 4, UV_DIRENT_SOCKET: 5, UV_DIRENT_CHAR: 6, UV_DIRENT_BLOCK: 7, UV_FS_O_FILEMAP: 0, UV_FS_O_TEMPORARY: 0, UV_FS_O_SHORT_LIVED: 0, UV_FS_O_SEQUENTIAL: 0, UV_FS_O_RANDOM: 0 };
  const source = Object.assign({}, rawOS, host.fsConstants, uv);
  const names = ['UV_FS_SYMLINK_DIR', 'UV_FS_SYMLINK_JUNCTION', 'O_RDONLY', 'O_WRONLY', 'O_RDWR', 'UV_DIRENT_UNKNOWN', 'UV_DIRENT_FILE', 'UV_DIRENT_DIR', 'UV_DIRENT_LINK', 'UV_DIRENT_FIFO', 'UV_DIRENT_SOCKET', 'UV_DIRENT_CHAR', 'UV_DIRENT_BLOCK', 'S_IFMT', 'S_IFREG', 'S_IFDIR', 'S_IFCHR', 'S_IFBLK', 'S_IFIFO', 'S_IFLNK', 'S_IFSOCK', 'O_CREAT', 'O_EXCL', 'UV_FS_O_FILEMAP', 'UV_FS_O_TEMPORARY', 'UV_FS_O_SHORT_LIVED', 'UV_FS_O_SEQUENTIAL', 'UV_FS_O_RANDOM', 'O_NOCTTY', 'O_TRUNC', 'O_APPEND', 'O_DIRECTORY', 'O_NOATIME', 'O_NOFOLLOW', 'O_SYNC', 'O_DSYNC', 'O_SYMLINK', 'O_DIRECT', 'O_NONBLOCK', 'S_IRWXU', 'S_IRUSR', 'S_IWUSR', 'S_IXUSR', 'S_IRWXG', 'S_IRGRP', 'S_IWGRP', 'S_IXGRP', 'S_IRWXO', 'S_IROTH', 'S_IWOTH', 'S_IXOTH', 'F_OK', 'R_OK', 'W_OK', 'X_OK', 'UV_FS_COPYFILE_EXCL', 'COPYFILE_EXCL', 'UV_FS_COPYFILE_FICLONE', 'COPYFILE_FICLONE', 'UV_FS_COPYFILE_FICLONE_FORCE', 'COPYFILE_FICLONE_FORCE'];
  const result = Object.create(null);
  for (const name of names) if (typeof source[name] === 'number') result[name] = source[name];
  return result;
})();
const errnoNames = { 1: 'EPERM', 2: 'ENOENT', 3: 'ESRCH', 4: 'EINTR', 5: 'EIO', 6: 'ENXIO', 7: 'E2BIG', 8: 'ENOEXEC', 9: 'EBADF', 10: 'ECHILD', 12: 'ENOMEM', 13: 'EACCES', 14: 'EFAULT', 16: 'EBUSY', 17: 'EEXIST', 18: 'EXDEV', 19: 'ENODEV', 20: 'ENOTDIR', 21: 'EISDIR', 22: 'EINVAL', 23: 'ENFILE', 24: 'EMFILE', 27: 'EFBIG', 28: 'ENOSPC', 29: 'ESPIPE', 30: 'EROFS', 31: 'EMLINK', 32: 'EPIPE' };
Object.assign(errnoNames, os.platform === 'darwin' ? { 11: 'EDEADLK', 35: 'EAGAIN', 45: 'ENOTSUP', 62: 'ELOOP', 63: 'ENAMETOOLONG', 66: 'ENOTEMPTY', 78: 'ENOSYS' } : { 11: 'EAGAIN', 36: 'ENAMETOOLONG', 38: 'ENOSYS', 39: 'ENOTEMPTY', 40: 'ELOOP', 95: 'ENOTSUP' });
function error(code, syscall, path, dest, errno) {
  const message = errno === undefined ? code : host.utilErrorMessage(-Math.abs(errno));
  const e = new Error(`${code}: ${message}, ${syscall}${path === undefined ? '' : ` '${path}'`}${dest === undefined ? '' : ` -> '${dest}'`}`);
  e.code = code; e.syscall = syscall;
  if (errno !== undefined) e.errno = -Math.abs(errno);
  if (path !== undefined) e.path = path;
  if (dest !== undefined) e.dest = dest;
  return e;
}
function fail(result, syscall, path, dest) {
  if (typeof result === 'number' && result < 0) throw error(errnoNames[-result] || 'UNKNOWN', syscall, path, dest, result);
  return result;
}
function pair(result, syscall, path) {
  if (result[1]) fail(-Math.abs(result[1]), syscall, path);
  return result[0];
}
const v = require('internal/validators');
const { AbortError, codes: { ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE, ERR_OUT_OF_RANGE } } = require('internal/errors');
// Legacy helpers for callers that state the expectation in words.
function invalid(name, expected) { const e = new TypeError(`The "${name}" argument must be ${expected}`); e.code = 'ERR_INVALID_ARG_TYPE'; return e; }
function range(name) { const e = new RangeError(`The value of "${name}" is out of range`); e.code = 'ERR_OUT_OF_RANGE'; return e; }
function integer(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) { v.validateInteger(value, name, min, max); return value; }
// Node's getValidatedPath: a string, a Uint8Array or a file: URL, without null bytes.
let urlToPath;
function toPathIfFileURL(value) {
  urlToPath ??= require('internal/url').toPathIfFileURL;
  return urlToPath(value);
}
function path(value, name = 'path') {
  value = toPathIfFileURL(value);
  if (typeof value === 'string') {
    if (value.includes('\0')) throw new ERR_INVALID_ARG_VALUE(name, value, 'must be a string, Uint8Array, or URL without null bytes');
    return value;
  }
  if (value instanceof Uint8Array) {
    if (value.includes(0)) throw new ERR_INVALID_ARG_VALUE(name, value, 'must be a string, Uint8Array, or URL without null bytes');
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString();
  }
  throw new ERR_INVALID_ARG_TYPE(name, ['string', 'Buffer', 'URL'], value);
}
function fd(value, name = 'fd') { if (Object.is(value, -0)) return 0; v.validateInt32(value, name, 0); return value; }
// Node's getOptions.
function options(value, defaults) {
  if (value === undefined || value === null || typeof value === 'function') return Object.assign({}, defaults);
  if (typeof value === 'string') { if (value !== 'buffer') assertEncoding(value); return Object.assign({}, defaults, { encoding: value }); }
  if (typeof value !== 'object') throw new ERR_INVALID_ARG_TYPE('options', ['string', 'Object'], value);
  const result = Object.assign({}, defaults, value);
  if (result.encoding !== 'buffer') assertEncoding(result.encoding);
  if (result.signal !== undefined) v.validateAbortSignal(result.signal, 'options.signal');
  return result;
}
function assertEncoding(value) { if (value && !Buffer.isEncoding(value)) throw new ERR_INVALID_ARG_VALUE('encoding', value, 'is invalid encoding'); }
function mode(value, fallback, name = 'mode') { return v.parseFileMode(value, name, fallback); }
function flags(value, name = 'flags') {
  if (typeof value === 'number') { v.validateInt32(value, name); return value + 0; }
  if (value == null) return constants.O_RDONLY;
  const c = constants;
  switch (value) {
    case 'r': return c.O_RDONLY;
    case 'rs': case 'sr': return c.O_RDONLY | syncFlag();
    case 'r+': return c.O_RDWR;
    case 'rs+': case 'sr+': return c.O_RDWR | syncFlag();
    case 'w': return c.O_TRUNC | c.O_CREAT | c.O_WRONLY;
    case 'wx': case 'xw': return c.O_TRUNC | c.O_CREAT | c.O_WRONLY | c.O_EXCL;
    case 'w+': return c.O_TRUNC | c.O_CREAT | c.O_RDWR;
    case 'wx+': case 'xw+': return c.O_TRUNC | c.O_CREAT | c.O_RDWR | c.O_EXCL;
    case 'a': return c.O_APPEND | c.O_CREAT | c.O_WRONLY;
    case 'ax': case 'xa': return c.O_APPEND | c.O_CREAT | c.O_WRONLY | c.O_EXCL;
    case 'as': case 'sa': return c.O_APPEND | c.O_CREAT | c.O_WRONLY | syncFlag();
    case 'a+': return c.O_APPEND | c.O_CREAT | c.O_RDWR;
    case 'ax+': case 'xa+': return c.O_APPEND | c.O_CREAT | c.O_RDWR | c.O_EXCL;
    case 'as+': case 'sa+': return c.O_APPEND | c.O_CREAT | c.O_RDWR | syncFlag();
  }
  throw new ERR_INVALID_ARG_VALUE('flags', value);
}
function syncFlag() { if (constants.O_SYNC === undefined) throw error('ENOSYS', 'open'); return constants.O_SYNC; }
// Private native extension: fsSync(name, positionalArgs) returns a Node result
// or throws an Error retaining code, errno, syscall, path, and dest. Unlike the
// QuickJS os API, it must not return negative errno values or [value, errno].
// pread/pwrite receive [fd, ArrayBuffer, absoluteByteOffset, length, position]
// and preserve the descriptor's current offset. Metadata includes blksize,
// birthtimeMs and, for bigint requests, exact integer fields and *timeNs.
const kSyncCategory = 'node,node.fs,node.fs.sync';
// Node names a sync trace event after its binding call: copyFile is copyfile, scandir readdir.
const syncNames = { __proto__: null, copyFile: 'copyfile', scandir: 'readdir' };
function traced(operation, call, self, args) {
  const name = `fs.sync.${syncNames[operation] ?? operation}`;
  trace.emit(kSyncCategory, name, 'B');
  try { return Reflect.apply(call, self, args); }
  finally { trace.emit(kSyncCategory, name, 'E'); }
}
function native(operation, args) {
  if (typeof host.fsSync !== 'function') throw error('ENOSYS', operation, typeof args[0] === 'string' ? args[0] : undefined);
  if (!syncTracing) return host.fsSync(operation, args);
  return traced(operation, host.fsSync, host, [operation, args]);
}
// The sync calls fs makes on os directly, traced only while the category is on.
const tracedOS = ['mkdir', 'read', 'readlink', 'realpath', 'rename', 'symlink', 'utimes', 'write'];
let syncTracing = false;
trace.watch(kSyncCategory, on => {
  syncTracing = on;
  for (const name of tracedOS) {
    if (on) os[name] = function (...args) { return traced(name, rawOS[name], rawOS, args); };
    else delete os[name];
  }
});
function callback(value) { v.validateFunction(value, 'cb'); return value; }
// Native ownership kinds: callback, Promise, and FileHandle-close respectively.
const promiseCallbacks = new WeakMap();
function promiseCallback(cb, kind = 1) {
  if (kind) promiseCallbacks.set(cb, kind);
  return cb;
}
// submitIO owns off-thread execution and delivers exactly one callback on the
// JS thread, never before returning. It retains views until completion and
// scatters read results into their original buffers. Args use Node units
// (timestamps in seconds); flags are numeric where normalized by fs.js.
// AbortSignal and cp.filter require JS-thread orchestration by the executor.
function submit(operation, args, cb, owner = cb) {
  callback(cb);
  if (typeof host.submitIO !== 'function') throw error('ENOSYS', operation);
  const requestKind = promiseCallbacks.get(owner) || 0;
  if (requestKind === 0 && host.builtinLoaded('internal/permission')) require('internal/permission').checkCallbackFile(operation, args);
  if (!trace.enabled('node,node.fs,node.fs.async')) { host.submitIO(operation, args, cb, requestKind); return; }
  const id = trace.begin('node,node.fs,node.fs.async', operation);
  try {
    host.submitIO(operation, args, function(error, ...values) {
      trace.end('node,node.fs,node.fs.async', operation, id, error ? { error: error.code } : {});
      return Reflect.apply(cb, this, [error, ...values]);
    }, requestKind);
  } catch (error) {
    trace.end('node,node.fs,node.fs.async', operation, id, { error: error.code });
    throw error;
  }
}
// Node's toUnixTimestamp: a Date, a finite number or a numeric string, in seconds.
function time(value, name = 'time') {
  if (typeof value === 'string' && +value == value) return +value;
  if (Number.isFinite(value)) return value < 0 ? Date.now() / 1000 : value;
  if (value instanceof Date) return value.getTime() / 1000;
  throw new ERR_INVALID_ARG_TYPE(name, ['Date', 'Time in seconds'], value);
}
function bytes(value, name = 'buffer') { v.validateBuffer(value, name); return value; }
// Node's validatePosition; null, undefined and -1 mean the current position.
function position(value, name = 'position', length = 0) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') { v.validateInteger(value, name, -1); return value === -1 ? null : value; }
  if (typeof value === 'bigint') {
    const max = 2n ** 63n - 1n - BigInt(length);
    if (!(value >= -1n && value <= max)) throw new ERR_OUT_OF_RANGE(name, `>= -1 && <= ${max}`, value);
    return value === -1n ? null : value;
  }
  throw new ERR_INVALID_ARG_TYPE(name, ['integer', 'bigint'], value);
}
function validateOffsetLengthRead(offset, length, bufferLength) {
  if (offset < 0) throw new ERR_OUT_OF_RANGE('offset', '>= 0', offset);
  if (length < 0) throw new ERR_OUT_OF_RANGE('length', '>= 0', length);
  if (offset + length > bufferLength) throw new ERR_OUT_OF_RANGE('length', `<= ${bufferLength - offset}`, length);
}
function validateOffsetLengthWrite(offset, length, byteLength) {
  if (offset > byteLength) throw new ERR_OUT_OF_RANGE('offset', `<= ${byteLength}`, offset);
  if (length > byteLength - offset) throw new ERR_OUT_OF_RANGE('length', `<= ${byteLength - offset}`, length);
  if (length < 0) throw new ERR_OUT_OF_RANGE('length', '>= 0', length);
  v.validateInt32(length, 'length', 0);
}
function validateStringAfterArrayBufferView(value, name) {
  if (typeof value !== 'string') throw new ERR_INVALID_ARG_TYPE(name, ['string', 'Buffer', 'TypedArray', 'DataView'], value);
}
function bufferArray(buffers, name = 'buffers') {
  if (!Array.isArray(buffers)) throw new ERR_INVALID_ARG_TYPE(name, 'ArrayBufferView[]', buffers);
  for (let i = 0; i < buffers.length; i++) if (!ArrayBuffer.isView(buffers[i])) throw new ERR_INVALID_ARG_TYPE(name, 'ArrayBufferView[]', buffers);
  return buffers;
}
function encoding(value, fallback = 'utf8', bufferAllowed = false) {
  if (value === undefined || value === null) return fallback;
  if (bufferAllowed && value === 'buffer') return value;
  assertEncoding(value);
  return value;
}
function encoded(value, enc) { return enc === 'buffer' ? Buffer.from(value) : enc === 'utf8' || enc === 'utf-8' ? value : Buffer.from(value).toString(enc); }
function aborted(signal) { if (signal && signal.aborted) throw new AbortError(undefined, { cause: signal?.reason }); }
// Node's Stats and BigIntStats (lib/internal/fs/utils.js): function constructors taking the
// fields in order, with atime, mtime, ctime and birthtime as Dates made when first read.
const S_IFMT = 0o170000;
function StatsBase(dev, mode, nlink, uid, gid, rdev, blksize, ino, size, blocks) {
  this.dev = dev; this.mode = mode; this.nlink = nlink; this.uid = uid; this.gid = gid; this.rdev = rdev;
  this.blksize = blksize; this.ino = ino; this.size = size; this.blocks = blocks;
}
StatsBase.prototype.isDirectory = function() { return this._checkModeProperty(0o040000); };
StatsBase.prototype.isFile = function() { return this._checkModeProperty(0o100000); };
StatsBase.prototype.isBlockDevice = function() { return this._checkModeProperty(0o060000); };
StatsBase.prototype.isCharacterDevice = function() { return this._checkModeProperty(0o020000); };
StatsBase.prototype.isSymbolicLink = function() { return this._checkModeProperty(0o120000); };
StatsBase.prototype.isFIFO = function() { return this._checkModeProperty(0o010000); };
StatsBase.prototype.isSocket = function() { return this._checkModeProperty(0o140000); };
function dateFromMs(ms) { return new Date(Math.round(Number(ms))); }
const lazyDateFields = {};
for (const name of ['atime', 'mtime', 'ctime', 'birthtime']) {
  const ms = name + 'Ms';
  const own = (target, value) => { Object.defineProperty(target, name, { value, writable: true, enumerable: true, configurable: true }); return value; };
  lazyDateFields[name] = { enumerable: true, configurable: true, get() { return own(this, dateFromMs(this[ms])); }, set(value) { own(this, value); } };
}
function BigIntStats(dev, mode, nlink, uid, gid, rdev, blksize, ino, size, blocks, atimeNs, mtimeNs, ctimeNs, birthtimeNs) {
  StatsBase.call(this, dev, mode, nlink, uid, gid, rdev, blksize, ino, size, blocks);
  this.atimeMs = atimeNs / 1000000n; this.mtimeMs = mtimeNs / 1000000n; this.ctimeMs = ctimeNs / 1000000n; this.birthtimeMs = birthtimeNs / 1000000n;
  this.atimeNs = atimeNs; this.mtimeNs = mtimeNs; this.ctimeNs = ctimeNs; this.birthtimeNs = birthtimeNs;
}
Object.setPrototypeOf(BigIntStats.prototype, StatsBase.prototype);
Object.setPrototypeOf(BigIntStats, StatsBase);
Object.defineProperties(BigIntStats.prototype, lazyDateFields);
BigIntStats.prototype._checkModeProperty = function(property) { return (this.mode & BigInt(S_IFMT)) === BigInt(property); };
function Stats(dev, mode, nlink, uid, gid, rdev, blksize, ino, size, blocks, atimeMs, mtimeMs, ctimeMs, birthtimeMs) {
  StatsBase.call(this, dev, mode, nlink, uid, gid, rdev, blksize, ino, size, blocks);
  this.atimeMs = atimeMs; this.mtimeMs = mtimeMs; this.ctimeMs = ctimeMs; this.birthtimeMs = birthtimeMs;
}
Object.setPrototypeOf(Stats.prototype, StatsBase.prototype);
Object.setPrototypeOf(Stats, StatsBase);
Object.defineProperties(Stats.prototype, lazyDateFields);
Stats.prototype._checkModeProperty = function(property) { return (this.mode & S_IFMT) === property; };
// A Stats from a native stat result: an object with the fields by name, *timeMs for
// numbers and *timeNs for bigint requests. A missing field is 0, as for a file a
// watcher saw vanish.
function makeStats(value = {}, bigint = false) {
  if (bigint) {
    const big = x => x === undefined ? 0n : BigInt(x);
    const ns = (n, m) => n !== undefined ? BigInt(n) : m !== undefined ? BigInt(Math.trunc(Number(m))) * 1000000n : 0n;
    return new BigIntStats(big(value.dev), big(value.mode), big(value.nlink), big(value.uid), big(value.gid), big(value.rdev), big(value.blksize), big(value.ino), big(value.size), big(value.blocks),
      ns(value.atimeNs, value.atimeMs), ns(value.mtimeNs, value.mtimeMs), ns(value.ctimeNs, value.ctimeMs), ns(value.birthtimeNs, value.birthtimeMs));
  }
  const small = x => x === undefined ? 0 : Number(x);
  return new Stats(small(value.dev), small(value.mode), small(value.nlink), small(value.uid), small(value.gid), small(value.rdev), small(value.blksize), small(value.ino), small(value.size), small(value.blocks),
    small(value.atimeMs), small(value.mtimeMs), small(value.ctimeMs), small(value.birthtimeMs));
}
class Dirent {
  constructor(name, mode, parentPath) { this.name = name; this.parentPath = parentPath; this.path = parentPath; Object.defineProperty(this, '_mode', { value: Number(mode) }); }
  _is(type) { return (this._mode & 0o170000) === type; }
  isFile() { return this._is(0o100000); }
  isDirectory() { return this._is(0o040000); }
  isBlockDevice() { return this._is(0o060000); }
  isCharacterDevice() { return this._is(0o020000); }
  isSymbolicLink() { return this._is(0o120000); }
  isFIFO() { return this._is(0o010000); }
  isSocket() { return this._is(0o140000); }
}
class StatFs {
  constructor(type, bsize, frsize, blocks, bfree, bavail, files, ffree) {
    this.type = type; this.bsize = bsize; this.frsize = frsize; this.blocks = blocks;
    this.bfree = bfree; this.bavail = bavail; this.files = files; this.ffree = ffree;
  }
}
function makeStatFs(value, bigint = false) {
  const get = name => bigint ? BigInt(value[name]) : Number(value[name]);
  return new StatFs(get('type'), get('bsize'), get('frsize'), get('blocks'), get('bfree'), get('bavail'), get('files'), get('ffree'));
}
// A FileHandle's hold on its descriptor, taken by streams reading or writing through it.
const kRef = Symbol('kRef');
const kUnref = Symbol('kUnref');
module.exports = { kRef, kUnref, host, os, std, Buffer, constants, error, fail, pair, invalid, range, integer, path, toPathIfFileURL, fd, options, assertEncoding, mode, flags, native, callback, promiseCallback, submit, time, bytes, position, validateOffsetLengthRead, validateOffsetLengthWrite, validateStringAfterArrayBufferView, bufferArray, encoding, encoded, aborted, Stats, BigIntStats, makeStats, Dirent, StatFs, makeStatFs, v };
