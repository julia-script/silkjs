'use strict';

// V8 value wire format v15, not V8 execution or QuickJS binary objects.
// Protocol: deps/v8/src/objects/value-serializer.cc; Node host view indices:
// lib/v8.js and src/node_ipc_serdes.cc. IPC framing belongs to child_process.
// Shared by node:v8, workers and IPC: emits v15; reads v13-v15 (not legacy
// v13 buggy view flags). The convenience reader consumes one value and does
// not require EOF. Base classes support native views and explicit AB transfers;
// defaults copy only the visible bytes of each view, as Node does. Worker codecs
// opt into shared backing and host-object hooks; IPC never emits those extensions.
// Worker-specific native owners are handled by the worker host-object codec.
const { Buffer, Blob } = require('buffer');
const types = require('util/types');
const host = require('internal/host');
const apply = Reflect.apply;
const descriptor = Object.getOwnPropertyDescriptor;
const define = Object.defineProperty;
const own = Function.call.bind(Object.prototype.hasOwnProperty);
const keys = Object.keys;
const typedProto = Object.getPrototypeOf(Uint8Array.prototype);
const typedTag = descriptor(typedProto, Symbol.toStringTag).get;
const getter = (proto, key) => descriptor(proto, key).get;
const typedBuffer = getter(typedProto, 'buffer');
const typedOffset = getter(typedProto, 'byteOffset');
const typedLength = getter(typedProto, 'byteLength');
const dataBuffer = getter(DataView.prototype, 'buffer');
const dataOffset = getter(DataView.prototype, 'byteOffset');
const dataLength = getter(DataView.prototype, 'byteLength');
const bufferLength = getter(ArrayBuffer.prototype, 'byteLength');
const resizable = descriptor(ArrayBuffer.prototype, 'resizable');
const sharedLength = typeof SharedArrayBuffer === 'function' ? getter(SharedArrayBuffer.prototype, 'byteLength') : null;
const growable = typeof SharedArrayBuffer === 'function' ? descriptor(SharedArrayBuffer.prototype, 'growable') : null;
const blobSize = getter(Blob.prototype, 'size');
const maximum = descriptor(ArrayBuffer.prototype, 'maxByteLength');
const dateTime = Date.prototype.getTime;
const regexpSource = getter(RegExp.prototype, 'source');
const flagNames = ['global', 'ignoreCase', 'multiline', 'sticky', 'unicode', 'dotAll', null, 'hasIndices', 'unicodeSets'];
const flagLetters = ['g', 'i', 'm', 'y', 'u', 's', '', 'd', 'v'];
const flagGetters = flagNames.map(name => name && descriptor(RegExp.prototype, name));
const constructors = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
  Int32Array, Uint32Array, Float32Array, Float64Array, DataView, Buffer,
  BigInt64Array, BigUint64Array, globalThis.Float16Array];
const viewNames = ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'DataView', 'Buffer',
  'BigInt64Array', 'BigUint64Array', 'Float16Array'];
const viewTags = [98, 66, 67, 119, 87, 100, 68, 102, 70, 63, 66, 113, 81, 104];
const errorConstructors = { E: EvalError, R: RangeError, F: ReferenceError, S: SyntaxError, T: TypeError, U: URIError };
const errorTags = { EvalError: 'E', RangeError: 'R', ReferenceError: 'F', SyntaxError: 'S', TypeError: 'T', URIError: 'U' };
const nativeLittleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const UNRESOLVED = Symbol('unresolved wire object');

function isHostObject(value) {
  if (types.isKeyObject(value) || types.isCryptoKey(value) || host.types.isX509Certificate?.(value)) return true;
  if (host.types.isStorage?.(value) || host.types.isEventSource?.(value) || host.types.isStreamBindingObject?.(value)) return true;
  try { apply(blobSize, value, []); return true; } catch { return false; }
}

