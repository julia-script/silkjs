'use strict';
// Node's on-disk compile cache (src/compile_cache.cc). Each source file and code
// type gets one file, <dir>/<version>-<arch>-<build tag>-<uid>/<crc32(type, name)>,
// holding a five word header (magic, code size, cache size, code hash, cache hash,
// hashes are crc32) and then the cache bytes: engine bytecode for CommonJS and
// ESM, transpiled JavaScript for TypeScript. NODE_DEBUG_NATIVE=COMPILE_CACHE
// prints the trace Node prints. Only the module-loader compiler and the
// TypeScript loader participate: VM scripts and embedded builtins do not. Like
// Node, data: ESM and Module._compile virtual filenames do participate.
const host = require('internal/host');
const fs = require('fs');
const path = require('path');
const { Buffer } = require('buffer');
const { codedError } = require('internal/errors');

const compileCacheStatus = Object.freeze(Object.assign(Object.create(null), {
  FAILED: 0, ENABLED: 1, ALREADY_ENABLED: 2, DISABLED: 3,
}));
const constants = Object.freeze(Object.assign(Object.create(null), { compileCacheStatus }));

const kCommonJS = 0, kESM = 1, kStrippedTypeScript = 2, kTransformedTypeScript = 3,
  kTransformedTypeScriptWithSourceMaps = 4;
const typeNames = ['CommonJS', 'ESM', 'StrippedTypeScript', 'TransformedTypeScript',
  'TransformedTypeScriptWithSourceMaps'];
// Native kind 2 compiles a function with its own parameter list. Node counts it as
// CommonJS, but its bytecode differs from a plain script of the same file.
const kWrappedKey = 0x80;
const kMagic = 0x8adfdbb2;
const kHeaderSize = 20;
const errorText = {
  ENOENT: 'no such file or directory', EACCES: 'permission denied', EPERM: 'operation not permitted',
  ENOTDIR: 'not a directory', EISDIR: 'illegal operation on a directory', EEXIST: 'file already exists',
  ENOSPC: 'no space left on device', EROFS: 'read-only file system', ENAMETOOLONG: 'name too long',
};

let cacheDir = '';
let portable = false;
let entries = new Map();
// The engine reports only rejected caches (by compiling and saving). An entry
// handed out stays here until the next cache call, which then logs it accepted.
let awaiting = null;
let debugEnabled;

