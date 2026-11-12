'use strict';
// Node's lib/internal/fs/promises.js (v24): the same validation, the
// FileHandle with its reference count, close promise and lock, and readFile/writeFile on
// a handle. The work goes to the native submitIO operations as Promise requests.
const fs = require('fs');
const { ArrayPrototypeConcat, ReflectApply } = require('internal/per_context/primordials');
const c = require('internal/fs/utils');
const p = require('path');
const { EventEmitter } = require('events');
const { Buffer } = require('buffer');
const v = c.v;
const { AbortError, codes: { ERR_FS_EISDIR, ERR_FS_FILE_TOO_LARGE, ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE, ERR_INVALID_STATE, ERR_METHOD_NOT_IMPLEMENTED, ERR_OUT_OF_RANGE } } = require('internal/errors');
const { validateAbortSignal, validateBoolean, validateInteger, validateObject, validateOneOf, kValidateObjectAllowNullable } = v;
const { constants, kRef, kUnref, makeStats, makeStatFs, Dirent } = c;
const promises = {};
const kMaxUserId = 2 ** 32 - 1;
const kIoMaxLength = 2 ** 31 - 1;
const kReadFileBufferLength = 512 * 1024;
const kReadFileUnknownBufferLength = 64 * 1024;
const kWriteFileMaxChunkSize = 512 * 1024;
const kRefs = Symbol('kRefs');
const kFd = Symbol('kFd');
const kClosePromise = Symbol('kClosePromise');
const kCloseResolve = Symbol('kCloseResolve');
const kCloseReject = Symbol('kCloseReject');
const kCloseReason = Symbol('kCloseReason');
const kCloseSync = Symbol('kCloseSync');
const kLocked = Symbol('kLocked');
const kHandle = Symbol('kHandle');
const { kDeserialize, kTransfer, kTransferList, markTransferMode } = require('internal/worker/js_transferable');
const invalidState = (message, Base = Error) => new (Base === Error ? ERR_INVALID_STATE : ERR_INVALID_STATE[Base.name])(message);

// One native request with Promise ownership (requestKind 1), or 2 for a FileHandle close.
function binding(operation, args, requestKind = 1) {
  return new Promise((resolve, reject) => { c.submit(operation, args, c.promiseCallback((err, value) => err ? reject(err) : resolve(value), requestKind)); });
}
function aggregateTwoErrors(inner, outer) {
  if (inner && outer && inner !== outer) {
    if (Array.isArray(outer.errors)) { outer.errors.push(inner); return outer; }
    const error = new AggregateError([outer, inner], outer.message);
    error.code = outer.code; return error;
  }
  return inner || outer;
}
function checkAborted(signal) { if (signal?.aborted) throw new AbortError(undefined, { cause: signal?.reason }); }

