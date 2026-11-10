'use strict';
// Only the module-loader compiler participates: VM scripts and embedded builtins
// do not. Like Node, data: ESM and Module._compile virtual filenames do participate.
const host = require('internal/host');
const fs = require('fs');
const path = require('path');
const { tmpdir } = require('os');
const { fileURLToPath } = require('url');
const { Buffer } = require('buffer');
const { createHash } = require('crypto');
const { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, mkdtempSync, rmdirSync } = fs;
const compileCacheStatus = Object.freeze(Object.assign(Object.create(null), {
  FAILED: 0, ENABLED: 1, ALREADY_ENABLED: 2, DISABLED: 3,
}));
const constants = Object.freeze(Object.assign(Object.create(null), { compileCacheStatus }));
const identity = Buffer.from(host.cacheBuildIdentity, 'hex');
const magic = Buffer.from('SILKMC01');
const HEADER = 104;
let directory;
let portable = false;
let optionIdentity;
const pending = new Map();
const digest = value => createHash('sha256').update(value).digest();
function invalid(message) { return Object.assign(new TypeError(message), { code: 'ERR_INVALID_ARG_TYPE' }); }
function key(source, filename, kind) {
  if (kind === 1 && (filename.startsWith('node:') || filename.startsWith('silk:'))) return;
  let name = filename;
  if (portable) {
    if (name.startsWith('file:')) name = fileURLToPath(name);
    if (path.isAbsolute(name)) name = path.relative(directory, name);
  }
  return digest(JSON.stringify([name, kind, source, optionIdentity])).toString('hex');
}
function load(source, filename, kind) {
  try {
    const id = key(source, filename, kind);
    if (!id) return;
    const bytes = pending.get(id) || readFileSync(path.join(directory, id));
    if (bytes.length <= HEADER || !bytes.subarray(0, 8).equals(magic) ||
        !bytes.subarray(8, 40).equals(identity) ||
        bytes.subarray(40, 72).toString('hex') !== id ||
        !bytes.subarray(72, HEADER).equals(digest(bytes.subarray(HEADER)))) return;
    // The native decoder takes only stable, owned ArrayBuffer storage.
    const payload = bytes.subarray(HEADER);
    return payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
  } catch { return; }
}
function save(source, filename, kind, bytecode) {
  try {
    const id = key(source, filename, kind);
    if (!id) return;
    const payload = Buffer.from(bytecode);
    pending.set(id, Buffer.concat([magic, identity, Buffer.from(id, 'hex'), digest(payload), payload]));
  } catch { /* Cache allocation/I/O must never change module execution. */ }
}
function enableCompileCache(options) {
  let cacheDir, requestedPortable;
  if (typeof options === 'object' && options !== null) ({ directory: cacheDir, portable: requestedPortable } = options);
  else cacheDir = options;
  if (cacheDir === undefined) cacheDir = process.env.NODE_COMPILE_CACHE || path.join(tmpdir(), 'node-compile-cache');
  if (requestedPortable === undefined) requestedPortable = process.env.NODE_COMPILE_CACHE_PORTABLE === '1';
  if (typeof cacheDir !== 'string') throw invalid('cacheDir should be a string');
  if (process.env.NODE_DISABLE_COMPILE_CACHE !== undefined)
    return { status: compileCacheStatus.DISABLED, message: 'Disabled by NODE_DISABLE_COMPILE_CACHE' };
  if (directory) return { status: compileCacheStatus.ALREADY_ENABLED, directory };
  // Node's native UTF8 path argument terminates at the first NUL.
  const base = path.resolve(cacheDir.split('\0', 1)[0]);
  const target = path.join(base, `silk-${host.cacheBuildIdentity}-${typeof process.getuid === 'function' ? process.getuid() : 0}`);
  try { mkdirSync(target, { recursive: true }); }
  catch (error) {
    if (error.code !== 'EEXIST') {
      const descriptions = { ENOTDIR: 'not a directory', EACCES: 'permission denied', EPERM: 'operation not permitted', ENOSPC: 'no space left on device', EROFS: 'read-only file system', ENAMETOOLONG: 'name too long', ENOENT: 'no such file or directory' };
      return { status: compileCacheStatus.FAILED, message: `Cannot create cache directory: ${descriptions[error.code] || error.message}` };
    }
  }
  directory = target;
  portable = requestedPortable === true;
  optionIdentity = JSON.stringify([process.execArgv, process.env.NODE_OPTIONS || '', host.typeScriptMode, host.sourceMapsEnabled]);
  host.setCompileCacheCallbacks(load, save);
  return { status: compileCacheStatus.ENABLED, directory: base };
}
function getCompileCacheDir() { return directory; }
function flushCompileCache() {
  if (arguments[0] !== undefined && typeof arguments[0] !== 'boolean')
    throw invalid('keepDeserializedCache should be a boolean');
  for (const [id, bytes] of pending) {
    let temporary;
    try {
      // mkdtemp is atomic across isolates/processes. Rename publishes only a
      // complete entry on the same filesystem; readers never see partial data.
      temporary = mkdtempSync(path.join(directory, '.tmp-'));
      const file = path.join(temporary, id);
      writeFileSync(file, bytes);
      renameSync(file, path.join(directory, id));
      pending.delete(id);
    } catch { /* Best effort, retry retained bytes on the next flush. */ }
    finally {
      if (temporary) {
        try { unlinkSync(path.join(temporary, id)); } catch {}
        try { rmdirSync(temporary); } catch {}
      }
    }
  }
}
function initialize() {
  if (process.env.NODE_COMPILE_CACHE) enableCompileCache();
}
module.exports = { initialize, enableCompileCache, getCompileCacheDir, flushCompileCache, constants };
