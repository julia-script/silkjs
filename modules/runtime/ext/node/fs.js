'use strict';
// The argument handling follows Node's lib/fs.js (v24) function by function; the work goes
// to the native fsSync and submitIO operations.
const c = require('internal/fs_core');
const p = require('path');
const { Buffer, os, constants, Dirent, makeStats, makeStatFs } = c;
const v = c.v;
const { ERR_INVALID_ARG_VALUE, validateBoolean, validateFunction, validateInteger, validateObject, validateOneOf, validateString, kValidateObjectAllowNullable } = v;
const { bufferCodec } = c.host;
const fs = module.exports;
const kMaxUserId = 2 ** 32 - 1;
const kIoMaxLength = 2 ** 31 - 1;
const customPromisifyArgs = Symbol.for('nodejs.util.promisify.customArgs');
const customPromisified = Symbol.for('nodejs.util.promisify.custom');
const isFd = value => value === (value | 0);
const stats = (value, bigint) => value === undefined ? undefined : makeStats(value, !!bigint);
Object.defineProperty(fs, 'constants', { value: constants, enumerable: true, configurable: false, writable: false });
fs.Dirent = Dirent;
fs.Stats = require('util').deprecate(c.Stats, 'fs.Stats constructor is deprecated.', 'DEP0180');
for (const name of ['F_OK', 'R_OK', 'W_OK', 'X_OK']) {
  const value = constants[name];
  Object.defineProperty(fs, name, {
    enumerable: false, configurable: true,
    get: require('util').deprecate(() => value || 0, `fs.${name} is deprecated, use fs.constants.${name} instead`, 'DEP0176'),
  });
}
function makeCallback(cb) { validateFunction(cb, 'cb'); return cb; }
function checkAborted(signal, callback) {
  if (signal && signal.aborted) { callback(v.abortError(signal)); return true; }
  return false;
}
function aggregateTwoErrors(inner, outer) {
  if (inner && outer && inner !== outer) {
    if (Array.isArray(outer.errors)) { outer.errors.push(inner); return outer; }
    const error = new AggregateError([outer, inner], outer.message);
    error.code = outer.code; return error;
  }
  return inner || outer;
}
// Node's getValidMode for access (F_OK..7) and copyFile (0..7).
function validMode(mode, type) {
  if (mode == null) return type === 'copyFile' ? 0 : constants.F_OK;
  validateInteger(mode, 'mode', 0, 7);
  return mode;
}
let warnedNonPortableTemplate = false;
function warnOnNonPortableTemplate(template) {
  if (!warnedNonPortableTemplate && template.endsWith('X')) {
    process.emitWarning('mkdtemp() templates ending with X are not portable. For details see: https://nodejs.org/api/fs.html');
    warnedNonPortableTemplate = true;
  }
}

fs.access = function access(path, mode, callback) {
  if (typeof mode === 'function') { callback = mode; mode = constants.F_OK; }
  path = c.path(path); mode = validMode(mode, 'access'); callback = makeCallback(callback);
  c.submit('access', [path, mode], callback);
};
fs.accessSync = function accessSync(path, mode) { c.native('access', [c.path(path), validMode(mode, 'access')]); };
fs.exists = function exists(path, callback) {
  validateFunction(callback, 'cb');
  try { fs.access(path, constants.F_OK, err => callback(!err)); } catch { return callback(false); }
};
Object.defineProperty(fs.exists, customPromisified, { value: function exists(path) { return new Promise(resolve => fs.exists(path, resolve)); } });
let showExistsDeprecation = true;
fs.existsSync = function existsSync(path) {
  try { path = c.path(path); } catch (err) {
    if (showExistsDeprecation && err && err.code === 'ERR_INVALID_ARG_TYPE') {
      process.emitWarning('Passing invalid argument types to fs.existsSync is deprecated', 'DeprecationWarning', 'DEP0187');
      showExistsDeprecation = false;
    }
    return false;
  }
  try { c.native('access', [path, constants.F_OK]); return true; } catch { return false; }
};

function defaultCloseCallback(err) { if (err != null) throw err; }
fs.close = function close(fd, callback = defaultCloseCallback) {
  fd = c.fd(fd);
  if (callback !== defaultCloseCallback) callback = makeCallback(callback);
  c.submit('close', [fd], callback);
};
fs.closeSync = function closeSync(fd) { c.native('close', [c.fd(fd)]); };
fs.open = function open(path, flags, mode, callback) {
  path = c.path(path);
  if (arguments.length < 3) { callback = flags; flags = 'r'; mode = 0o666; }
  else if (typeof mode === 'function') { callback = mode; mode = 0o666; }
  else mode = c.mode(mode, 0o666);
  const flagsNumber = c.flags(flags);
  callback = makeCallback(callback);
  c.submit('open', [path, flagsNumber, mode], callback);
};
fs.openSync = function openSync(path, flags, mode) { return c.native('open', [c.path(path), c.flags(flags), c.mode(mode, 0o666)]); };
fs.openAsBlob = function openAsBlob(path, options = {}) {
  validateObject(options, 'options');
  const type = options.type || '';
  validateString(type, 'options.type');
  path = c.path(path);
  const stat = fs.statSync(path, { bigint: true });
  return Promise.resolve(require('internal/web/blob')._fromFile(path, stat, type));
};

