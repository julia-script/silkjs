'use strict';

const { WritableStream } = require('internal/web/streams');
const { Duplex } = require('stream');
const { Buffer } = require('buffer');
const { isArrayBuffer } = require('util/types');
const compressionStreams = new WeakMap();
const decompressionStreams = new WeakMap();
const formats = {
  deflate: ['createDeflate', 'createInflate'],
  'deflate-raw': ['createDeflateRaw', 'createInflateRaw'],
  gzip: ['createGzip', 'createGunzip'],
  brotli: ['createBrotliCompress', 'createBrotliDecompress'],
};

function bufferSource(chunk) {
  if (typeof chunk === 'string') return Buffer.from(chunk);
  const view = ArrayBuffer.isView(chunk);
  const buffer = view ? chunk.buffer : chunk;
  if (!isArrayBuffer(buffer)) {
    const error = new TypeError('The "chunk" argument must be a string, ArrayBuffer, Buffer, TypedArray, or DataView not backed by SharedArrayBuffer');
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  // Constructing the view also rejects detached buffers. Preserve the byte
  // range of non-byte views instead of converting their numeric elements.
  return Buffer.from(buffer, view ? chunk.byteOffset : 0, view ? chunk.byteLength : buffer.byteLength);
}

function create(format, decompress) {
  if (typeof format === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
  format = String(format);
  if (!Object.prototype.hasOwnProperty.call(formats, format)) {
    throw Object.assign(new TypeError(`The argument 'format' is invalid. Received ${format}`), { code: 'ERR_INVALID_ARG_VALUE' });
  }
  const codec = require('zlib')[formats[format][decompress ? 1 : 0]](
    decompress ? { rejectGarbageAfterEnd: true } : undefined,
  );
  // The native codec and the existing Node/web adapter own bounded output,
  // readable backpressure, final-flush validation and cancellation cleanup.
  const pair = Duplex.toWeb(codec);
  const writer = pair.writable.getWriter();
  const writable = new WritableStream({
    start(controller) {
      // Readable cancellation or an asynchronous codec failure must also error
      // an idle writable, not wait for its next write or close.
      writer.closed.catch(error => controller.error(error));
    },
    write(chunk) {
      try {
        return writer.write(bufferSource(chunk));
      } catch (error) {
        // Synchronous WebIDL conversion failures must release the native codec
        // and propagate to the readable side as well as the rejected write.
        codec.destroy(error);
        throw error;
      }
    },
    close() { return writer.close(); },
    abort(reason) { return writer.abort(reason); },
  });
  return { readable: pair.readable, writable };
}

function state(map, receiver) {
  const value = map.get(receiver);
  if (!value) throw new TypeError('Invalid compression stream receiver');
  return value;
}
class CompressionStream {
  constructor(format) { compressionStreams.set(this, create(format, false)); }
  get readable() { return state(compressionStreams, this).readable; }
  get writable() { return state(compressionStreams, this).writable; }
}
class DecompressionStream {
  constructor(format) { decompressionStreams.set(this, create(format, true)); }
  get readable() { return state(decompressionStreams, this).readable; }
  get writable() { return state(decompressionStreams, this).writable; }
}
for (const Constructor of [CompressionStream, DecompressionStream]) {
  Object.defineProperties(Constructor.prototype, {
    readable: { enumerable: true },
    writable: { enumerable: true },
    [Symbol.toStringTag]: { value: Constructor.name, configurable: true },
  });
}
module.exports = { CompressionStream, DecompressionStream };
