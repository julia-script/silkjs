'use strict';
// fs.ReadStream and fs.WriteStream, ported from Node's lib/internal/fs/streams.js (v24):
// function constructors that also work without new, options.fs overrides, FileHandle
// descriptors, and the deprecated open() hook that old subclasses override.
const { Readable, Writable, finished } = require('stream');
const { errorOrDestroy } = require('internal/streams/destroy');
const fs = require('fs');
const c = require('internal/fs_core');
const v = require('internal/validators');
const { Buffer } = require('buffer');
const { validateBoolean, validateFunction, validateInteger, ERR_INVALID_ARG_TYPE, ERR_OUT_OF_RANGE } = v;
const kIoDone = Symbol('kIoDone');
const kIsPerformingIO = Symbol('kIsPerformingIO');
const kFs = Symbol('kFs');
const kHandle = Symbol('kHandle');
const notImplemented = method => v.makeError(Error, 'ERR_METHOD_NOT_IMPLEMENTED', `The ${method} method is not implemented`);
const destroyed = method => v.makeError(Error, 'ERR_STREAM_DESTROYED', `Cannot call ${method} after a stream was destroyed`);
const systemFailure = message => v.makeError(Error, 'ERR_SYSTEM_ERROR', `A system error occurred: ${message}`);
function validateThisInternalField(object, key, name) {
  if (typeof object !== 'object' || object === null || !(key in object)) throw v.makeError(TypeError, 'ERR_INVALID_THIS', `Value of "this" must be of type ${name}`);
}

