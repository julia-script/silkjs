'use strict';

// Native operations always advance a bounded output chunk. Async operations run
// on libuv's worker pool; the Transform owns ordering and readable backpressure.
const { Buffer, constants: bufferConstants } = require('buffer');
const { Transform } = require('stream');
const { codes, codecError, decode, call, asyncCall } = require('internal/compression/binding');
const constants = require('internal/compression/constants');
const kCommand = Symbol('compression command');
const empty = Buffer.alloc(0);
function error(code, message, Constructor = Error) { const e = new Constructor(message); e.code = code; return e; }
function integer(value, name, min, max, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number') throw error('ERR_INVALID_ARG_TYPE', `The "${name}" argument must be of type number`, TypeError);
  if (!Number.isInteger(value) || value < min || value > max) throw error('ERR_OUT_OF_RANGE', `The value of "${name}" is out of range. It must be >= ${min} and <= ${max}. Received ${value}`, RangeError);
  return value;
}
function input(value, name = 'buffer', strings = true) {
  if (strings && typeof value === 'string') return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer || typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) return Buffer.from(value);
  throw error('ERR_INVALID_ARG_TYPE', `The "${name}" argument must be a string, Buffer, TypedArray, DataView, or ArrayBuffer`, TypeError);
}
function backing(buffer) { return buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength ? buffer.buffer : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength); }
function packedParams(params, kind) {
  if (params === undefined) return undefined;
  if (params === null || typeof params !== 'object') throw error('ERR_INVALID_ARG_TYPE', 'The "options.params" property must be an object', TypeError);
  const entries = Object.keys(params); const bytes = new ArrayBuffer(entries.length * 8); const view = new DataView(bytes);
  entries.forEach((key, i) => {
    const parameter = Number(key);
    if (!Number.isInteger(parameter) || parameter < 0 || parameter > 2147483647) throw error(kind >= 10 ? 'ERR_ZSTD_INVALID_PARAM' : 'ERR_BROTLI_INVALID_PARAM', `Invalid compression parameter: ${key}`, RangeError);
    let value = params[key]; if (typeof value === 'boolean') value = Number(value);
    value = integer(value, `options.params[${key}]`, -2147483648, 4294967295);
    view.setInt32(i * 8, parameter, true); view.setInt32(i * 8 + 4, value, true);
  });
  return bytes;
}
class Codec extends Transform {
  constructor(options, kind) {
    if (options === undefined || options === null) options = {};
    if (typeof options !== 'object') throw error('ERR_INVALID_ARG_TYPE', 'The "options" argument must be an object', TypeError);
    super({ ...options, readableObjectMode: false, writableObjectMode: false, objectMode: false });
    this._kind = kind;
    this._chunkSize = integer(options.chunkSize, 'options.chunkSize', 64, 2147483627, 16384);
    this._defaultFlushFlag = integer(options.flush, 'options.flush', 0, kind <= 7 ? 5 : kind <= 9 ? 3 : 2, 0);
    this._finishFlushFlag = integer(options.finishFlush, 'options.finishFlush', 0, kind <= 7 ? 5 : kind <= 9 ? 3 : 2, kind <= 7 ? 4 : 2);
    this._defaultFullFlushFlag = kind <= 7 ? 3 : 1;
    this._maxOutputLength = integer(options.maxOutputLength, 'options.maxOutputLength', 1, bufferConstants.MAX_LENGTH, bufferConstants.MAX_LENGTH);
    this._level = integer(options.level, 'options.level', -1, 9, -1);
    this._strategy = integer(options.strategy, 'options.strategy', 0, 4, 0);
    let window = integer(options.windowBits, 'options.windowBits', kind === 2 || kind === 4 || kind === 7 ? 0 : 8, 15, 15);
    if (window !== 0 && window < 8) throw error('ERR_OUT_OF_RANGE', 'options.windowBits must be 0 or between 8 and 15', RangeError);
    if (kind === 5 && window === 8) window = 9;
    const memory = integer(options.memLevel, 'options.memLevel', 1, 9, 8);
    const dictionary = options.dictionary === undefined ? undefined : backing(input(options.dictionary, 'options.dictionary', false));
    const params = packedParams(options.params, kind);
    this.bytesWritten = 0; this._handle = null; this._resumeCompression = null; this._activeCompression = false; this._completion = null;
    this._totalOutput = 0; this._info = !!options.info; this._convenience = false;
    if (options.rejectGarbageAfterEnd !== undefined && typeof options.rejectGarbageAfterEnd !== 'boolean') throw error('ERR_INVALID_ARG_TYPE', 'options.rejectGarbageAfterEnd must be a boolean', TypeError);
    this._rejectGarbageAfterEnd = options.rejectGarbageAfterEnd === true;
    const id = call('create', [kind, window, this._level, memory, this._strategy, dictionary, params, options.rejectGarbageAfterEnd ? 1 : 0]);
    if (id < 1) throw error('ERR_ZLIB_INITIALIZATION_FAILED', 'Initialization failed');
    this._handle = id;
  }
  get bytesRead() { return this.bytesWritten; }
  set bytesRead(value) { this.bytesWritten = value; }
  get _closed() { return this._handle === null; }
  _read(size) {
    if (this._resumeCompression) { const resume = this._resumeCompression; this._resumeCompression = null; resume(); }
    Transform.prototype._read.call(this, size);
  }
  _transform(chunk, encoding, callback) {
    const command = chunk[kCommand];
    if (command && command.type === 'params') {
      this._run(empty, constants.Z_SYNC_FLUSH, err => {
        if (err) callback(err); else this._run(empty, this._defaultFlushFlag, callback, 'params', command);
      }); return;
    }
    this._run(chunk, command ? command.flush : this._defaultFlushFlag, callback);
  }
  _flush(callback) { this._run(empty, this._finishFlushFlag, callback); }
  _run(chunk, flush, callback, operation = 'process', command) {
    if (this._handle === null) { callback(error('ERR_STREAM_DESTROYED', 'Cannot call write after a stream was destroyed')); return; }
    let offset = 0, first = true;
    this._activeCompression = true;
    let completed = false;
    const done = err => { if (completed) return; completed = true; this._activeCompression = false; this._completion = null; callback(err); };
    this._completion = done;
    const step = () => {
      if (this.destroyed || this._handle === null) { done(); return; }
      const capacity = this._convenience ? Math.min(this._chunkSize, this._maxOutputLength - this._totalOutput + 1) : this._chunkSize;
      const args = operation === 'params' ? [this._handle, undefined, command.level, command.strategy] : [this._handle, first ? backing(chunk) : undefined, flush, capacity];
      first = false;
      try {
        asyncCall(operation, args, (err, value) => {
          if (this.destroyed) { done(); return; }
          if (err) { done(err instanceof Error ? err : new Error(String(err))); return; }
          let result;
          try { result = decode(value, this._kind); } catch (failure) { done(failure); return; }
          offset += result.consumed; this.bytesWritten += result.consumed; this._totalOutput += result.output.length;
          if (this._convenience && this._totalOutput > this._maxOutputLength) { done(error('ERR_BUFFER_TOO_LARGE', `Cannot create a Buffer larger than ${this._maxOutputLength} bytes`, RangeError)); return; }
          if (operation === 'params' && !result.again) { this._level = command.level; this._strategy = command.strategy; }
          const again = result.again || !result.finished && offset < chunk.length;
          const trailing = result.finished && !again && offset < chunk.length;
          if (trailing && this._rejectGarbageAfterEnd) { done(codecError(-3000, this._kind)); return; }
          const canContinue = !result.output.length || this.push(result.output);
          if (trailing) this.push(null);
          if (!again) { done(); return; }
          if (canContinue) step(); else this._resumeCompression = step;
        });
      } catch (failure) { done(failure); }
    };
    step();
  }
  _processChunk(chunk, flush, callback) {
    chunk = input(chunk);
    if (typeof callback === 'function') { this._run(chunk, flush, callback); return; }
    const output = []; let total = 0, offset = 0, first = true;
    try {
      for (;;) {
        const capacity = Math.min(this._chunkSize, this._maxOutputLength - total + 1);
        const result = decode(call('process', [this._handle, first ? backing(chunk) : undefined, flush, capacity]), this._kind);
        first = false;
        offset += result.consumed; this.bytesWritten += result.consumed;
        if (result.output.length) { total += result.output.length; if (total > this._maxOutputLength) throw error('ERR_BUFFER_TOO_LARGE', `Cannot create a Buffer larger than ${this._maxOutputLength} bytes`, RangeError); output.push(result.output); }
        if (result.finished && !result.again && offset < chunk.length && this._rejectGarbageAfterEnd) throw codecError(-3000, this._kind);
        if (!result.again && (result.finished || offset === chunk.length)) break;
      }
      return Buffer.concat(output, total);
    } finally { this._release(); }
  }
  flush(kind, callback) {
    if (typeof kind === 'function') { callback = kind; kind = this._defaultFullFlushFlag; }
    if (kind === undefined) kind = this._defaultFullFlushFlag;
    kind = integer(kind, 'kind', 0, this._kind <= 7 ? 5 : this._kind <= 9 ? 3 : 2);
    if (callback !== undefined && typeof callback !== 'function') throw error('ERR_INVALID_ARG_TYPE', 'The "callback" argument must be a function', TypeError);
    if (this.writableFinished) { if (callback) process.nextTick(callback); return; }
    if (this.writableEnded) { if (callback) this.once('end', callback); return; }
    const marker = Buffer.alloc(0); marker[kCommand] = { flush: kind }; this.write(marker, callback);
  }
  params(level, strategy, callback) {
    if (!(this._kind === 1 || this._kind === 3 || this._kind === 5)) throw error('ERR_INVALID_STATE', 'params() is only available for zlib compression streams');
    level = integer(level, 'level', -1, 9); strategy = integer(strategy, 'strategy', 0, 4);
    if (typeof callback !== 'function') throw error('ERR_INVALID_ARG_TYPE', 'The "callback" argument must be a function', TypeError);
    // A queued marker orders the parameter transition behind preceding writes.
    const marker = Buffer.alloc(0); marker[kCommand] = { type: 'params', level, strategy }; this.write(marker, callback);
  }
  reset() {
    if (this._handle === null) throw error('ERR_INVALID_STATE', 'Cannot reset a closed compression stream');
    if (this._activeCompression || this.writableLength) throw error('ERR_INVALID_STATE', 'Cannot reset a compression stream with pending writes');
    decode(call('reset', [this._handle]), this._kind);
  }
  close(callback) {
    if (callback !== undefined && typeof callback !== 'function') throw error('ERR_INVALID_ARG_TYPE', 'The "callback" argument must be a function', TypeError);
    if (callback) { if (this.closed) process.nextTick(callback); else this.once('close', callback); }
    this.destroy();
  }
  _release() { if (this._handle !== null) { const id = this._handle; this._handle = null; call('close', [id]); } }
  _destroy(err, callback) {
    this._resumeCompression = null; this._release();
    // A worker retains its codec until completion. It never retains a JS view.
    if (this._completion) this._completion();
    callback(err);
  }
}
const kinds = { Deflate: 1, Inflate: 2, Gzip: 3, Gunzip: 4, DeflateRaw: 5, InflateRaw: 6, Unzip: 7, BrotliCompress: 8, BrotliDecompress: 9, ZstdCompress: 10, ZstdDecompress: 11 };
const api = { constants, codes };
for (const [name, kind] of Object.entries(kinds)) {
  const Constructor = function(options) { return Reflect.construct(Codec, [options, kind], new.target || Constructor); };
  Object.defineProperty(Constructor, 'name', { value: name }); Object.setPrototypeOf(Constructor, Codec);
  Constructor.prototype = Object.create(Codec.prototype, { constructor: { value: Constructor, configurable: true, writable: true } });
  api[name] = Constructor; api['create' + name] = options => new Constructor(options);
  const lower = name[0].toLowerCase() + name.slice(1);
  api[lower + 'Sync'] = (buffer, options) => {
    buffer = input(buffer); const engine = new Constructor(options); const result = engine._processChunk(buffer, engine._finishFlushFlag);
    return engine._info ? { buffer: result, engine } : result;
  };
  api[lower] = (buffer, options, callback) => {
    if (typeof options === 'function') { callback = options; options = undefined; }
    if (typeof callback !== 'function') throw error('ERR_INVALID_ARG_TYPE', 'The "callback" argument must be a function', TypeError);
    buffer = input(buffer); const engine = new Constructor(options); const chunks = []; let length = 0, called = false;
    engine._convenience = true;
    const done = (err, result) => { if (called) return; called = true; callback(err, result); };
    engine.on('error', err => done(err));
    engine.on('data', chunk => { length += chunk.length; if (length > engine._maxOutputLength) { engine.destroy(error('ERR_BUFFER_TOO_LARGE', `Cannot create a Buffer larger than ${engine._maxOutputLength} bytes`, RangeError)); return; } chunks.push(chunk); });
    engine.on('end', () => { const result = Buffer.concat(chunks, length); done(null, engine._info ? { buffer: result, engine } : result); });
    engine.end(buffer);
  };
}
api.crc32 = (data, value = 0) => {
  if (typeof data !== 'string' && !ArrayBuffer.isView(data)) throw error('ERR_INVALID_ARG_TYPE', 'The "data" argument must be a string, Buffer, TypedArray, or DataView', TypeError);
  data = input(data, 'data'); value = integer(value, 'value', 0, 0xffffffff); return call('crc32', [backing(data), value]);
};
for (const [name, value] of Object.entries(constants)) if (!name.startsWith('BROTLI')) Object.defineProperty(api, name, { value });
Object.defineProperties(api, {
  constants: { value: constants, enumerable: true, writable: false, configurable: false },
  codes: { value: codes, enumerable: true, writable: false, configurable: false }
});
module.exports = api;
