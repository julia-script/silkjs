'use strict';
// fs.cp and fs.cpSync after Node's lib/internal/fs/cp/cp.js. One generator holds the
// algorithm; each filesystem step is yielded, and a driver runs the step with the
// synchronous or the promise API and sends back its result.
const fs = require('fs');
const { dirname, isAbsolute, join, parse, resolve, sep } = require('path');
const v = require('internal/validators');
const { validateBoolean, validateFunction, validateObject } = v;
const { codes } = require('internal/errors');
const { ERR_INCOMPATIBLE_OPTION_PAIR, ERR_INVALID_RETURN_VALUE } = codes;
const EEXIST = 17; const EISDIR = 21; const EINVAL = 22; const ENOTDIR = 20;

const defaultCpOptions = { dereference: false, errorOnExist: false, filter: undefined, force: true, preserveTimestamps: false, recursive: false, verbatimSymlinks: false };
function validateCpOptions(options) {
  if (options === undefined) return { ...defaultCpOptions, mode: 0 };
  validateObject(options, 'options');
  options = { ...defaultCpOptions, ...options };
  validateBoolean(options.dereference, 'options.dereference');
  validateBoolean(options.errorOnExist, 'options.errorOnExist');
  validateBoolean(options.force, 'options.force');
  validateBoolean(options.preserveTimestamps, 'options.preserveTimestamps');
  validateBoolean(options.recursive, 'options.recursive');
  validateBoolean(options.verbatimSymlinks, 'options.verbatimSymlinks');
  if (options.mode == null) options.mode = 0;
  else v.validateInteger(options.mode, 'mode', 0, 7);
  if (options.dereference === true && options.verbatimSymlinks === true) {
    throw new ERR_INCOMPATIBLE_OPTION_PAIR('dereference', 'verbatimSymlinks');
  }
  if (options.filter !== undefined) validateFunction(options.filter, 'options.filter');
  return options;
}

const fail = (key, message, path, errno, code) => new codes[key]({ message, path, syscall: 'cp', errno, code });
const ENOENT = error => { if (error.code === 'ENOENT') return null; throw error; };