function invalid() { throw new Error('Unable to deserialize cloned data.'); }
function publicRead(deserializer, read, name) {
  const offset = deserializer._offset;
  try { return apply(read, deserializer, []); } catch {
    deserializer._offset = offset;
    throw new Error(`${name}() failed`);
  }
}
function uint32(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError('Expected a uint32');
  return value;
}
function dataProperty(object, key, value, enumerable = true) {
  define(object, key, { value, writable: true, configurable: true, enumerable });
}
function isResizable(buffer) {
  const property = types.isSharedArrayBuffer(buffer) ? growable : resizable;
  return !!property && apply(property.get, buffer, []);
}
function stringValue(value) {
  if (typeof value === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
  return String(value);
}
function viewInfo(value) {
  const name = apply(typedTag, value, []);
  const data = name === undefined;
  const index = data ? 9 : viewNames.indexOf(name);
  if (index < 0) throw new Error('Unsupported ArrayBufferView');
  // Intrinsic getters cannot be redirected by own properties or @@toStringTag.
  const buffer = apply(data ? dataBuffer : typedBuffer, value, []);
  const offset = apply(data ? dataOffset : typedOffset, value, []);
  const length = apply(data ? dataLength : typedLength, value, []);
  // TypedArray#values validates detached and out-of-bounds views without a read.
  if (!data) apply(typedProto.values, value, []);
  return { index, buffer, offset, length };
}

// V8's Object::NoSideEffectsToString for the values a serializer rejects: no
// getter, trap or toString of the value runs.
function describeValue(value) {
  switch (typeof value) {
    case 'function': return Function.prototype.toString.call(value);
    case 'symbol': return Symbol.prototype.toString.call(value);
    case 'object': break;
    default: return String(value);
  }
  if (value === null) return 'null';
  if (types.isProxy(value)) return '#<Object>';
  let name = 'Object';
  for (let object = value; object !== null; object = Reflect.getPrototypeOf(object)) {
    if (types.isProxy(object)) break;
    const descriptor = Reflect.getOwnPropertyDescriptor(object, 'constructor');
    if (descriptor !== undefined && typeof descriptor.value === 'function') {
      const own = Reflect.getOwnPropertyDescriptor(descriptor.value, 'name');
      if (own !== undefined && typeof own.value === 'string' && own.value !== '') name = own.value;
      break;
    }
  }
  return `#<${name}>`;
}

// As the serdes binding's FunctionTemplates: a call without `new` is Node's
// ERR_CONSTRUCT_CALL_REQUIRED, while subclasses construct through it as usual.
function constructCallRequired(Class) {
  const name = Class.name;
  const constructor = { [name]: function(...args) {
    if (new.target === undefined) {
      const error = new TypeError(`Class constructor ${name} cannot be invoked without 'new'`);
      error.code = 'ERR_CONSTRUCT_CALL_REQUIRED';
      throw error;
    }
    return Reflect.construct(Class, args, new.target);
  } }[name];
  define(constructor, 'length', { __proto__: null, value: Class.length, configurable: true });
  define(constructor, 'prototype', { __proto__: null, value: Class.prototype, writable: false });
  define(Class.prototype, 'constructor', { __proto__: null, value: constructor, writable: true, configurable: true, enumerable: false });
  return constructor;
}

const Serializer = constructCallRequired(class Serializer {
  constructor() {
    this._buffer = Buffer.allocUnsafe(256);
    this._length = 0;
    this._objects = new Map();
    this._viewsAsHost = false;
    this._transfers = new Map();
  }
  // V8's kDataCloneError: "%s could not be cloned." over the value's NoSideEffectsToString.
  _fail(value) { throw new this._getDataCloneError(`${describeValue(value)} could not be cloned.`); }
  _reserve(length) {
    const needed = this._length + length;
    if (!Number.isSafeInteger(needed) || needed > 0xffffffff) throw new RangeError('Serialized data is too large');
    if (needed <= this._buffer.length) return;
    const buffer = Buffer.allocUnsafe(Math.max(needed, Math.min(0xffffffff, this._buffer.length * 2)));
    buffer.set(this._buffer.subarray(0, this._length));
    this._buffer = buffer;
  }
  _byte(value) { this._reserve(1); this._buffer[this._length++] = value; }
  _tag(value) { this._byte(value.charCodeAt(0)); }
  writeHeader() { this._byte(255); this.writeUint32(15); }
  writeUint32(value) {
    value = uint32(value);
    do { const byte = value & 127; value = Math.floor(value / 128); this._byte(byte | (value ? 128 : 0)); } while (value);
  }
  writeUint64(high, low) {
    let value = (BigInt(uint32(high)) << 32n) | BigInt(uint32(low));
    do { const byte = Number(value & 127n); value >>= 7n; this._byte(byte | (value ? 128 : 0)); } while (value);
  }
  writeDouble(value) {
    this._reserve(8);
    new DataView(this._buffer.buffer, this._buffer.byteOffset + this._length, 8).setFloat64(0, value, nativeLittleEndian);
    this._length += 8;
  }
  writeRawBytes(value) {
    if (!ArrayBuffer.isView(value)) throw new TypeError('source must be a TypedArray or a DataView');
    const info = viewInfo(value);
    this._reserve(info.length);
    this._buffer.set(new Uint8Array(info.buffer, info.offset, info.length), this._length);
    this._length += info.length;
  }
  releaseBuffer() {
    const result = this._buffer.subarray(0, this._length);
    this._buffer = Buffer.allocUnsafe(256);
    this._length = 0;
    return result;
  }
  _setTreatArrayBufferViewsAsHostObjects(value) { this._viewsAsHost = !!value; }
  transferArrayBuffer(id, value) {
    if (!types.isArrayBuffer(value)) throw new TypeError('Expected an ArrayBuffer');
    this._transfers.set(value, uint32(id));
  }
  _writeHostObject(value) { this._fail(value); }
  _writeViewExtents(info) { this.writeUint32(info.offset); this.writeUint32(info.length); }
  _getSharedArrayBufferId(value) { this._fail(value); }
  _string(value) {
    let oneByte = true;
    for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) > 255) { oneByte = false; break; }
    const size = value.length * (oneByte ? 1 : 2);
    uint32(size);
    if (!oneByte) {
      let varintSize = 1;
      for (let n = size; n >= 128; n = Math.floor(n / 128)) varintSize++;
      if ((this._length + 1 + varintSize) & 1) this._byte(0);
    }
    this._tag(oneByte ? '"' : 'c');
    this.writeUint32(size);
    this._reserve(size);
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (oneByte) this._buffer[this._length++] = code;
      else {
        this._buffer[this._length++] = nativeLittleEndian ? code & 255 : code >>> 8;
        this._buffer[this._length++] = nativeLittleEndian ? code >>> 8 : code & 255;
      }
    }
  }
  _bigint(value) {
    const negative = value < 0n;
    let digits = (negative ? -value : value).toString(16);
    const size = value === 0n ? 0 : Math.ceil(digits.length / 16) * 8;
    this.writeUint32(size * 2 + (negative ? 1 : 0));
    this._reserve(size);
    digits = digits.padStart(size * 2, '0');
    for (let i = size - 1; i >= 0; i--) this._buffer[this._length++] = parseInt(digits.slice(i * 2, i * 2 + 2), 16);
  }
  _properties(value, names) {
    let count = 0;
    for (const key of names) {
      if (!own(value, key)) continue;
      this._string(key);
      this.writeValue(value[key]);
      count++;
    }
    return count;
  }
  writeValue(value) { this._value(value); return true; }
  _value(value) {
    if (value === undefined) { this._tag('_'); return; }
    if (value === null) { this._tag('0'); return; }
    switch (typeof value) {
      case 'boolean': this._tag(value ? 'T' : 'F'); return;
      case 'string': this._string(value); return;
      case 'bigint': this._tag('Z'); this._bigint(value); return;
      case 'number':
        if (Number.isInteger(value) && !Object.is(value, -0) && value >= -2147483648 && value <= 2147483647) {
          this._tag('I'); this.writeUint32(((value << 1) ^ (value >> 31)) >>> 0);
        } else { this._tag('N'); this.writeDouble(value); }
        return;
      case 'object': break;
      default: this._fail(value);
    }
    if (types.isProxy(value)) this._fail(value);
    this._validateCloneValue?.(value);
    if (this._objects.has(value)) { this._tag('^'); this.writeUint32(this._objects.get(value)); return; }
    // V8 emits (and assigns an ID to) a native view's buffer before the view.
    if (ArrayBuffer.isView(value) && !this._viewsAsHost) {
      const info = viewInfo(value);
      const flags = host.getArrayBufferViewFlags(value);
      this._value(info.buffer);
      this._objects.set(value, this._objects.size);
      this._tag('V'); this.writeUint32(viewTags[info.index]);
      this._writeViewExtents(info); this.writeUint32(flags);
      return;
    }
    this._objects.set(value, this._objects.size);
    if (ArrayBuffer.isView(value)) { this._tag('\\'); this._writeHostObject(value); return; }
    // An interceptor object (process.env) is a V8 API object: a host object to V8's own
    // check, an ordinary object to a delegate that answers it (node_messaging.cc
    // IsHostObject asks only for BaseObjects), as structuredClone(process.env) is.
    if (this._isHostObject?.(value) || isHostObject(value) ||
        (this._isHostObject === undefined && host.isInterceptor(value))) { this._tag('\\'); this._writeHostObject(value); return; }
    if (Array.isArray(value)) {
      // Sparse encoding preserves holes and all enumerable own properties;
      // it is equally valid for packed arrays and avoids materializing holes.
      const length = value.length;
      this._tag('a'); this.writeUint32(length);
      const count = this._properties(value, keys(value));
      this._tag('@'); this.writeUint32(count); this.writeUint32(length); return;
    }
    if (types.isDate(value)) { this._tag('D'); this.writeDouble(apply(dateTime, value, [])); return; }
    if (types.isRegExp(value)) {
      this._tag('R'); this._string(apply(regexpSource, value, []));
      let flags = 0;
      for (let i = 0; i < flagGetters.length; i++) if (flagGetters[i] && apply(flagGetters[i].get, value, [])) flags |= 1 << i;
      this.writeUint32(flags); return;
    }
    if (types.isMap(value)) {
      const entries = Array.from(apply(Map.prototype.entries, value, []));
      this._tag(';');
      for (const [key, item] of entries) { this.writeValue(key); this.writeValue(item); }
      this._tag(':'); this.writeUint32(entries.length * 2); return;
    }
    if (types.isSet(value)) {
      const entries = Array.from(apply(Set.prototype.values, value, []));
      this._tag("'"); for (const item of entries) this.writeValue(item);
      this._tag(','); this.writeUint32(entries.length); return;
    }
    if (types.isArrayBuffer(value)) {
      if (this._transfers.has(value)) { this._tag('t'); this.writeUint32(this._transfers.get(value)); return; }
      const bytes = new Uint8Array(value); // Reject detached buffers.
      const resize = isResizable(value);
      this._tag(resize ? '~' : 'B'); this.writeUint32(bytes.length);
      if (resize) this.writeUint32(apply(maximum.get, value, []));
      this.writeRawBytes(bytes); return;
    }
    if (types.isSharedArrayBuffer(value)) {
      const id = this._getSharedArrayBufferId(value);
      this._tag('u'); this.writeUint32(id); return;
    }
    if (types.isBooleanObject(value)) { this._tag(apply(Boolean.prototype.valueOf, value, []) ? 'y' : 'x'); return; }
    if (types.isNumberObject(value)) { this._tag('n'); this.writeDouble(apply(Number.prototype.valueOf, value, [])); return; }
    if (types.isStringObject(value)) { this._tag('s'); this._string(apply(String.prototype.valueOf, value, [])); return; }
    if (types.isBigIntObject(value)) { this._tag('z'); this._bigint(apply(BigInt.prototype.valueOf, value, [])); return; }
    if (types.isNativeError(value)) {
      const message = descriptor(value, 'message');
      const cause = descriptor(value, 'cause');
      this._tag('r');
      const name = stringValue(value.name);
      if (own(errorTags, name)) this._tag(errorTags[name]);
      if (message && own(message, 'value')) { this._tag('m'); this._string(stringValue(message.value)); }
      const stack = value.stack;
      if (typeof stack === 'string') { this._tag('s'); this._string(stack); }
      if (cause && own(cause, 'value')) { this._tag('c'); this.writeValue(cause.value); }
      this._tag('.'); return;
    }
    // Class-ID classification excludes unsupported exotic engine objects;
    // prototypes and @@toStringTag are deliberately not used as brands.
    if (types.isSymbolObject(value) ||
        types.isWeakMap(value) || types.isWeakSet(value) || types.isPromise(value) ||
        (host.serializationInfo(value) !== 0 && !host.isInterceptor(value))) this._fail(value);
    this._tag('o'); const count = this._properties(value, keys(value));
    this._tag('{'); this.writeUint32(count);
  }
});
Serializer.prototype._getDataCloneError = Error;

