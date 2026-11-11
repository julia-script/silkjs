'use strict';

const host = require('internal/host');
const types = require('util/types');
const isCryptoKey = types.isCryptoKey;
const isKeyObject = types.isKeyObject;
const { Serializer, Deserializer } = require('internal/serialization/v8');
const { DOMException, isDOMException } = require('internal/path_events/event_target');
const abort = require('internal/abort_controller');
const uncloneable = new WeakSet();
const arrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
const arrayBufferResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const arrayBufferMaximum = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'maxByteLength')?.get;
let portHooks;

function cloneError(message = 'The object could not be cloned.') {
  return new DOMException(message, 'DataCloneError');
}
function codedError(code, message, Kind = TypeError) {
  return Object.assign(new Kind(message), { code });
}
function object(value) { return value !== null && (typeof value === 'object' || typeof value === 'function'); }
const { markAsUntransferable, isMarkedAsUntransferable } = require('internal/buffer');
function markAsUncloneable(value) {
  if (object(value) && !types.isArrayBuffer(value) && !types.isSharedArrayBuffer(value) && !ArrayBuffer.isView(value)) uncloneable.add(value);
}
function installPortHooks(hooks) { portHooks = hooks; }
function transferList(value) {
  if (value === undefined) return [];
  if (value === null || typeof value[Symbol.iterator] !== 'function')
    throw codedError('ERR_INVALID_ARG_TYPE', 'The transferList argument must be an iterable');
  return Array.from(value);
}