function _construct(callback) {
  const stream = this;
  if (typeof stream.fd === 'number') { callback(); return; }
  if (stream.open !== openWriteFs && stream.open !== openReadFs) {
    // Backwards compat for monkey patching open().
    const orgEmit = stream.emit;
    stream.emit = function(...args) {
      if (args[0] === 'open') { this.emit = orgEmit; callback(); Reflect.apply(orgEmit, this, args); }
      else if (args[0] === 'error') { this.emit = orgEmit; callback(args[1]); }
      else Reflect.apply(orgEmit, this, args);
    };
    stream.open();
  } else {
    stream[kFs].open(stream.path, stream.flags, stream.mode, (er, fd) => {
      if (er) callback(er);
      else { stream.fd = fd; callback(); stream.emit('open', stream.fd); stream.emit('ready'); }
    });
  }
}
const FileHandleOperations = handle => ({
  open: () => { throw notImplemented('open()'); },
  close: (fd, cb) => { handle[c.kUnref](); handle.close().then(() => cb(), cb); },
  fsync: (fd, cb) => { handle.sync().then(() => cb(), cb); },
  read: (fd, buf, offset, length, pos, cb) => { handle.read(buf, offset, length, pos).then(r => cb(null, r.bytesRead, r.buffer), err => cb(err, 0, buf)); },
  write: (fd, buf, offset, length, pos, cb) => { handle.write(buf, offset, length, pos).then(r => cb(null, r.bytesWritten, r.buffer), err => cb(err, 0, buf)); },
  writev: (fd, buffers, pos, cb) => { handle.writev(buffers, pos).then(r => cb(null, r.bytesWritten, r.buffers), err => cb(err, 0, buffers)); },
});
function close(stream, err, cb) {
  if (!stream.fd) cb(err);
  else if (stream.flush) stream[kFs].fsync(stream.fd, flushErr => { _close(stream, err || flushErr, cb); });
  else _close(stream, err, cb);
}
function _close(stream, err, cb) {
  stream[kFs].close(stream.fd, er => { cb(er || err); });
  stream.fd = null;
}
function importFd(stream, options) {
  if (typeof options.fd === 'number') { stream[kFs] = options.fs || fs; return options.fd; }
  if (typeof options.fd === 'object' && options.fd !== null && typeof options.fd[c.kRef] === 'function') {
    if (options.fs) throw notImplemented('FileHandle with fs');
    stream[kHandle] = options.fd;
    stream[kFs] = FileHandleOperations(stream[kHandle]);
    stream[kHandle][c.kRef]();
    options.fd.on('close', stream.close.bind(stream));
    return options.fd.fd;
  }
  throw ERR_INVALID_ARG_TYPE('options.fd', ['number', 'FileHandle'], options.fd);
}
function importWindowsHandle(options) {
  if (options.windowsHandle == null) throw v.makeError(TypeError, 'ERR_MISSING_OPTION', 'options.windowsHandle is required');
  throw v.makeError(TypeError, 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM', 'The feature windowsHandle is unavailable on the current platform, which is being used to run Node.js');
}
const incompatible = (a, b) => v.makeError(TypeError, 'ERR_INCOMPATIBLE_OPTION_PAIR', `Option "${a}" cannot be used in combination with option "${b}"`);
function validatePath(path) {
  if (typeof path !== 'string' && !(path instanceof Uint8Array)) throw ERR_INVALID_ARG_TYPE('path', ['string', 'Buffer', 'URL'], path);
  c.path(path);
}

// Node's getOptions keeps an options object as given and copyObject copies it with for...in,
// so inherited options apply.
function streamOptions(options) { const checked = c.options(options); return options !== null && typeof options === 'object' ? options : checked; }
function copyObject(source) { const target = {}; for (const key in source) target[key] = source[key]; return target; }
function ReadStream(path, options) {
  if (!(this instanceof ReadStream)) return new ReadStream(path, options);
  options = copyObject(streamOptions(options));
  if (options.highWaterMark === undefined) options.highWaterMark = 64 * 1024;
  if (options.autoDestroy === undefined) options.autoDestroy = false;
  if (options.fd != null && options.windowsHandle != null) throw incompatible('windowsHandle', 'fd');
  else if (options.windowsHandle != null) importWindowsHandle(options);
  else if (options.fd == null) {
    this.fd = null;
    this[kFs] = options.fs || fs;
    validateFunction(this[kFs].open, 'options.fs.open');
    this.path = c.toPathIfFileURL(path);
    this.flags = options.flags === undefined ? 'r' : options.flags;
    this.mode = options.mode === undefined ? 0o666 : options.mode;
    validatePath(this.path);
  } else this.fd = c.fd(importFd(this, options));
  options.autoDestroy = options.autoClose === undefined ? true : options.autoClose;
  validateFunction(this[kFs].read, 'options.fs.read');
  if (options.autoDestroy) validateFunction(this[kFs].close, 'options.fs.close');
  this.start = options.start;
  this.end = options.end;
  this.pos = undefined;
  this.bytesRead = 0;
  this[kIsPerformingIO] = false;
  if (this.start !== undefined) { validateInteger(this.start, 'start', 0); this.pos = this.start; }
  if (this.end === undefined) this.end = Infinity;
  else if (this.end !== Infinity) {
    validateInteger(this.end, 'end', 0);
    if (this.start !== undefined && this.start > this.end) throw ERR_OUT_OF_RANGE('start', `<= "end" (here: ${this.end})`, this.start);
  }
  Reflect.apply(Readable, this, [options]);
}
Object.setPrototypeOf(ReadStream.prototype, Readable.prototype);
Object.setPrototypeOf(ReadStream, Readable);
Object.defineProperty(ReadStream.prototype, 'autoClose', {
  get() { validateThisInternalField(this, kFs, 'ReadStream'); return this._readableState.autoDestroy; },
  set(value) { validateThisInternalField(this, kFs, 'ReadStream'); this._readableState.autoDestroy = value; },
});
const deprecate = require('util').deprecate;
const openReadFs = deprecate(function() {}, 'ReadStream.prototype.open() is deprecated', 'DEP0135');
ReadStream.prototype.open = openReadFs;
ReadStream.prototype._construct = _construct;
ReadStream.prototype._read = function(n) {
  n = this.pos !== undefined ? Math.min(this.end - this.pos + 1, n) : Math.min(this.end - this.bytesRead + 1, n);
  if (n <= 0) { this.push(null); return; }
  const buf = Buffer.allocUnsafeSlow(n);
  this[kIsPerformingIO] = true;
  this[kFs].read(this.fd, buf, 0, n, this.pos, (er, bytesRead, buf) => {
    this[kIsPerformingIO] = false;
    // Tell ._destroy() that it's safe to close the fd now.
    if (this.destroyed) { this.emit(kIoDone, er); return; }
    if (er) errorOrDestroy(this, er);
    else if (bytesRead > 0) {
      if (this.pos !== undefined) this.pos += bytesRead;
      this.bytesRead += bytesRead;
      if (bytesRead !== buf.length) {
        // Slow path. Shrink to fit.
        const dst = Buffer.allocUnsafeSlow(bytesRead);
        buf.copy(dst, 0, 0, bytesRead);
        buf = dst;
      }
      this.push(buf);
    } else this.push(null);
  });
};
ReadStream.prototype._destroy = function(err, cb) {
  if (this[kIsPerformingIO]) this.once(kIoDone, er => close(this, err || er, cb));
  else close(this, err, cb);
};
ReadStream.prototype.close = function(cb) {
  if (typeof cb === 'function') finished(this, cb);
  this.destroy();
};
Object.defineProperty(ReadStream.prototype, 'pending', { get() { return this.fd === null; }, configurable: true });

function WriteStream(path, options) {
  if (!(this instanceof WriteStream)) return new WriteStream(path, options);
  options = copyObject(streamOptions(options));
  options.decodeStrings = true;
  if (options.fd != null && options.windowsHandle != null) throw incompatible('windowsHandle', 'fd');
  else if (options.windowsHandle != null) importWindowsHandle(options);
  else if (options.fd == null) {
    this.fd = null;
    this[kFs] = options.fs || fs;
    validateFunction(this[kFs].open, 'options.fs.open');
    this.path = c.toPathIfFileURL(path);
    this.flags = options.flags === undefined ? 'w' : options.flags;
    this.mode = options.mode === undefined ? 0o666 : options.mode;
    validatePath(this.path);
  } else this.fd = c.fd(importFd(this, options));
  options.autoDestroy = options.autoClose === undefined ? true : options.autoClose;
  if (!this[kFs].write && !this[kFs].writev) throw ERR_INVALID_ARG_TYPE('options.fs.write', 'function', this[kFs].write);
  if (this[kFs].write) validateFunction(this[kFs].write, 'options.fs.write');
  if (this[kFs].writev) validateFunction(this[kFs].writev, 'options.fs.writev');
  if (options.autoDestroy) validateFunction(this[kFs].close, 'options.fs.close');
  this.flush = options.flush;
  if (this.flush == null) this.flush = false;
  else { validateBoolean(this.flush, 'options.flush'); validateFunction(this[kFs].fsync, 'options.fs.fsync'); }
  // It's enough to override either, in which case only one will be used.
  if (!this[kFs].write) this._write = null;
  if (!this[kFs].writev) this._writev = null;
  this.start = options.start;
  this.pos = undefined;
  this.bytesWritten = 0;
  this[kIsPerformingIO] = false;
  if (this.start !== undefined) { validateInteger(this.start, 'start', 0); this.pos = this.start; }
  Reflect.apply(Writable, this, [options]);
  if (options.encoding) this.setDefaultEncoding(options.encoding);
}
Object.setPrototypeOf(WriteStream.prototype, Writable.prototype);
Object.setPrototypeOf(WriteStream, Writable);
Object.defineProperty(WriteStream.prototype, 'autoClose', {
  get() { validateThisInternalField(this, kFs, 'WriteStream'); return this._writableState.autoDestroy; },
  set(value) { validateThisInternalField(this, kFs, 'WriteStream'); this._writableState.autoDestroy = value; },
});
const openWriteFs = deprecate(function() {}, 'WriteStream.prototype.open() is deprecated', 'DEP0135');
WriteStream.prototype.open = openWriteFs;
WriteStream.prototype._construct = _construct;
function writeAll(data, size, pos, cb, retries = 0) {
  this[kFs].write(this.fd, data, 0, size, pos, (er, bytesWritten, buffer) => {
    if (er?.code === 'EAGAIN') { er = null; bytesWritten = 0; }
    if (this.destroyed || er) return cb(er || destroyed('write'));
    this.bytesWritten += bytesWritten;
    retries = bytesWritten ? 0 : retries + 1;
    size -= bytesWritten;
    pos += bytesWritten;
    // Try writing non-zero number of bytes up to 5 times.
    if (retries > 5) cb(systemFailure('write failed'));
    else if (size) writeAll.call(this, buffer.slice(bytesWritten), size, pos, cb, retries);
    else cb();
  });
}
function writevAll(chunks, size, pos, cb, retries = 0) {
  this[kFs].writev(this.fd, chunks, this.pos, (er, bytesWritten, buffers) => {
    if (er?.code === 'EAGAIN') { er = null; bytesWritten = 0; }
    if (this.destroyed || er) return cb(er || destroyed('writev'));
    this.bytesWritten += bytesWritten;
    retries = bytesWritten ? 0 : retries + 1;
    size -= bytesWritten;
    pos += bytesWritten;
    if (retries > 5) cb(systemFailure('writev failed'));
    else if (size) writevAll.call(this, [Buffer.concat(buffers).slice(bytesWritten)], size, pos, cb, retries);
    else cb();
  });
}
WriteStream.prototype._write = function(data, encoding, cb) {
  this[kIsPerformingIO] = true;
  writeAll.call(this, data, data.length, this.pos, er => {
    this[kIsPerformingIO] = false;
    if (this.destroyed) { cb(er); return this.emit(kIoDone, er); }
    cb(er);
  });
  if (this.pos !== undefined) this.pos += data.length;
};
WriteStream.prototype._writev = function(data, cb) {
  const len = data.length;
  const chunks = new Array(len);
  let size = 0;
  for (let i = 0; i < len; i++) { const chunk = data[i].chunk; chunks[i] = chunk; size += chunk.length; }
  this[kIsPerformingIO] = true;
  writevAll.call(this, chunks, size, this.pos, er => {
    this[kIsPerformingIO] = false;
    if (this.destroyed) { cb(er); return this.emit(kIoDone, er); }
    cb(er);
  });
  if (this.pos !== undefined) this.pos += size;
};
WriteStream.prototype._destroy = function(err, cb) {
  if (this[kIsPerformingIO]) this.once(kIoDone, er => close(this, err || er, cb));
  else close(this, err, cb);
};
WriteStream.prototype.close = function(cb) {
  if (cb) {
    if (this.closed) { process.nextTick(cb); return; }
    this.on('close', cb);
  }
  // If we are not autoClosing, we should call destroy on 'finish'.
  if (!this.autoClose) this.on('finish', this.destroy);
  // We use end() instead of destroy() because of https://github.com/nodejs/node/issues/2006
  this.end();
};
// There is no shutdown() for files.
WriteStream.prototype.destroySoon = WriteStream.prototype.end;
Object.defineProperty(WriteStream.prototype, 'pending', { get() { return this.fd === null; }, configurable: true });
module.exports = { ReadStream, WriteStream };