const Deserializer = constructCallRequired(class Deserializer {
  constructor(bytes) {
    if (!ArrayBuffer.isView(bytes)) throw new TypeError('buffer must be a TypedArray or a DataView');
    const info = viewInfo(bytes);
    this.buffer = Buffer.from(info.buffer, info.offset, info.length);
    this._offset = 0;
    this._objects = [];
    this._transfers = new Map();
    this._version = 0;
  }
  _need(length) {
    if (!Number.isInteger(length) || length < 0 || length > this.buffer.length - this._offset) invalid();
  }
  _byte() { this._need(1); return this.buffer[this._offset++]; }
  _peek() {
    while (this._offset < this.buffer.length && this.buffer[this._offset] === 0) this._offset++;
    this._need(1); return this.buffer[this._offset];
  }
  _tag() { const tag = this._peek(); this._offset++; return tag; }
  _uint32() {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const byte = this._byte();
      if (i === 4 && byte > 15) invalid();
      value += (byte & 127) * 2 ** (i * 7);
      if (!(byte & 128)) return value;
    }
    invalid();
  }
  _uint64() {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      const byte = this._byte();
      if (i === 9 && byte > 1) invalid();
      value |= BigInt(byte & 127) << BigInt(i * 7);
      if (!(byte & 128)) return [Number(value >> 32n), Number(value & 0xffffffffn)];
    }
    invalid();
  }
  _double() {
    this._need(8);
    const value = new DataView(this.buffer.buffer, this.buffer.byteOffset + this._offset, 8).getFloat64(0, nativeLittleEndian);
    this._offset += 8; return value;
  }
  // node_serdes.cc: the public reads report their own failure (V8's own reads say
  // "Unable to deserialize cloned data.").
  readUint32() { return publicRead(this, this._uint32, 'ReadUint32'); }
  readUint64() { return publicRead(this, this._uint64, 'ReadUint64'); }
  readDouble() { return publicRead(this, this._double, 'ReadDouble'); }
  _readRawBytes(length) { this._need(length); const start = this._offset; this._offset += length; return start; }
  readRawBytes(length) { const start = this._readRawBytes(length); return this.buffer.subarray(start, start + length); }
  readHeader() {
    if (this._byte() !== 255) invalid();
    this._version = this._uint32();
    // Legacy pre-v13 host-object formats require an embedder-specific codec.
    if (this._version < 13 || this._version > 15) throw new Error('Unable to deserialize cloned data due to invalid or unsupported version.');
    return true;
  }
  getWireFormatVersion() { return this._version; }
  transferArrayBuffer(id, value) {
    if (!types.isArrayBuffer(value)) throw new TypeError('Expected an ArrayBuffer');
    this._transfers.set(uint32(id), value);
  }
  _readHostObject() { invalid(); }
  _getSharedArrayBufferFromId() { invalid(); }
  _add(value) { this._objects.push(value); return value; }
  _string(tag) {
    const bytes = this.readRawBytes(this._uint32());
    if (tag === 83) return bytes.toString('utf8');
    if (tag === 34) return bytes.toString('latin1');
    if (tag !== 99 || bytes.length % 2) invalid();
    if (nativeLittleEndian) return bytes.toString('utf16le');
    let result = '';
    for (let i = 0; i < bytes.length; i += 2) result += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return result;
  }
  _readString() {
    const tag = this._tag();
    if (tag !== 83 && tag !== 34 && tag !== 99) invalid();
    return this._string(tag);
  }
  _bigint() {
    const bits = this._uint32();
    // V8's length bitfield has 30 bits and its sign occupies bit 0.
    if (bits >= 0x80000000) invalid();
    const length = bits >>> 1;
    const bytes = this.readRawBytes(length);
    if (!length) { if (bits & 1) invalid(); return 0n; }
    const parts = new Array(length);
    for (let i = 0; i < length; i++) parts[length - i - 1] = bytes[i].toString(16).padStart(2, '0');
    const value = BigInt('0x' + parts.join(''));
    return bits & 1 ? -value : value;
  }
  _properties(object, end) {
    let count = 0;
    while (this._peek() !== end) {
      const key = this.readValue();
      if (typeof key !== 'string' && typeof key !== 'number') invalid();
      const name = String(key);
      if (own(object, name)) invalid();
      const value = this.readValue();
      dataProperty(object, name, value); count++;
    }
    this._tag();
    if (this._uint32() !== count) invalid();
  }
  readValue() {
    let value = this._value();
    // Native views follow their buffer rather than preceding it.
    if ((types.isArrayBuffer(value) || types.isSharedArrayBuffer(value)) && this._offset < this.buffer.length) {
      let next = this._offset;
      while (next < this.buffer.length && this.buffer[next] === 0) next++;
      if (this.buffer[next] === 86) { this._offset = next + 1; value = this._view(value); }
    }
    return value;
  }
  _readViewExtent() { return this._uint32(); }
  _view(buffer) {
    const tag = this._uint32();
    const index = viewTags.indexOf(tag);
    const offset = this._readViewExtent();
    const length = this._readViewExtent();
    const flags = this._version >= 14 ? this._uint32() : 0;
    const resize = isResizable(buffer);
    const shared = types.isSharedArrayBuffer(buffer);
    const size = apply(shared ? sharedLength : bufferLength, buffer, []);
    if (index < 0 || flags > 3 || !!(flags & 2) !== (resize && !shared) || (flags & 1) && !resize || offset > size || length > size - offset) invalid();
    const Ctor = constructors[index];
    if (!Ctor) invalid();
    const width = Ctor.BYTES_PER_ELEMENT || 1;
    if (offset % width || length % width) invalid();
    const view = flags & 1 ? new Ctor(buffer, offset) : new Ctor(buffer, offset, length / width);
    return this._add(view);
  }
  _value() {
    const tag = this._tag();
    switch (tag) {
      case 63: this._uint32(); return this.readValue();
      case 95: return undefined;
      case 48: return null;
      case 84: return true;
      case 70: return false;
      case 73: { const n = this._uint32(); return (n >>> 1) ^ -(n & 1); }
      case 85: return this._uint32();
      case 78: return this._double();
      case 90: return this._bigint();
      case 83: case 34: case 99: return this._string(tag);
      case 94: {
        const id = this._uint32();
        if (id >= this._objects.length || this._objects[id] === UNRESOLVED) invalid();
        return this._objects[id];
      }
      case 111: { const object = this._add({}); this._properties(object, 123); return object; }
      case 97: case 65: {
        const length = this._uint32();
        if (tag === 65 && length > this.buffer.length - this._offset) invalid();
        const array = this._add(new Array(length));
        if (tag === 65) {
          for (let i = 0; i < length; i++) {
            if (this._peek() === 45) this._tag();
            else dataProperty(array, String(i), this.readValue());
          }
        }
        this._properties(array, tag === 65 ? 36 : 64);
        if (this._uint32() !== length || array.length !== length) invalid();
        return array;
      }
      case 68: return this._add(new Date(this._double()));
      case 121: return this._add(new Boolean(true));
      case 120: return this._add(new Boolean(false));
      case 110: return this._add(new Number(this._double()));
      case 122: return this._add(Object(this._bigint()));
      case 115: return this._add(new String(this._readString()));
      case 82: {
        const pattern = this._readString();
        const flags = this._uint32();
        if (flags & ~0x1bf || (flags & 16) && (flags & 256)) invalid();
        let text = '';
        for (let i = 0; i < flagLetters.length; i++) if (flags & (1 << i)) {
          if (!flagGetters[i]) invalid();
          text += flagLetters[i];
        }
        try { return this._add(new RegExp(pattern, text)); } catch { invalid(); }
      }
      case 59: {
        const map = this._add(new Map()); let count = 0;
        while (this._peek() !== 58) { const key = this.readValue(); const item = this.readValue(); Map.prototype.set.call(map, key, item); count += 2; }
        this._tag(); if (this._uint32() !== count) invalid(); return map;
      }
      case 39: {
        const set = this._add(new Set()); let count = 0;
        while (this._peek() !== 44) { Set.prototype.add.call(set, this.readValue()); count++; }
        this._tag(); if (this._uint32() !== count) invalid(); return set;
      }
      case 66: case 126: {
        const length = this._uint32();
        const max = tag === 126 ? this._uint32() : length;
        if (length > max || tag === 126 && !resizable) invalid();
        const bytes = this.readRawBytes(length);
        const buffer = tag === 126 ? new ArrayBuffer(length, { maxByteLength: max }) : new ArrayBuffer(length);
        if (tag === 126 && !isResizable(buffer)) invalid();
        new Uint8Array(buffer).set(bytes); return this._add(buffer);
      }
      case 116: {
        const id = this._uint32(); if (!this._transfers.has(id)) invalid();
        return this._add(this._transfers.get(id));
      }
      case 117: {
        const value = this._getSharedArrayBufferFromId(this._uint32());
        if (!types.isSharedArrayBuffer(value)) invalid();
        return this._add(value);
      }
      case 92: {
        const id = this._objects.length; this._add(UNRESOLVED);
        const value = this._readHostObject();
        if (value === null || typeof value !== 'object') invalid();
        this._objects[id] = value; return value;
      }
      case 114: return this._error();
      default: invalid();
    }
  }
  _error() {
    const id = this._objects.length; this._add(UNRESOLVED);
    let tag = this._uint32();
    if (tag > 255) invalid();
    let Ctor = Error;
    const name = String.fromCharCode(tag);
    if (own(errorConstructors, name)) { Ctor = errorConstructors[name]; tag = this._uint32(); }
    let message;
    if (tag === 109) { message = this._readString(); tag = this._uint32(); }
    let stack;
    if (tag === 115) { stack = this._readString(); tag = this._uint32(); }
    const error = message === undefined ? new Ctor() : new Ctor(message);
    dataProperty(error, 'stack', stack, false);
    this._objects[id] = error;
    if (tag === 99) { dataProperty(error, 'cause', this.readValue(), false); tag = this._uint32(); }
    if (tag !== 46) invalid();
    return error;
  }
});