function debug(text) {
  if (debugEnabled === undefined) {
    const list = process.env.NODE_DEBUG_NATIVE;
    debugEnabled = typeof list === 'string' &&
      list.split(',').some(name => name.trim().toUpperCase() === 'COMPILE_CACHE');
  }
  if (debugEnabled) try { fs.writeSync(2, text); } catch {}
}
function describe(error) { return errorText[error && error.code] || (error && error.message) || String(error); }
function owned(bytes) {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
function crc32(bytes) { return host.compression('crc32', [owned(bytes), 0]) >>> 0; }
function hex(value) { return value.toString(16).padStart(8, '0'); }
function versionTag() {
  const build = crc32(Buffer.from(host.cacheBuildIdentity, 'hex'));
  let tag = `${process.version}-${process.arch}-${hex(build)}`;
  if (typeof process.getuid === 'function') tag += `-${process.getuid()}`;
  return tag;
}
function isAbsoluteFilePath(name) { return name.startsWith('file://') || path.isAbsolute(name); }

function settle(next) {
  const entry = awaiting;
  awaiting = null;
  if (entry !== null && entry !== next) {
    debug(`[compile cache] V8 code cache for ${typeNames[entry.type]} ${entry.sourceFilename} was accepted, keeping the in-memory entry\n`);
  }
}

function readCacheFile(entry) {
  debug(`[compile cache] reading cache from ${entry.cacheFilename} for ${typeNames[entry.type]} ${entry.sourceFilename}...`);
  let bytes;
  try { bytes = fs.readFileSync(entry.cacheFilename); }
  catch (error) { debug(` ${describe(error)}\n`); return; }
  if (bytes.length < kHeaderSize) { debug(`reading header failed, bytes read ${bytes.length}\n`); return; }
  const magic = bytes.readUInt32LE(0), codeSize = bytes.readUInt32LE(4), cacheSize = bytes.readUInt32LE(8);
  const codeHash = bytes.readUInt32LE(12), cacheHash = bytes.readUInt32LE(16);
  debug(`[${magic} ${codeSize} ${cacheSize} ${codeHash} ${cacheHash}]...`);
  if (magic !== kMagic) { debug(`magic number mismatch: expected ${kMagic}, actual ${magic}\n`); return; }
  if (codeSize !== entry.codeSize) { debug(`code size mismatch: expected ${entry.codeSize}, actual ${codeSize}\n`); return; }
  if (codeHash !== entry.codeHash) { debug(`code hash mismatch: expected ${entry.codeHash}, actual ${codeHash}\n`); return; }
  const cache = bytes.subarray(kHeaderSize);
  if (cacheSize !== cache.length) { debug(`cache size mismatch: expected ${cacheSize}, actual ${cache.length}\n`); return; }
  const actual = crc32(cache);
  if (cacheHash !== actual) { debug(`cache hash mismatch: expected ${cacheHash}, actual ${actual}\n`); return; }
  entry.cache = cache;
  debug(` success, size=${cache.length}\n`);
}

function getOrInsert(source, filename, type, keyType = type) {
  let name = filename;
  if (portable && isAbsoluteFilePath(name)) {
    let normalized;
    try { normalized = path.normalize(name.startsWith('file:') ? require('url').fileURLToPath(name) : name); }
    catch { return; }
    const relative = path.relative(cacheDir, normalized);
    if (relative) {
      name = relative;
      debug(`[compile cache] using relative path ${name} from ${cacheDir}\n`);
    }
  }
  const key = crc32(Buffer.concat([Buffer.of(keyType), Buffer.from(name)]));
  const code = Buffer.from(source);
  const codeHash = crc32(code);
  const loaded = entries.get(key);
  if (loaded !== undefined && loaded.codeHash === codeHash) return loaded;
  const entry = {
    codeHash, codeSize: code.length, cacheFilename: path.join(cacheDir, hex(key)),
    sourceFilename: filename, type, cache: null, refreshed: false, persisted: false,
  };
  entries.set(key, entry);
  readCacheFile(entry);
  return entry;
}

// Native callbacks: kind 0 is CommonJS, 1 ESM, 2 a wrapped CommonJS function.
function entryFor(source, filename, kind) {
  return kind === 2 ? getOrInsert(source, filename, kCommonJS, kWrappedKey) : getOrInsert(source, filename, kind);
}
function load(source, filename, kind) {
  try {
    settle(null);
    const entry = entryFor(source, filename, kind);
    if (entry === undefined || entry.cache === null) return;
    awaiting = entry;
    // The native decoder takes only stable, owned ArrayBuffer storage.
    return entry.cache.buffer.slice(entry.cache.byteOffset, entry.cache.byteOffset + entry.cache.byteLength);
  } catch { return; }
}
function save(source, filename, kind, bytecode) {
  try {
    const entry = entryFor(source, filename, kind);
    settle(entry);
    if (entry === undefined) return;
    const rejected = entry.cache !== null;
    debug(`[compile cache] V8 code cache for ${typeNames[entry.type]} ${entry.sourceFilename} was ${rejected ? 'rejected' : 'not initialized'}, ` +
      `${rejected ? 'refreshing' : 'initializing'} the in-memory entry\n`);
    entry.cache = Buffer.from(bytecode);
    entry.refreshed = true;
  } catch { /* Cache allocation/I/O must never change module execution. */ }
}

// TypeScript loader hook: returns the cached JavaScript for `source`, or calls
// `transpile` and keeps its result for the next run.
function transpile(source, filename, mode, sourceMap, transpileSource) {
  if (!cacheDir || !filename) return transpileSource();
  let entry;
  try {
    settle(null);
    const type = mode === 'transform' ? (sourceMap ? kTransformedTypeScriptWithSourceMaps : kTransformedTypeScript)
      : kStrippedTypeScript;
    entry = getOrInsert(source, filename, type);
    if (entry !== undefined && entry.cache !== null) {
      debug(`[compile cache] retrieving transpile cache for ${typeNames[type]} ${filename}...`);
      const text = entry.cache.toString();
      debug('success\n');
      return text;
    }
    if (entry !== undefined) debug(`[compile cache] no transpile cache for ${typeNames[type]} ${filename}\n`);
  } catch { entry = undefined; }
  const output = transpileSource();
  if (entry !== undefined) {
    debug(`[compile cache] saving transpilation cache for ${typeNames[entry.type]} ${entry.sourceFilename}\n`);
    entry.cache = Buffer.from(output);
    entry.refreshed = true;
  }
  return output;
}

function enableCompileCache(options) {
  let directory, requestedPortable;
  if (typeof options === 'object' && options !== null) ({ directory, portable: requestedPortable } = options);
  else directory = options;
  if (directory === undefined) directory = process.env.NODE_COMPILE_CACHE || path.join(require('os').tmpdir(), 'node-compile-cache');
  if (requestedPortable === undefined) requestedPortable = process.env.NODE_COMPILE_CACHE_PORTABLE === '1';
  if (typeof directory !== 'string') throw codedError(TypeError, 'ERR_INVALID_ARG_TYPE', 'cacheDir should be a string');
  return enable(directory, requestedPortable === true);
}
function enable(directory, requestedPortable) {
  if (process.env.NODE_DISABLE_COMPILE_CACHE !== undefined) {
    const message = 'Disabled by NODE_DISABLE_COMPILE_CACHE';
    debug(`[compile cache] ${message}.\n`);
    return { status: compileCacheStatus.DISABLED, message };
  }
  if (cacheDir) return { status: compileCacheStatus.ALREADY_ENABLED, directory: cacheDir };
  const tag = versionTag();
  // Node's native UTF8 path argument terminates at the first NUL.
  const base = path.resolve(directory.split('\0', 1)[0]);
  const target = base + path.sep + tag;
  debug(`[compile cache] resolved path ${directory} + ${tag} -> ${target}\n`);
  const failed = message => {
    debug(`[compile cache] ${message}\n`);
    return { status: compileCacheStatus.FAILED, message };
  };
  const permission = require('internal/permission');
  for (const [scope, name] of [['fs.write', 'write'], ['fs.read', 'read']]) {
    if (!permission.allows(scope, target)) return failed(`Skipping compile cache because ${name} permission for ${target} is not granted`);
  }
  let error;
  try { fs.mkdirSync(target, { recursive: true }); } catch (cause) { error = cause; }
  debug(`[compile cache] creating cache directory ${target}...${error ? describe(error) : 'success'}\n`);
  if (error && error.code !== 'EEXIST') return failed(`Cannot create cache directory: ${describe(error)}`);
  cacheDir = target;
  portable = requestedPortable;
  host.setCompileCacheCallbacks(load, save);
  return { status: compileCacheStatus.ENABLED, directory: base };
}
function getCompileCacheDir() { return cacheDir || undefined; }

function temporaryFile(prefix) {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (;;) {
    let name = prefix + '.';
    for (let i = 0; i < 6; i++) name += letters[Math.floor(Math.random() * letters.length)];
    try { return { name, fd: fs.openSync(name, 'wx', 0o600) }; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}
function persist() {
  settle(null);
  for (const entry of entries.values()) {
    const type = typeNames[entry.type];
    if (entry.cache === null) {
      debug(`[compile cache] skip persisting ${type} ${entry.sourceFilename} because the cache was not initialized\n`);
      continue;
    }
    if (!entry.refreshed) {
      debug(`[compile cache] skip persisting ${type} ${entry.sourceFilename} because cache was the same\n`);
      continue;
    }
    if (entry.persisted) {
      debug(`[compile cache] skip persisting ${type} ${entry.sourceFilename} because cache was already persisted\n`);
      continue;
    }
    const header = Buffer.alloc(kHeaderSize);
    const cacheHash = crc32(entry.cache);
    header.writeUInt32LE(kMagic, 0);
    header.writeUInt32LE(entry.codeSize, 4);
    header.writeUInt32LE(entry.cache.length, 8);
    header.writeUInt32LE(entry.codeHash, 12);
    header.writeUInt32LE(cacheHash, 16);
    debug(`[compile cache] Creating temporary file for cache of ${entry.sourceFilename} (${type})...`);
    let file;
    try { file = temporaryFile(entry.cacheFilename); }
    catch (error) { debug(`failed. ${describe(error)}\n`); continue; }
    debug(` -> ${file.name}\n`);
    debug(`[compile cache] writing cache for ${type} ${entry.sourceFilename} to temporary file ${file.name} ` +
      `[${kMagic} ${entry.codeSize} ${entry.cache.length} ${entry.codeHash} ${cacheHash}]...`);
    try {
      try { fs.writeSync(file.fd, header); fs.writeSync(file.fd, entry.cache); }
      finally { fs.closeSync(file.fd); }
    } catch (error) { debug(`failed: ${describe(error)}\n`); continue; }
    debug('success\n');
    debug(`[compile cache] Renaming ${file.name} to ${entry.cacheFilename}...`);
    try { fs.renameSync(file.name, entry.cacheFilename); }
    catch (error) { debug(`failed: ${describe(error)}\n`); continue; }
    debug('success\n');
    entry.persisted = true;
  }
  debug('[compile cache] Clear deserialized cache.\n');
  entries = new Map();
}
function flushCompileCache(keepDeserializedCache) {
  if (keepDeserializedCache !== undefined && typeof keepDeserializedCache !== 'boolean')
    throw codedError(TypeError, 'ERR_INVALID_ARG_TYPE', 'keepDeserializedCache should be a boolean');
  debug('[compile cache] module.flushCompileCache() requested.\n');
  if (cacheDir) persist();
  debug('[compile cache] module.flushCompileCache() finished.\n');
}
// Process exit and worker shutdown: Node's AtExit hook, which logs no request lines.
function flushAtExit() { if (cacheDir) persist(); }
function initialize() {
  const directory = process.env.NODE_COMPILE_CACHE;
  if (!directory) return;
  const usePortable = process.env.NODE_COMPILE_CACHE_PORTABLE === '1';
  if (usePortable) debug('[compile cache] using relative path\n');
  enable(directory, usePortable);
}
module.exports = { initialize, enableCompileCache, getCompileCacheDir, flushCompileCache, flushAtExit, transpile, constants };
