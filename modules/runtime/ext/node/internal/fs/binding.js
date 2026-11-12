'use strict';

// Node's fs binding (src/node_file.cc) over the runtime's fsSync and submitIO
// operations, for process.binding('fs') and internalBinding('fs'). Every call
// takes Node's trailing req: undefined runs the call synchronously and throws,
// an FSReqCallback gets oncomplete(err, result), and kUsePromises returns a
// promise. Stat calls fill statValues or bigintStatValues and return it, in
// node_file.cc's field order. Copyright Node.js contributors. MIT license (see
// vendor/node-api/LICENSE).

const c = require('internal/fs/utils');

const kFsStatsFieldsNumber = 18;
const statValues = new Float64Array(kFsStatsFieldsNumber * 2);
const bigintStatValues = new BigInt64Array(kFsStatsFieldsNumber * 2);
const statFsValues = new Float64Array(7);
const bigintStatFsValues = new BigInt64Array(7);
const kUsePromises = Symbol('fs_use_promises_symbol');

function FSReqCallback(bigint) {
  if (!new.target) throw new TypeError("Class constructor FSReqCallback cannot be invoked without 'new'");
  this.oncomplete = undefined;
  this.context = undefined;
  this.bigint = !!bigint;
}

const kFields = ['dev', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'blksize', 'ino', 'size', 'blocks'];
const kTimes = ['atime', 'mtime', 'ctime', 'birthtime'];
// FillStatsArray: the ten integer fields, then seconds and nanoseconds of each time.
function fillStats(value, bigint, offset = 0) {
  const array = bigint ? bigintStatValues : statValues;
  const num = bigint ? x => BigInt(x ?? 0) : x => Number(x ?? 0);
  for (let i = 0; i < kFields.length; i++) array[offset + i] = num(value[kFields[i]]);
  for (let i = 0; i < kTimes.length; i++) {
    const name = kTimes[i];
    let ns = value[`${name}Ns`];
    ns = ns !== undefined ? BigInt(ns) : BigInt(Math.round(Number(value[`${name}Ms`] ?? 0) * 1e6));
    const sec = ns / 1000000000n, nsec = ns % 1000000000n;
    array[offset + 10 + i * 2] = bigint ? sec : Number(sec);
    array[offset + 11 + i * 2] = bigint ? nsec : Number(nsec);
  }
  return array;
}
const kStatFsFields = ['type', 'bsize', 'blocks', 'bfree', 'bavail', 'files', 'ffree'];
function fillStatFs(value, bigint) {
  const array = bigint ? bigintStatFsValues : statFsValues;
  for (let i = 0; i < kStatFsFields.length; i++) array[i] = bigint ? BigInt(value[kStatFsFields[i]]) : Number(value[kStatFsFields[i]]);
  return array;
}

// One binding call: the sync operation, the async one and the result mapping.
function call(req, syncOp, syncArgs, asyncOp, asyncArgs, result = x => x) {
  if (req === undefined) return result(c.native(syncOp, syncArgs));
  if (req === kUsePromises) {
    return new Promise((resolve, reject) => {
      c.submit(asyncOp, asyncArgs, c.promiseCallback((err, value) => err ? reject(err) : resolve(result(value))));
    });
  }
  c.submit(asyncOp, asyncArgs, (err, value) => {
    if (err) req.oncomplete(err);
    else req.oncomplete(null, result(value));
  });
}
const same = (req, op, args, result) => call(req, op, args, op, args, result);
// A promise request owns its stat array (FSReqPromise's stats_field_array_); the others share statValues.
const statResult = (req, bigint) => value => {
  const array = fillStats(value, bigint);
  return req === kUsePromises ? array.slice(0, kFsStatsFieldsNumber) : array;
};

// The sync calls node_file.cc takes a ctx for: an error fills ctx (errno, code, syscall) instead of throwing.
function withCtx(ctx, fn) {
  if (ctx === undefined) return fn();
  try { return fn(); } catch (error) {
    ctx.errno = error.errno; ctx.code = error.code; ctx.syscall = error.syscall;
    if (error.path !== undefined) ctx.path = error.path;
    return undefined;
  }
}