// A read or write of length bytes at offset in buffer; position null is the current one.
function transfer(operation, fd, buffer, offset, length, position) {
  if (position !== null) return c.native(operation === 'read' ? 'pread' : 'pwrite', [fd, buffer.buffer, buffer.byteOffset + offset, length, position]);
  return c.fail(os[operation](fd, buffer.buffer, buffer.byteOffset + offset, length), operation);
}
fs.read = function read(fd, buffer, offsetOrOptions, length, position, callback) {
  fd = c.fd(fd);
  let offset = offsetOrOptions;
  let params = null;
  if (arguments.length <= 4) {
    if (arguments.length === 4) {
      validateObject(offsetOrOptions, 'options', kValidateObjectAllowNullable);
      callback = length; params = offsetOrOptions;
    } else if (arguments.length === 3) {
      if (!ArrayBuffer.isView(buffer)) { params = buffer; ({ buffer = Buffer.alloc(16384) } = params ?? {}); }
      callback = offsetOrOptions;
    } else { callback = buffer; buffer = Buffer.alloc(16384); }
    if (params !== undefined) validateObject(params, 'options', kValidateObjectAllowNullable);
    ({ offset = 0, length = buffer?.byteLength - offset, position = null } = params ?? {});
  }
  c.bytes(buffer);
  validateFunction(callback, 'cb');
  if (offset == null) offset = 0; else validateInteger(offset, 'offset', 0);
  length |= 0;
  position = c.position(position, 'position', length);
  if (length === 0) { process.nextTick(function tick() { callback(null, 0, buffer); }); return; }
  if (buffer.byteLength === 0) throw ERR_INVALID_ARG_VALUE('buffer', buffer, 'is empty and cannot be written');
  c.validateOffsetLengthRead(offset, length, buffer.byteLength);
  c.submit('read', [fd, buffer, offset, length, position], (err, bytesRead) => callback(err || null, bytesRead || 0, buffer), callback);
};
Object.defineProperty(fs.read, customPromisifyArgs, { value: ['bytesRead', 'buffer'], enumerable: false });
fs.readSync = function readSync(fd, buffer, offsetOrOptions, length, position) {
  fd = c.fd(fd);
  c.bytes(buffer);
  let offset = offsetOrOptions;
  if (arguments.length <= 3 || typeof offsetOrOptions === 'object') {
    if (offsetOrOptions !== undefined) validateObject(offsetOrOptions, 'options', kValidateObjectAllowNullable);
    ({ offset = 0, length = buffer.byteLength - offset, position = null } = offsetOrOptions ?? {});
  }
  if (offset === undefined) offset = 0; else validateInteger(offset, 'offset', 0);
  length |= 0;
  position = c.position(position, 'position', length);
  if (length === 0) return 0;
  if (buffer.byteLength === 0) throw ERR_INVALID_ARG_VALUE('buffer', buffer, 'is empty and cannot be written');
  c.validateOffsetLengthRead(offset, length, buffer.byteLength);
  return transfer('read', fd, buffer, offset, length, position);
};
function vectorSync(operation, fd, buffers, position) {
  let total = 0;
  for (const buffer of buffers) {
    const count = transfer(operation, fd, buffer, 0, buffer.byteLength, position);
    total += count;
    if (position !== null) position += typeof position === 'bigint' ? BigInt(count) : count;
    if (count < buffer.byteLength) break;
  }
  return total;
}
fs.readv = function readv(fd, buffers, position, callback) {
  fd = c.fd(fd); c.bufferArray(buffers);
  callback ||= position; validateFunction(callback, 'cb');
  if (typeof position !== 'number') position = null;
  c.submit('readv', [fd, buffers, position], (err, read) => callback(err || null, read || 0, buffers), callback);
};
Object.defineProperty(fs.readv, customPromisifyArgs, { value: ['bytesRead', 'buffers'], enumerable: false });
fs.readvSync = function readvSync(fd, buffers, position) {
  fd = c.fd(fd); c.bufferArray(buffers);
  if (typeof position !== 'number') position = null;
  return vectorSync('read', fd, buffers, position);
};
fs.write = function write(fd, buffer, offsetOrOptions, length, position, callback) {
  fd = c.fd(fd);
  let offset = offsetOrOptions;
  if (ArrayBuffer.isView(buffer)) {
    callback ||= position || length || offset;
    validateFunction(callback, 'cb');
    if (typeof offset === 'object') ({ offset = 0, length = buffer.byteLength - offset, position = null } = offsetOrOptions ?? {});
    if (offset == null || typeof offset === 'function') offset = 0; else validateInteger(offset, 'offset', 0);
    if (typeof length !== 'number') length = buffer.byteLength - offset;
    if (typeof position !== 'number') position = null;
    c.validateOffsetLengthWrite(offset, length, buffer.byteLength);
    c.submit('write', [fd, buffer, offset, length, position], (err, written) => callback(err || null, written || 0, buffer), callback);
    return;
  }
  c.validateStringAfterArrayBufferView(buffer, 'buffer');
  if (typeof position !== 'function') {
    if (typeof offset === 'function') { position = offset; offset = null; } else position = length;
    length = 'utf8';
  }
  const string = buffer;
  validateEncoding(string, length);
  callback = position;
  validateFunction(callback, 'cb');
  const bytes = Buffer.from(string, length || 'utf8');
  c.submit('write', [fd, bytes, 0, bytes.byteLength, typeof offset === 'number' ? offset : null], (err, written) => callback(err || null, written || 0, string), callback);
};
Object.defineProperty(fs.write, customPromisifyArgs, { value: ['bytesWritten', 'buffer'], enumerable: false });
function validateEncoding(data, encoding) {
  const normalized = Buffer.isEncoding(encoding) ? String(encoding).toLowerCase() : encoding;
  if (normalized === 'hex' && data.length % 2 !== 0) throw ERR_INVALID_ARG_VALUE('encoding', encoding, `is invalid for data of length ${data.length}`);
}
fs.writeSync = function writeSync(fd, buffer, offsetOrOptions, length, position) {
  fd = c.fd(fd);
  let offset = offsetOrOptions;
  if (ArrayBuffer.isView(buffer)) {
    // The whole of a view at the current position: the common call.
    if (offset === undefined && length === undefined && position === undefined) return c.fail(os.write(fd, buffer.buffer, buffer.byteOffset, buffer.byteLength), 'write');
    if (typeof offset === 'object') ({ offset = 0, length = buffer.byteLength - offset, position = null } = offsetOrOptions ?? {});
    if (position === undefined) position = null;
    if (offset == null) offset = 0; else validateInteger(offset, 'offset', 0);
    if (typeof length !== 'number') length = buffer.byteLength - offset;
    c.validateOffsetLengthWrite(offset, length, buffer.byteLength);
    return transfer('write', fd, buffer, offset, length, typeof position === 'number' || typeof position === 'bigint' ? c.position(position) : null);
  }
  c.validateStringAfterArrayBufferView(buffer, 'buffer');
  validateEncoding(buffer, length);
  if (offset === undefined) offset = null;
  const encoding = typeof length === 'string' ? length : 'utf8';
  if ((encoding === 'utf8' || encoding === 'utf-8') && buffer.length <= 21845 && offset === null) {
    // Three bytes at most for each UTF-16 unit, so the string fits in the read buffer.
    const scratch = readBuffer || Buffer.allocUnsafeSlow(65536); readBuffer = null;
    try {
      const count = buffer.length === 0 ? 0 : bufferCodec(1, buffer, scratch, 0, scratch.length);
      return c.fail(os.write(fd, scratch.buffer, scratch.byteOffset, count), 'write');
    } finally { readBuffer = scratch; }
  }
  const bytes = Buffer.from(buffer, encoding);
  return transfer('write', fd, bytes, 0, bytes.byteLength, typeof offset === 'number' ? c.position(offset) : null);
};
fs.writev = function writev(fd, buffers, position, callback) {
  fd = c.fd(fd); c.bufferArray(buffers);
  callback ||= position; validateFunction(callback, 'cb');
  if (buffers.length === 0) { process.nextTick(callback, null, 0, buffers); return; }
  if (typeof position !== 'number') position = null;
  c.submit('writev', [fd, buffers, position], (err, written) => callback(err || null, written || 0, buffers), callback);
};
Object.defineProperty(fs.writev, customPromisifyArgs, { value: ['bytesWritten', 'buffer'], enumerable: false });
fs.writevSync = function writevSync(fd, buffers, position) {
  fd = c.fd(fd); c.bufferArray(buffers);
  if (buffers.length === 0) return 0;
  if (typeof position !== 'number') position = null;
  return vectorSync('write', fd, buffers, position);
};

