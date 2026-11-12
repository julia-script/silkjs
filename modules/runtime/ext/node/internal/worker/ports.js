'use strict';

const host = require('internal/host');
const EventEmitter = require('events');
const { CustomEvent, EventTarget, kEvents } = require('internal/path_events/event_target');
const { MessageEvent } = require('internal/web/websocket/events');
const clone = require('internal/worker/clone');
const { _createResource: createResource } = require('async_hooks');
const { codes: { ERR_MISSING_ARGS } } = require('internal/validators');
const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
const constructCallInvalid = () => clone.codedError('ERR_CONSTRUCT_CALL_INVALID', 'Constructor cannot be called');
const states = new WeakMap();
const endpoints = new Map();
const retained = new Map();
// Ports closed while messages for them were queued, until those are emitted.
const closing = new Map();
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
function transferId(port) {
  const value = state(port);
  if (value.id === null) throw clone.cloneError('MessagePort in transfer list is already detached');
  return value.id;
}
function retain(port) {
  const value = state(port);
  if (value.id === null) return;
  const listening = value.realm ? value.realm.hasListener(port) :
    value.emitter.listenerCount('message') > 0 || !!port[kEvents]?.get('message')?.size;
  if (value.refed || value.started && listening) retained.set(value.id, port);
  else retained.delete(value.id);
}
function emit(port, type, data, ports) {
  const value = state(port);
  value.resource.runInAsyncScope(() => {
    if (value.realm) {
      value.realm.deliver(port, type, data);
      retain(port);
      return;
    }
    value.emitter.emit(type, data);
    // Other types go out as Node's NodeEventTarget does: an event whose detail is the argument.
    const event = type === 'message' || type === 'messageerror' ? new MessageEvent(type, { data, ports }) : new CustomEvent(type, { detail: data });
    if (type === 'message' && data === undefined) Object.defineProperty(event, 'data', { value: undefined, enumerable: true });
    port.dispatchEvent(event);
    if (type === 'message' && !value.emitter.listenerCount(type) && !port[kEvents]?.get(type)?.size) ref(port, false);
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
  if (notify) {
    value.closing = true;
    host.nextTick(() => { value.closing = false; emit(port, 'close'); value.resource.emitDestroy(); });
  }
  else value.resource.emitDestroy();
}
function start(port) {
  const value = state(port);
  if (value.id === null) return;
  value.started = true;
  host.workerNative('start', [value.id, true]);
  retain(port);
}
// Node's removeListener hook: with no message listener left the port stops delivering
// (messages wait in the queue for the next listener) and drops its ref.
function idle(port) {
  const value = state(port);
  if (value.id !== null && value.started) {
    value.started = false;
    host.workerNative('start', [value.id, false]);
  }
  ref(port, false);
}
function close(port, callback) {
  const value = state(port);
  if (callback !== undefined) {
    if (typeof callback !== 'function') throw clone.codedError('ERR_INVALID_ARG_TYPE', 'The callback argument must be a function');
    if (value.id === null) host.nextTick(callback);
    else value.emitter.once('close', callback);
  }
  if (value.id === null) return;
  value.refedAtClose = host.workerNative('hasRef', [value.id]);
  // As Node's MessagePort::Close: messages already queued for this port are
  // still emitted, before 'close'.
  const endpoint = value.id;
  const queued = [];
  if (value.started) {
    let envelope;
    while ((envelope = host.workerNative('receive', [endpoint])) !== null) queued.push(envelope);
  }
  host.workerNative('close', [endpoint]);
  closing.set(endpoint, port);
  for (let at = 0; at < queued.length; at++) host.nextTick(() => deliver(port, queued[at]));
  dispose(port, true);
  host.nextTick(() => closing.delete(endpoint));
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
function initialize(port, endpoint, realm, fresh = false) {
  const value = { id: endpoint, started: false, refed: false, emitter: new EventEmitter(),
    resource: null, realm, handlers: Object.create(null), closing: false, refedAtClose: false };
  states.set(port, value);
  endpoints.set(endpoint, new WeakRef(port));
  finalizer.register(port, endpoint, port);
  host.workerNative('start', [endpoint, false]);
  host.workerNative('ref', [endpoint, false]);
  // Like Node's, the async resource of a port is the port itself.
  value.resource = createResource('MESSAGEPORT', port);
  if (fresh) require('internal/event_target').initEventTarget(port);
  return port;
}
function hasRef(port) {
  const value = state(port);
  if (value.id === null) return value.closing ? value.refedAtClose : false;
  return host.workerNative('hasRef', [value.id]);
}
// Node puts the EventEmitter-style methods on NodeEventTarget, between MessagePort and
// EventTarget, so MessagePort.prototype itself holds only the port's own members.
class PortEventTarget extends EventTarget {
  addEventListener(type, listener, options) {
    super.addEventListener(type, listener, options);
    // Node's kNewListener: a message listener, of either kind, starts and refs the port.
    if (type === 'message' && this[kEvents]?.get(type)?.size) { start(this); ref(this, true); }
    retain(this);
  }
  removeEventListener(type, listener, options) {
    super.removeEventListener(type, listener, options);
    if (type === 'message' && !state(this).emitter.listenerCount(type) && !this[kEvents]?.get(type)?.size) idle(this);
    retain(this);
  }
  emit(type, data) {
    const handled = state(this).emitter.listenerCount(type) > 0 || !!this[kEvents]?.get(type)?.size;
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
    if (type === 'message' && !value.emitter.listenerCount(type) && !this[kEvents]?.get('message')?.size) idle(this);
    retain(this);
    return this;
  }
  off(type, listener) { return this.removeListener(type, listener); }
  removeAllListeners(type) {
    const value = state(this);
    if (arguments.length) value.emitter.removeAllListeners(type);
    else value.emitter.removeAllListeners();
    if (!value.emitter.listenerCount('message') && !this[kEvents]?.get('message')?.size) idle(this);
    retain(this);
    return this;
  }
  listeners(type) { return state(this).emitter.listeners(type).map(fn => fn.listener?.listener || fn.listener || fn); }
  listenerCount(type) { return state(this).emitter.listenerCount(type); }
  eventNames() { return state(this).emitter.eventNames(); }
  setMaxListeners(count) { state(this).emitter.setMaxListeners(count); return this; }
  getMaxListeners() { return state(this).emitter.getMaxListeners(); }
}
class InternalMessagePort extends PortEventTarget {
  // Like Node's native MessagePort, a port is made by wrap(), not by its constructor, so
  // that the async init hook sees it before its EventTarget fields exist (oninit's order).
  constructor() { throw constructCallInvalid(); }
  postMessage(value, transferList) {
    if (arguments.length === 0) throw new ERR_MISSING_ARGS('value');
    const data = state(this);
    // A closed port still checks the message and transfer list, as Node's does, then drops it.
    if (data.id === null) { clone.rollback(clone.prepare(value, transferList, null)); return; }
    clone.post(data.id, value, transferList);
  }
  start() { start(this); }
  close(callback) { close(this, callback); }
  ref() { return ref(this, true); }
  unref() { return ref(this, false); }
  hasRef() { return hasRef(this); }
}
for (const type of ['message', 'messageerror']) {
  Object.defineProperty(InternalMessagePort.prototype, 'on' + type, {
    enumerable: true, configurable: true,
    get() { return state(this).handlers[type] || null; },
    set(callback) {
      const value = state(this);
      if (value.handlers[type]) this.removeEventListener(type, value.handlers[type]);
      value.handlers[type] = typeof callback === 'function' ? callback : null;
      if (value.handlers[type]) {
        this.addEventListener(type, callback);
        if (type === 'message') { start(this); ref(this, true); }
      } else if (type === 'message' && !value.emitter.listenerCount(type) && !this[kEvents]?.get(type)?.size) idle(this);
      retain(this);
    },
  });
}
// MessagePort cannot be constructed by user code, with or without new; ports come from
// MessageChannel and transfers. Its prototype is the internal class's.
function MessagePort() { throw constructCallInvalid(); }
MessagePort.prototype = InternalMessagePort.prototype;
Object.defineProperty(MessagePort.prototype, 'constructor', { value: MessagePort, writable: true, configurable: true });
Object.setPrototypeOf(MessagePort, EventTarget);
Object.defineProperty(MessagePort.prototype, inspectCustom, {
  enumerable: false, writable: false, configurable: true,
  value: function inspect() {
    let ref;
    try { ref = state(this).id === null ? undefined : hasRef(this); } catch { return this; }
    return Object.assign({ __proto__: MessagePort.prototype }, ref === undefined ? { active: false } : { active: true, refed: ref }, this);
  },
});
if (Symbol.dispose) MessagePort.prototype[Symbol.dispose] = MessagePort.prototype.close;
function wrap(endpoint, realm) {
  if (!realm) return initialize(Object.create(InternalMessagePort.prototype), endpoint, null, true);
  return initialize(realm.makePort({
    post(port, value, list) { const data = state(port); if (data.id !== null) clone.post(data.id, value, list); },
    start, close, ref, retain,
    hasRef,
  }), endpoint, realm);
}
function MessageChannel() {
  if (new.target === undefined) {
    throw clone.codedError('ERR_CONSTRUCT_CALL_REQUIRED', 'Class constructor MessageChannel cannot be invoked without `new`');
  }
  const pair = host.workerNative('channel', []);
  this.port1 = wrap(pair[0]);
  this.port2 = wrap(pair[1]);
}
function receiveMessageOnPort(port) {
  if (!states.has(port)) throw clone.codedError('ERR_INVALID_ARG_TYPE', 'The "port" argument must be a MessagePort instance');
  const endpoint = state(port).id;
  if (endpoint === null) return undefined;
  const envelope = host.workerNative('receive', [endpoint]);
  if (envelope === null) return undefined;
  return { message: clone.decode(envelope, state(port).realm) };
}
function deliver(port, envelope) {
  let value;
  const ports = [];
  try { value = clone.decode(envelope, state(port).realm, ports); }
  catch (error) { emit(port, 'messageerror', error); return; }
  emit(port, 'message', value, ports);
}
function dispatch(event) {
  const port = endpoints.get(event.port)?.deref() ?? closing.get(event.port);
  if (!port) return false;
  if (event.type === 'close') { dispose(port, true); return true; }
  deliver(port, event.envelope);
  return true;
}
function moveMessagePortToContext(port, context) {
  if (states.get(port)?.id === null) throw clone.codedError('ERR_CLOSED_MESSAGE_PORT', 'Cannot send data on closed MessagePort');
  const endpoint = id(port);
  const vm = require('vm');
  if (!vm.isContext(context)) throw clone.codedError('ERR_INVALID_ARG_TYPE', 'The contextifiedSandbox argument must be a vm.Context');
  // Allocate the wrapper and adopt deserialized graph prototypes in the target
  // realm. The underlying ArrayBuffer/SAB backing stores are never copied.
  const realm = vm.runInContext(`(() => {
    const handlers = new WeakMap();
    const errorHandlers = new WeakMap();
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
          get onmessage() { return handlers.get(this); },
          set onmessage(fn) {
            handlers.set(this, typeof fn === 'function' ? fn : null);
            bridge.retain(this);
          },
          get onmessageerror() { return errorHandlers.get(this); },
          set onmessageerror(fn) { errorHandlers.set(this, typeof fn === 'function' ? fn : null); },
        };
        Object.defineProperty(port, Symbol.toStringTag, { value: 'MessagePort' });
        return port;
      },
      deliver(port, type, data) {
        if (type === 'message') handlers.get(port)?.call(port, { data });
        else if (type === 'messageerror') errorHandlers.get(port)?.call(port, { data });
      }
    };
  })()`, context);
  // Creating a wrapper can throw; retain the old endpoint until it succeeds.
  const moved = wrap(endpoint, realm);
  dispose(port, false);
  endpoints.set(endpoint, new WeakRef(moved));
  return moved;
}
clone.installPortHooks({ isPort: port => states.has(port), detached: port => states.get(port).id === null, id, transferId, wrap, detach: port => dispose(port, true), close });
module.exports = { MessagePort, MessageChannel, receiveMessageOnPort, moveMessagePortToContext,
  wrap, id, dispatch, close, start, ref };
