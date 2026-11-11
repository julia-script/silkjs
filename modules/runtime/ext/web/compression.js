'use strict';

const { WritableStream } = require('internal/web/streams');
const { Duplex } = require('stream');
const { Buffer } = require('buffer');
const { isAnyArrayBuffer, isSharedArrayBuffer } = require('util/types');
const { codes: { ERR_INVALID_ARG_TYPE, ERR_STREAM_NULL_VALUES } } = require('internal/streams/support');
const formats = {
  deflate: ['createDeflate', 'createInflate'],
  'deflate-raw': ['createDeflateRaw', 'createInflateRaw'],
  gzip: ['createGzip', 'createGunzip'],
  brotli: ['createBrotliCompress', 'createBrotliDecompress'],
};

// Chunks are BufferSource values not backed by a SharedArrayBuffer (Compression
// Streams spec). The rest is the codec's own Writable chunk validation, done
// here so that a rejected chunk also errors the readable side.
function bufferSource(chunk) {
  const view = ArrayBuffer.isView(chunk);
  if (isSharedArrayBuffer(view ? chunk.buffer : chunk)) {
    throw new ERR_INVALID_ARG_TYPE('chunk', ['ArrayBuffer', 'Buffer', 'TypedArray', 'DataView'], chunk);
  }
  if (chunk === null) throw new ERR_STREAM_NULL_VALUES();
  if (typeof chunk === 'string') return Buffer.from(chunk);
  // Constructing the view also rejects detached buffers. Preserve the byte
  // range of non-byte views instead of converting their numeric elements.
  if (view) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (isAnyArrayBuffer(chunk)) return Buffer.from(chunk);
  throw new ERR_INVALID_ARG_TYPE('chunk', ['string', 'Buffer', 'TypedArray', 'DataView'], chunk);
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

class CompressionStream {
  #transform;
  constructor(format) { this.#transform = create(format, false); }
  get readable() { return this.#transform.readable; }
  get writable() { return this.#transform.writable; }
}
class DecompressionStream {
  #transform;
  constructor(format) { this.#transform = create(format, true); }
  get readable() { return this.#transform.readable; }
  get writable() { return this.#transform.writable; }
}
for (const Constructor of [CompressionStream, DecompressionStream]) {
  Object.defineProperties(Constructor.prototype, {
    readable: { enumerable: true },
    writable: { enumerable: true },
    [Symbol.toStringTag]: { value: Constructor.name, configurable: true },
  });
}
module.exports = { CompressionStream, DecompressionStream };