fs.rename = function rename(oldPath, newPath, callback) {
  callback = makeCallback(callback);
  c.submit('rename', [c.path(oldPath, 'oldPath'), c.path(newPath, 'newPath')], callback);
};
fs.renameSync = function renameSync(oldPath, newPath) {
  oldPath = c.path(oldPath, 'oldPath'); newPath = c.path(newPath, 'newPath');
  c.fail(os.rename(oldPath, newPath), 'rename', oldPath, newPath);
};
fs.truncate = function truncate(path, len, callback) {
  if (typeof len === 'function') { callback = len; len = 0; } else if (len === undefined) len = 0;
  validateInteger(len, 'len'); len = Math.max(0, len);
  validateFunction(callback, 'cb');
  fs.open(path, 'r+', (er, fd) => {
    if (er) return callback(er);
    c.submit('ftruncate', [fd, len], er => { fs.close(fd, er2 => callback(aggregateTwoErrors(er2, er))); });
  });
};
fs.truncateSync = function truncateSync(path, len) {
  if (len === undefined) len = 0;
  const fd = fs.openSync(path, 'r+');
  try { fs.ftruncateSync(fd, len); } finally { fs.closeSync(fd); }
};
fs.ftruncate = function ftruncate(fd, len = 0, callback) {
  if (typeof len === 'function') { callback = len; len = 0; }
  fd = c.fd(fd);
  validateInteger(len, 'len'); len = Math.max(0, len);
  callback = makeCallback(callback);
  c.submit('ftruncate', [fd, len], callback);
};
fs.ftruncateSync = function ftruncateSync(fd, len = 0) {
  fd = c.fd(fd); validateInteger(len, 'len');
  c.native('ftruncate', [fd, len < 0 ? 0 : len]);
};