// Each step is [operation name, ...arguments]; 'filter' runs the user's filter.
function* cpSteps(src, dest, opts, sync) {
  const stats = yield* checkPaths(src, dest, opts, sync);
  const { srcStat, destStat, skipped } = stats;
  if (skipped) return;
  yield* checkParentPaths(src, srcStat, dest);
  yield* checkParentDir(destStat, src, dest, opts);
}
function* checkPaths(src, dest, opts, sync) {
  if (opts.filter) {
    const accepted = yield ['filter', opts.filter, src, dest];
    if (sync && accepted && typeof accepted.then === 'function') {
      throw new ERR_INVALID_RETURN_VALUE('boolean', 'filter', accepted);
    }
    if (!accepted) return { skipped: true };
  }
  const statName = opts.dereference ? 'stat' : 'lstat';
  const srcStat = yield [statName, src, { bigint: true }];
  const destStat = yield [statName, dest, { bigint: true }, ENOENT];
  if (destStat) {
    if (areIdentical(srcStat, destStat)) throw fail('ERR_FS_CP_EINVAL', 'src and dest cannot be the same', dest, EINVAL, 'EINVAL');
    if (srcStat.isDirectory() && !destStat.isDirectory()) throw fail('ERR_FS_CP_DIR_TO_NON_DIR', `cannot overwrite non-directory ${dest} with directory ${src}`, dest, EISDIR, 'EISDIR');
    if (!srcStat.isDirectory() && destStat.isDirectory()) throw fail('ERR_FS_CP_NON_DIR_TO_DIR', `cannot overwrite directory ${dest} with non-directory ${src}`, dest, ENOTDIR, 'ENOTDIR');
  }
  if (srcStat.isDirectory() && isSrcSubdir(src, dest)) throw fail('ERR_FS_CP_EINVAL', `cannot copy ${src} to a subdirectory of self ${dest}`, dest, EINVAL, 'EINVAL');
  return { srcStat, destStat, skipped: false };
}
function areIdentical(srcStat, destStat) { return destStat.ino && destStat.dev && destStat.ino === srcStat.ino && destStat.dev === srcStat.dev; }
function* checkParentDir(destStat, src, dest, opts) {
  const destParent = dirname(dest);
  const exists = (yield ['stat', destParent, undefined, ENOENT]) !== null;
  if (!exists) yield ['mkdir', destParent, { recursive: true }];
  yield* getStatsForCopy(destStat, src, dest, opts);
}
function* checkParentPaths(src, srcStat, dest) {
  for (;;) {
    const srcParent = resolve(dirname(src));
    const destParent = resolve(dirname(dest));
    if (destParent === srcParent || destParent === parse(destParent).root) return;
    const destStat = yield ['stat', destParent, { bigint: true }, ENOENT];
    if (destStat === null) return;
    if (areIdentical(srcStat, destStat)) throw fail('ERR_FS_CP_EINVAL', `cannot copy ${src} to a subdirectory of self ${dest}`, dest, EINVAL, 'EINVAL');
    dest = destParent;
  }
}
const normalizePathToArray = path => resolve(path).split(sep).filter(Boolean);
function isSrcSubdir(src, dest) {
  const srcArr = normalizePathToArray(src); const destArr = normalizePathToArray(dest);
  return srcArr.every((current, i) => destArr[i] === current);
}
function* getStatsForCopy(destStat, src, dest, opts) {
  const srcStat = yield [opts.dereference ? 'stat' : 'lstat', src];
  if (srcStat.isDirectory() && opts.recursive) return yield* onDir(srcStat, destStat, src, dest, opts);
  if (srcStat.isDirectory()) throw fail('ERR_FS_EISDIR', `${src} is a directory (not copied)`, src, EISDIR, 'EISDIR');
  if (srcStat.isFile() || srcStat.isCharacterDevice() || srcStat.isBlockDevice()) return yield* onFile(srcStat, destStat, src, dest, opts);
  if (srcStat.isSymbolicLink()) return yield* onLink(destStat, src, dest, opts);
  if (srcStat.isSocket()) throw fail('ERR_FS_CP_SOCKET', `cannot copy a socket file: ${dest}`, dest, EINVAL, 'EINVAL');
  if (srcStat.isFIFO()) throw fail('ERR_FS_CP_FIFO_PIPE', `cannot copy a FIFO pipe: ${dest}`, dest, EINVAL, 'EINVAL');
  throw fail('ERR_FS_CP_UNKNOWN', `cannot copy an unknown file type: ${dest}`, dest, EINVAL, 'EINVAL');
}
function* onFile(srcStat, destStat, src, dest, opts) {
  if (destStat) {
    if (opts.force) yield ['unlink', dest];
    else if (opts.errorOnExist) throw fail('ERR_FS_CP_EEXIST', `${dest} already exists`, dest, EEXIST, 'EEXIST');
    else return;
  }
  yield ['copyFile', src, dest, opts.mode];
  if (opts.preserveTimestamps) {
    if ((srcStat.mode & 0o200) === 0) yield ['chmod', dest, Number(srcStat.mode | 0o200)];
    yield* setDestTimestamps(src, dest);
  }
  yield ['chmod', dest, Number(srcStat.mode)];
}
function* setDestTimestamps(src, dest) {
  const updated = yield ['stat', src];
  yield ['utimes', dest, updated.atime, updated.mtime];
}
function* onDir(srcStat, destStat, src, dest, opts) {
  if (!destStat) {
    yield ['mkdir', dest];
    yield* copyDir(src, dest, opts);
    if (opts.preserveTimestamps) yield* setDestTimestamps(src, dest);
    yield ['chmod', dest, Number(srcStat.mode)];
    return;
  }
  if (opts.errorOnExist && !opts.force) throw fail('ERR_FS_CP_EEXIST', `${dest} already exists`, dest, EEXIST, 'EEXIST');
  yield* copyDir(src, dest, opts);
  if (opts.preserveTimestamps) yield* setDestTimestamps(src, dest);
}
function* copyDir(src, dest, opts) {
  for (const name of yield ['readdir', src]) {
    const srcItem = join(src, name); const destItem = join(dest, name);
    const { destStat, skipped } = yield* checkPaths(srcItem, destItem, opts, opts[kSync]);
    if (!skipped) yield* getStatsForCopy(destStat, srcItem, destItem, opts);
  }
}
function* onLink(destStat, src, dest, opts) {
  let resolvedSrc = yield ['readlink', src];
  if (!opts.verbatimSymlinks && !isAbsolute(resolvedSrc)) resolvedSrc = resolve(dirname(src), resolvedSrc);
  const target = yield ['stat', src, undefined, ENOENT];
  const srcIsDir = target !== null && target.isDirectory();
  const symlinkType = srcIsDir ? 'dir' : 'file';
  if (!destStat) return yield ['symlink', resolvedSrc, dest, symlinkType];
  let resolvedDest = yield ['readlink', dest, undefined, error => { if (error.code === 'EINVAL' || error.code === 'UNKNOWN') return null; throw error; }];
  if (resolvedDest === null) return yield ['symlink', resolvedSrc, dest, symlinkType];
  if (!isAbsolute(resolvedDest)) resolvedDest = resolve(dirname(dest), resolvedDest);
  if (srcIsDir && isSrcSubdir(resolvedSrc, resolvedDest)) throw fail('ERR_FS_CP_EINVAL', `cannot copy ${resolvedSrc} to a subdirectory of self ${resolvedDest}`, dest, EINVAL, 'EINVAL');
  const srcStat = yield ['stat', src];
  if (srcStat.isDirectory() && isSrcSubdir(resolvedDest, resolvedSrc)) throw fail('ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY', `cannot overwrite ${resolvedDest} with ${resolvedSrc}`, dest, EINVAL, 'EINVAL');
  yield ['unlink', dest];
  return yield ['symlink', resolvedSrc, dest, symlinkType];
}
const kSync = Symbol('sync');

