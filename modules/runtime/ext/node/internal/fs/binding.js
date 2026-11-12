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
  lstat(path, bigint, req) { return same(req, 'lstat', [path, { bigint: !!bigint }], value => fillStats(value, bigint)); },
  fstat(fd, bigint, req) { return same(req, 'fstat', [fd, { bigint: !!bigint }], value => fillStats(value, bigint)); },
  statfs(path, bigint, req) { return same(req, 'statfs', [path, { bigint: !!bigint }], value => fillStatFs(value, bigint)); },
};

module.exports = binding;
