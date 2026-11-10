'use strict';
const { Readable, Writable } = require('stream');
const c = require('internal/fs_core');
const fs = require('fs');
function initialize(stream, path, options, reading) {
  stream.path = path === undefined ? undefined : c.path(path);
  stream.fd = options.fd === undefined ? null : c.fd(options.fd);
  stream.flags = options.flags === undefined ? reading ? 'r' : 'w' : options.flags;
  stream.mode = c.mode(options.mode);
  stream.autoClose = options.autoClose !== false;
  stream.pending = stream.fd === null;
  stream._fs = options.fs || fs;
  stream._position = options.start === undefined ? null : c.integer(options.start, 'start');
  stream._inflight = 0;
  stream._afterIO = null;
  stream._flush = !!options.flush;
  if (reading) { stream.end = options.end === undefined ? Infinity : c.integer(options.end, 'end'); if (stream._position !== null && stream._position > stream.end) throw c.range('start'); stream.bytesRead = 0; }
  else stream.bytesWritten = 0;
}
function construct(callback) {
  if (this.fd !== null) { this.pending = false; callback(); return; }
  this._fs.open(this.path, this.flags, this.mode, (err, fd) => { this.pending = false; if (err) { callback(err); return; } this.fd = fd; this.emit('open', fd); this.emit('ready'); callback(); });
}
function finishIO(stream) { stream._inflight--; if (stream._inflight === 0 && stream._afterIO) { const fn = stream._afterIO; stream._afterIO = null; fn(); } }
function destroy(err, callback) {
  const close = () => {
    if (this.fd === null || !this.autoClose) { callback(err); return; }
    const fd = this.fd; this.fd = null;
    const release = flushError => this._fs.close(fd, closeError => callback(err || flushError || closeError));
    if (this._flush && this instanceof WriteStream) this._fs.fsync(fd, release); else release(null);
  };
  if (this._inflight) this._afterIO = close; else close();
}
class ReadStream extends Readable {
  constructor(path, options) { options = c.options(options); super(Object.assign({ highWaterMark: 65536, autoDestroy: true }, options)); initialize(this, path, options, true); }
  _construct(callback) { construct.call(this, callback); }
  _read(size) {
    const position = this._position;
    const current = position === null ? this.bytesRead : position;
    const length = Math.min(size, this.end - current + 1);
    if (length <= 0) { this.push(null); return; }
    const buffer = c.Buffer.allocUnsafe(length); this._inflight++;
    this._fs.read(this.fd, buffer, 0, length, position, (err, count) => {
      finishIO(this); if (this.destroyed) return;
      if (err) { this.destroy(err); return; }
      if (count === 0) { this.push(null); return; }
      this.bytesRead += count; if (this._position !== null) this._position += count;
      this.push(count === length ? buffer : buffer.subarray(0, count));
    });
  }
  _destroy(err, callback) { destroy.call(this, err, callback); }
  close(callback) { if (callback) this.once('close', callback); this.autoClose = true; this.destroy(); }
}
class WriteStream extends Writable {
  constructor(path, options) { options = c.options(options); super(Object.assign({ autoDestroy: true }, options)); initialize(this, path, options, false); }
  _construct(callback) { construct.call(this, callback); }
  _write(chunk, encoding, callback) {
    const buffer = typeof chunk === 'string' ? c.Buffer.from(chunk, encoding) : chunk; let offset = 0;
    const write = () => {
      if (offset === buffer.length) { callback(); return; }
      this._inflight++;
      this._fs.write(this.fd, buffer, offset, buffer.length - offset, this._position, (err, count) => {
        finishIO(this);
        if (err) { callback(err); return; }
        if (count === 0) { callback(c.error('EIO', 'write', this.path)); return; }
        offset += count; this.bytesWritten += count; if (this._position !== null) this._position += count;
        if (this.destroyed) { callback(c.error('EBADF', 'write', this.path)); return; }
        write();
      });
    };
    write();
  }
  _destroy(err, callback) { destroy.call(this, err, callback); }
  close(callback) { if (callback) this.once('close', callback); this.autoClose = true; if (this.writableFinished) this.destroy(); else { this.once('finish', () => this.destroy()); this.end(); } }
  destroySoon() { this.end(); }
}
module.exports = { ReadStream, WriteStream };