// Node's validateRmdirOptions and validateRmOptions(Sync).
const defaultRmdirOptions = { retryDelay: 100, maxRetries: 0, recursive: false };
const defaultRmOptions = { recursive: false, force: false, retryDelay: 100, maxRetries: 0 };
function validateRmdirOptions(options, defaults = defaultRmdirOptions) {
  if (options === undefined) return defaults;
  validateObject(options, 'options');
  options = { ...defaults, ...options };
  validateBoolean(options.recursive, 'options.recursive');
  v.validateInt32(options.retryDelay, 'options.retryDelay', 0);
  v.validateUint32(options.maxRetries, 'options.maxRetries');
  return options;
}
function isDirectoryError(path) { return v.systemError('ERR_FS_EISDIR', { code: 'EISDIR', message: 'is a directory', path, syscall: 'rm', errno: 21 }); }
function validateRmOptionsSync(path, options, expectDir) {
  options = validateRmdirOptions(options, defaultRmOptions);
  validateBoolean(options.force, 'options.force');
  if (!options.force || expectDir || !options.recursive) {
    const info = fs.lstatSync(path, { throwIfNoEntry: !options.force });
    const isDirectory = info !== undefined && info.isDirectory();
    if (expectDir && !isDirectory) return false;
    if (isDirectory && !options.recursive) throw isDirectoryError(path);
  }
  return options;
}
function validateRmOptions(path, options, expectDir, cb) {
  options = validateRmdirOptions(options, defaultRmOptions);
  validateBoolean(options.force, 'options.force');
  fs.lstat(path, (err, info) => {
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
const retryable = new Set(['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM']);
function removeSync(path, options) {
  for (let attempt = 0; ; attempt++) {
    try {
      let info;
      try { info = fs.lstatSync(path); } catch (e) { if (options.force && e.code === 'ENOENT') return; throw e; }
      if (info.isDirectory()) {
        if (!options.recursive) throw isDirectoryError(path);
        for (const name of c.native('scandir', [path])) if (name !== '.' && name !== '..') removeSync(p.join(path, name), { ...options, maxRetries: 0 });
        c.native('rmdir', [path]);
      } else c.native('unlink', [path]);
      return;
    } catch (e) {
      if (options.force && e.code === 'ENOENT') return;
      if (!options.recursive || !retryable.has(e.code) || attempt >= options.maxRetries) throw e;
    }
  }
}
fs.rmdir = function rmdir(path, options, callback) {
  if (typeof options === 'function') { callback = options; options = undefined; }
  callback = makeCallback(callback);
  path = c.path(path);
  if (options?.recursive) {
    emitRecursiveRmdirWarning();
    validateRmOptions(path, { ...options, force: false }, true, (err, options) => {
      if (err === false) { c.submit('rmdir', [path, {}], callback); return; }
      if (err) return callback(err);
      c.submit('rm', [path, options], callback);
    });
  } else {
    validateRmdirOptions(options);
    c.submit('rmdir', [path, {}], callback);
  }
};
fs.rmdirSync = function rmdirSync(path, options) {
  path = c.path(path);
  if (options?.recursive) {
    emitRecursiveRmdirWarning();
    options = validateRmOptionsSync(path, { ...options, force: false }, true);
    if (options !== false) return removeSync(path, options);
  } else validateRmdirOptions(options);
  c.native('rmdir', [path]);
};
fs.rm = function rm(path, options, callback) {
  if (typeof options === 'function') { callback = options; options = undefined; }
  path = c.path(path);
  validateRmOptions(path, options, false, (err, options) => {
    if (err) return callback(err);
    c.submit('rm', [path, options], callback);
  });
};
fs.rmSync = function rmSync(path, options) {
  path = c.path(path);
  const o = validateRmOptionsSync(path, options, false);
  return removeSync(path, o);
};
for (const name of ['fsync', 'fdatasync']) {
  fs[name] = function(fd, callback) { callback = makeCallback(callback); c.submit(name, [c.fd(fd)], callback); };
  fs[`${name}Sync`] = function(fd) { c.native(name, [c.fd(fd)]); };
}

function mkdirArguments(options) {
  let mode = 0o777; let recursive = false;
  if (typeof options === 'number' || typeof options === 'string') mode = c.mode(options, undefined, 'mode');
  else if (options) {
    if (options.recursive !== undefined) { recursive = options.recursive; validateBoolean(recursive, 'options.recursive'); }
    if (options.mode !== undefined) mode = c.mode(options.mode, undefined, 'options.mode');
  }
  return { mode, recursive };
}
fs.mkdir = function mkdir(path, options, callback) {
  if (typeof options === 'function') { callback = options; options = undefined; }
  const o = mkdirArguments(options);
  callback = makeCallback(callback);
  c.submit('mkdir', [c.path(path), o], callback);
};
fs.mkdirSync = function mkdirSync(path, options) {
  path = c.path(path); const { mode, recursive } = mkdirArguments(options);
  if (!recursive) { c.fail(os.mkdir(path, mode), 'mkdir', path); return; }
  // As libuv's recursive mkdir: the first directory made, or undefined when all existed.
  let first;
  function create(current) {
    const result = os.mkdir(current, mode);
    if (result >= 0) { if (first === undefined) first = current; return; }
    try { c.fail(result, 'mkdir', current); } catch (e) {
      if (e.code === 'ENOENT') { const parent = p.dirname(current); if (parent === current) throw e; create(parent); const again = os.mkdir(current, mode); if (again >= 0) { if (first === undefined) first = current; return; } try { c.fail(again, 'mkdir', current); } catch (race) { if (race.code !== 'EEXIST' || !fs.statSync(current).isDirectory()) throw race; } }
      else if (e.code !== 'EEXIST') throw e;
      else { const info = fs.statSync(current, { throwIfNoEntry: false }); if (!info || !info.isDirectory()) throw c.error(info ? 'ENOTDIR' : 'EEXIST', 'mkdir', path, undefined, info ? -20 : -17); }
    }
  }
  create(p.resolve(path)); return first;
};

function readdirEntries(dir, o, recursive) {
  const output = [];
  const queue = [dir];
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    for (const name of c.native('scandir', [current])) {
      if (name === '.' || name === '..') continue;
      const full = p.join(current, name);
      const info = o.withFileTypes || recursive ? fs.lstatSync(full) : null;
      if (o.withFileTypes) output.push(new Dirent(c.encoded(name, o.encoding), info.mode, current));
      else output.push(c.encoded(recursive ? p.relative(dir, full) : name, o.encoding));
      if (recursive && (info.isDirectory() || (info.isSymbolicLink() && fs.statSync(full, { throwIfNoEntry: false })?.isDirectory()))) queue.push(full);
    }
  }
  return output;
}
fs.readdirSync = function readdirSync(path, options) {
  const o = c.options(options, { encoding: 'utf8' }); path = c.path(path);
  if (o.recursive != null) validateBoolean(o.recursive, 'options.recursive');
  return readdirEntries(path, o, !!o.recursive);
};
fs.readdir = function readdir(path, options, callback) {
  callback = makeCallback(typeof options === 'function' ? options : callback);
  const o = c.options(options, { encoding: 'utf8' }); path = c.path(path);
  if (o.recursive != null) validateBoolean(o.recursive, 'options.recursive');
  c.submit('readdir', [path, o], (err, value) => {
    if (err) { callback(err); return; }
    callback(null, value.map(entry => o.withFileTypes ? entry instanceof Dirent ? entry : new Dirent(c.encoded(entry.name, o.encoding), entry.mode, entry.parentPath === undefined ? path : entry.parentPath) : typeof entry === 'string' ? c.encoded(entry, o.encoding) : Buffer.from(entry)));
  }, callback);
};

function statCallback(cb, bigint) { validateFunction(cb, 'cb'); return [(err, value) => { if (err) return cb(err); cb(null, stats(value, bigint)); }, cb]; }
fs.fstat = function fstat(fd, options = { bigint: false }, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  const [done, owner] = statCallback(callback, options.bigint);
  c.submit('fstat', [c.fd(fd), { bigint: !!options.bigint }], done, owner);
};
fs.lstat = function lstat(path, options = { bigint: false }, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  const [done, owner] = statCallback(callback, options.bigint);
  c.submit('lstat', [c.path(path), { bigint: !!options.bigint }], done, owner);
};
fs.stat = function stat(path, options = { bigint: false, throwIfNoEntry: true }, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  else if (options === null || typeof options !== 'object') options = {};
  else options = c.options(options, { bigint: false });
  const [done, owner] = statCallback(callback, options.bigint);
  path = c.path(path);
  if (checkAborted(options.signal, callback)) return;
  c.submit('stat', [path, { bigint: !!options.bigint, throwIfNoEntry: options.throwIfNoEntry }], done, owner);
};
fs.statfs = function statfs(path, options = { bigint: false }, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  validateFunction(callback, 'cb');
  path = c.path(path);
  c.submit('statfs', [path, { bigint: !!options.bigint }], (err, value) => { if (err) return callback(err); callback(null, makeStatFs(value, !!options.bigint)); }, callback);
};
function statSync(operation, target, options) {
  try { return stats(c.native(operation, [target, { bigint: !!options.bigint }]), options.bigint); }
  catch (e) { if (options.throwIfNoEntry === false && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return undefined; throw e; }
}
fs.fstatSync = function fstatSync(fd, options = { bigint: false }) { return statSync('fstat', c.fd(fd), options); };
fs.lstatSync = function lstatSync(path, options = { bigint: false, throwIfNoEntry: true }) { return statSync('lstat', c.path(path), options); };
fs.statSync = function statSync_(path, options = { bigint: false, throwIfNoEntry: true }) { return statSync('stat', c.path(path), options); };
Object.defineProperty(fs.statSync, 'name', { value: 'statSync' });
fs.statfsSync = function statfsSync(path, options = { bigint: false }) { return makeStatFs(c.native('statfs', [c.path(path), { bigint: !!options.bigint }]), !!options.bigint); };

fs.readlink = function readlink(path, options, callback) {
  callback = makeCallback(typeof options === 'function' ? options : callback);
  const o = c.options(options); const enc = c.encoding(o.encoding, 'utf8', true);
  c.submit('readlink', [c.path(path), o], (err, value) => err ? callback(err) : callback(null, c.encoded(value, enc)), callback);
};
fs.readlinkSync = function readlinkSync(path, options) {
  const o = c.options(options); path = c.path(path);
  return c.encoded(c.pair(os.readlink(path), 'readlink', path), c.encoding(o.encoding, 'utf8', true));
};
fs.symlink = function symlink(target, path, type, callback) {
  if (callback === undefined) { callback = makeCallback(type); type = undefined; }
  else validateOneOf(type, 'type', ['dir', 'file', 'junction', null, undefined]);
  target = c.path(target, 'target'); path = c.path(path);
  c.submit('symlink', [target, path, type], callback);
};
fs.symlinkSync = function symlinkSync(target, path, type) {
  validateOneOf(type, 'type', ['dir', 'file', 'junction', null, undefined]);
  target = c.path(target, 'target'); path = c.path(path);
  c.fail(os.symlink(target, path), 'symlink', target, path);
};
fs.link = function link(existingPath, newPath, callback) {
  callback = makeCallback(callback);
  c.submit('link', [c.path(existingPath, 'existingPath'), c.path(newPath, 'newPath')], callback);
};
fs.linkSync = function linkSync(existingPath, newPath) { c.native('link', [c.path(existingPath, 'existingPath'), c.path(newPath, 'newPath')]); };
fs.unlink = function unlink(path, callback) { callback = makeCallback(callback); c.submit('unlink', [c.path(path)], callback); };
fs.unlinkSync = function unlinkSync(path) { c.native('unlink', [c.path(path)]); };

fs.fchmod = function fchmod(fd, mode, callback) {
  fd = c.fd(fd); mode = c.mode(mode, undefined); callback = makeCallback(callback);
  c.submit('fchmod', [fd, mode], callback);
};
fs.fchmodSync = function fchmodSync(fd, mode) { c.native('fchmod', [c.fd(fd), c.mode(mode, undefined)]); };
fs.chmod = function chmod(path, mode, callback) {
  path = c.path(path); mode = c.mode(mode, undefined); callback = makeCallback(callback);
  c.submit('chmod', [path, mode], callback);
};
fs.chmodSync = function chmodSync(path, mode) { path = c.path(path); c.native('chmod', [path, c.mode(mode, undefined)]); };
if (constants.O_SYMLINK !== undefined) {
  fs.lchmod = function lchmod(path, mode, callback) {
    validateFunction(callback, 'cb'); path = c.path(path); mode = c.mode(mode, undefined);
    c.submit('lchmod', [path, mode], callback);
  };
  fs.lchmodSync = function lchmodSync(path, mode) { path = c.path(path); c.native('lchmod', [path, c.mode(mode, undefined)]); };
} else { fs.lchmod = undefined; fs.lchmodSync = undefined; }
function ids(uid, gid) { validateInteger(uid, 'uid', -1, kMaxUserId); validateInteger(gid, 'gid', -1, kMaxUserId); }
for (const name of ['chown', 'lchown']) {
  fs[name] = function(path, uid, gid, callback) { callback = makeCallback(callback); path = c.path(path); ids(uid, gid); c.submit(name, [path, uid, gid], callback); };
  fs[`${name}Sync`] = function(path, uid, gid) { path = c.path(path); ids(uid, gid); c.native(name, [path, uid, gid]); };
}
fs.fchown = function fchown(fd, uid, gid, callback) { fd = c.fd(fd); ids(uid, gid); callback = makeCallback(callback); c.submit('fchown', [fd, uid, gid], callback); };
fs.fchownSync = function fchownSync(fd, uid, gid) { fd = c.fd(fd); ids(uid, gid); c.native('fchown', [fd, uid, gid]); };
fs.utimes = function utimes(path, atime, mtime, callback) {
  callback = makeCallback(callback); path = c.path(path);
  c.submit('utimes', [path, c.time(atime), c.time(mtime)], callback);
};
fs.utimesSync = function utimesSync(path, atime, mtime) { path = c.path(path); c.fail(os.utimes(path, c.time(atime) * 1000, c.time(mtime) * 1000), 'utime', path); };
fs.futimes = function futimes(fd, atime, mtime, callback) {
  fd = c.fd(fd); atime = c.time(atime, 'atime'); mtime = c.time(mtime, 'mtime'); callback = makeCallback(callback);
  c.submit('futimes', [fd, atime, mtime], callback);
};
fs.futimesSync = function futimesSync(fd, atime, mtime) { c.native('futimes', [c.fd(fd), c.time(atime, 'atime'), c.time(mtime, 'mtime')]); };
fs.lutimes = function lutimes(path, atime, mtime, callback) {
  callback = makeCallback(callback); path = c.path(path);
  c.submit('lutimes', [path, c.time(atime), c.time(mtime)], callback);
};
fs.lutimesSync = function lutimesSync(path, atime, mtime) { c.native('lutimes', [c.path(path), c.time(atime), c.time(mtime)]); };

// Most files fit in this buffer, read into until a read returns 0 and then decoded or
// copied at the size read. A reader takes it, so a nested read gets its own.
let readBuffer = null;
function readAll(fd, signal, encoding) {
  const buffer = readBuffer || Buffer.allocUnsafeSlow(65536); readBuffer = null;
  try {
    let chunks = null, held = 0, total = 0;
    for (;;) {
      c.aborted(signal);
      if (held === buffer.length) { (chunks ??= []).push(Buffer.from(buffer)); held = 0; }
      const count = c.fail(os.read(fd, buffer.buffer, buffer.byteOffset + held, buffer.length - held), 'read');
      if (count === 0) break;
      held += count; total += count;
      if (total > kIoMaxLength) throw fileTooLarge(total);
    }
    if (chunks === null) return encoding == null ? Buffer.from(buffer.subarray(0, held)) : buffer.toString(encoding, 0, held);
    if (held !== 0) chunks.push(Buffer.from(buffer.subarray(0, held)));
    const result = Buffer.concat(chunks, total); return encoding == null ? result : result.toString(encoding);
  } finally { readBuffer = buffer; }
}
function fileTooLarge(size) { return v.makeError(RangeError, 'ERR_FS_FILE_TOO_LARGE', `File size (${size}) is greater than 2 GiB`); }
fs.readFileSync = function readFileSync(path, options) {
  const o = c.options(options, { flag: 'r' }); c.aborted(o.signal);
  const isUserFd = isFd(path);
  const fd = isUserFd ? path : fs.openSync(path, o.flag, 0o666);
  try { return readAll(fd, o.signal, o.encoding || null); }
  finally { if (!isUserFd) fs.closeSync(fd); }
};
fs.readFile = function readFile(path, options, callback) {
  callback ||= options; validateFunction(callback, 'cb');
  const o = c.options(options, { flag: 'r' });
  const encoding = o.encoding || null;
  const done = (err, value) => { if (err) { callback(err); return; } callback(null, encoding === null ? Buffer.from(value) : typeof value === 'string' ? value : Buffer.from(value).toString(encoding)); };
  if (isFd(path)) { c.submit('readFile', [path, { signal: o.signal, flag: 0 }], done, callback); return; }
  if (checkAborted(o.signal, callback)) return;
  const flag = c.flags(o.flag, 'options.flag');
  c.submit('readFile', [c.path(path), { signal: o.signal, flag }], done, callback);
};
function writeFileOptions(options, flag) {
  const o = c.options(options, { encoding: 'utf8', mode: 0o666, flag, flush: false });
  o.flag ||= flag;
  o.flush ??= false; validateBoolean(o.flush, 'options.flush');
  return o;
}
function writeFileData(data, o) {
  if (ArrayBuffer.isView(data)) return data;
  c.validateStringAfterArrayBufferView(data, 'data');
  return Buffer.from(data, o.encoding || 'utf8');
}
fs.writeFile = function writeFile(path, data, options, callback) {
  callback ||= options; validateFunction(callback, 'cb');
  const o = writeFileOptions(options, 'w');
  data = writeFileData(data, o);
  if (isFd(path)) { c.submit('writeFile', [path, data, { signal: o.signal, flush: o.flush }], callback); return; }
  if (checkAborted(o.signal, callback)) return;
  c.submit('writeFile', [c.path(path), data, { signal: o.signal, flush: o.flush, flag: c.flags(o.flag), mode: c.mode(o.mode, 0o666) }], callback);
};
fs.writeFileSync = function writeFileSync(path, data, options) {
  const o = writeFileOptions(options, 'w');
  data = writeFileData(data, o);
  const isUserFd = isFd(path);
  const fd = isUserFd ? path : fs.openSync(path, o.flag, o.mode);
  try {
    let offset = 0, length = data.byteLength;
    while (length > 0) { const written = fs.writeSync(fd, data, offset, length); offset += written; length -= written; }
    if (o.flush) fs.fsyncSync(fd);
  } finally { if (!isUserFd) fs.closeSync(fd); }
};
fs.appendFile = function appendFile(path, data, options, callback) {
  callback ||= options; validateFunction(callback, 'cb');
  const o = c.options(options, { encoding: 'utf8', mode: 0o666, flag: 'a' });
  if (!o.flag || isFd(path)) o.flag = 'a';
  fs.writeFile(path, data, o, callback);
};
fs.appendFileSync = function appendFileSync(path, data, options) {
  const o = c.options(options, { encoding: 'utf8', mode: 0o666, flag: 'a' });
  if (!o.flag || isFd(path)) o.flag = 'a';
  fs.writeFileSync(path, data, o);
};

// Node's realpathSync: lstat each component and resolve the links met, stopping at a
// pipe or socket (which /proc and /dev links can name), with the native realpath as
// realpathSync.native.
function splitRoot(string) { for (let i = 0; i < string.length; ++i) if (string.charCodeAt(i) !== 47) return string.slice(0, i); return string; }
function encodeRealpathResult(result, options) {
  if (!options || !options.encoding || options.encoding === 'utf8') return result;
  const asBuffer = Buffer.from(result);
  return options.encoding === 'buffer' ? asBuffer : asBuffer.toString(options.encoding);
}
const realpathCacheKey = Symbol('realpathCacheKey');
fs.realpathSync = function realpathSync(path, options) {
  options = c.options(options);
  path = c.toPathIfFileURL(path);
  if (typeof path !== 'string') path += '';
  path = c.path(path);
  path = p.resolve(path);
  const cache = options[realpathCacheKey];
  const cached = cache?.get(path);
  if (cached) return cached;
  const seenLinks = new Map(); const knownHard = new Set(); const original = path;
  let reachedPipeOrSocket = false;
  let current, base, previous;
  current = base = splitRoot(path); let pos = current.length;
  while (pos < path.length) {
    const result = path.indexOf('/', pos);
    previous = current;
    if (result === -1) { const last = path.slice(pos); current += last; base = previous + last; pos = path.length; }
    else { current += path.slice(pos, result + 1); base = previous + path.slice(pos, result); pos = result + 1; }
    if (knownHard.has(base) || cache?.get(base) === base) { if (reachedPipeOrSocket) break; continue; }
    let resolvedLink;
    const maybeCached = cache?.get(base);
    if (maybeCached) resolvedLink = maybeCached;
    else {
      const info = fs.lstatSync(base, { bigint: true });
      if (!info.isSymbolicLink()) { knownHard.add(base); cache?.set(base, base); continue; }
      const id = `${info.dev.toString(32)}:${info.ino.toString(32)}`;
      let linkTarget = seenLinks.has(id) ? seenLinks.get(id) : null;
      if (linkTarget === null) {
        const target = fs.statSync(base);
        reachedPipeOrSocket = target.isFIFO() || target.isSocket();
        linkTarget = c.pair(os.readlink(base), 'readlink', base);
      }
      resolvedLink = p.resolve(previous, linkTarget);
      cache?.set(base, resolvedLink);
      seenLinks.set(id, linkTarget);
    }
    path = p.resolve(resolvedLink, path.slice(pos));
    current = base = splitRoot(path); pos = current.length;
  }
  cache?.set(original, path);
  return encodeRealpathResult(path, options);
};
fs.realpathSync.native = function realpath(path, options) {
  options = c.options(options); path = c.path(path);
  return c.encoded(c.pair(os.realpath(path), 'realpath', path), c.encoding(options.encoding, 'utf8', true));
};
fs.realpath = function realpath(path, options, callback) {
  if (typeof options === 'function') callback = options; else validateFunction(callback, 'cb');
  options = c.options(options);
  path = c.toPathIfFileURL(path);
  if (typeof path !== 'string') path += '';
  path = p.resolve(c.path(path));
  const seenLinks = new Map(); const knownHard = new Set();
  let reachedPipeOrSocket = false;
  let current, base, previous;
  current = base = splitRoot(path); let pos = current.length;
  process.nextTick(LOOP);
  function LOOP() {
    if (pos >= path.length) return callback(null, encodeRealpathResult(path, options));
    const result = path.indexOf('/', pos);
    previous = current;
    if (result === -1) { const last = path.slice(pos); current += last; base = previous + last; pos = path.length; }
    else { current += path.slice(pos, result + 1); base = previous + path.slice(pos, result); pos = result + 1; }
    if (knownHard.has(base)) { if (reachedPipeOrSocket) return callback(null, encodeRealpathResult(path, options)); return process.nextTick(LOOP); }
    return fs.lstat(base, { bigint: true }, gotStat);
  }
  function gotStat(err, info) {
    if (err) return callback(err);
    if (!info.isSymbolicLink()) { knownHard.add(base); return process.nextTick(LOOP); }
    const id = `${info.dev.toString(32)}:${info.ino.toString(32)}`;
    if (seenLinks.has(id)) return gotTarget(null, seenLinks.get(id));
    fs.stat(base, (err, target) => {
      if (err) return callback(err);
      reachedPipeOrSocket = target.isFIFO() || target.isSocket();
      fs.readlink(base, (err, linkTarget) => { seenLinks.set(id, linkTarget); gotTarget(err, linkTarget); });
    });
  }
  function gotTarget(err, target) {
    if (err) return callback(err);
    path = p.resolve(p.resolve(previous, target), path.slice(pos));
    current = base = splitRoot(path); pos = current.length;
    process.nextTick(LOOP);
  }
};
fs.realpath.native = function realpath(path, options, callback) {
  callback = makeCallback(callback || options);
  options = c.options(options); path = c.path(path);
  const enc = c.encoding(options.encoding, 'utf8', true);
  c.submit('realpath', [path, options], (err, value) => err ? callback(err) : callback(null, c.encoded(value, enc)), callback);
};
fs.mkdtemp = function mkdtemp(prefix, options, callback) {
  callback = makeCallback(typeof options === 'function' ? options : callback);
  const o = c.options(options); prefix = c.path(prefix, 'prefix'); warnOnNonPortableTemplate(prefix);
  const enc = c.encoding(o.encoding, 'utf8', true);
  c.submit('mkdtemp', [prefix, o], (err, value) => err ? callback(err) : callback(null, c.encoded(value, enc)), callback);
};
fs.mkdtempSync = function mkdtempSync(prefix, options) {
  const o = c.options(options); prefix = c.path(prefix, 'prefix'); warnOnNonPortableTemplate(prefix);
  return c.encoded(c.native('mkdtemp', [prefix]), c.encoding(o.encoding, 'utf8', true));
};
fs.mkdtempDisposableSync = function mkdtempDisposableSync(prefix, options) {
  const path = fs.mkdtempSync(prefix, options);
  const fullPath = p.resolve(process.cwd(), typeof path === 'string' ? path : path.toString());
  const remove = () => { removeSync(fullPath, { recursive: true, force: false, maxRetries: 0, retryDelay: 100 }); };
  return { path, remove, [Symbol.dispose]() { remove(); } };
};
fs.copyFile = function copyFile(src, dest, mode, callback) {
  if (typeof mode === 'function') { callback = mode; mode = 0; }
  src = c.path(src, 'src'); dest = c.path(dest, 'dest');
  callback = makeCallback(callback);
  c.submit('copyFile', [src, dest, validMode(mode, 'copyFile')], callback);
};
fs.copyFileSync = function copyFileSync(src, dest, mode) {
  c.native('copyFile', [c.path(src, 'src'), c.path(dest, 'dest'), validMode(mode, 'copyFile')]);
};
const cp = () => require('internal/fs_cp');
fs.cp = function cp_(src, dest, options, callback) {
  if (typeof options === 'function') { callback = options; options = undefined; }
  callback = makeCallback(callback);
  options = cp().validateCpOptions(options);
  src = c.path(src, 'src'); dest = c.path(dest, 'dest');
  cp().cpFn(src, dest, options).then(() => callback(null), callback);
};
Object.defineProperty(fs.cp, 'name', { value: 'cp' });
fs.cpSync = function cpSync(src, dest, options) {
  options = cp().validateCpOptions(options);
  src = c.path(src, 'src'); dest = c.path(dest, 'dest');
  cp().cpSyncFn(src, dest, options);
};

const { Dir, FSWatcher, StatWatcher, watch, watchFile, unwatchFile } = require('internal/fs_handles');
Object.assign(fs, { Dir, FSWatcher, StatWatcher, watch, watchFile, unwatchFile });
fs.opendirSync = function opendirSync(path, options) {
  path = c.path(path); const o = c.options(options, { encoding: 'utf8' });
  if (o.bufferSize !== undefined) v.validateUint32(o.bufferSize, 'options.bufferSize', true);
  return new Dir(path, fs.readdirSync(path, Object.assign(o, { withFileTypes: true })));
};
fs.opendir = function opendir(path, options, callback) {
  callback = typeof options === 'function' ? options : callback; validateFunction(callback, 'callback');
  path = c.path(path); const o = c.options(typeof options === 'function' ? undefined : options, { encoding: 'utf8' });
  if (o.bufferSize !== undefined) v.validateUint32(o.bufferSize, 'options.bufferSize', true);
  c.submit('opendir', [path, o], (err, entries) => callback(err || null, err ? undefined : new Dir(path, entries.map(e => e instanceof Dirent ? e : new Dirent(e.name, e.mode, e.parentPath === undefined ? path : e.parentPath)))), callback);
};
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
fs.createReadStream = function createReadStream(path, options) { return new (require('internal/fs_streams').ReadStream)(path, options); };
fs.createWriteStream = function createWriteStream(path, options) { return new (require('internal/fs_streams').WriteStream)(path, options); };
Object.defineProperty(fs, 'Utf8Stream', { enumerable: true, configurable: true, get() { return require('internal/fs_utf8_stream'); } });
fs.globSync = function globSync(pattern, options) { return new (require('internal/fs_glob').Glob)(pattern, options).globSync(); };
fs.glob = function glob(pattern, options, callback) {
  if (typeof options === 'function') { callback = options; options = undefined; }
  callback = makeCallback(callback);
  const iterator = new (require('internal/fs_glob').Glob)(pattern, options).glob();
  (async () => { const results = []; for await (const entry of iterator) results.push(entry); return results; })().then(results => callback(null, results), callback);
};
fs._toUnixTimestamp = c.time;
Object.defineProperty(fs, 'promises', { enumerable: true, configurable: true, get() { return require('fs/promises'); } });
