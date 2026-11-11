'use strict';

// The compression handles that lib/zlib.js drives. They follow the contract of
// Node's internalBinding('zlib') classes (src/node_zlib.cc): init() configures
// the codec, write()/writeSync() fill a caller-owned output range and report
// [availOutAfter, availInAfter] through the shared write state, failures go to
// handle.onerror(message, errno, code), and a closed handle defers its release
// until a pending threadpool write completes.

const { Buffer } = require('buffer');
const { call, asyncCall } = require('internal/compression/binding');
const constants = require('internal/compression/constants');
const { codes: { ERR_INVALID_ARG_TYPE, ERR_OUT_OF_RANGE } } = require('internal/streams/support');

const zlibCodes = Object.create(null);
for (const name of ['Z_OK', 'Z_STREAM_END', 'Z_NEED_DICT', 'Z_ERRNO', 'Z_STREAM_ERROR',
  'Z_DATA_ERROR', 'Z_MEM_ERROR', 'Z_BUF_ERROR', 'Z_VERSION_ERROR']) zlibCodes[constants[name]] = name;
const zstdCodes = Object.create(null);
const brotliCodes = Object.create(null);
for (const key of Object.keys(constants)) {
  if (key.startsWith('ZSTD_error_')) zstdCodes[constants[key]] = key;
  else if (key.startsWith('BROTLI_DECODER_ERROR_')) brotliCodes[constants[key]] = 'ERR_' + key.slice('BROTLI_DECODER'.length);
}

// Native kinds of internal/compression/binding.
const DEFLATE = 1, GZIP = 3, DEFLATERAW = 5;
const BROTLI_ENCODER = 8, BROTLI_DECODER = 9, ZSTD_COMPRESS = 10;

function initializationFailed(message = 'Initialization failed') {
  const error = new Error(message);
  error.code = 'ERR_ZLIB_INITIALIZATION_FAILED';
  return error;
}

function byteView(value, name) {
  if (value === undefined) return undefined;
  if (!ArrayBuffer.isView(value)) throw new ERR_INVALID_ARG_TYPE(name, ['Buffer', 'TypedArray', 'DataView'], value);
  return value;
}

const typedArrayLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;
const typedArrayOffset = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteOffset').get;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'buffer').get;
const dataViewLength = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength').get;
const dataViewOffset = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteOffset').get;
const dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer').get;

// The view's own byte range; user-defined length properties do not widen it.
function range(view) {
  if (view instanceof DataView) {
    return { buffer: dataViewBuffer.call(view), offset: dataViewOffset.call(view), length: dataViewLength.call(view) };
  }
  return { buffer: typedArrayBuffer.call(view), offset: typedArrayOffset.call(view), length: typedArrayLength.call(view) };
}

// The native codec takes ownership of a copy of each input range.
function snapshot(view, offset, length, name) {
  const bytes = range(view);
  if (!Number.isInteger(offset) || offset < 0 || offset > bytes.length) {
    throw new ERR_OUT_OF_RANGE(`${name}_off`, `>= 0 && <= ${bytes.length}`, offset);
  }
  if (!Number.isInteger(length) || length < 0 || length > bytes.length - offset) {
    throw new ERR_OUT_OF_RANGE(`${name}_len`, `>= 0 && <= ${bytes.length - offset}`, length);
  }
  const start = bytes.offset + offset;
  return bytes.buffer.slice(start, start + length);
}

function decode(value) {
  const view = new DataView(value);
  const written = view.getUint32(8, true);
  let message;
  if (value.byteLength > 20 + written) message = Buffer.from(value, 20 + written).toString('latin1');
  return {
    status: view.getInt32(0, true),
    consumed: view.getUint32(4, true),
    output: new Uint8Array(value, 20, written),
    finished: view.getInt32(12, true) !== 0,
    again: view.getInt32(16, true) !== 0,
    message,
  };
}

// [message, errno, code] for a native status, as node_zlib.cc reports them.
function failure(kind, status, message) {
  if (status === -3000) return ['Trailing junk found after the end of the compressed stream', undefined, 'ERR_TRAILING_JUNK_AFTER_STREAM_END'];
  if (status === -3001) return ['Bad dictionary', constants.Z_NEED_DICT, 'Z_NEED_DICT'];
  if (status === constants.Z_NEED_DICT) return [message || 'Missing dictionary', status, 'Z_NEED_DICT'];
  if (status === constants.Z_BUF_ERROR) return [message || 'unexpected end of file', status, 'Z_BUF_ERROR'];
  if (status <= -2000) {
    const errno = -2000 - status;
    const code = zstdCodes[errno] || 'ZSTD_error_GENERIC';
    return [message || code, errno, code];
  }
  if (status <= -1000) {
    const errno = status + 1000;
    return ['Decompression failed', errno, brotliCodes[errno] || 'ERR_BROTLI_DECOMPRESSION_FAILED'];
  }
  if (kind === BROTLI_ENCODER) return ['Compression failed', -1, 'ERR_BROTLI_COMPRESSION_FAILED'];
  if (kind >= ZSTD_COMPRESS) return [message || 'Compression failed', status, kind === ZSTD_COMPRESS ? 'ERR_ZSTD_COMPRESSION_FAILED' : 'ERR_ZSTD_DECOMPRESSION_FAILED'];
  return [message || 'Zlib error', status, zlibCodes[status] || 'Z_UNKNOWN_ERROR'];
}

