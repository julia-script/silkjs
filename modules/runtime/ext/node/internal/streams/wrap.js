'use strict';

const { Duplex } = require('stream');
const { codes: { ERR_INVALID_ARG_TYPE, ERR_STREAM_WRAP, ERR_STREAM_PREMATURE_CLOSE } } =
  require('internal/streams/support');

// Silk has no Node C++ JSStream handle. This wrapper forwards the JavaScript
// duplex contract; native TLS/HTTP handle integration belongs to the host.
class JSStreamSocket extends Duplex {
  constructor(stream) {
    if (!stream || typeof stream.on !== 'function' || typeof stream.write !== 'function' ||
        typeof stream.pause !== 'function' || typeof stream.resume !== 'function') {
      throw new ERR_INVALID_ARG_TYPE('stream', 'Duplex', stream);
    }
    super({ readable: stream.readable, writable: stream.writable });
    this.stream = stream;
    stream.pause();
    const ondata = (chunk) => {
      if (typeof chunk === 'string' || stream.readableObjectMode) {
        stream.pause();
        this.destroy(new ERR_STREAM_WRAP());
        return;
      }
      if (!this.push(chunk)) stream.pause();
    };
    const onend = () => this.push(null);
    const onerror = (error) => this.destroy(error);
    const onclose = () => {
      if (!this.destroyed) {
        const premature = !this.readableEnded && !stream.readableEnded;
        this.destroy(premature ? new ERR_STREAM_PREMATURE_CLOSE() : undefined);
      }
    };
    stream.on('data', ondata);
    stream.once('end', onend);
    stream.on('error', onerror);
    stream.once('close', onclose);
    this.once('close', () => {
      stream.removeListener('data', ondata);
      stream.removeListener('end', onend);
      stream.removeListener('error', onerror);
      stream.removeListener('close', onclose);
    });
    if (stream.readableEnded) this.push(null);
    this.read(0);
  }

  static get StreamWrap() { return JSStreamSocket; }
  isClosing() { return !this.readable || !this.writable; }
  readStart() { this.stream.resume(); return 0; }
  readStop() { this.stream.pause(); return 0; }
  _read() { this.stream.resume(); }
  _write(chunk, encoding, callback) { this.stream.write(chunk, encoding, callback); }
  _final(callback) { this.stream.end(callback); }
  _destroy(error, callback) {
    this.stream.destroy();
    callback(error);
  }
}

module.exports = JSStreamSocket;
