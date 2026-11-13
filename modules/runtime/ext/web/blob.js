'use strict';

// Encoding and streams load on first use; URL (and so startup) requires this module.
const TextDecoder = function(...args) { return new (require('internal/encoding').TextDecoder)(...args); };
const ReadableStream = function(...args) { return new (require('internal/web/streams').ReadableStream)(...args); };
let encoderInstance;
const encoder = { encode: text => (encoderInstance ||= new (require('internal/encoding').TextEncoder)()).encode(text) };
const blobs = new WeakMap();
const files = new WeakMap();
const objectURLs = new Map();

function string(value) {
  if (typeof value === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
  return String(value);
}
function scalarString(value) {
  const text = string(value);
  return text.toWellFormed ? text.toWellFormed() : new TextDecoder().decode(encoder.encode(text));
}
function optionsObject(options) {
  if (options == null) return {};
  require('internal/validators').validateDictionary(options, 'options');
  return options;
}
function normalizeType(value = '') {
  const type = string(value);
  return /[^\x20-\x7e]/.test(type) ? '' : type.toLowerCase();
}
function state(blob) {
  const value = blobs.get(blob);
  if (!value) throw new (require('internal/errors').codes.ERR_INVALID_THIS)('Blob');
  return value;
}
function integer(value) {
  const number = +value;
  return Number.isNaN(number) ? 0 : Math.trunc(number);
}
// Only active readers own descriptors. The immutable backing descriptor is safe
// to share between slices and workers; it never contains a native pointer.
const fileReaders = new FinalizationRegistry(fd => {
  try { require('fs').closeSync(fd); } catch (_) {}
});
const kInspect = Symbol.for('nodejs.util.inspect.custom');
const inspectValue = (value, options) => require('internal/util/inspect').inspect(value, options);

class BlobReader {
  constructor(record) { this.parts = record.parts; this.index = 0; this.offset = 0; this.fd = -1; }
  close() {
    if (this.fd !== -1) {
      const fd = this.fd;
      this.fd = -1;
      fileReaders.unregister(this);
      require('fs').closeSync(fd);
    }
  }
  // What is left of the part the next read starts in, past any empty parts.
  partRemaining() {
    while (this.index < this.parts.length && this.parts[this.index].byteLength === this.offset) { this.index++; this.offset = 0; }
    return this.index < this.parts.length ? this.parts[this.index].byteLength - this.offset : 0;
  }
  read(target) {
    let written = 0;
    try {
      while (this.index < this.parts.length) {
        const part = this.parts[this.index];
        const count = Math.min(part.byteLength - this.offset, target.byteLength - written);
        if (part.file) {
          const fs = require('fs');
          if (this.fd === -1) {
            const fd = fs.openSync(part.file.path, 'r');
            try { fileReaders.register(this, fd, this); this.fd = fd; }
            catch (error) { fs.closeSync(fd); throw error; }
          }
          const stat = fs.fstatSync(this.fd, { bigint: true });
          if (Number(stat.size) !== part.file.size ||
              stat.mtimeNs % 1000000000n !== part.file.mtimeNs % 1000000000n) throw new Error('File changed');
          let read = 0;
          while (read < count) {
            const n = fs.readSync(this.fd, target, written + read, count - read, part.offset + this.offset + read);
            if (n === 0) throw new Error('Unexpected end of file');
            read += n;
          }
        } else if (count) {
          target.set(part.subarray(this.offset, this.offset + count), written);
        }
        written += count;
        this.offset += count;
        if (this.offset === part.byteLength) { this.close(); this.index++; this.offset = 0; }
        if (written === target.byteLength && this.index < this.parts.length && this.parts[this.index].byteLength) break;
      }
      return written;
    } catch (_) {
      try { this.close(); } catch (_) {}
      const { DOMException } = require('internal/path_events/event_target');
      throw new DOMException('The blob could not be read', 'NotReadableError');
    }
  }
}
function copyBytes(record) {
  const result = new Uint8Array(record.size);
  const reader = new BlobReader(record);
  try { reader.read(result); }
  finally { reader.close(); }
  return result;
}

// Node's sourcesConverter: sequence<(BlobPart)>, each part kept as bytes, a blob or text.
function blobPart(part) {
  if (blobs.has(part)) return { blob: state(part) };
  if (part instanceof ArrayBuffer || (typeof SharedArrayBuffer === 'function' && part instanceof SharedArrayBuffer)) {
    return { bytes: new Uint8Array(new Uint8Array(part)) };
  }
  if (ArrayBuffer.isView(part)) return { bytes: new Uint8Array(new Uint8Array(part.buffer, part.byteOffset, part.byteLength)) };
  return { text: scalarString(part) };
}
let blobPartsConverter;

class Blob {
  constructor(blobParts = [], options = {}) {
    // Web IDL converts the sequence before the options dictionary.
    blobPartsConverter ??= require('internal/webidl').createSequenceConverter(blobPart);
    const values = blobPartsConverter(blobParts);
    options = optionsObject(options);
    const endings = options.endings === undefined ? 'transparent' : string(options.endings);
    if (endings !== 'transparent' && endings !== 'native') throw new (require('internal/errors').codes.ERR_INVALID_ARG_VALUE)('options.endings', endings);
    const type = normalizeType(options.type);
    const parts = [];
    let size = 0;
    for (const value of values) {
      if (value.blob) {
        parts.push(...value.blob.parts);
        size += value.blob.size;
        continue;
      }
      let bytes = value.bytes;
      if (!bytes) {
        let text = value.text;
        if (endings === 'native') {
          const newline = typeof process !== 'undefined' && process.platform === 'win32' ? '\r\n' : '\n';
          text = text.replace(/\r\n|\r|\n/g, newline);
        }
        bytes = encoder.encode(text);
      }
      if (bytes.byteLength) parts.push(bytes);
      size += bytes.byteLength;
    }
    blobs.set(this, { parts, size, type });
  }
  get size() { return state(this).size; }
  get type() { return state(this).type; }
  // Node's lib/internal/blob.js [kInspect].
  [kInspect](depth, options) {
    // Node returns the Blob, which util.inspect shows as [Blob] past the depth:
    // its internal slots are symbol keys there, held in a WeakMap here.
    if (depth < 0)
      return options.stylize('[Blob]', 'special');

    const opts = {
      ...options,
      depth: options.depth == null ? null : options.depth - 1,
    };

    return `Blob ${inspectValue({
      size: this.size,
      type: this.type,
    }, opts)}`;
  }
  slice(start = 0, end = undefined, contentType = '') {
    const source = state(this);
    // Node's slice: Web IDL long long conversions, clamped.
    const { converters } = require('internal/webidl');
    start = converters['long long'](start, { __proto__: null, context: 'start', clamp: true });
    end = end === undefined ? source.size : converters['long long'](end, { __proto__: null, context: 'end', clamp: true });
    const first = start < 0 ? Math.max(source.size + start, 0) : Math.min(start, source.size);
    const last = end < 0 ? Math.max(source.size + end, 0) : Math.min(end, source.size);
    const size = Math.max(last - first, 0);
    const parts = [];
    let offset = 0;
    for (const part of source.parts) {
      const next = offset + part.byteLength;
      if (next > first && offset < last) {
        const begin = Math.max(first - offset, 0);
        const end = Math.min(last - offset, part.byteLength);
        parts.push(part.file ? { file: part.file, offset: part.offset + begin, byteLength: end - begin } : part.subarray(begin, end));
      }
      offset = next;
      if (offset >= last) break;
    }
    const result = new Blob();
    blobs.set(result, { parts, size, type: normalizeType(contentType) });
    return result;
  }
  async arrayBuffer() { return copyBytes(state(this)).buffer; }
  async bytes() { return copyBytes(state(this)); }
  async text() {
    return new TextDecoder().decode(copyBytes(state(this)));
  }
  // The blob's text as it decodes, chunk by chunk.
  textStream() {
    return blobStream(state(this)).pipeThrough(new (require('internal/webstreams/encoding').TextDecoderStream)());
  }
  stream() {
    return blobStream(state(this));
  }
}
// The bytes of a blob, as a byte stream that reads them as it is pulled.
function blobStream(source) {
  const reader = new BlobReader(source);
  let remaining = source.size;
  return new ReadableStream({
    type: 'bytes',
    // As Node's blob reader stream: each pull enqueues the next part (at most 64 KiB of
    // it), which also fills a BYOB reader's view.
    pull(controller) {
      if (remaining === 0) {
        reader.read(new Uint8Array(0));
        reader.close();
        controller.close();
        controller.byobRequest?.respond(0);
        return;
      }
      const chunk = new Uint8Array(Math.min(65536, reader.partRemaining()));
      remaining -= reader.read(chunk);
      controller.enqueue(chunk);
      if (remaining === 0) { reader.close(); controller.close(); }
    },
    cancel() { reader.close(); },
  });
}

class File extends Blob {
  constructor(fileBits, fileName, options = {}) {
    if (arguments.length < 2) throw new TypeError('File requires two arguments');
    const name = scalarString(fileName);
    options = optionsObject(options);
    super(fileBits, options);
    // The dictionary member is read once, as Web IDL converts it.
    const lastModifiedOption = options.lastModified;
    const lastModified = lastModifiedOption === undefined ? Date.now() : integer(lastModifiedOption);
    // Web IDL signed long long conversion.
    const finite = Number.isFinite(lastModified) ? lastModified : 0;
    const wrapped = ((finite % 18446744073709551616) + 18446744073709551616) % 18446744073709551616;
    files.set(this, { name, lastModified: finite >= -9223372036854775808 && finite < 9223372036854775808 ? finite : wrapped >= 9223372036854775808 ? wrapped - 18446744073709551616 : wrapped });
  }
  get name() {
    const file = files.get(this);
    if (!file) throw new TypeError('Invalid File receiver');
    return file.name;
  }
  get lastModified() {
    const file = files.get(this);
    if (!file) throw new TypeError('Invalid File receiver');
    return file.lastModified;
  }
  // Node's lib/internal/file.js [kInspect].
  [kInspect](depth, options) {
    if (depth < 0) {
      return options.stylize('[File]', 'special');
    }

    const opts = {
      ...options,
      depth: options.depth == null ? null : options.depth - 1,
    };

    return `File ${inspectValue({
      size: this.size,
      type: this.type,
      name: this.name,
      lastModified: this.lastModified,
    }, opts)}`;
  }
}
for (const Constructor of [Blob, File]) {
  Object.defineProperty(Constructor.prototype, Symbol.toStringTag, { value: Constructor.name, configurable: true });
  for (const key of Object.getOwnPropertyNames(Constructor.prototype)) {
    if (key !== 'constructor') Object.defineProperty(Constructor.prototype, key, { enumerable: true });
  }
}
function createObjectURL(blob) {
  if (!blobs.has(blob)) {
    const { ERR_INVALID_ARG_TYPE } = require('internal/errors').codes;
    throw new ERR_INVALID_ARG_TYPE('obj', 'Blob', blob);
  }
  const id = 'blob:nodedata:' + require('crypto').randomUUID();
  objectURLs.set(id, blob);
  return id;
}
function revokeObjectURL(url) { objectURLs.delete(string(url)); }
function resolveObjectURL(url) { return objectURLs.get(string(url)); }
module.exports = { Blob, File, createObjectURL, revokeObjectURL, resolveObjectURL };
// Memory snapshots and lazy file descriptors for the structured-clone codec.
// No filesystem read or descriptor ownership crosses the clone boundary.
Object.defineProperty(module.exports, '_cloneData', { value(value) {
  const record = blobs.get(value);
  if (!record) return undefined;
  if (record.uncloneable) {
    const error = new TypeError('Invalid state: File-backed Blobs are not cloneable');
    error.code = 'ERR_INVALID_STATE';
    throw error;
  }
  const file = files.get(value);
  const metadata = { type: record.type, name: file?.name, lastModified: file?.lastModified };
  if (record.parts.some(part => part.file)) {
    return { ...metadata, parts: record.parts.map(part => part.file
      ? { file: { ...part.file }, offset: part.offset, byteLength: part.byteLength }
      : { bytes: new Uint8Array(part) }) };
  }
  return { ...metadata, bytes: copyBytes(record) };
} });
Object.defineProperty(module.exports, '_fromFile', { value(path, stat, type) {
  const result = new Blob();
  const size = Number(stat.size);
  const file = { path, size, mtimeNs: stat.mtimeNs };
  blobs.set(result, { parts: [{ file, offset: 0, byteLength: size }], size, type, uncloneable: true });
  return result;
} });
Object.defineProperty(module.exports, '_fromCloneData', { value(data) {
  const result = data.name === undefined ? new Blob() : new File([], data.name, { lastModified: data.lastModified });
  const parts = data.parts.map(part => part.file
    ? { file: { ...part.file }, offset: part.offset, byteLength: part.byteLength }
    : new Uint8Array(part.bytes));
  const size = parts.reduce((sum, part) => sum + part.byteLength, 0);
  blobs.set(result, { parts, size, type: data.type });
  return result;
} });
// The bytes of a Blob held in memory, without a copy when it has one part; undefined for a
// Blob read from a file. Callers must not change them.
Object.defineProperty(module.exports, '_memoryBytes', { value(value) {
  const record = blobs.get(value);
  if (!record) return undefined;
  const parts = record.parts;
  if (parts.length === 0) return new Uint8Array(0);
  if (parts.length === 1) return parts[0].file ? undefined : parts[0];
  if (parts.some(part => part.file)) return undefined;
  return copyBytes(record);
} });