const closeHandles = new FinalizationRegistry(id => call('close', [id]));

class CompressionHandle {
  constructor(kind) {
    this._kind = kind;
    this._id = 0;
    this._writeState = null;
    this._callback = null;
    this._writeInProgress = false;
    this._pendingClose = false;
    this.onerror = null;
  }

  _create(numbers, dictionary, params, strict, writeState, callback) {
    if (!(writeState instanceof Uint32Array) || writeState.length < 2) {
      throw new ERR_INVALID_ARG_TYPE('writeState', 'Uint32Array', writeState);
    }
    dictionary = byteView(dictionary, 'dictionary');
    const id = call('create', [this._kind, ...numbers,
      dictionary && snapshot(dictionary, 0, range(dictionary).length, 'dictionary'), params, strict ? 1 : 0]);
    if (id < 1) {
      // -3002: a parameter value was rejected (node_zlib.cc words it this way for zstd).
      throw initializationFailed(id === -3002 && this._kind >= ZSTD_COMPRESS ? 'Setting parameter failed' : undefined);
    }
    this._id = id;
    this._writeState = writeState;
    this._callback = callback;
    closeHandles.register(this, id, this);
  }

  _check(method) {
    if (!this._id) {
      const error = new Error(`Cannot call ${method}() on a closed compression handle`);
      error.code = 'ERR_INVALID_STATE';
      throw error;
    }
    if (this._writeInProgress) {
      const error = new Error('A compression write is already in progress');
      error.code = 'ERR_INVALID_STATE';
      throw error;
    }
  }

  _error(status, message) {
    const [text, errno, code] = failure(this._kind, status, message);
    if (typeof this.onerror === 'function') this.onerror(text, errno, code);
  }

  // One write() runs native steps until the output range is full, the input is
  // consumed, or the codec reports that the stream ended. Every step resumes the
  // codec's retained copy of the remaining input.
  _step(sync, state, done) {
    const args = [this._id, state.input, state.flush, state.outLength - state.written];
    state.input = undefined;
    const finish = (value) => {
      const result = decode(value);
      if (result.output.length) {
        state.out.set(result.output, state.outOffset + state.written);
        state.written += result.output.length;
      }
      state.consumed += result.consumed;
      if (result.status !== 0) { done(result.status, result.message); return; }
      const progressed = result.consumed !== 0 || result.output.length !== 0;
      if (result.again && progressed && state.written < state.outLength && this._id) {
        this._step(sync, state, done);
        return;
      }
      done(0);
    };
    if (sync) finish(call('process', args));
    else asyncCall('process', args, (err, value) => {
      if (err) { done(constants.Z_STREAM_ERROR, err.message); return; }
      if (!this._id) { done(0); return; }
      finish(value);
    });
  }

  _write(sync, flush, input, inOffset, inLength, out, outOffset, outLength) {
    this._check(sync ? 'writeSync' : 'write');
    if (!Number.isInteger(flush)) throw new ERR_INVALID_ARG_TYPE('flush', 'number', flush);
    const source = input === undefined || input === null ? new ArrayBuffer(0) :
      snapshot(byteView(input, 'in'), inOffset, inLength, 'in');
    out = byteView(out, 'out');
    const target = range(out);
    if (!Number.isInteger(outOffset) || outOffset < 0 || outOffset > target.length) {
      throw new ERR_OUT_OF_RANGE('out_off', `>= 0 && <= ${target.length}`, outOffset);
    }
    if (!Number.isInteger(outLength) || outLength < 1 || outLength > target.length - outOffset) {
      throw new ERR_OUT_OF_RANGE('out_len', `>= 1 && <= ${target.length - outOffset}`, outLength);
    }
    const state = {
      input: source, flush, consumed: 0, written: 0,
      out: new Uint8Array(target.buffer, target.offset, target.length), outOffset, outLength,
    };
    const inBefore = source.byteLength;
    this._writeInProgress = true;
    this._step(sync, state, (status, message) => {
      this._writeInProgress = false;
      this._writeState[0] = outLength - state.written;
      this._writeState[1] = inBefore - state.consumed;
      if (this._pendingClose) this.close();
      if (status !== 0) { this._error(status, message); return; }
      if (!sync) this._callback.call(this);
    });
  }