// node_file.cc's FileHandle: owns its descriptor, and one never closed is closed on
// garbage collection, which warns from an unref'ed immediate (DEP0137 once per process).
let gcCloseWarned = false;
const gcCloser = new FinalizationRegistry((fd) => {
  try { c.native('close', [fd]); } catch {}
  setImmediate(() => {
    process.emitWarning(`Closing file descriptor ${fd} on garbage collection`);
    if (gcCloseWarned) return;
    gcCloseWarned = true;
    process.emitWarning('Closing a FileHandle object on garbage collection is deprecated. ' +
      'Please close FileHandle objects explicitly using FileHandle.prototype.close(). ' +
      'In the future, an error will be thrown if a file descriptor is closed during garbage collection.',
    'DeprecationWarning', 'DEP0137');
  }).unref();
});
class FileHandle {
  constructor(fd) {
    this.fd = fd;
    if (fd !== -1) gcCloser.register(this, fd, this);
  }
  getAsyncId() { return -1; }
  // The descriptor leaves the handle, which no longer closes it.
  releaseFD() {
    const fd = this.fd;
    this.fd = -1;
    gcCloser.unregister(this);
    return fd;
  }
  close() {
    const fd = this.releaseFD();
    return new Promise((resolve, reject) => {
      c.submit('close', [fd], c.promiseCallback((err) => err ? reject(err) : resolve(), 2));
    });
  }
}

const kIoMaxLength = 2 ** 31 - 1;
// Most files fit in this buffer: read into it until a read returns 0, then decode at the
// size read. A reader takes it, so a nested read gets its own.
let readBuffer = null;
function readAllUtf8(fd) {
  const { Buffer } = c;
  const buffer = readBuffer || Buffer.allocUnsafeSlow(65536); readBuffer = null;
  try {
    let chunks = null, held = 0, total = 0;
    for (;;) {
      if (held === buffer.length) { (chunks ??= []).push(Buffer.from(buffer)); held = 0; }
      const count = c.fail(c.os.read(fd, buffer.buffer, buffer.byteOffset + held, buffer.length - held), 'read');
      if (count === 0) break;
      held += count; total += count;
      if (total > kIoMaxLength) throw new (require('internal/errors').codes.ERR_FS_FILE_TOO_LARGE)(total);
    }
    if (chunks === null) return buffer.utf8Slice(0, held);
    if (held !== 0) chunks.push(Buffer.from(buffer.subarray(0, held)));
    return Buffer.concat(chunks, total).utf8Slice();
  } finally { readBuffer = buffer; }
}
function transferSync(operation, fd, buffer, offset, length, position) {
  if (position !== null) return c.native(operation === 'read' ? 'pread' : 'pwrite', [fd, buffer.buffer, buffer.byteOffset + offset, length, position]);
  return c.fail(c.os[operation](fd, buffer.buffer, buffer.byteOffset + offset, length), operation);
}
// Node passes -1 (or null) for the current position.
const position = value => value === -1 || value === -1n || value == null ? null : value;
const encode = encoding => value => c.encoded(value, encoding);

