'use strict';
// The StreamBase pieces of Node.js v24 lib/internal/stream_base_commons.js that
// the http2 modules use, over the handles in internal/http2/binding. Copyright Joyent, Inc. and other Node contributors.
// MIT license (see THIRD_PARTY_NOTICES).
//
// Node's handles read from the shared streamBaseState array; these handles pass
// the read size and buffer to onread directly, and take every write as a list
// of buffers.
const { Buffer } = require('buffer');
const { clearTimeout, setTimeout } = require('timers');
const { getTimerDuration, kTimeout } = require('internal/timers');
const { UV_EOF } = require('internal/http2/binding');
const { ErrnoException } = require('internal/errors');
const { validateFunction } = require('internal/validators');

const kMaybeDestroy = Symbol('kMaybeDestroy');
const kUpdateTimer = Symbol('kUpdateTimer');
const kAfterAsyncWrite = Symbol('kAfterAsyncWrite');
const kHandle = Symbol('kHandle');
const kBoundSession = Symbol('kBoundSession');
const kSession = Symbol('kSession');
const owner_symbol = Symbol('owner_symbol');
const async_id_symbol = Symbol('asyncId');

function onWriteComplete(status) {
  const stream = this.handle[owner_symbol];

  if (status < 0) {
    const error = new ErrnoException(status, 'write', this.error);
    if (typeof this.callback === 'function') {
      return this.callback(error);
    }
    return stream.destroy(error);
  }

  if (stream.destroyed) {
    if (typeof this.callback === 'function') this.callback(null);
    return;
  }

  stream[kUpdateTimer]();
  stream[kAfterAsyncWrite](this);

  if (typeof this.callback === 'function') this.callback(null);
}

function dispatchWrite(handle, buffers, cb) {
  let bytes = 0;
  for (let i = 0; i < buffers.length; i++) bytes += buffers[i].length;
  const req = { handle, oncomplete: onWriteComplete, callback: cb, async: true, bytes, buffer: buffers, error: null };
  const ret = handle.write(req, buffers);
  if (ret !== 0) {
    cb(new ErrnoException(ret, 'write'));
    return { async: false, bytes };
  }
  return req;
}

function toBuffer(chunk, encoding) {
  if (typeof chunk === 'string') return Buffer.from(chunk, encoding === 'buffer' ? 'utf8' : encoding);
  if (Buffer.isBuffer(chunk)) return chunk;
  return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

function writevGeneric(self, data, cb) {
  // Like Node, a list of buffers is turned into the chunks in place.
  if (data.allBuffers) {
    for (let i = 0; i < data.length; i++) data[i] = data[i].chunk;
    return dispatchWrite(self[kHandle], data, cb);
  }
  const buffers = new Array(data.length);
  for (let i = 0; i < data.length; i++) buffers[i] = toBuffer(data[i].chunk, data[i].encoding);
  return dispatchWrite(self[kHandle], buffers, cb);
}

function writeGeneric(self, data, encoding, cb) {
  return dispatchWrite(self[kHandle], [toBuffer(data, encoding)], cb);
}

function onStreamRead(nread, buf) {
  const handle = this;
  const stream = this[owner_symbol];

  stream[kUpdateTimer]();

  if (nread > 0 && !stream.destroyed) {
    const result = stream.push(buf);
    if (!result) {
      handle.reading = false;
      if (!stream.destroyed) {
        const err = handle.readStop();
        if (err) stream.destroy(new ErrnoException(err, 'read'));
      }
    }
    return;
  }

  if (nread === 0) return;

  if (nread !== UV_EOF) {
    stream.destroy(new ErrnoException(nread, 'read'));
    return;
  }

  if (stream._readableState.endEmitted) {
    if (stream[kMaybeDestroy]) stream[kMaybeDestroy]();
  } else {
    if (stream[kMaybeDestroy]) stream.on('end', stream[kMaybeDestroy]);
    stream.push(null);
    stream.read(0);
  }
}

// A shutdown request: the handle calls oncomplete(status) when the writable side is closed.
class ShutdownWrap {}

function onStreamTimeout(stream) {
  stream._onTimeout();
}

function setStreamTimeout(msecs, callback) {
  if (this.destroyed) return this;

  this.timeout = msecs;
  msecs = getTimerDuration(msecs, 'msecs');

  clearTimeout(this[kTimeout]);

  if (msecs === 0) {
    if (callback !== undefined) {
      validateFunction(callback, 'callback');
      this.removeListener('timeout', callback);
    }
  } else {
    this[kTimeout] = setTimeout(onStreamTimeout, msecs, this);
    this[kTimeout].unref();
    if (this[kSession]) this[kSession][kUpdateTimer]();
    if (this[kBoundSession]) this[kBoundSession][kUpdateTimer]();

    if (callback !== undefined) {
      validateFunction(callback, 'callback');
      this.once('timeout', callback);
    }
  }
  return this;
}

module.exports = {
  async_id_symbol,
  kAfterAsyncWrite,
  kBoundSession,
  kHandle,
  kMaybeDestroy,
  kSession,
  kTimeout,
  kUpdateTimer,
  onStreamRead,
  owner_symbol,
  setStreamTimeout,
  ShutdownWrap,
  writeGeneric,
  writevGeneric,
};
