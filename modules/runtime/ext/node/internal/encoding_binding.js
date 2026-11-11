'use strict';

// internalBinding('encoding_binding') (Node.js v24.22.1 src/encoding_binding.cc) and the
// getConverter/decode calls of internalBinding('icu') that lib/internal/encoding.js makes.
// UTF-8 goes through the runtime's native codec, the one Buffer uses: write (1) stops before
// a scalar that does not fit, read (3) replaces ill-formed sequences as WHATWG decoding does,
// and both turn lone surrogates into U+FFFD. The other encodings use the vendored WHATWG
// decoders (@kayahr/text-encoding) where Node uses ICU converters.

const { bufferCodec } = require('internal/host');
const { isUtf8 } = require('internal/buffer_binding');

const CONVERTER_FLAGS_FLUSH = 0x1;
const CONVERTER_FLAGS_FATAL = 0x2;
const CONVERTER_FLAGS_IGNORE_BOM = 0x4;

// Errors that Node's C++ throws carry a code but are not internal/errors NodeErrors.
function nativeError(code, message) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

const empty = new Uint8Array(0);
// A detached buffer reads as no bytes, as in Node.
function inputBytes(input) {
  if (ArrayBuffer.isView(input)) {
    return input.buffer.detached ? empty : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input?.detached === true) return empty;
  if (input instanceof ArrayBuffer ||
      (typeof SharedArrayBuffer === 'function' && input instanceof SharedArrayBuffer)) {
    return new Uint8Array(input);
  }
  throw nativeError('ERR_INVALID_ARG_TYPE',
                    'The "list" argument must be an instance of SharedArrayBuffer, ArrayBuffer or ArrayBufferView.');
}

function invalidData(encoding) {
  return nativeError('ERR_ENCODING_INVALID_ENCODED_DATA', `The encoded data was not valid for encoding ${encoding}`);
}

function encodeUtf8String(input) {
  const bytes = new Uint8Array(bufferCodec(0, input));
  if (bytes.length !== 0) bufferCodec(1, input, bytes, 0, bytes.length);
  return bytes;
}

// The UTF-16 units of source whose UTF-8 form is its first written bytes.
function unitsWritten(source, written) {
  let read = 0;
  for (let bytes = 0; read < source.length;) {
    const unit = source.charCodeAt(read);
    let size = 3, units = 1;
    if (unit < 0x80) size = 1;
    else if (unit < 0x800) size = 2;
    else if (unit <= 0xdbff && unit >= 0xd800 && read + 1 < source.length) {
      const low = source.charCodeAt(read + 1);
      if (low >= 0xdc00 && low <= 0xdfff) { size = 4; units = 2; }
    }
    if (bytes + size > written) break;
    bytes += size; read += units;
  }
  return read;
}

const encodeIntoResults = new Uint32Array(2);
function encodeInto(source, dest) {
  const capacity = dest.length;
  let read = 0, written = 0;
  if (capacity !== 0 && source.length !== 0) {
    written = bufferCodec(1, source, dest, 0, capacity);
    read = source.length * 3 <= capacity || bufferCodec(0, source) === written ?
      source.length : unitsWritten(source, written);
  }
  encodeIntoResults[0] = read;
  encodeIntoResults[1] = written;
}

function decodeUTF8(input, ignoreBOM, fatal) {
  const bytes = inputBytes(input);
  if (fatal && !isUtf8(bytes)) throw invalidData('utf-8');
  const start = !ignoreBOM && bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  return bufferCodec(3, bytes, start, bytes.length);
}

let Decoder;
function getConverter(encoding, flags) {
  if (Decoder === undefined) {
    require('internal/web/vendor/text-encoding/lib/main/encodings');
    ({ TextDecoder: Decoder } = require('internal/web/vendor/text-encoding/lib/main/TextDecoder'));
  }
  try {
    return new Decoder(encoding, {
      fatal: (flags & CONVERTER_FLAGS_FATAL) !== 0,
      ignoreBOM: (flags & CONVERTER_FLAGS_IGNORE_BOM) !== 0,
    });
  } catch (error) {
    if (error instanceof RangeError) return undefined;
    throw error;
  }
}

function decode(converter, input, flags, encoding) {
  const bytes = inputBytes(input);
  try {
    return converter.decode(bytes, { stream: (flags & CONVERTER_FLAGS_FLUSH) === 0 });
  } catch (error) {
    // The decoder's fatal error mode reports malformed input as a TypeError.
    if (converter.fatal && error instanceof TypeError) throw invalidData(encoding);
    throw error;
  }
}

module.exports = {
  encodeInto,
  encodeIntoResults,
  encodeUtf8String,
  decodeUTF8,
  icu: { getConverter, decode },
};