// Node's native FileHandle closes a descriptor that its object never closed, and then
// warns from an unref'ed immediate, with the DEP0137 deprecation once per process.
let gcCloseWarned = false;
const gcCloser = new FinalizationRegistry((fd) => {
  try { fs.closeSync(fd); } catch {}
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
function releaseFd(handle) {
  const fd = handle[kFd];
  handle[kFd] = -1;
  gcCloser.unregister(handle);
  return fd;
}

class FileHandle extends EventEmitter {
  #brandCheck = undefined;
  static isFileHandle(value) { return value != null && typeof value === 'object' && #brandCheck in value; }
  constructor(fd) {
    super();
    this[kFd] = fd === undefined ? -1 : fd;
    if (this[kFd] !== -1) gcCloser.register(this, this[kFd], this);
    this[kRefs] = 1;
    this[kClosePromise] = null;
    markTransferMode(this, false, true);
  }
  getAsyncId() { return -1; }
  get fd() { return this[kFd]; }
  appendFile(data, options) { return fsCall(writeFile, this, data, options); }
  chmod(mode) { return fsCall(fchmod, this, mode); }
  chown(uid, gid) { return fsCall(fchown, this, uid, gid); }
  datasync() { return fsCall(fdatasync, this); }
  sync() { return fsCall(fsync, this); }
  read(buffer, offset, length, position) { return fsCall(read, this, buffer, offset, length, position); }
  readv(buffers, position) { return fsCall(readv, this, buffers, position); }
  readFile(options) { return fsCall(readFile, this, options); }
  readLines(options = undefined) {
    return new (require('readline').Interface)({ input: this.createReadStream(options), crlfDelay: Infinity });
  }
  stat(options) { return fsCall(fstat, this, options); }
  truncate(len = 0) { return fsCall(ftruncate, this, len); }
  utimes(atime, mtime) { return fsCall(futimes, this, atime, mtime); }
  write(buffer, offset, length, position) { return fsCall(write, this, buffer, offset, length, position); }
  writev(buffers, position) { return fsCall(writev, this, buffers, position); }
  writeFile(data, options) { return fsCall(writeFile, this, data, options); }
  close = () => {
    if (this[kFd] === -1) return Promise.resolve();
    if (this[kClosePromise]) return this[kClosePromise];
    this[kRefs]--;
    if (this[kRefs] === 0) {
      const fd = releaseFd(this);
      this[kClosePromise] = binding('close', [fd], 2).finally(() => { this[kClosePromise] = undefined; });
    } else {
      this[kClosePromise] = new Promise((resolve, reject) => { this[kCloseResolve] = resolve; this[kCloseReject] = reject; })
        .finally(() => { this[kClosePromise] = undefined; this[kCloseReject] = undefined; this[kCloseResolve] = undefined; });
    }
    this.emit('close');
    return this[kClosePromise];
  };
  [kCloseSync]() {
    if (this[kFd] === -1) return;
    if (this[kClosePromise]) throw invalidState('The FileHandle is closing');
    const fd = releaseFd(this);
    fs.closeSync(fd);
    this.emit('close');
  }
  async [Symbol.asyncDispose]() { await this.close(); }
  readableWebStream(options = {}) {
    if (this[kFd] === -1) throw invalidState('The FileHandle is closed');
    if (this[kClosePromise]) throw invalidState('The FileHandle is closing');
    if (this[kLocked]) throw invalidState('The FileHandle is locked');
    this[kLocked] = true;
    validateObject(options, 'options');
    const { type = 'bytes', autoClose = false } = options;
    validateBoolean(autoClose, 'options.autoClose');
    if (type !== 'bytes') process.emitWarning('A non-"bytes" options.type has no effect. A byte-oriented steam is always created.', 'ExperimentalWarning');
    const readFn = this.read.bind(this);
    const ondone = async () => { this[kUnref](); if (autoClose) await this.close(); };
    const { ReadableStream } = require('stream/web');
    const readable = new ReadableStream({
      type: 'bytes',
      autoAllocateChunkSize: 16384,
      async pull(controller) {
        const view = controller.byobRequest.view;
        const { bytesRead } = await readFn(view, 0, view.byteLength);
        if (bytesRead === 0) { controller.close(); await ondone(); }
        controller.byobRequest.respond(bytesRead);
      },
      async cancel() { await ondone(); },
    });
    this[kRef]();
    // Node's readableStreamCancel: the stream is cancelled even while a reader holds its lock.
    this.once('close', () => { require('internal/webstreams/readablestream').readableStreamCancel(readable); });
    return readable;
  }
  createReadStream(options = undefined) { return new (require('internal/fs/streams').ReadStream)(undefined, { ...options, fd: this }); }
  createWriteStream(options = undefined) { return new (require('internal/fs/streams').WriteStream)(undefined, { ...options, fd: this }); }
  [kTransfer]() {
    if (this[kClosePromise] || this[kRefs] > 1 || this[kFd] === -1) {
      throw new (require('internal/path_events/event_target').DOMException)('Cannot transfer FileHandle while in use', 'DataCloneError');
    }
    const handle = this[kHandle];
    this[kHandle] = null;
    releaseFd(this);
    // Until the message is posted, the descriptor belongs to the handle, which
    // closes it if the post fails and the handle is collected.
    handleCloser.register(handle, handle.fd, handle);
    this[kCloseReason] = 'The FileHandle has been transferred';
    this[kRefs] = 0;
    return {
      data: { handle },
      deserializeInfo: 'internal/fs/promises:FileHandle',
    };
  }
  [kTransferList]() {
    if (this[kFd] === -1) return [];
    return [this[kHandle] ??= new FileHandleNative(this[kFd])];
  }
  [kDeserialize]({ handle }) {
    this[kHandle] = handle;
    this[kFd] = handle.fd;
    gcCloser.register(this, handle.fd, this);
  }
  [kRef]() { this[kRefs]++; }
  [kUnref]() {
    this[kRefs]--;
    if (this[kRefs] === 0) {
      const fd = releaseFd(this);
      binding('close', [fd], 2).then(this[kCloseResolve], this[kCloseReject]);
    }
  }
}
// Node's FileHandle binding object, which a transfer moves: workers share the
// process's descriptor table, so the receiver gets the same descriptor.
class FileHandleNative {
  constructor(fd) { this.fd = fd; }
}
const handleCloser = new FinalizationRegistry(fd => { try { fs.closeSync(fd); } catch {} });
c.fileHandles = {
  isNative: value => value instanceof FileHandleNative,
  // The posted message now owns the descriptor, and the receiver's thread tracks it.
  detach: handle => { handleCloser.unregister(handle); require('internal/host').fsTracking(2, handle.fd); },
  create: fd => { require('internal/host').fsTracking(1, fd); return new FileHandleNative(fd); },
};
require('internal/fs/iter').register(FileHandle, { kFd, kLocked, kRef, kUnref, kClosePromise, kCloseSync, invalidState });

async function fsCall(fn, handle, ...args) {
  if (!FileHandle.isFileHandle(handle)) throw new ERR_INVALID_ARG_TYPE('handle', 'FileHandle', handle);
  if (handle.fd === -1) {
    const err = new Error(handle[kCloseReason] ?? 'file closed');
    err.code = 'EBADF'; err.syscall = fn.name;
    throw err;
  }
  // Not spread: user code may have replaced the array iterator.
  try { handle[kRef](); return await ReflectApply(fn, undefined, ArrayPrototypeConcat([handle], args)); }
  finally { handle[kUnref](); }
}
async function handleFdClose(fileOpPromise, closeFunc) {
  return fileOpPromise.then(result => closeFunc().then(() => result), opError => closeFunc().then(() => Promise.reject(opError), closeError => Promise.reject(aggregateTwoErrors(closeError, opError))));
}
async function handleFdSync(fileOpPromise, handle) {
  return fileOpPromise.then(result => handle.sync().then(() => result, syncError => Promise.reject(syncError)), opError => Promise.reject(opError));
}
function isIterable(obj) { return obj != null && (typeof obj[Symbol.iterator] === 'function' || typeof obj[Symbol.asyncIterator] === 'function'); }
function isCustomIterable(obj) { return isIterable(obj) && !ArrayBuffer.isView(obj) && typeof obj !== 'string'; }
async function writeFileHandle(filehandle, data, signal, encoding) {
  checkAborted(signal);
  if (isCustomIterable(data)) {
    for await (const buf of data) {
      checkAborted(signal);
      const toWrite = ArrayBuffer.isView(buf) ? buf : Buffer.from(buf, encoding || 'utf8');
      let remaining = toWrite.byteLength;
      while (remaining > 0) {
        const writeSize = Math.min(kWriteFileMaxChunkSize, remaining);
        const { bytesWritten } = await write(filehandle, toWrite, toWrite.byteLength - remaining, writeSize);
        remaining -= bytesWritten;
        checkAborted(signal);
      }
    }
    return;
  }
  data = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let remaining = data.byteLength;
  if (remaining === 0) return;
  do {
    checkAborted(signal);
    const { bytesWritten } = await write(filehandle, data, 0, Math.min(kWriteFileMaxChunkSize, data.byteLength));
    remaining -= bytesWritten;
    data = new Uint8Array(data.buffer, data.byteOffset + bytesWritten, data.byteLength - bytesWritten);
  } while (remaining > 0);
}
function validateReadFileBufferOptions(options) {
  const { buffer } = options;
  if (buffer !== undefined && typeof buffer !== 'function' && !ArrayBuffer.isView(buffer)) throw new ERR_INVALID_ARG_TYPE('options.buffer', ['Buffer', 'TypedArray', 'DataView', 'Function'], buffer);
}
function getReadFileBuffer(options, size) {
  let { buffer } = options;
  if (typeof buffer === 'function') { buffer = options.buffer(size); v.validateBuffer(buffer, 'options.buffer()'); }
  if (buffer === undefined) return undefined;
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (size > buffer.byteLength) throw new ERR_INVALID_ARG_VALUE(typeof options.buffer === 'function' ? 'options.buffer().byteLength' : 'options.buffer.byteLength', buffer.byteLength, `is smaller than the file size of ${size} bytes`);
  return buffer;
}
async function readFileHandleWithUserBuffer(filehandle, options, size) {
  const signal = options?.signal; const encoding = options?.encoding;
  const buffer = getReadFileBuffer(options, size);
  const byteLengthName = typeof options.buffer === 'function' ? 'options.buffer().byteLength' : 'options.buffer.byteLength';
  let totalRead = 0;
  while (totalRead < buffer.byteLength) {
    checkAborted(signal);
    const length = size === 0 ? buffer.byteLength - totalRead : Math.min(size - totalRead, kReadFileBufferLength);
    const bytesRead = (await binding('read', [filehandle.fd, buffer, totalRead, length, null])) ?? 0;
    totalRead += bytesRead;
    if (bytesRead === 0 || totalRead === size) { const result = buffer.subarray(0, totalRead); return encoding ? result.toString(encoding) : result; }
  }
  if (size === 0) {
    checkAborted(signal);
    const extraBuffer = Buffer.allocUnsafeSlow(1);
    const bytesRead = (await binding('read', [filehandle.fd, extraBuffer, 0, 1, null])) ?? 0;
    if (bytesRead !== 0) throw new ERR_INVALID_ARG_VALUE(byteLengthName, buffer.byteLength, 'is too small to contain the entire file');
  }
  return encoding ? buffer.toString(encoding) : buffer.subarray(0, totalRead);
}
async function readFileHandle(filehandle, options) {
  const signal = options?.signal; const encoding = options?.encoding;
  const decoder = encoding && new (require('string_decoder').StringDecoder)(encoding);
  checkAborted(signal);
  const statFields = await binding('fstat', [filehandle.fd, { bigint: false }]);
  checkAborted(signal);
  let size = 0; let length = 0;
  if ((statFields.mode & 0o170000) === 0o100000) { size = statFields.size; length = encoding ? Math.min(size, kReadFileBufferLength) : size; }
  if (length === 0) length = kReadFileUnknownBufferLength;
  if (size > kIoMaxLength) throw new ERR_FS_FILE_TOO_LARGE(size);
  if (options.buffer !== undefined) return readFileHandleWithUserBuffer(filehandle, options, size);
  let totalRead = 0; const noSize = size === 0;
  let buffer = Buffer.allocUnsafeSlow(length);
  let result = ''; let offset = 0; let buffers;
  const chunkedRead = length > kReadFileBufferLength;
  for (;;) {
    checkAborted(signal);
    if (chunkedRead) length = Math.min(size - totalRead, kReadFileBufferLength);
    const bytesRead = (await binding('read', [filehandle.fd, buffer, offset, length, null])) ?? 0;
    totalRead += bytesRead;
    if (bytesRead === 0 || totalRead === size || (bytesRead !== buffer.length && !chunkedRead && !noSize)) {
      const singleRead = bytesRead === totalRead;
      const bytesToCheck = chunkedRead ? totalRead : bytesRead;
      if (bytesToCheck !== buffer.length) buffer = buffer.subarray(0, bytesToCheck);
      if (!encoding) {
        if (noSize && !singleRead) { buffers.push(buffer); return Buffer.concat(buffers, totalRead); }
        return buffer;
      }
      if (singleRead) return buffer.toString(encoding);
      result += decoder.end(buffer);
      return result;
    }
    const readBuffer = bytesRead !== buffer.length ? buffer.subarray(0, bytesRead) : buffer;
    if (encoding) result += decoder.write(readBuffer);
    else if (size !== 0) offset = totalRead;
    else { buffers ??= []; buffers.push(readBuffer); buffer = Buffer.allocUnsafeSlow(kReadFileUnknownBufferLength); }
  }
}

async function access(path, mode = constants.F_OK) {
  path = c.path(path);
  if (mode == null) mode = constants.F_OK; else validateInteger(mode, 'mode', 0, 7);
  return binding('access', [path, mode]);
}
async function cp(src, dest, options) {
  const { validateCpOptions, cpFn } = require('internal/fs/cp/cp');
  options = validateCpOptions(options);
  src = c.path(src, 'src'); dest = c.path(dest, 'dest');
  return cpFn(src, dest, options);
}
async function copyFile(src, dest, mode) {
  src = c.path(src, 'src'); dest = c.path(dest, 'dest');
  if (mode == null) mode = 0; else validateInteger(mode, 'mode', 0, 7);
  return binding('copyFile', [src, dest, mode]);
}
async function open(path, flags, mode) {
  path = c.path(path);
  const flagsNumber = c.stringToFlags(flags);
  mode = c.mode(mode, 0o666);
  return new FileHandle(await binding('open', [path, flagsNumber, mode]));
}
async function read(handle, bufferOrParams, offset, length, position) {
  let buffer = bufferOrParams;
  if (!ArrayBuffer.isView(buffer)) {
    if (bufferOrParams !== undefined) validateObject(bufferOrParams, 'options', kValidateObjectAllowNullable);
    ({ buffer = Buffer.alloc(16384), offset = 0, length = buffer.byteLength - offset, position = null } = bufferOrParams ?? {});
    v.validateBuffer(buffer);
  }
  if (offset !== null && typeof offset === 'object') ({ offset = 0, length = buffer.byteLength - offset, position = null } = offset);
  if (offset == null) offset = 0; else validateInteger(offset, 'offset', 0);
  length ??= buffer.byteLength - offset;
  length |= 0;
  position = c.position(position, 'position', length);
  if (length === 0) return { __proto__: null, bytesRead: length, buffer };
  if (buffer.byteLength === 0) throw new ERR_INVALID_ARG_VALUE('buffer', buffer, 'is empty and cannot be written');
  c.validateOffsetLengthRead(offset, length, buffer.byteLength);
  const bytesRead = (await binding('read', [handle.fd, buffer, offset, length, position])) || 0;
  return { __proto__: null, bytesRead, buffer };
}
async function readv(handle, buffers, position) {
  c.bufferArray(buffers);
  if (typeof position !== 'number') position = null;
  const bytesRead = (await binding('readv', [handle.fd, buffers, position])) || 0;
  return { __proto__: null, bytesRead, buffers };
}
function validateEncoding(data, encoding) {
  const normalized = Buffer.isEncoding(encoding) ? String(encoding).toLowerCase() : encoding;
  if (normalized === 'hex' && data.length % 2 !== 0) throw new ERR_INVALID_ARG_VALUE('encoding', encoding, `is invalid for data of length ${data.length}`);
}
async function write(handle, buffer, offsetOrOptions, length, position) {
  if (buffer?.byteLength === 0) return { __proto__: null, bytesWritten: 0, buffer };
  let offset = offsetOrOptions;
  if (ArrayBuffer.isView(buffer)) {
    if (typeof offset === 'object') ({ offset = 0, length = buffer.byteLength - offset, position = null } = offsetOrOptions ?? {});
    if (offset == null) offset = 0; else validateInteger(offset, 'offset', 0);
    if (typeof length !== 'number') length = buffer.byteLength - offset;
    if (typeof position !== 'number') position = null;
    c.validateOffsetLengthWrite(offset, length, buffer.byteLength);
    const bytesWritten = (await binding('write', [handle.fd, buffer, offset, length, position])) || 0;
    return { __proto__: null, bytesWritten, buffer };
  }
  c.validateStringAfterArrayBufferView(buffer, 'buffer');
  validateEncoding(buffer, length);
  // A string: offset is the position, length the encoding.
  const bytes = Buffer.from(buffer, typeof length === 'string' ? length : 'utf8');
  const bytesWritten = (await binding('write', [handle.fd, bytes, 0, bytes.byteLength, typeof offset === 'number' ? offset : null])) || 0;
  return { __proto__: null, bytesWritten, buffer };
}
async function writev(handle, buffers, position) {
  c.bufferArray(buffers);
  if (typeof position !== 'number') position = null;
  if (buffers.length === 0) return { __proto__: null, bytesWritten: 0, buffers };
  const bytesWritten = (await binding('writev', [handle.fd, buffers, position])) || 0;
  return { __proto__: null, bytesWritten, buffers };
}
async function rename(oldPath, newPath) { return binding('rename', [c.path(oldPath, 'oldPath'), c.path(newPath, 'newPath')]); }
async function truncate(path, len = 0) {
  const fd = await open(path, 'r+');
  return handleFdClose(ftruncate(fd, len), fd.close);
}
async function ftruncate(handle, len = 0) {
  validateInteger(len, 'len'); len = Math.max(0, len);
  return binding('ftruncate', [handle.fd, len]);
}
async function rm(path, options) {
  path = c.path(path);
  options = c.validateRmdirOptions(options, c.defaultRmOptions);
  validateBoolean(options.force, 'options.force');
  let info;
  try { info = await lstat(path); } catch (err) { if (options.force && err.code === 'ENOENT') return; throw err; }
  if (info.isDirectory() && !options.recursive) throw new ERR_FS_EISDIR({ code: 'EISDIR', message: 'is a directory', path, syscall: 'rm', errno: 21 });
  return binding('rm', [path, options]);
}
async function rmdir(path, options) {
  path = c.path(path);
  options = c.validateRmdirOptions(options);
  if (options.recursive) {
    c.emitRecursiveRmdirWarning();
    const info = await stat(path);
    if (info.isDirectory()) return binding('rm', [path, { ...options, force: false }]);
  }
  return binding('rmdir', [path, {}]);
}
async function fdatasync(handle) { return binding('fdatasync', [handle.fd]); }
async function fsync(handle) { return binding('fsync', [handle.fd]); }
async function mkdir(path, options) {
  if (typeof options === 'number' || typeof options === 'string') options = { mode: options };
  const { recursive = false, mode = 0o777 } = options || {};
  path = c.path(path);
  validateBoolean(recursive, 'options.recursive');
  return binding('mkdir', [path, { mode: c.mode(mode, 0o777), recursive }]);
}
async function readdir(path, options) {
  options = { ...c.options(options) };
  path = c.path(path);
  const encoding = c.encoding(options.encoding, 'utf8', true);
  const value = await binding('readdir', [path, { ...options, encoding }]);
  return value.map(entry => options.withFileTypes ? entry instanceof Dirent ? entry : new Dirent(c.encoded(entry.name, encoding), entry.mode, entry.parentPath === undefined ? path : entry.parentPath) : c.encoded(entry, encoding));
}
async function readlink(path, options) {
  options = c.options(options);
  path = c.path(path, 'oldPath');
  return c.encoded(await binding('readlink', [path, options]), c.encoding(options.encoding, 'utf8', true));
}
async function symlink(target, path, type) {
  validateOneOf(type, 'type', ['dir', 'file', 'junction', null, undefined]);
  target = c.path(target, 'target'); path = c.path(path);
  return binding('symlink', [c.preprocessSymlinkDestination(target, type, path), path, type]);
}
async function fstat(handle, options = { bigint: false }) {
  return makeStats(await binding('fstat', [handle.fd, { bigint: !!options.bigint }]), !!options.bigint);
}
async function lstat(path, options = { bigint: false }) {
  path = c.path(path);
  return makeStats(await binding('lstat', [path, { bigint: !!options.bigint }]), !!options.bigint);
}
async function stat(path, options = { bigint: false, throwIfNoEntry: true }) {
  const result = await binding('stat', [c.path(path), { bigint: !!options.bigint, throwIfNoEntry: options.throwIfNoEntry }]);
  if (!options.throwIfNoEntry && result === undefined) return undefined;
  return makeStats(result, !!options.bigint);
}
async function statfs(path, options = { bigint: false }) {
  return makeStatFs(await binding('statfs', [c.path(path), { bigint: !!options.bigint }]), !!options.bigint);
}
async function link(existingPath, newPath) { return binding('link', [c.path(existingPath, 'existingPath'), c.path(newPath, 'newPath')]); }
async function unlink(path) { return binding('unlink', [c.path(path)]); }
async function fchmod(handle, mode) { mode = c.mode(mode, undefined); return binding('fchmod', [handle.fd, mode]); }
async function chmod(path, mode) { path = c.path(path); mode = c.mode(mode, undefined); return binding('chmod', [path, mode]); }
async function lchmod(path, mode) {
  if (constants.O_SYMLINK === undefined) throw new ERR_METHOD_NOT_IMPLEMENTED('lchmod()');
  const fd = await open(path, constants.O_WRONLY | constants.O_SYMLINK);
  return handleFdClose(fchmod(fd, mode), fd.close);
}
function ids(uid, gid) { validateInteger(uid, 'uid', -1, kMaxUserId); validateInteger(gid, 'gid', -1, kMaxUserId); }
async function lchown(path, uid, gid) { path = c.path(path); ids(uid, gid); return binding('lchown', [path, uid, gid]); }
async function fchown(handle, uid, gid) { ids(uid, gid); return binding('fchown', [handle.fd, uid, gid]); }
async function chown(path, uid, gid) { path = c.path(path); ids(uid, gid); return binding('chown', [path, uid, gid]); }
async function utimes(path, atime, mtime) { path = c.path(path); return binding('utimes', [path, c.time(atime), c.time(mtime)]); }
async function futimes(handle, atime, mtime) { atime = c.time(atime, 'atime'); mtime = c.time(mtime, 'mtime'); return binding('futimes', [handle.fd, atime, mtime]); }
async function lutimes(path, atime, mtime) { return binding('lutimes', [c.path(path), c.time(atime), c.time(mtime)]); }
async function realpath(path, options) {
  options = c.options(options);
  return c.encoded(await binding('realpath', [c.path(path), options]), c.encoding(options.encoding, 'utf8', true));
}
let warnedNonPortableTemplate = false;
function warnOnNonPortableTemplate(template) {
  if (!warnedNonPortableTemplate && template.endsWith('X')) {
    process.emitWarning('mkdtemp() templates ending with X are not portable. For details see: https://nodejs.org/api/fs.html');
    warnedNonPortableTemplate = true;
  }
}
async function mkdtemp(prefix, options) {
  options = c.options(options);
  prefix = c.path(prefix, 'prefix');
  warnOnNonPortableTemplate(prefix);
  return c.encoded(await binding('mkdtemp', [prefix, options]), c.encoding(options.encoding, 'utf8', true));
}
async function mkdtempDisposable(prefix, options) {
  const cwd = process.cwd();
  const path = await mkdtemp(prefix, options);
  const fullPath = p.resolve(cwd, typeof path === 'string' ? path : path.toString());
  const remove = async () => { await binding('rm', [fullPath, { maxRetries: 0, recursive: true, retryDelay: 0, force: true }]); };
  return { __proto__: null, path, remove, async [Symbol.asyncDispose]() { await remove(); } };
}
async function writeFile(path, data, options) {
  options = c.options(options, { encoding: 'utf8', mode: 0o666, flag: 'w', flush: false });
  const flag = options.flag || 'w';
  const flush = options.flush ?? false;
  validateBoolean(flush, 'options.flush');
  if (!ArrayBuffer.isView(data) && !isCustomIterable(data)) {
    c.validateStringAfterArrayBufferView(data, 'data');
    data = Buffer.from(data, options.encoding || 'utf8');
  }
  validateAbortSignal(options.signal);
  if (FileHandle.isFileHandle(path)) return writeFileHandle(path, data, options.signal, options.encoding);
  checkAborted(options.signal);
  const fd = await open(path, flag, options.mode);
  let writeOp = writeFileHandle(fd, data, options.signal, options.encoding);
  if (flush) writeOp = handleFdSync(writeOp, fd);
  return handleFdClose(writeOp, fd.close);
}
async function appendFile(path, data, options) {
  options = { ...c.options(options, { encoding: 'utf8', mode: 0o666, flag: 'a' }) };
  options.flag ||= 'a';
  return writeFile(path, data, options);
}
async function readFile(path, options) {
  options = c.options(options, { flag: 'r' });
  validateReadFileBufferOptions(options);
  const flag = options.flag || 'r';
  if (FileHandle.isFileHandle(path)) return readFileHandle(path, options);
  checkAborted(options.signal);
  const fd = await open(path, flag, 0o666);
  return handleFdClose(readFileHandle(fd, options), fd.close);
}
function opendir(path, options) {
  return new Promise((resolve, reject) => { fs.opendir(path, options, (err, dir) => err ? reject(err) : resolve(dir)); });
}
async function* glob(pattern, options) { yield* new (require('internal/fs/glob').Glob)(pattern, options).glob(); }
Object.assign(promises, {
  access, copyFile, cp, glob, open, opendir, rename, truncate, rm, rmdir, mkdir, readdir, readlink, symlink, lstat, stat, statfs,
  link, unlink, chmod, lchmod, lchown, chown, utimes, lutimes, realpath, mkdtemp, mkdtempDisposable, writeFile, appendFile, readFile,
  constants,
});
for (const name of ['access', 'copyFile', 'cp', 'open', 'rename', 'truncate', 'rm', 'rmdir', 'mkdir', 'readdir', 'readlink', 'symlink', 'lstat', 'stat', 'statfs', 'link', 'unlink', 'chmod', 'lchmod', 'lchown', 'chown', 'utimes', 'lutimes', 'realpath', 'mkdtemp', 'mkdtempDisposable', 'writeFile', 'appendFile', 'readFile']) Object.defineProperty(promises[name], 'name', { value: name });
promises.watch = require('internal/fs/watchers').promisesWatch;

module.exports = { exports: promises, FileHandle, kRef, kUnref };