const binding = {
  kFsStatsFieldsNumber, statValues, bigintStatValues, statFsValues, bigintStatFsValues, kUsePromises, FSReqCallback,
  access(path, mode, req) { return same(req, 'access', [path, mode]); },
  existsSync(path) { try { c.native('access', [path, c.constants.F_OK]); return true; } catch { return false; } },
  open(path, flags, mode, req) { return same(req, 'open', [path, flags, mode]); },
  close(fd, req) { return same(req, 'close', [fd], () => undefined); },
  fsync(fd, req) { return same(req, 'fsync', [fd]); },
  fdatasync(fd, req) { return same(req, 'fdatasync', [fd]); },
  ftruncate(fd, len, req) { return same(req, 'ftruncate', [fd, len]); },
  rename(from, to, req) { return same(req, 'rename', [from, to]); },
  link(from, to, req) { return same(req, 'link', [from, to]); },
  symlink(target, path, flags, req) {
    const type = flags & 1 ? 'dir' : flags & 2 ? 'junction' : 'file';
    return same(req, 'symlink', [target, path, type]);
  },
  unlink(path, req) { return same(req, 'unlink', [path]); },
  rmdir(path, req) { return call(req, 'rmdir', [path], 'rmdir', [path, {}]); },
  chmod(path, mode, req) { return same(req, 'chmod', [path, mode]); },
  fchmod(fd, mode, req) { return same(req, 'fchmod', [fd, mode]); },
  chown(path, uid, gid, req) { return same(req, 'chown', [path, uid, gid]); },
  fchown(fd, uid, gid, req) { return same(req, 'fchown', [fd, uid, gid]); },
  lchown(path, uid, gid, req) { return same(req, 'lchown', [path, uid, gid]); },
  utimes(path, atime, mtime, req) { return same(req, 'utimes', [path, atime, mtime]); },
  futimes(fd, atime, mtime, req) { return same(req, 'futimes', [fd, atime, mtime]); },
  lutimes(path, atime, mtime, req) { return same(req, 'lutimes', [path, atime, mtime]); },
  copyFile(src, dest, mode, req) { return same(req, 'copyFile', [src, dest, mode]); },
  readlink(path, encoding, req) { return call(req, 'readlink', [path], 'readlink', [path, { encoding }], encode(encoding)); },
  realpath(path, encoding, req) { return call(req, 'realpath', [path], 'realpath', [path, { encoding }], encode(encoding)); },
  mkdtemp(prefix, encoding, req) { return call(req, 'mkdtemp', [prefix], 'mkdtemp', [prefix, { encoding }], encode(encoding)); },
  stat(path, bigint, req, throwIfNoEntry = true) {
    const fill = value => value === undefined ? undefined : fillStats(value, bigint);
    return call(req, 'stat', [path, { bigint: !!bigint, throwIfNoEntry }], 'stat', [path, { bigint: !!bigint, throwIfNoEntry }], fill);
  },
  lstat(path, bigint, req) { return same(req, 'lstat', [path, { bigint: !!bigint }], statResult(req, bigint)); },
  fstat(fd, bigint, req, shouldNotThrow) {
    if (req === undefined && shouldNotThrow) {
      try { return fillStats(c.native('fstat', [fd, { bigint: !!bigint }]), bigint); } catch { return undefined; }
    }
    return same(req, 'fstat', [fd, { bigint: !!bigint }], statResult(req, bigint));
  },
  openFileHandle(path, flags, mode, req, ctx) {
    if (req === undefined) return withCtx(ctx, () => new FileHandle(c.native('open', [path, flags, mode])));
    return same(req, 'open', [path, flags, mode], fd => new FileHandle(fd));
  },
  FileHandle,
  read(fd, buffer, offset, length, pos, req) {
    pos = position(pos);
    if (req === undefined) return transferSync('read', fd, buffer, offset, length, pos);
    return same(req, 'read', [fd, buffer, offset, length, pos]);
  },
  // node_file.cc ReadDir: the names, or [names, types] with UV_DIRENT_* types.
  readdir(path, encoding, withTypes, req) {
    if (req === undefined) {
      const raw = c.rawNames(encoding);
      const names = [], types = [];
      for (const name of c.native('scandir', [path, raw])) {
        if (name === '.' || name === '..') continue;
        names.push(c.encoded(name, encoding));
        if (withTypes) types.push(c.modeType(c.native('lstat', [raw ? c.rawEntryPath(path, name) : require('path').join(path, name), { bigint: false }]).mode));
      }
      return withTypes ? [names, types] : names;
    }
    const result = entries => {
      if (!withTypes) return entries.map(name => c.encoded(name, encoding));
      return [entries.map(entry => c.encoded(entry.name, encoding)), entries.map(entry => c.modeType(entry.mode))];
    };
    return same(req, 'readdir', [path, { encoding, withFileTypes: !!withTypes }], result);
  },
  // node_file.cc ReadFileUtf8: open (unless given a descriptor), read to the end, close.
  readFileUtf8(path, flags) {
    const isUserFd = typeof path === 'number';
    const fd = isUserFd ? path : c.native('open', [path, flags, 0o666]);
    try {
      const info = c.native('fstat', [fd, { bigint: false }]);
      if ((info.mode & 0o170000) === 0o100000 && info.size > kIoMaxLength) throw new (require('internal/errors').codes.ERR_FS_FILE_TOO_LARGE)(info.size);
      return readAllUtf8(fd);
    } finally { if (!isUserFd) c.native('close', [fd]); }
  },
  // node_file.cc WriteFileUtf8: open (unless given a descriptor), write all of data, close.
  writeFileUtf8(path, data, flags, mode) {
    const isUserFd = typeof path === 'number';
    const fd = isUserFd ? path : c.native('open', [path, flags, mode]);
    try {
      const bytes = c.Buffer.from(data, 'utf8');
      let offset = 0;
      while (offset < bytes.byteLength) offset += transferSync('write', fd, bytes, offset, bytes.byteLength - offset, null);
    } finally { if (!isUserFd) c.native('close', [fd]); }
  },
  statfs(path, bigint, req) { return same(req, 'statfs', [path, { bigint: !!bigint }], value => fillStatFs(value, bigint)); },
};

module.exports = binding;