class DefaultSerializer extends Serializer {
  constructor() { super(); this._setTreatArrayBufferViewsAsHostObjects(true); }
  _writeHostObject(value) {
    // lib/v8.js: a host object that is not an ArrayBufferView.
    if (!ArrayBuffer.isView(value)) throw new this._getDataCloneError(`Unserializable host object: ${require('internal/util/inspect').inspect(value)}`);
    host.getArrayBufferViewFlags(value);
    const info = viewInfo(value);
    // lib/v8.js classifies by the view's constructor against the stable Buffer, so a
    // Buffer with another constructor is that view and any view constructed as Buffer is one.
    const index = value.constructor === Buffer ? 10 : info.index;
    this.writeUint32(index); this.writeUint32(info.length);
    this.writeRawBytes(new Uint8Array(info.buffer, info.offset, info.length));
  }
}
class DefaultDeserializer extends Deserializer {
  _readHostObject() {
    const index = this._uint32();
    const Ctor = constructors[index];
    if (!Ctor) invalid();
    const length = this._uint32();
    const width = Ctor.BYTES_PER_ELEMENT || 1;
    if (length % width) invalid();
    let bytes = this.readRawBytes(length);
    if (bytes.byteOffset % width) {
      const aligned = new Uint8Array(length); aligned.set(bytes); bytes = aligned;
    }
    if (index === 10) return Buffer.from(bytes.buffer, bytes.byteOffset, length);
    return new Ctor(bytes.buffer, bytes.byteOffset, length / width);
  }
}
class IPCSerializer extends DefaultSerializer {
  _writeHostObject(value) {
    if (ArrayBuffer.isView(value)) { this.writeUint32(0); super._writeHostObject(value); return; }
    this.writeUint32(1);
    const copy = {};
    for (const key of keys(value)) dataProperty(copy, key, value[key]);
    this.writeValue(copy);
  }
}
class IPCDeserializer extends DefaultDeserializer {
  _readHostObject() {
    const tag = this._uint32();
    if (tag === 0) return super._readHostObject();
    if (tag === 1) return this.readValue();
    // node_ipc_serdes.cc accepts only the two tags its serializer writes.
    throw new (require('internal/errors').codes.ERR_INVALID_STATE)(`Unknown host object tag ${tag}`);
  }
}
function encode(value, Ctor) { const serializer = new Ctor(); serializer.writeHeader(); serializer.writeValue(value); return serializer.releaseBuffer(); }
function decode(bytes, Ctor) { const deserializer = new Ctor(bytes); deserializer.readHeader(); return deserializer.readValue(); }
function serialize(value) { return encode(value, DefaultSerializer); }
function deserialize(bytes) { return decode(bytes, DefaultDeserializer); }
function serializeIPC(value) { return encode(value, IPCSerializer); }
function deserializeIPC(bytes) { return decode(bytes, IPCDeserializer); }

module.exports = { serialize, deserialize, serializeIPC, deserializeIPC,
  Serializer, Deserializer, DefaultSerializer, DefaultDeserializer };
