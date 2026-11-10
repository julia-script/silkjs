'use strict';
const host = require('internal/host');
const { Buffer } = require('buffer');
const trace = require('internal/trace_events');
const os = host.rawOS;
const std = host.rawStd;
const constants = Object.assign({ F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, COPYFILE_EXCL: 1, COPYFILE_FICLONE: 2, COPYFILE_FICLONE_FORCE: 4, S_IRUSR: 256, S_IWUSR: 128, S_IXUSR: 64, S_IRGRP: 32, S_IWGRP: 16, S_IXGRP: 8, S_IROTH: 4, S_IWOTH: 2, S_IXOTH: 1 }, host.fsConstants);
for (const key of Object.keys(os)) if (/^(O_|S_)/.test(key)) constants[key] = os[key];
const errnoNames = { 1: 'EPERM', 2: 'ENOENT', 3: 'ESRCH', 4: 'EINTR', 5: 'EIO', 6: 'ENXIO', 7: 'E2BIG', 8: 'ENOEXEC', 9: 'EBADF', 10: 'ECHILD', 12: 'ENOMEM', 13: 'EACCES', 14: 'EFAULT', 16: 'EBUSY', 17: 'EEXIST', 18: 'EXDEV', 19: 'ENODEV', 20: 'ENOTDIR', 21: 'EISDIR', 22: 'EINVAL', 23: 'ENFILE', 24: 'EMFILE', 27: 'EFBIG', 28: 'ENOSPC', 29: 'ESPIPE', 30: 'EROFS', 31: 'EMLINK', 32: 'EPIPE' };
Object.assign(errnoNames, os.platform === 'darwin' ? { 11: 'EDEADLK', 35: 'EAGAIN', 45: 'ENOTSUP', 62: 'ELOOP', 63: 'ENAMETOOLONG', 66: 'ENOTEMPTY', 78: 'ENOSYS' } : { 11: 'EAGAIN', 36: 'ENAMETOOLONG', 38: 'ENOSYS', 39: 'ENOTEMPTY', 40: 'ELOOP', 95: 'ENOTSUP' });
function error(code, syscall, path, dest, errno) {
  const message = errno !== undefined && std && std.strerror ? std.strerror(Math.abs(errno)) : code;
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
function invalid(name, expected) { const e = new TypeError(`The "${name}" argument must be ${expected}`); e.code = 'ERR_INVALID_ARG_TYPE'; return e; }
function range(name) { const e = new RangeError(`The value of "${name}" is out of range`); e.code = 'ERR_OUT_OF_RANGE'; return e; }
function integer(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'number') throw invalid(name, 'a number');
  if (!Number.isInteger(value) || value < min || value > max) throw range(name);
  return value;
}
function path(value) {
  if (Buffer.isBuffer(value)) value = value.toString();
  else if (value && typeof value === 'object' && value.protocol === 'file:') {
    if (value.hostname && value.hostname !== 'localhost') { const e = new TypeError('File URL host must be empty or localhost'); e.code = 'ERR_INVALID_FILE_URL_HOST'; throw e; }
    if (/%2f|%5c/i.test(value.pathname)) { const e = new TypeError('File URL path must not include encoded separators'); e.code = 'ERR_INVALID_FILE_URL_PATH'; throw e; }
    value = decodeURIComponent(value.pathname);
  }
  if (typeof value !== 'string') throw invalid('path', 'a string, Buffer, or file URL');
  if (value.includes('\0')) { const e = new TypeError('Path must not contain null bytes'); e.code = 'ERR_INVALID_ARG_VALUE'; throw e; }
  return value;
}
function fd(value) { return integer(value, 'fd', 0, 0x7fffffff); }
function options(value, defaults) {
  if (value === undefined || value === null) return Object.assign({}, defaults);
  if (typeof value === 'string') return Object.assign({}, defaults, { encoding: value });
  if (typeof value !== 'object') throw invalid('options', 'an object or string');
  return Object.assign({}, defaults, value);
}
function mode(value, fallback = 0o666) { return value === undefined ? fallback : typeof value === 'string' && /^[0-7]+$/.test(value) ? parseInt(value, 8) : integer(value, 'mode', 0, 0xffffffff); }
function flags(value = 'r') {
  if (typeof value === 'number') return integer(value, 'flags', 0, 0x7fffffff);
  let result;
  const c = constants;
  switch (value) {
    case 'r': result = c.O_RDONLY; break;
    case 'r+': result = c.O_RDWR; break;
    case 'rs': case 'sr': result = c.O_RDONLY | syncFlag(); break;
    case 'rs+': case 'sr+': result = c.O_RDWR | syncFlag(); break;
    case 'w': result = c.O_WRONLY | c.O_CREAT | c.O_TRUNC; break;
    case 'wx': case 'xw': result = c.O_WRONLY | c.O_CREAT | c.O_TRUNC | c.O_EXCL; break;
    case 'w+': result = c.O_RDWR | c.O_CREAT | c.O_TRUNC; break;
    case 'wx+': case 'xw+': result = c.O_RDWR | c.O_CREAT | c.O_TRUNC | c.O_EXCL; break;
    case 'a': result = c.O_WRONLY | c.O_CREAT | c.O_APPEND; break;
    case 'ax': case 'xa': result = c.O_WRONLY | c.O_CREAT | c.O_APPEND | c.O_EXCL; break;
    case 'a+': result = c.O_RDWR | c.O_CREAT | c.O_APPEND; break;
    case 'ax+': case 'xa+': result = c.O_RDWR | c.O_CREAT | c.O_APPEND | c.O_EXCL; break;
    case 'as': case 'sa': result = c.O_WRONLY | c.O_CREAT | c.O_APPEND | syncFlag(); break;
    case 'as+': case 'sa+': result = c.O_RDWR | c.O_CREAT | c.O_APPEND | syncFlag(); break;
    default: { const e = new TypeError(`Unknown file open flag: ${value}`); e.code = 'ERR_INVALID_ARG_VALUE'; throw e; }
  }
  return result;
}
function syncFlag() { if (constants.O_SYNC === undefined) throw error('ENOSYS', 'open'); return constants.O_SYNC; }
// Private native extension: fsSync(name, positionalArgs) returns a Node result
// or throws an Error retaining code, errno, syscall, path, and dest. Unlike the
// QuickJS os API, it must not return negative errno values or [value, errno].
// pread/pwrite receive [fd, ArrayBuffer, absoluteByteOffset, length, position]
// and preserve the descriptor's current offset. Metadata includes blksize,
// birthtimeMs and, for bigint requests, exact integer fields and *timeNs.
function native(operation, args) {
  if (typeof host.fsSync !== 'function') throw error('ENOSYS', operation, typeof args[0] === 'string' ? args[0] : undefined);
  if (!trace.enabled('node,node.fs,node.fs.sync')) return host.fsSync(operation, args);
  trace.emit('node,node.fs,node.fs.sync', `fs.sync.${operation}`, 'B');
  try { return host.fsSync(operation, args); }
  finally { trace.emit('node,node.fs,node.fs.sync', `fs.sync.${operation}`, 'E'); }
}
function callback(value) { if (typeof value !== 'function') throw invalid('callback', 'a function'); return value; }
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
function time(value) {
  if (value instanceof Date) value = value.getTime() / 1000;
  else if (typeof value === 'string' && value.trim() !== '') value = Number(value);
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid('time', 'a finite number, numeric string, or Date');
  return value < 0 ? Date.now() / 1000 : value;
}
function bytes(value) {
  if (!ArrayBuffer.isView(value)) throw invalid('buffer', 'a Buffer, TypedArray, or DataView');
  return value;
}
function position(value) {
  if (value === undefined || value === null || value === -1 || value === -1n) return null;
  if (typeof value === 'bigint') { if (value < 0n || value > 0x7fffffffffffffffn) throw range('position'); return value; }
  return integer(value, 'position');
}
function slice(buffer, offset = 0, length = buffer.byteLength - offset) {
  bytes(buffer); integer(offset, 'offset', 0, buffer.byteLength); integer(length, 'length', 0, buffer.byteLength - offset);
  return [buffer, offset, length];
}
function encoding(value, fallback = 'utf8', bufferAllowed = false) {
  if (value === undefined || value === null) return fallback;
  if (bufferAllowed && value === 'buffer') return value;
  if (!Buffer.isEncoding(value)) { const e = new TypeError(`Unknown encoding: ${value}`); e.code = 'ERR_INVALID_ARG_VALUE'; throw e; }
  return value;
}
function encoded(value, enc) { return enc === 'buffer' ? Buffer.from(value) : enc === 'utf8' || enc === 'utf-8' ? value : Buffer.from(value).toString(enc); }
function aborted(signal) { if (signal && signal.aborted) { const e = new Error('The operation was aborted', { cause: signal.reason }); e.name = 'AbortError'; e.code = 'ABORT_ERR'; throw e; } }
class Stats {
  constructor(value = {}, bigint = false) {
    const number = x => bigint ? BigInt(x === undefined ? 0 : x) : Number(x === undefined ? 0 : x);
    for (const name of ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'size', 'blksize', 'blocks']) this[name] = number(value[name]);
    for (const name of ['atime', 'mtime', 'ctime', 'birthtime']) {
      const ms = value[`${name}Ms`] === undefined ? value[name] instanceof Date ? value[name].getTime() : value[name] === undefined ? 0 : value[name] : value[`${name}Ms`];
      const ns = value[`${name}Ns`];
      this[`${name}Ms`] = bigint ? ns === undefined ? typeof ms === 'bigint' ? ms : BigInt(Math.trunc(ms)) : BigInt(ns) / 1000000n : Number(ms);
      this[name] = new Date(Number(this[`${name}Ms`]));
      if (bigint) this[`${name}Ns`] = ns === undefined ? this[`${name}Ms`] * 1000000n : BigInt(ns);
    }
  }
  _is(type) { return (Number(this.mode) & 0o170000) === type; }
  isFile() { return this._is(0o100000); }
  isDirectory() { return this._is(0o040000); }
  isBlockDevice() { return this._is(0o060000); }
  isCharacterDevice() { return this._is(0o020000); }
  isSymbolicLink() { return this._is(0o120000); }
  isFIFO() { return this._is(0o010000); }
  isSocket() { return this._is(0o140000); }
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
  constructor(value, bigint = false) { for (const name of ['type', 'bsize', 'blocks', 'bfree', 'bavail', 'files', 'ffree']) this[name] = bigint ? BigInt(value[name]) : Number(value[name]); }
}
module.exports = { host, os, std, Buffer, constants, error, fail, pair, invalid, range, integer, path, fd, options, mode, flags, native, callback, promiseCallback, submit, time, bytes, position, slice, encoding, encoded, aborted, Stats, Dirent, StatFs };
