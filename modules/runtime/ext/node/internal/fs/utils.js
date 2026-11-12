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
const { AbortError, codes: { ERR_FS_EISDIR, ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE, ERR_OUT_OF_RANGE } } = require('internal/errors');
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
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    // A name that is not valid UTF-8 goes to the native operations as its raw bytes.
    return require('buffer').isUtf8(bytes) ? bytes.toString() : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
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
function stringToFlags(value, name = 'flags') {
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
// Node's Environment::PrintSyncTrace for --trace-sync-io: host.traceSyncIO is set when
// the event loop starts, and each sync call then prints up to 10 frames of its stack.
function printSyncTrace() {
  const frames = host.captureCallSites(10, native);
  let text = `(node:${process.pid}) WARNING: Detected use of sync API\n`;
  for (let index = 0; index < frames.length; index++) {
    const { functionName, scriptName, lineNumber, columnNumber } = frames[index];
    text += functionName ? `    at ${functionName} (${scriptName}:${lineNumber}:${columnNumber})\n` : `    at ${scriptName}:${lineNumber}:${columnNumber}\n`;
  }
  host.stderr.write(text);
}
function native(operation, args) {
  if (typeof host.fsSync !== 'function') throw error('ENOSYS', operation, typeof args[0] === 'string' ? args[0] : undefined);
  if (host.traceSyncIO) printSyncTrace();
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
// Node's FS_ASYNC_TRACE_BEGIN/END: a nestable async pair per libuv request, named
// after the request (fs_async names it), while node.fs.async or node.fs_dir.async is on.
const kAsyncCategory = 'node,node.fs,node.fs.async';
const kDirAsyncCategory = 'node,node.fs_dir,node.fs_dir.async';
const asyncTracing = { file: false, dir: false };
let asyncTraceId = 0;
const asyncTracer = {
  begin(name, dir = false) {
    if (!(dir ? asyncTracing.dir : asyncTracing.file)) return undefined;
    const id = ++asyncTraceId;
    trace.emit(dir ? kDirAsyncCategory : kAsyncCategory, name, 'b', {}, id);
    return id;
  },
  end(name, id, dir = false) {
    if (id !== undefined) trace.emit(dir ? kDirAsyncCategory : kAsyncCategory, name, 'e', {}, id);
  },
};
function syncAsyncTracer() { host.fsAsyncTracer = asyncTracing.file || asyncTracing.dir ? asyncTracer : undefined; }
trace.watch(kAsyncCategory, on => { asyncTracing.file = on; syncAsyncTracer(); });
trace.watch(kDirAsyncCategory, on => { asyncTracing.dir = on; syncAsyncTracer(); });
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
// A directory entry name in the requested encoding. Names arrive as strings, or as their raw
// bytes (an ArrayBuffer) when rawNames(enc) asked scandir for them.
function encoded(value, enc) {
  if (typeof value !== 'string') { const bytes = Buffer.from(value); return enc === 'buffer' ? bytes : bytes.toString(enc); }
  return enc === 'buffer' ? Buffer.from(value) : enc === 'utf8' || enc === 'utf-8' ? value : Buffer.from(value).toString(enc);
}
// Names that are not valid UTF-8 survive only as bytes, so every other encoding reads them raw.
function rawNames(enc) { return enc != null && enc !== 'utf8' && enc !== 'utf-8' && String(enc).toLowerCase() !== 'utf8' && String(enc).toLowerCase() !== 'utf-8'; }
// The path, as a Buffer, of a raw entry name inside a directory given as a string or bytes.
function rawEntryPath(directory, name) {
  const parent = Buffer.from(directory);
  return Buffer.concat(parent[parent.length - 1] === 0x2f ? [parent, Buffer.from(name)] : [parent, Buffer.from('/'), Buffer.from(name)]);
}
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
// Node's lib/internal/fs/utils.js Dirent: the uv_dirent_t type, as the binding reports it.
const kType = Symbol('type');
const kStats = Symbol('stats');
class Dirent {
  constructor(name, type, path) { this.name = name; this.parentPath = path; this.path = path; this[kType] = type; }
  isDirectory() { return this[kType] === constants.UV_DIRENT_DIR; }
  isFile() { return this[kType] === constants.UV_DIRENT_FILE; }
  isBlockDevice() { return this[kType] === constants.UV_DIRENT_BLOCK; }
  isCharacterDevice() { return this[kType] === constants.UV_DIRENT_CHAR; }
  isSymbolicLink() { return this[kType] === constants.UV_DIRENT_LINK; }
  isFIFO() { return this[kType] === constants.UV_DIRENT_FIFO; }
  isSocket() { return this[kType] === constants.UV_DIRENT_SOCKET; }
}
class DirentFromStats extends Dirent {
  constructor(name, stats, path) { super(name, null, path); this[kStats] = stats; }
}
for (const name of Reflect.ownKeys(Dirent.prototype)) {
  if (name === 'constructor') continue;
  DirentFromStats.prototype[name] = function() { return this[kStats][name](); };
}
// The uv_dirent_t type of a file mode, for entries the runtime reads with their mode.
function modeType(mode) {
  switch (Number(mode) & 0o170000) {
    case 0o100000: return constants.UV_DIRENT_FILE;
    case 0o040000: return constants.UV_DIRENT_DIR;
    case 0o120000: return constants.UV_DIRENT_LINK;
    case 0o010000: return constants.UV_DIRENT_FIFO;
    case 0o140000: return constants.UV_DIRENT_SOCKET;
    case 0o020000: return constants.UV_DIRENT_CHAR;
    case 0o060000: return constants.UV_DIRENT_BLOCK;
    default: return constants.UV_DIRENT_UNKNOWN;
  }
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
// Node's validateRmdirOptions and validateRmOptions(Sync).
const defaultRmdirOptions = { retryDelay: 100, maxRetries: 0, recursive: false };
const defaultRmOptions = { recursive: false, force: false, retryDelay: 100, maxRetries: 0 };
function validateRmdirOptions(options, defaults = defaultRmdirOptions) {
  if (options === undefined) return defaults;
  v.validateObject(options, 'options');
  options = { ...defaults, ...options };
  v.validateBoolean(options.recursive, 'options.recursive');
  v.validateInt32(options.retryDelay, 'options.retryDelay', 0);
  v.validateUint32(options.maxRetries, 'options.maxRetries');
  return options;
}
function isDirectoryError(path) { return new ERR_FS_EISDIR({ code: 'EISDIR', message: 'is a directory', path, syscall: 'rm', errno: 21 }); }
function validateRmOptionsSync(path, options, expectDir) {
  options = validateRmdirOptions(options, defaultRmOptions);
  v.validateBoolean(options.force, 'options.force');
  if (!options.force || expectDir || !options.recursive) {
    const info = require('fs').lstatSync(path, { throwIfNoEntry: !options.force });
    const isDirectory = info !== undefined && info.isDirectory();
    if (expectDir && !isDirectory) return false;
    if (isDirectory && !options.recursive) throw isDirectoryError(path);
  }
  return options;
}
function validateRmOptions(path, options, expectDir, cb) {
  options = validateRmdirOptions(options, defaultRmOptions);
  v.validateBoolean(options.force, 'options.force');
  require('fs').lstat(path, (err, info) => {
    if (err) { if (options.force && err.code === 'ENOENT') return cb(null, options); return cb(err, options); }
    if (expectDir && !info.isDirectory()) return cb(false);
    if (info.isDirectory() && !options.recursive) return cb(isDirectoryError(path));
    return cb(null, options);
  });
}
let recursiveRmdirWarned;
function emitRecursiveRmdirWarning() {
  if (recursiveRmdirWarned === undefined) recursiveRmdirWarned = process.noDeprecation;
  if (!recursiveRmdirWarned) {
    process.emitWarning('In future versions of Node.js, fs.rmdir(path, { recursive: true }) will be removed. Use fs.rm(path, { recursive: true }) instead', 'DeprecationWarning', 'DEP0147');
    recursiveRmdirWarned = true;
  }
}
const realpathCacheKey = Symbol('realpathCacheKey');

// Node's getDirents and getDirent: readdir results with an unknown entry type are
// completed with lstat, the others build their Dirent from the UV_DIRENT type.
function direntJoin(path, name) {
  const isBytes = (value) => value instanceof Uint8Array;
  if ((typeof path === 'string' || isBytes(path)) && name === undefined) return path;
  if (typeof path === 'string' && isBytes(name)) return Buffer.concat([Buffer.from(require('path').join(path, require('path').sep)), name]);
  if (typeof path === 'string' && typeof name === 'string') return require('path').join(path, name);
  if (isBytes(path) && isBytes(name)) return Buffer.concat([path, Buffer.from(require('path').sep), name]);
  throw new ERR_INVALID_ARG_TYPE('path', ['string', 'Buffer'], path);
}
function getDirent(path, name, type, callback) {
  if (typeof callback === 'function') {
    if (type === constants.UV_DIRENT_UNKNOWN) {
      let filepath;
      try { filepath = direntJoin(path, name); } catch (err) { callback(err); return; }
      require('fs').lstat(filepath, (err, stats) => {
        if (err) { callback(err); return; }
        callback(null, new DirentFromStats(name, stats, path));
      });
    } else callback(null, new Dirent(name, type, path));
  } else if (type === constants.UV_DIRENT_UNKNOWN) {
    return new DirentFromStats(name, require('fs').lstatSync(direntJoin(path, name)), path);
  } else return new Dirent(name, type, path);
}
function getDirents(path, { 0: names, 1: types }, callback) {
  const len = names.length;
  if (typeof callback !== 'function') {
    for (let i = 0; i < len; i++) names[i] = getDirent(path, names[i], types[i]);
    return names;
  }
  let toFinish = 0; let done = false;
  const finish = (err, value) => { if (!done) { done = true; callback(err, value); } };
  for (let i = 0; i < len; i++) {
    if (types[i] !== constants.UV_DIRENT_UNKNOWN) { names[i] = new Dirent(names[i], types[i], path); continue; }
    toFinish++;
    getDirent(path, names[i], types[i], (err, dirent) => {
      if (err) { finish(err); return; }
      names[i] = dirent;
      if (--toFinish === 0) finish(null, names);
    });
    if (done) return;
  }
  if (toFinish === 0) finish(null, names);
}

// Node's validatePath and getValidatedPath live in internal/fs/utils.
const { validatePath, getValidatedPath } = require('internal/validators');

function preprocessSymlinkDestination(path, type, linkPath) {
  if (process.platform !== 'win32') {
    // No preprocessing is needed on Unix.
    return path;
  }
  const pathModule = require('path');
  path = '' + path;
  if (type === 'junction') {
    // Junctions paths need to be absolute and \\?\-prefixed.
    // A relative target is relative to the link's parent directory.
    path = pathModule.resolve(linkPath, '..', path);
    return pathModule.toNamespacedPath(path);
  }
  if (pathModule.isAbsolute(path)) {
    // If the path is absolute, use the \\?\-prefix to enable long filenames
    return pathModule.toNamespacedPath(path);
  }
  // Windows symlinks don't tolerate forward slashes.
  return path.replace(/\//g, '\\');
}
// The readFile buffer option, as Node's internal/fs/utils.
function validateReadFileBufferOptions(options) {
  const { buffer } = options;
  if (buffer !== undefined && typeof buffer !== 'function' && !ArrayBuffer.isView(buffer)) throw new ERR_INVALID_ARG_TYPE('options.buffer', ['Buffer', 'TypedArray', 'DataView', 'Function'], buffer);
}
function getReadFileBufferByteLengthName(options) { return typeof options.buffer === 'function' ? 'options.buffer().byteLength' : 'options.buffer.byteLength'; }
function getReadFileBuffer(options, size) {
  let { buffer } = options;
  if (typeof buffer === 'function') { buffer = options.buffer(size); v.validateBuffer(buffer, 'options.buffer()'); }
  if (buffer === undefined) return undefined;
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (size > buffer.byteLength) throw new ERR_INVALID_ARG_VALUE(getReadFileBufferByteLengthName(options), buffer.byteLength, `is smaller than the file size of ${size} bytes`);
  return buffer;
}
module.exports = { validateReadFileBufferOptions, getReadFileBuffer, getReadFileBufferByteLengthName, preprocessSymlinkDestination, validatePath, getValidatedPath, defaultRmOptions, validateRmdirOptions, validateRmOptions, validateRmOptionsSync, isDirectoryError, emitRecursiveRmdirWarning, realpathCacheKey, getDirent, getDirents, kRef, kUnref, host, os, std, Buffer, constants, error, fail, pair, invalid, range, integer, path, toPathIfFileURL, fd, options, assertEncoding, mode, stringToFlags, native, callback, promiseCallback, submit, time, bytes, position, validateOffsetLengthRead, validateOffsetLengthWrite, validateStringAfterArrayBufferView, bufferArray, encoding, encoded, rawNames, rawEntryPath, aborted, Stats, BigIntStats, makeStats, Dirent, DirentFromStats, modeType, StatFs, makeStatFs, v };
