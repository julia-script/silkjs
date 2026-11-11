'use strict';

const host = require('internal/host');
const { native, error: nativeError } = require('internal/net/transport');

function socket(fd, reading) {
  const owned = native('duplicateFd', [fd]);
  if (owned < 0) throw nativeError(owned, 'dup');
  let stream;
  try { stream = new (require('net').Socket)({ fd: owned, readable: reading, writable: !reading, manualStart: true }); }
  catch (error) { require('fs').closeSync(owned); throw error; }
  stream.fd = fd;
  stream._type = 'pipe';
  return stream;
}

function output(fd) {
  const kind = native('guessHandleType', [fd]);
  let stream;
  if (kind === 5) {
    stream = new (require('tty').WriteStream)(fd);
    stream._type = 'tty';
  } else if (kind === 1 || kind === 2) {
    stream = socket(fd, false);
    if (process.platform === 'win32') {
      const status = stream._transport.call('setBlocking', true);
      if (status < 0) { stream.destroy(); throw nativeError(status, 'setBlocking'); }
    }
  } else {
    // Regular files (and character devices such as /dev/null) use synchronous
    // writes on all platforms. Invalid descriptors report their real write error.
    const { writeAll } = require('internal/tty/write');
    stream = new (require('internal/streams/writable'))({
      autoDestroy: false,
      emitClose: false,
      write(chunk, encoding, callback) {
        let failure;
        try { writeAll(fd, chunk); } catch (error) { failure = error; }
        callback(failure);
      }
    });
    stream._type = 'fs';
  }
  stream.fd = fd;
  stream._isStdio = true;
  // Standard output streams survive destroy(), as in Node. The process owns
  // its descriptors; native teardown closes only our duplicated transport fds.
  stream._destroy = function(error, callback) {
    callback(error);
    this._undestroy();
    if (!this._writableState.emitClose) process.nextTick(() => this.emit('close'));
  };
  stream.destroySoon = stream.destroy;
  return stream;
}

function input() {
  const kind = native('guessHandleType', [0]);
  let stream;
  if (kind === 5) {
    stream = new (require('tty').ReadStream)(0);
    stream._type = 'tty';
  } else if (kind === 1 || kind === 2) {
    stream = socket(0, true);
  } else {
    stream = require('fs').createReadStream(undefined, { fd: 0, autoClose: false });
    stream._type = 'fs';
    // Even an explicit close() must not transfer ownership of process fd 0.
    const destroy = stream._destroy;
    stream._destroy = function(error, callback) { this.autoClose = false; destroy.call(this, error, callback); };
  }
  stream.fd = 0;
  stream._isStdio = true;
  if (stream._writableState) stream._writableState.ended = true;
  if (stream._transport) {
    stream._transport.readStop();
    stream._readableState.reading = false;
    stream.on('pause', () => {
      process.nextTick(() => {
        if (!stream.readableFlowing) {
          stream._transport?.readStop();
          stream._readableState.reading = false;
        }
      });
    });
  }
  return stream;
}

function install(process) {
  let stdin, stdout, stderr;
  // In particular, do not inspect/open fd 0 here: the CLI may still need to
  // synchronously consume piped program source before application execution.
  Object.defineProperties(process, {
    stdin: { configurable: true, enumerable: true, get() { return stdin ||= input(); } },
    stdout: { configurable: true, enumerable: true, get() {
      if (!stdout) {
        stdout = output(1);
        if (stdout.isTTY) process.on('SIGWINCH', () => stdout._refreshSize());
      }
      return stdout;
    } },
    stderr: { configurable: true, enumerable: true, get() {
      if (!stderr) {
        stderr = output(2);
        if (stderr.isTTY) process.on('SIGWINCH', () => stderr._refreshSize());
      }
      return stderr;
    } }
  });
  process.openStdin = () => { const stream = process.stdin; stream.resume(); return stream; };
  // Explicit process.exit bypasses native state teardown. Restore terminal mode
  // here too; the shared net state handles normal completion and fatal teardown.
  process.on('exit', () => native('ttyResetMode', []));
}

module.exports = { install };
