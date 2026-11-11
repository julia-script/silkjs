'use strict';

const host = require('internal/host');
const { Buffer } = require('buffer');
const { AsyncResource } = require('async_hooks');
const constants = require('internal/compression/constants');
const codes = Object.create(null);
for (const name of ['Z_OK', 'Z_STREAM_END', 'Z_NEED_DICT', 'Z_ERRNO', 'Z_STREAM_ERROR', 'Z_DATA_ERROR', 'Z_MEM_ERROR', 'Z_BUF_ERROR', 'Z_VERSION_ERROR']) {
  codes[name] = constants[name]; codes[constants[name]] = name;
}
Object.freeze(codes);
function error(code, message, Constructor = Error) { const e = new Constructor(message); e.code = code; return e; }
function codecError(status, kind) {
  let code = codes[status], message;
  if (status === -3000) {
    return error('ERR_TRAILING_JUNK_AFTER_STREAM_END', 'Trailing junk found after the end of the compressed stream', TypeError);
  } else if (status === -3001) {
    code = 'Z_NEED_DICT'; message = 'Bad dictionary'; status = 2;
  } else if (status <= -2000) {
    const number = -2000 - status;
    for (const key of Object.keys(constants)) if (key.startsWith('ZSTD_error_') && constants[key] === number) { code = key; break; }
    code = code || 'ZSTD_error_GENERIC'; message = code; status = number;
  } else if (status <= -1000) {
    status += 1000;
    for (const key of Object.keys(constants)) if (key.startsWith('BROTLI_DECODER_ERROR_') && constants[key] === status) { code = 'ERR_' + key.slice('BROTLI_DECODER'.length); break; }
    code = code || 'ERR_BROTLI_DECOMPRESSION_FAILED'; message = 'Decompression failed';
  } else {
    code = code || (kind >= 10 ? 'ERR_ZSTD_COMPRESSION_FAILED' : kind >= 8 ? 'ERR_BROTLI_COMPRESSION_FAILED' : 'Z_STREAM_ERROR');
    message = status === -5 ? 'unexpected end of file' : status === 2 ? 'Missing dictionary' : status === -3 ? 'incorrect header check or corrupted compressed data' : status === -4 ? 'Insufficient memory' : 'Compression operation failed';
  }
  const e = error(code, message); e.errno = status; return e;
}
function decode(value, kind) {
  const view = new DataView(value); const status = view.getInt32(0, true);
  if (status) throw codecError(status, kind);
  return { consumed: view.getUint32(4, true), output: Buffer.from(value, 20, view.getUint32(8, true)), finished: !!view.getInt32(12, true), again: !!view.getInt32(16, true) };
}
function call(op, args) { return host.compression(op, args); }
function asyncCall(op, args, callback) {
  const resource = new AsyncResource('ZLIB');
  try {
    host.compressionAsync(op, args, (err, value) => {
      host.invokeResource(resource, callback, undefined, [err, value]);
      host.checkpoint();
    });
  } catch (err) { resource.emitDestroy(); throw err; }
}
module.exports = { codes, codecError, decode, call, asyncCall };
