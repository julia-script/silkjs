'use strict';

const host = require('internal/host');
const EventEmitter = require('events');
const { AsyncResource } = require('async_hooks');
const { Event, EventTarget, kEvents } = require('internal/path_events/event_target');
const { MessageEvent } = require('internal/web/websocket/events');
const clone = require('internal/worker/clone');
const states = new WeakMap();
const endpoints = new Map();
const retained = new Map();
const token = {};
const finalizer = new FinalizationRegistry(id => {
  endpoints.delete(id);
  host.workerNative('close', [id]);
});
function state(port) {
  const value = states.get(port);
  if (!value) throw clone.codedError('ERR_INVALID_THIS', 'Value of this must be a MessagePort');
  return value;
}
function id(port) {
  const value = state(port);
  if (value.id === null) throw clone.cloneError('MessagePort is already detached or closed.');
  return value.id;
}
function retain(port) {
  const value = state(port);
  if (value.id === null) return;
  const listening = value.realm ? value.realm.hasListener(port) :
    value.emitter.listenerCount('message') > 0 || !!port[kEvents].get('message')?.size;
  if (value.refed || value.started && listening) retained.set(value.id, port);
  else retained.delete(value.id);
}
function emit(port, type, data) {
  const value = state(port);
  value.resource.runInAsyncScope(() => {
    if (value.realm) {
      value.realm.deliver(port, type, data);
      retain(port);
      return;
    }
    value.emitter.emit(type, data);
    const event = type === 'message' || type === 'messageerror' ? new MessageEvent(type, { data }) : new Event(type);
    if (type === 'message' && data === undefined) Object.defineProperty(event, 'data', { value: undefined, enumerable: true });
    port.dispatchEvent(event);
    if (type === 'message' && !value.emitter.listenerCount(type) && !port[kEvents].get(type)?.size) ref(port, false);
    retain(port);
  }, port);
}
function dispose(port, notify) {
  const value = state(port);
  if (value.id === null) return;
  endpoints.delete(value.id);
  retained.delete(value.id);
  finalizer.unregister(port);
  value.id = null;
  if (notify) host.nextTick(() => { emit(port, 'close'); value.resource.emitDestroy(); });
  else value.resource.emitDestroy();
}
function start(port) {
  const value = state(port);
  if (value.id === null) return;
  value.started = true;
  host.workerNative('start', [value.id, true]);
  retain(port);
}
function close(port, callback) {
  const value = state(port);
  if (callback !== undefined) {
    if (typeof callback !== 'function') throw clone.codedError('ERR_INVALID_ARG_TYPE', 'The callback argument must be a function');
    if (value.id === null) host.nextTick(callback);
    else value.emitter.once('close', callback);
  }
  if (value.id === null) return;
  host.workerNative('close', [value.id]);
  dispose(port, true);
}
function ref(port, enabled) {
  const value = state(port);
  if (value.id !== null) {
    host.workerNative('ref', [value.id, enabled]);
    value.refed = enabled;
    retain(port);
  }
  return port;
}
function initialize(port, endpoint, realm) {
  states.set(port, { id: endpoint, started: false, refed: false, emitter: new EventEmitter(),
    resource: new AsyncResource('MESSAGEPORT'), realm, handlers: Object.create(null) });
  endpoints.set(endpoint, new WeakRef(port));
  finalizer.register(port, endpoint, port);
  host.workerNative('start', [endpoint, false]);
  host.workerNative('ref', [endpoint, false]);
  return port;
}
class MessagePort extends EventTarget {
  constructor(key, endpoint) {
    super();
    if (key !== token) throw clone.codedError('ERR_CONSTRUCT_CALL_INVALID', 'MessagePort cannot be constructed directly');
    initialize(this, endpoint);
  }
  postMessage(value, transferList) {
    if (arguments.length === 0) throw clone.codedError('ERR_MISSING_ARGS', 'The value argument must be specified');
    const data = state(this);
    if (data.id === null) return;
    const list = transferList && typeof transferList === 'object' && !transferList[Symbol.iterator] ? transferList.transfer : transferList;
    clone.post(data.id, value, list);
  }
  start() { start(this); }
  close(callback) { close(this, callback); }
  ref() { return ref(this, true); }
  unref() { return ref(this, false); }
  hasRef() { const value = state(this); return value.id !== null && host.workerNative('hasRef', [value.id]); }
  addEventListener(type, listener, options) {
    super.addEventListener(type, listener, options);
    if (type === 'message' && this[kEvents].get(type)?.size) ref(this, true);
    retain(this);
  }
  removeEventListener(type, listener, options) {
    super.removeEventListener(type, listener, options);
    if (type === 'message' && !state(this).emitter.listenerCount(type) && !this[kEvents].get(type)?.size) ref(this, false);
    retain(this);
  }
  emit(type, data) {
    const handled = state(this).emitter.listenerCount(type) > 0 || !!this[kEvents].get(type)?.size;
    emit(this, type, data);
    return handled;
  }
  on(type, listener) { return this.addListener(type, listener); }
  addListener(type, listener) {
    const value = state(this);
    // Bind listeners to the public port, not the private emitter.
    if (typeof listener !== 'function') throw clone.codedError('ERR_INVALID_ARG_TYPE', 'The listener argument must be a function');
    const wrapped = (...args) => Reflect.apply(listener, this, args);
    wrapped.listener = listener;
    value.emitter.on(type, wrapped);
    if (type === 'message') { start(this); ref(this, true); }
    return this;
  }
  once(type, listener) {
    if (typeof listener !== 'function') throw clone.codedError('ERR_INVALID_ARG_TYPE', 'The listener argument must be a function');
    const wrapped = (...args) => { this.removeListener(type, wrapped); return Reflect.apply(listener, this, args); };
    wrapped.listener = listener;
    return this.addListener(type, wrapped);
  }
  removeListener(type, listener) {
    const value = state(this);
    for (const wrapped of value.emitter.rawListeners(type)) {
      if (wrapped === listener || wrapped.listener === listener || wrapped.listener?.listener === listener) {
        value.emitter.removeListener(type, wrapped);
        break;
      }
    }
    if (type === 'message' && !value.emitter.listenerCount(type) && !this[kEvents].get('message')?.size) ref(this, false);
    retain(this);
    return this;
  }
  off(type, listener) { return this.removeListener(type, listener); }
  removeAllListeners(type) {
    const value = state(this);
    if (arguments.length) value.emitter.removeAllListeners(type);
    else value.emitter.removeAllListeners();
    if (!value.emitter.listenerCount('message') && !this[kEvents].get('message')?.size) ref(this, false);
    retain(this);
    return this;
  }
  listeners(type) { return state(this).emitter.listeners(type).map(fn => fn.listener?.listener || fn.listener || fn); }
  listenerCount(type) { return state(this).emitter.listenerCount(type); }
  eventNames() { return state(this).emitter.eventNames(); }
  setMaxListeners(count) { state(this).emitter.setMaxListeners(count); return this; }
  getMaxListeners() { return state(this).emitter.getMaxListeners(); }
}
for (const type of ['message', 'messageerror', 'close']) {
  Object.defineProperty(MessagePort.prototype, 'on' + type, {
    enumerable: true, configurable: true,
    get() { return state(this).handlers[type] || null; },
    set(callback) {
      const value = state(this);
      if (value.handlers[type]) this.removeEventListener(type, value.handlers[type]);
      value.handlers[type] = typeof callback === 'function' ? callback : null;
      if (value.handlers[type]) {
        this.addEventListener(type, callback);
        if (type === 'message') { start(this); ref(this, true); }
      } else if (type === 'message' && !value.emitter.listenerCount(type) && !this[kEvents].get(type)?.size) ref(this, false);
      retain(this);
    },
  });
}
Object.defineProperty(MessagePort.prototype, Symbol.toStringTag, { value: 'MessagePort', configurable: true });
if (Symbol.dispose) MessagePort.prototype[Symbol.dispose] = MessagePort.prototype.close;
function wrap(endpoint, realm) {
  if (!realm) return new MessagePort(token, endpoint);
  return initialize(realm.makePort({
    post(port, value, list) { const data = state(port); if (data.id !== null) clone.post(data.id, value, list); },
    start, close, ref, retain,
    hasRef(port) { const data = state(port); return data.id !== null && host.workerNative('hasRef', [data.id]); },
  }), endpoint, realm);
}
class MessageChannel {
  constructor() {
    const pair = host.workerNative('channel', []);
    this.port1 = wrap(pair[0]);
    this.port2 = wrap(pair[1]);
  }
}
function receiveMessageOnPort(port) {
  const endpoint = state(port).id;
  if (endpoint === null) return undefined;
  const envelope = host.workerNative('receive', [endpoint]);
  if (envelope === null) return undefined;
  return { message: clone.decode(envelope, state(port).realm) };
}
function dispatch(event) {
  const port = endpoints.get(event.port)?.deref();
  if (!port) return false;
  if (event.type === 'close') { dispose(port, true); return true; }
  let value;
  try { value = clone.decode(event.envelope, state(port).realm); }
  catch (error) { emit(port, 'messageerror', error); return true; }
  emit(port, 'message', value);
  return true;
}
function moveMessagePortToContext(port, context) {
  const endpoint = id(port);
  const vm = require('vm');
  if (!vm.isContext(context)) throw clone.codedError('ERR_INVALID_ARG_TYPE', 'The contextifiedSandbox argument must be a vm.Context');
  // Allocate the wrapper and adopt deserialized graph prototypes in the target
  // realm. The underlying ArrayBuffer/SAB backing stores are never copied.
  const realm = vm.runInContext(`(() => {
    const handlers = new WeakMap();
    const tag = Function.call.bind(Object.prototype.toString);
    const prototypes = { Object: Object.prototype, Array: Array.prototype,
      Map: Map.prototype, Set: Set.prototype, Date: Date.prototype, RegExp: RegExp.prototype,
      ArrayBuffer: ArrayBuffer.prototype, SharedArrayBuffer: SharedArrayBuffer.prototype,
      DataView: DataView.prototype, Number: Number.prototype, Boolean: Boolean.prototype,
      String: String.prototype, BigInt: BigInt.prototype, Error: Error.prototype,
      EvalError: EvalError.prototype, RangeError: RangeError.prototype, ReferenceError: ReferenceError.prototype,
      SyntaxError: SyntaxError.prototype, TypeError: TypeError.prototype, URIError: URIError.prototype };
    for (const C of [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
      Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array]) prototypes[C.name] = C.prototype;
    return {
      hasListener(port) { return !!handlers.get(port); },
      adopt(value) {
        const name = tag(value).slice(8, -1);
        const proto = prototypes[name === 'Error' && prototypes[value.name] ? value.name : name];
        if (proto) Object.setPrototypeOf(value, proto);
      },
      makePort(bridge) {
        const port = {
          postMessage(value, transferList) { bridge.post(this, value, transferList); },
          start() { bridge.start(this); }, close() { bridge.close(this); },
          ref() { return bridge.ref(this, true); }, unref() { return bridge.ref(this, false); },
          hasRef() { return bridge.hasRef(this); },
          get onmessage() { return handlers.get(this) || null; },
          set onmessage(fn) {
            handlers.set(this, typeof fn === 'function' ? fn : null);
            bridge.retain(this);
          }
        };
        Object.defineProperty(port, Symbol.toStringTag, { value: 'MessagePort' });
        return port;
      },
      deliver(port, type, data) { if (type === 'message') handlers.get(port)?.call(port, { data }); }
    };
  })()`, context);
  // Creating a wrapper can throw; retain the old endpoint until it succeeds.
  const moved = wrap(endpoint, realm);
  dispose(port, false);
  endpoints.set(endpoint, new WeakRef(moved));
  return moved;
}
clone.installPortHooks({ isPort: port => states.has(port), id, wrap, detach: port => dispose(port, true), close });
module.exports = { MessagePort, MessageChannel, receiveMessageOnPort, moveMessagePortToContext,
  wrap, id, dispatch, close, start, ref };