class CloneSerializer extends Serializer {
  constructor(ports, shared, buffers, signals) {
    super();
    this.ports = ports;
    this.shared = shared;
    this.sharedIds = new Map();
    this.buffers = buffers;
    this.signals = signals;
    this.pendingSignals = [];
    this.modules = new WeakMap();
    this.memories = new WeakMap();
  }
  _validateCloneValue(value) {
    if (uncloneable.has(value)) throw cloneError('Object is marked as uncloneable.');
    if (types.isArrayBuffer(value)) {
      try { new Uint8Array(value); } catch { throw cloneError('An ArrayBuffer is detached.'); }
      const length = Reflect.apply(arrayBufferLength, value, []);
      const resizable = arrayBufferResizable && Reflect.apply(arrayBufferResizable, value, []);
      const maximum = resizable ? Reflect.apply(arrayBufferMaximum, value, []) : length;
      if (!this._transfers.has(value) && (length > 0xffffffff || maximum > 0xffffffff)) {
        // Large buffer extents exceed the standard wire's uint32 fields.
        // Snapshot into the native side table without consulting species.
        const copy = resizable ? new ArrayBuffer(length, { maxByteLength: maximum }) : new ArrayBuffer(length);
        new Uint8Array(copy).set(new Uint8Array(value));
        const id = this.buffers.length;
        this.buffers.push(copy);
        this.transferArrayBuffer(id, value);
      }
    } else if (ArrayBuffer.isView(value)) {
      try {
        if (types.isDataView(value)) Reflect.apply(Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength').get, value, []);
        else Uint8Array.prototype.values.call(value);
      } catch { throw cloneError('An ArrayBufferView is detached or out of bounds.'); }
    }
  }
  _isHostObject(value) {
    if (isDOMException(value)) return true;
    if (abort.isTransferable(value)) return true;
    if (isCryptoKey(value) || isKeyObject(value) || host.types.isX509Certificate?.(value)) return true;
    if (host.types.isStorage?.(value) || host.types.isEventSource?.(value)) return true;
    if (portHooks?.isPort(value)) return true;
    const memory = host.wasmNative('cloneMemory', value);
    if (memory === false) throw cloneError('A nonshared WebAssembly.Memory cannot be cloned.');
    if (memory !== undefined) { this.memories.set(value, memory); return true; }
    const bytes = host.wasmNative('cloneBytes', value);
    if (bytes === undefined) return false;
    this.modules.set(value, bytes);
    return true;
  }
  _writeViewExtents(info) {
    for (const value of [info.offset, info.length])
      this.writeUint64(Math.floor(value / 0x100000000), value % 0x100000000);
  }
  _getSharedArrayBufferId(value) {
    if (this.sharedIds.has(value)) return this.sharedIds.get(value);
    const id = this.shared.length;
    this.shared.push(value);
    this.sharedIds.set(value, id);
    return id;
  }
  _writeHostObject(value) {
    if (abort.isTransferable(value)) {
      if (!this.signals.has(value)) throw cloneError('Object that needs transfer was found in message but not listed in transferList');
      this.writeUint32(9);
      this.pendingSignals.push(value);
      return;
    }
    if (isDOMException(value)) {
      this.writeUint32(10);
      this.writeValue(value.name);
      this.writeValue(value.message);
      this.writeValue(value.stack);
      return;
    }
    if (isCryptoKey(value)) {
      this.writeUint32(5);
      this.writeValue(require('internal/crypto_webcrypto').serializeKey(value));
      return;
    }
    if (isKeyObject(value)) {
      this.writeUint32(6);
      this.writeValue(require('internal/crypto_core').serializeKeyObject(value));
      return;
    }
    if (host.types.isX509Certificate?.(value)) {
      this.writeUint32(7);
      this.writeValue(require('internal/crypto_certificates')._cloneData(value));
      return;
    }
    if (this.memories.has(value)) {
      this.writeUint32(4);
      this.writeValue(this.memories.get(value).buffer);
      return;
    }
    if (this.modules.has(value)) {
      const bytes = new Uint8Array(this.modules.get(value));
      this.writeUint32(3);
      this.writeDouble(bytes.byteLength);
      this.writeRawBytes(bytes);
      return;
    }
    if (portHooks?.isPort(value)) {
      const id = this.ports.indexOf(value);
      if (id < 0) throw codedError('ERR_MISSING_TRANSFERABLE_IN_TRANSFER_LIST', 'Object that needs transfer was found in message but not listed in transferList', Error);
      this.writeUint32(0);
      this.writeUint32(id);
      return;
    }
    const blob = require('internal/web/blob');
    const data = blob._cloneData(value);
    if (data) {
      if (data.parts) {
        this.writeUint32(8);
        this.writeValue(data);
        return;
      }
      this.writeUint32(data.name === undefined ? 1 : 2);
      this.writeValue(data.type);
      if (data.name !== undefined) { this.writeValue(data.name); this.writeDouble(data.lastModified); }
      this.writeUint32(data.bytes.byteLength);
      this.writeRawBytes(data.bytes);
      return;
    }
    this._fail();
  }
}
CloneSerializer.prototype._getDataCloneError = function(message) { return cloneError(message); };
class CloneDeserializer extends Deserializer {
  constructor(envelope, realm) {
    super(types.isArrayBuffer(envelope.bytes) ? new Uint8Array(envelope.bytes) : envelope.bytes);
    this.shared = envelope.shared || [];
    this.ports = (envelope.ports || []).map(id => portHooks.wrap(id, realm));
    this.realm = realm;
    for (let i = 0; i < (envelope.buffers || []).length; i++) this.transferArrayBuffer(i, envelope.buffers[i]);
  }
  _add(value) {
    if (this.realm && object(value)) this.realm.adopt(value);
    return super._add(value);
  }
  _readViewExtent() {
    const [high, low] = this.readUint64();
    const value = high * 0x100000000 + low;
    if (value > 0x400000000) throw cloneError('Invalid view extent.');
    return value;
  }
  _getSharedArrayBufferFromId(id) {
    if (id >= this.shared.length) throw cloneError('Invalid shared buffer reference.');
    return this.shared[id];
  }
  _readHostObject() {
    const tag = this.readUint32();
    if (tag === 9) {
      if (this.realm) throw codedError('ERR_MESSAGE_TARGET_CONTEXT_UNAVAILABLE', 'A native object cannot be received in the target context', Error);
      return abort.createTransferredSignal();
    }
    if (tag === 10) {
      const name = this.readValue();
      const exception = new DOMException(this.readValue(), name);
      const stack = this.readValue();
      if (typeof stack === 'string') Object.defineProperty(exception, 'stack', { value: stack, writable: true, configurable: true });
      return exception;
    }
    if (tag >= 5 && tag <= 7 && this.realm)
      throw codedError('ERR_MESSAGE_TARGET_CONTEXT_UNAVAILABLE', 'A native object cannot be received in the target context', Error);
    if (tag === 0) {
      const id = this.readUint32();
      if (id >= this.ports.length) throw cloneError('Invalid MessagePort reference.');
      return this.ports[id];
    }
    if (tag === 3) {
      const length = this.readDouble();
      if (!Number.isInteger(length) || length < 0 || length > 0x400000000)
        throw cloneError('Invalid WebAssembly module extent.');
      const bytes = this.readRawBytes(length);
      return host.wasmNative('cloneModule', bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    if (tag === 4) return host.wasmNative('cloneMemoryFrom', this.readValue());
    if (tag === 5) return require('internal/crypto_webcrypto').deserializeKey(this.readValue());
    if (tag === 6) {
      require('crypto');
      return require('internal/crypto_core').deserializeKeyObject(this.readValue());
    }
    if (tag === 7) return require('internal/crypto_certificates')._fromCloneData(this.readValue());
    if (tag === 8) return require('internal/web/blob')._fromCloneData(this.readValue());
    if (tag === 1 || tag === 2) {
      const type = this.readValue();
      const name = tag === 2 ? this.readValue() : undefined;
      const lastModified = tag === 2 ? this.readDouble() : undefined;
      const bytes = this.readRawBytes(this.readUint32());
      const { Blob, File } = require('internal/web/blob');
      return tag === 2 ? new File([bytes], name, { type, lastModified }) : new Blob([bytes], { type });
    }
    throw cloneError('Unsupported host object.');
  }
  _error() {
    const error = super._error();
    if (this.realm) this.realm.adopt(error);
    return error;
  }
}

function prepare(value, list, source) {
  const buffers = [];
  const ports = [];
  const ids = [];
  const shared = [];
  const seen = new Set();
  const signals = new Map();
  for (const item of transferList(list)) {
    if (seen.has(item)) throw cloneError('Transfer list contains a duplicate object.');
    seen.add(item);
    if (isMarkedAsUntransferable(item)) throw cloneError('Object is marked as untransferable.');
    if (types.isArrayBuffer(item)) {
      if (host.wasmNative('isMemoryBuffer', item)) throw cloneError('WebAssembly memory buffers cannot be transferred.');
      try { new Uint8Array(item); } catch { throw cloneError('An ArrayBuffer is detached.'); }
      buffers.push(item);
    } else if (portHooks?.isPort(item)) {
      const id = portHooks.id(item);
      if (id === source) throw cloneError('Transfer list contains the source port.');
      if (ids.includes(id)) throw cloneError('Transfer list contains a duplicate port.');
      ports.push(item);
      ids.push(id);
    } else if (abort.isTransferable(item)) {
      signals.set(item, undefined);
    } else throw codedError('ERR_INVALID_TRANSFER_OBJECT', 'Found invalid object in transferList');
  }
  try {
    for (const signal of signals.keys()) {
      const record = abort.prepareTransfer(signal);
      signals.set(signal, record);
      if (record.port) { ports.push(record.port); ids.push(portHooks.id(record.port)); }
    }
    const serializer = new CloneSerializer(ports, shared, buffers, signals);
    buffers.forEach((buffer, index) => serializer.transferArrayBuffer(index, buffer));
    serializer.writeHeader();
    serializer.writeValue(value);
    // Snapshot host state after graph getters, as Node's transfer callbacks do.
    // Placeholders also let reasons refer back to the signals being transferred.
    for (let index = 0; index < serializer.pendingSignals.length; index++) {
      const signal = serializer.pendingSignals[index];
      const record = signals.get(signal);
      record.snapshotAborted = signal.aborted;
      serializer.writeUint32(1);
      serializer.writeValue(signal);
      serializer.writeUint32(record.snapshotAborted ? 1 : 0);
      serializer.writeValue(record.snapshotAborted ? signal.reason : record.port);
      serializer.writeValue(record.snapshotAborted ? record.port : undefined);
    }
    serializer.writeUint32(0);
    // User getters may close/move a port or mark a buffer during serialization.
    for (let i = 0; i < ports.length; i++) {
      if (isMarkedAsUntransferable(ports[i]) || portHooks.id(ports[i]) !== ids[i]) throw cloneError('MessagePort changed during serialization.');
    }
    for (const signal of signals.keys()) {
      if (isMarkedAsUntransferable(signal)) throw cloneError('Object is marked as untransferable.');
    }
    for (const buffer of buffers) {
      if (isMarkedAsUntransferable(buffer)) throw cloneError('Object is marked as untransferable.');
      if (host.wasmNative('isMemoryBuffer', buffer)) throw cloneError('WebAssembly memory buffers cannot be transferred.');
      try { new Uint8Array(buffer); } catch { throw cloneError('An ArrayBuffer was detached during serialization.'); }
    }
    return { bytes: serializer.releaseBuffer(), buffers, shared, ports: ids, moved: ports, signals };
  } catch (error) {
    for (const record of signals.values()) if (record) abort.rollbackTransfer(record);
    throw error;
  }
}
function rollback(prepared) {
  for (const record of prepared.signals?.values() || []) abort.rollbackTransfer(record);
}
function commit(prepared) {
  for (const port of prepared.moved) portHooks.detach(port);
  for (const record of prepared.signals?.values() || []) abort.commitTransfer(record);
}
function post(id, value, list) {
  const prepared = prepare(value, list, id);
  try { host.workerNative('post', [id, prepared.bytes, prepared.buffers, prepared.shared, prepared.ports]); }
  catch (error) { rollback(prepared); throw error; }
  commit(prepared);
}
function decode(envelope, realm) {
  const deserializer = new CloneDeserializer(envelope, realm);
  try {
    deserializer.readHeader();
    const value = deserializer.readValue();
    while (deserializer.readUint32()) {
      const signal = deserializer.readValue();
      const aborted = deserializer.readUint32() === 1;
      abort.receiveTransfer(signal, aborted, deserializer.readValue());
      const unusedPort = deserializer.readValue();
      if (unusedPort) portHooks.close(unusedPort);
    }
    return value;
  }
  catch (error) { for (const port of deserializer.ports) portHooks.close(port); throw error; }
}
function structuredClone(value, options) {
  if (arguments.length === 0) throw codedError('ERR_MISSING_ARGS', 'The value argument must be specified');
  if (options != null && !object(options)) throw codedError('ERR_INVALID_ARG_TYPE', 'The options argument must be an object');
  let prepared;
  try { prepared = prepare(value, options?.transfer); }
  catch (error) {
    if (error?.code === 'ERR_INVALID_TRANSFER_OBJECT' || error?.code === 'ERR_MISSING_TRANSFERABLE_IN_TRANSFER_LIST')
      throw cloneError(error.message);
    throw error;
  }
  let send, receive;
  try {
    [send, receive] = host.workerNative('channel', []);
    host.workerNative('post', [send, prepared.bytes, prepared.buffers, prepared.shared, prepared.ports]);
    commit(prepared);
    return decode(host.workerNative('receive', [receive]));
  } catch (error) {
    rollback(prepared);
    throw error;
  } finally {
    if (send !== undefined) host.workerNative('close', [send]);
    if (receive !== undefined) host.workerNative('close', [receive]);
  }
}
module.exports = { cloneError, codedError, installPortHooks, transferList, prepare, commit, post, decode, structuredClone,
  markAsUntransferable, isMarkedAsUntransferable, markAsUncloneable };
