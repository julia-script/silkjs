'use strict';

// The imported iterable transforms use Node's bare-handle writeState contract.
// Adapt it to Silk's bounded native codec operations, retaining input in the
// native provider between output-buffer turns rather than copying its suffix.
const { Buffer } = require('buffer');
const { call, asyncCall, decode, codecError } = require('internal/compression/binding');

function backing(view) {
  if (view === undefined) return undefined;
  if (!ArrayBuffer.isView(view)) return view;
  return view.byteOffset === 0 && view.byteLength === view.buffer.byteLength
    ? view.buffer : view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}
function parameters(values) {
  let count = 0;
  for (let i = 0; i < values.length; i++) if (values[i] !== 0xffffffff) count++;
  const bytes = new ArrayBuffer(count * 8);
  const view = new DataView(bytes);
  let offset = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i] === 0xffffffff) continue;
    view.setInt32(offset, i, true);
    view.setUint32(offset + 4, values[i], true);
    offset += 8;
  }
  return bytes;
}
function validatePledge(value) {
  if (value === undefined) return;
  let error;
  if (typeof value !== 'number') {
    error = new TypeError('pledgedSrcSize must be a number');
    error.code = 'ERR_INVALID_ARG_TYPE';
  } else if (!Number.isSafeInteger(value)) {
    error = new RangeError('pledgedSrcSize must be a safe integer');
    error.code = 'ERR_OUT_OF_RANGE';
  } else if (value < 0) {
    error = new RangeError('pledgedSrcSize must be non-negative');
    error.code = 'ERR_OUT_OF_RANGE';
  }
  if (error) throw error;
}
class Handle {
  constructor(kind) {
    this.kind = kind;
    this.id = null;
    this.pending = false;
  }
  initialize(window, level, memory, strategy, dictionary, params, state, callback, pledge) {
    validatePledge(pledge);
    const id = call('create', [this.kind, window | 0, level | 0, memory | 0, strategy | 0,
      backing(dictionary), params]);
    if (id < 1) throw codecError(id, this.kind);
    this.id = id;
    this.state = state;
    this.callback = callback;
    if (this.kind === 10 && pledge !== undefined) {
      try { decode(call('pledge', [id, pledge]), this.kind); }
      catch (error) { this.close(); throw error; }
    }
  }
  close() {
    if (this.id === null) return;
    const id = this.id;
    this.id = null;
    call('close', [id]);
  }
  write(flush, input, inputOffset, inputLength, output, outputOffset, outputLength) {
    this.process(false, flush, input, inputOffset, inputLength, output, outputOffset, outputLength);
  }
  writeSync(flush, input, inputOffset, inputLength, output, outputOffset, outputLength) {
    this.process(true, flush, input, inputOffset, inputLength, output, outputOffset, outputLength);
  }
  process(sync, flush, input, inputOffset, inputLength, output, outputOffset, outputLength) {
    let consumed = 0;
    let written = 0;
    let data = this.pending ? undefined : backing(Buffer.from(input.buffer, input.byteOffset + inputOffset, inputLength));
    const accept = value => {
      const result = decode(value, this.kind);
      consumed += result.consumed;
      output.set(result.output, outputOffset + written);
      written += result.output.length;
      this.pending = result.again;
      this.state[0] = outputLength - written;
      this.state[1] = inputLength - consumed;
      // Concatenated frames can require another provider turn even when the
      // previous frame ended before filling the caller's output buffer.
      return result.again && written < outputLength;
    };
    const failed = error => this.onerror(error.message, error.errno, error.code);
    if (sync) {
      try {
        do {
          const value = call('process', [this.id, data, flush, outputLength - written]);
          data = undefined;
          if (!accept(value)) break;
        } while (true);
      } catch (error) { failed(error); }
      return;
    }
    const step = () => {
      try {
        const args = [this.id, data, flush, outputLength - written];
        data = undefined;
        asyncCall('process', args, (error, value) => {
          if (this.id === null) return;
          if (error) { failed(error); return; }
          let again;
          try { again = accept(value); } catch (failure) { failed(failure); return; }
          if (again) step(); else this.callback();
        });
      } catch (error) { failed(error); }
    };
    step();
  }
}
class Zlib extends Handle {
  init(window, level, memory, strategy, state, callback, dictionary) {
    this.initialize(window, level, memory, strategy, dictionary, undefined, state, callback);
  }
}
class BrotliEncoder extends Handle {
  constructor() { super(8); }
  init(params, state, callback, dictionary) {
    this.initialize(0, 0, 0, 0, dictionary, parameters(params), state, callback);
  }
}
class BrotliDecoder extends BrotliEncoder {
  constructor() { super(); this.kind = 9; }
}
class ZstdCompress extends Handle {
  constructor() { super(10); }
  init(params, pledge, state, callback, dictionary) {
    this.initialize(0, 0, 0, 0, dictionary, parameters(params), state, callback, pledge);
  }
}
class ZstdDecompress extends ZstdCompress {
  constructor() { super(); this.kind = 11; }
}
module.exports = { Zlib, BrotliEncoder, BrotliDecoder, ZstdCompress, ZstdDecompress };
