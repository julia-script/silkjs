'use strict';

// Encoding algorithms and tables: @kayahr/text-encoding 2.2.0 (MIT),
// mechanically converted to CommonJS under vendor/text-encoding.
require('internal/web/vendor/text-encoding/lib/main/encodings');
const { TextDecoder: Decoder } = require('internal/web/vendor/text-encoding/lib/main/TextDecoder');
const { TextEncoder: Encoder } = require('internal/web/vendor/text-encoding/lib/main/TextEncoder');
const encoder = new Encoder();
// UTF-8 goes through the runtime's native codec, the one Buffer uses: write (1) stops
// before a scalar that does not fit, read (3) replaces ill-formed sequences as WHATWG
// decoding does, and both turn lone surrogates into U+FFFD.
const { bufferCodec } = require('internal/host');
const decoders = new WeakMap();
const encoders = new WeakSet();

function domString(value) {
  if (typeof value === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
  return String(value);
}
function dictionary(value) {
  if (value == null) return {};
  if (typeof value !== 'object' && typeof value !== 'function') throw new TypeError('Options must be an object');
  return value;
}
function decoderFor(value) {
  const decoder = decoders.get(value);
  if (!decoder) throw new TypeError('Value of this must be of type TextDecoder');
  return decoder;
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

class TextEncoder {
  constructor() { encoders.add(this); }
  get encoding() {
    if (!encoders.has(this)) throw new TypeError('Invalid TextEncoder receiver');
    return 'utf-8';
  }
  encode(input = '') {
    if (!encoders.has(this)) throw new TypeError('Invalid TextEncoder receiver');
    input = domString(input);
    const bytes = new Uint8Array(bufferCodec(0, input));
    if (bytes.length !== 0) bufferCodec(1, input, bytes, 0, bytes.length);
    return bytes;
  }
  encodeInto(source, destination) {
    if (!encoders.has(this)) throw new TypeError('Invalid TextEncoder receiver');
    if (arguments.length < 2) throw new TypeError('encodeInto requires two arguments');
    source = domString(source);
    if (!(destination instanceof Uint8Array)) throw new TypeError('destination must be a Uint8Array');
    const capacity = destination.length;
    if (capacity === 0 || source.length === 0) return { read: 0, written: 0 };
    const written = bufferCodec(1, source, destination, 0, capacity);
    if (source.length * 3 <= capacity || bufferCodec(0, source) === written) return { read: source.length, written };
    return { read: unitsWritten(source, written), written };
  }
}

class TextDecoder {
  constructor(label = 'utf-8', options = {}) {
    label = domString(label).replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');
    if (/[^\x21-\x7e]/.test(label)) throw new RangeError('Unsupported encoding: ' + label);
    options = dictionary(options);
    decoders.set(this, new Decoder(label, { fatal: Boolean(options.fatal), ignoreBOM: Boolean(options.ignoreBOM) }));
  }
  get encoding() { return decoderFor(this).encoding; }
  get fatal() { return decoderFor(this).fatal; }
  get ignoreBOM() { return decoderFor(this).ignoreBOM; }
  decode(input, options = {}) {
    const decoder = decoderFor(this);
    if (input !== undefined && !(input instanceof ArrayBuffer) && !ArrayBuffer.isView(input) &&
        !(typeof SharedArrayBuffer === 'function' && input instanceof SharedArrayBuffer)) {
      throw new TypeError('input must be an ArrayBuffer or ArrayBufferView');
    }
    const stream = Boolean(dictionary(options).stream);
    // A whole UTF-8 input with no stream pending: the native codec, BOM dropped unless kept.
    if (!stream && decoder.decoder == null && !decoder.fatal && decoder.encoding === 'utf-8') {
      if (input === undefined) return '';
      const bytes = input instanceof Uint8Array ? input : ArrayBuffer.isView(input)
        ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
      const start = !decoder.ignoreBOM && bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
      return bufferCodec(3, bytes, start, bytes.length);
    }
    return decoder.decode(input, { stream });
  }
}
for (const Constructor of [TextEncoder, TextDecoder]) {
  Object.defineProperty(Constructor.prototype, Symbol.toStringTag, { value: Constructor.name, configurable: true });
  for (const key of Object.getOwnPropertyNames(Constructor.prototype)) {
    if (key !== 'constructor') Object.defineProperty(Constructor.prototype, key, { enumerable: true });
  }
}
module.exports = { TextEncoder, TextDecoder };
