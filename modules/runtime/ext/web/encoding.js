'use strict';

// Encoding algorithms and tables: @kayahr/text-encoding 2.2.0 (MIT),
// mechanically converted to CommonJS under vendor/text-encoding.
require('internal/web/vendor/text-encoding/lib/main/encodings');
const { TextDecoder: Decoder } = require('internal/web/vendor/text-encoding/lib/main/TextDecoder');
const { TextEncoder: Encoder } = require('internal/web/vendor/text-encoding/lib/main/TextEncoder');
const encoder = new Encoder();
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

class TextEncoder {
  constructor() { encoders.add(this); }
  get encoding() {
    if (!encoders.has(this)) throw new TypeError('Invalid TextEncoder receiver');
    return 'utf-8';
  }
  encode(input = '') {
    if (!encoders.has(this)) throw new TypeError('Invalid TextEncoder receiver');
    return encoder.encode(domString(input));
  }
  encodeInto(source, destination) {
    if (!encoders.has(this)) throw new TypeError('Invalid TextEncoder receiver');
    if (arguments.length < 2) throw new TypeError('encodeInto requires two arguments');
    source = domString(source);
    if (!(destination instanceof Uint8Array)) throw new TypeError('destination must be a Uint8Array');
    return encoder.encodeInto(source, destination);
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