  write(flush, input, inOffset, inLength, out, outOffset, outLength) {
    this._write(false, flush, input, inOffset, inLength, out, outOffset, outLength);
  }

  writeSync(flush, input, inOffset, inLength, out, outOffset, outLength) {
    this._write(true, flush, input, inOffset, inLength, out, outOffset, outLength);
  }

  reset() {
    if (this._writeInProgress) throw new Error('Cannot reset zlib stream while a write is in progress');
    this._check('reset');
    const result = decode(call('reset', [this._id]));
    if (result.status !== 0) this._error(result.status, 'Failed to reset stream');
  }

  close() {
    if (this._writeInProgress) { this._pendingClose = true; return; }
    this._pendingClose = false;
    if (!this._id) return;
    const id = this._id;
    this._id = 0;
    closeHandles.unregister(this);
    call('close', [id]);
  }
}

class Zlib extends CompressionHandle {
  init(windowBits, level, memLevel, strategy, writeState, callback, dictionary, rejectGarbageAfterEnd) {
    this._create([windowBits, level, memLevel, strategy], dictionary, undefined,
      rejectGarbageAfterEnd, writeState, callback);
  }

  params(level, strategy) {
    this._check('params');
    // Inflate modes have no parameters to change (node_zlib.cc SetParams).
    if (this._kind !== DEFLATE && this._kind !== GZIP && this._kind !== DEFLATERAW) return;
    const result = decode(call('params', [this._id, undefined, level, strategy]));
    if (result.status !== 0 && result.status !== constants.Z_BUF_ERROR) this._error(result.status, result.message);
  }
}

// Parameters are an array indexed by parameter number; unset slots hold
// 0xFFFFFFFF, as in lib/zlib.js.
function packParams(values) {
  if (!(values instanceof Uint32Array)) throw new ERR_INVALID_ARG_TYPE('params', 'Uint32Array', values);
  const pairs = [];
  // node_zlib.cc reads each slot as a C int.
  for (let key = 0; key < values.length; key++) if (values[key] !== 0xFFFFFFFF) pairs.push(key, values[key] | 0);
  const packed = new Int32Array(pairs);
  return packed.buffer;
}

class BrotliHandle extends CompressionHandle {
  init(params, writeState, callback, dictionary) {
    this._create([15, -1, 8, 0], dictionary, packParams(params), false, writeState, callback);
  }

  params() {
    // Brotli parameters are fixed at initialization (node_zlib.cc).
  }
}
class BrotliEncoder extends BrotliHandle {
  constructor() { super(BROTLI_ENCODER); }
}
class BrotliDecoder extends BrotliHandle {
  constructor() { super(BROTLI_DECODER); }
}

class ZstdHandle extends CompressionHandle {
  init(params, pledgedSrcSize, writeState, callback, dictionary, rejectGarbageAfterEnd) {
    if (pledgedSrcSize !== undefined) {
      if (typeof pledgedSrcSize !== 'number') {
        throw new ERR_INVALID_ARG_TYPE('options.pledgedSrcSize', 'number', pledgedSrcSize);
      }
      if (!Number.isSafeInteger(pledgedSrcSize) || pledgedSrcSize < 0) {
        throw new ERR_OUT_OF_RANGE('options.pledgedSrcSize', `>= 0 && <= ${Number.MAX_SAFE_INTEGER}`, pledgedSrcSize);
      }
    }
    this._create([15, -1, 8, 0], dictionary, packParams(params), rejectGarbageAfterEnd, writeState, callback);
    if (pledgedSrcSize !== undefined && this._kind === ZSTD_COMPRESS) {
      const result = decode(call('pledge', [this._id, pledgedSrcSize]));
      if (result.status !== 0) { this.close(); throw initializationFailed(); }
    }
  }

  params() {
    // Zstd parameters are fixed at initialization (node_zlib.cc).
  }
}
class ZstdCompress extends ZstdHandle {
  constructor() { super(ZSTD_COMPRESS); }
}
class ZstdDecompress extends ZstdHandle {
  constructor() { super(ZSTD_COMPRESS + 1); }
}

function crc32(data, value) {
  if (typeof data === 'string') data = Buffer.from(data);
  return call('crc32', [snapshot(data, 0, range(data).length, 'data'), value]);
}

module.exports = { Zlib, BrotliEncoder, BrotliDecoder, ZstdCompress, ZstdDecompress, crc32 };