// A step's optional last element maps its error to a result instead of a throw.
function splitStep(step) {
  const [name, ...args] = step;
  let recover = null;
  if (typeof args[args.length - 1] === 'function' && name !== 'filter') recover = args.pop();
  while (args.length && args[args.length - 1] === undefined) args.pop();
  return [name, args, recover];
}
function cpSyncFn(src, dest, opts) {
  // Node's cpSyncCheckPaths binding checks both paths before it copies anything.
  if (require('internal/host').builtinLoaded('internal/permission')) {
    const permission = require('internal/permission');
    permission.check('fs.read', src); permission.check('fs.write', dest);
  }
  opts = { ...opts, [kSync]: true };
  const steps = cpSteps(src, dest, opts, true);
  let input; let error; let failed = false;
  for (;;) {
    const next = failed ? steps.throw(error) : steps.next(input);
    failed = false;
    if (next.done) return next.value;
    const [name, args, recover] = splitStep(next.value);
    try { input = name === 'filter' ? args[0](args[1], args[2]) : fs[`${name}Sync`](...args); }
    catch (e) { if (recover) { try { input = recover(e); } catch (r) { error = r; failed = true; } } else { error = e; failed = true; } }
  }
}
async function cpFn(src, dest, opts) {
  const promises = require('fs/promises');
  const steps = cpSteps(src, dest, opts, false);
  let input; let error; let failed = false;
  for (;;) {
    const next = failed ? steps.throw(error) : steps.next(input);
    failed = false;
    if (next.done) return next.value;
    const [name, args, recover] = splitStep(next.value);
    try { input = name === 'filter' ? await args[0](args[1], args[2]) : await promises[name](...args); }
    catch (e) { if (recover) { try { input = recover(e); } catch (r) { error = r; failed = true; } } else { error = e; failed = true; } }
  }
}
module.exports = { validateCpOptions, cpFn, cpSyncFn, areIdentical, isSrcSubdir };
