'use strict';

// Node's lib/internal/fs/read/context.js: fs.readFile's state machine over the fs
// binding's open, fstat, read and close requests. Copyright Node.js contributors.
// MIT license (see vendor/node-api/LICENSE).

const {
  getReadFileBuffer,
  getReadFileBufferByteLengthName,
} = require('internal/fs/utils');
const { Buffer } = require('buffer');
const { FSReqCallback, close, read } = require('internal/fs/binding');
const {
  AbortError,
  aggregateTwoErrors,
  codes: { ERR_INVALID_ARG_VALUE },
} = require('internal/errors');

// Use 512kb buffer size: the hard limit on what a single read can take
// without blocking the thread pool for long.
const kReadFileBufferLength = 512 * 1024;
// Size used when the file size is unknown (it could be a pipe or similar).
const kReadFileUnknownBufferLength = 64 * 1024;

function createReadFileBufferTooSmallError(name, byteLength) {
  return new ERR_INVALID_ARG_VALUE(name, byteLength, 'is too small to contain the entire file');
}

function readFileAfterRead(err, bytesRead) {
  const context = this.context;

  if (err)
    return context.close(err);

  if (context.checkOverflow) {
    context.checkOverflow = false;
    if (bytesRead !== 0) {
      return context.close(createReadFileBufferTooSmallError(
        context.bufferByteLengthName,
        context.buffer.byteLength,
      ));
    }
    return context.close();
  }

  context.pos += bytesRead;

  if (context.userBuffer) {
    if (context.pos === context.size || bytesRead === 0) {
      context.close();
    } else {
      context.read();
    }
    return;
  }

  if (context.pos === context.size || bytesRead === 0) {
    context.close();
  } else {
    if (context.size === 0) {
      // Unknown size, just read until we don't get bytes.
      const buffer = bytesRead === kReadFileUnknownBufferLength ?
        context.buffer : context.buffer.slice(0, bytesRead);
      context.buffers.push(buffer);
    }
    context.read();
  }
}

function readFileAfterClose(err) {
  const context = this.context;
  const callback = context.callback;
  let buffer = null;

  if (context.err || err)
    return callback(aggregateTwoErrors(err, context.err));

  try {
    if (context.userBuffer) {
      buffer = context.buffer.subarray(0, context.pos);
    } else if (context.size === 0) {
      buffer = Buffer.concat(context.buffers, context.pos);
    } else if (context.pos < context.size) {
      buffer = context.buffer.slice(0, context.pos);
    } else {
      buffer = context.buffer;
    }

    if (context.encoding)
      buffer = buffer.toString(context.encoding);
  } catch (err) {
    return callback(err);
  }

  callback(null, buffer);
}

class ReadFileContext {
  constructor(callback, options) {
    this.fd = undefined;
    this.isUserFd = undefined;
    this.size = 0;
    this.callback = callback;
    this.buffers = null;
    this.buffer = null;
    this.pos = 0;
    this.encoding = options.encoding;
    this.options = options;
    this.err = null;
    this.signal = undefined;
    this.userBuffer = false;
    this.bufferByteLengthName = null;
    this.overflowBuffer = null;
    this.checkOverflow = false;
  }

  prepare() {
    const buffer = getReadFileBuffer(this.options, this.size);
    if (buffer !== undefined) {
      this.buffer = buffer;
      this.userBuffer = true;
      this.bufferByteLengthName = getReadFileBufferByteLengthName(this.options);
      return;
    }

    if (this.size === 0) {
      this.buffers = [];
    } else {
      this.buffer = Buffer.allocUnsafeSlow(this.size);
    }
  }

  read() {
    let buffer;
    let offset;
    let length;

    if (this.signal?.aborted) {
      return this.close(
        new AbortError(undefined, { cause: this.signal.reason }));
    }
    if (this.userBuffer) {
      if (this.size === 0) {
        buffer = this.buffer;
        offset = this.pos;
        length = this.buffer.byteLength - this.pos;
        if (length === 0) {
          // The buffer is full: one more byte tells whether the file fits.
          buffer = this.overflowBuffer ??= Buffer.allocUnsafeSlow(1);
          offset = 0;
          length = 1;
          this.checkOverflow = true;
        }
      } else {
        buffer = this.buffer;
        offset = this.pos;
        length = Math.min(kReadFileBufferLength, this.size - this.pos);
      }
    } else if (this.size === 0) {
      buffer = Buffer.allocUnsafeSlow(kReadFileUnknownBufferLength);
      offset = 0;
      length = kReadFileUnknownBufferLength;
      this.buffer = buffer;
    } else {
      buffer = this.buffer;
      offset = this.pos;
      length = Math.min(kReadFileBufferLength, this.size - this.pos);
    }

    const req = new FSReqCallback();
    req.oncomplete = readFileAfterRead;
    req.context = this;

    read(this.fd, buffer, offset, length, -1, req);
  }

  close(err) {
    if (this.isUserFd) {
      process.nextTick(function tick(context) {
        Reflect.apply(readFileAfterClose, { context }, [null]);
      }, this);
      return;
    }

    const req = new FSReqCallback();
    req.oncomplete = readFileAfterClose;
    req.context = this;
    this.err = err;

    close(this.fd, req);
  }
}

module.exports = ReadFileContext;
