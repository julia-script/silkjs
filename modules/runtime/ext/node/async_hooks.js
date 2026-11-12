'use strict';

const host = require('internal/host');
const RunScope = require('internal/async_local_storage/run_scope');
const apply = Reflect.apply;
const hookNames = ['init', 'before', 'after', 'destroy', 'promiseResolve'];
const hooks = new Set();
// internalBinding('async_wrap').setPromiseHooks: one function per event, set by
// internal/promise_hooks (which runs several hooks for one event itself).
let promiseHookFunctions = [undefined, undefined, undefined, undefined];
const promiseEventIndex = { init: 0, before: 1, after: 2, settled: 3 };
const nativeResources = new Map();
const rootResource = {};
const resourceOwnerToken = Symbol('resourceOwner');
let nextId = 2;
let emitting = false;
let pendingDestroy = [];
// Node's async_hook_fields counters: enabled hooks per callback kind (kInit..kPromiseResolve)
// and their total (kTotals), kept current by enable() and disable().
const hookFields = new Uint32Array(6);
function countHookFields() {
  hookFields.fill(0);
  for (const hook of hooks) {
    for (let index = 0; index < hookNames.length; index++) {
      if (hook.callbacks[hookNames[index]] !== undefined) { hookFields[index]++; hookFields[5]++; }
    }
  }
}
// Node's getPromiseHooks: the init, before, after and settled functions that
// setPromiseHooks installed (internal/promise_hooks), undefined where none is.
function getPromiseHooks() { return promiseHookFunctions.slice(); }

function error(code, message, Kind = TypeError) {
  const value = new Kind(message);
  value.code = code;
  return value;
}
function checkFunction(fn, name = 'fn') {
  if (typeof fn !== 'function') throw error('ERR_INVALID_ARG_TYPE', `The "${name}" argument must be a function`);
}
function captureContext() { return host.getAsyncContext(); }
function runWithContext(context, fn, receiver, args) {
  const previous = captureContext();
  host.setAsyncContext(context);
  try { return apply(fn, receiver, args); }
  finally { host.setAsyncContext(previous); }
}
function executionAsyncId() { return captureContext()?.id ?? 1; }
function triggerAsyncId() { return captureContext()?.trigger ?? 0; }
function executionAsyncResource() {
  const resource = captureContext()?.resource;
  return resource instanceof WeakRef ? resource.deref() : resource ?? rootResource;
}
// The inspector's view of promise reactions (V8's async task instrumentation),
// kept apart from promise hooks so it never shows up as one.
let promiseObserver;
function setPromiseObserver(observer) { promiseObserver = observer; syncNativeHooks(); }
function syncNativeHooks() {
  let enabled = !emitting && (promiseHookFunctions.some(Boolean) || promiseObserver !== undefined);
  if (!emitting) for (const hook of hooks) {
    if (hook.trackPromises && hookNames.some(name => hook.callbacks[name] !== undefined)) { enabled = true; break; }
  }
  host.setAsyncHooksEnabled(enabled);
}
function emit(name, args, promise = false) {
  if (emitting || hooks.size === 0) return;
  // Mutations during dispatch affect the next event, not this event's listeners.
  const listeners = Array.from(hooks);
  emitting = true;
  syncNativeHooks();
  try {
    // An index loop: user code may have replaced Array.prototype[Symbol.iterator].
    for (let i = 0; i < listeners.length; i++) {
      const hook = listeners[i];
      if (promise && !hook.trackPromises) continue;
      const callback = hook.callbacks[name];
      if (callback !== undefined) apply(callback, hook, args);
    }
  } catch (exception) {
    host.asyncHookFatal(exception);
  } finally {
    emitting = false;
    syncNativeHooks();
  }
}
function setPromiseHooks(init, before, after, settled) {
  promiseHookFunctions = [init, before, after, settled];
  syncNativeHooks();
}
// An exception from a promise hook is uncaught, as Node's hook functions report it.
function emitPromise(name, promise, parent) {
  const callback = promiseHookFunctions[promiseEventIndex[name]];
  if (emitting || callback === undefined) return;
  emitting = true;
  syncNativeHooks();
  let thrown;
  try {
    if (name === 'init') callback(promise, parent);
    else callback(promise);
  } catch (exception) {
    thrown = { exception };
  } finally {
    emitting = false;
    syncNativeHooks();
  }
  if (thrown !== undefined) host.triggerUncaughtException(thrown.exception);
}
function enqueueDestroy(state) {
  if (state.destroyed) return;
  state.destroyed = true;
  if (hooks.size !== 0) pendingDestroy.push(state);
}
const finalizer = new FinalizationRegistry(enqueueDestroy);
function drainDestroy() {
  if (pendingDestroy.length === 0) return;
  const pending = pendingDestroy;
  pendingDestroy = [];
  for (let index = 0; index < pending.length; index++) emit('destroy', [pending[index].id], pending[index].promise);
}

class AsyncHook {
  constructor(callbacks) {
    if (callbacks === null || typeof callbacks !== 'object') throw error('ERR_INVALID_ARG_TYPE', 'The "callbacks" argument must be an object');
    this.callbacks = Object.create(null);
    for (const name of hookNames) {
      const callback = callbacks[name];
      if (callback !== undefined && typeof callback !== 'function') throw error('ERR_ASYNC_CALLBACK', `hook.${name} must be a function`);
      this.callbacks[name] = callback;
    }
    if (callbacks.trackPromises !== undefined && typeof callbacks.trackPromises !== 'boolean') throw error('ERR_INVALID_ARG_TYPE', 'The "trackPromises" argument must be a boolean');
    this.trackPromises = callbacks.trackPromises !== false;
    if (!this.trackPromises && this.callbacks.promiseResolve !== undefined) throw error('ERR_INVALID_ARG_VALUE', 'trackPromises must not be false when promiseResolve is enabled');
  }
  enable() { hooks.add(this); countHookFields(); syncNativeHooks(); return this; }
  disable() { hooks.delete(this); countHookFields(); syncNativeHooks(); return this; }
}
function createHook(callbacks) { return new AsyncHook(callbacks); }
let enterResource, leaveResource, invokeIn;
// What enter/leave/invoke need from a resource: its id, its callback context and a stack
// of the contexts it interrupted. AsyncResource keeps them private; InternalResource
// (the runtime's own ticks, timers and requests) keeps them as plain fields.
const kId = Symbol('asyncId'), kScope = Symbol('asyncScope'), kStack = Symbol('asyncStack');
function frameScope(id, trigger, resource) { return { stores: undefined, id, trigger, resource }; }

class AsyncResource {
  // Only the stores: the whole context would keep the resource that was current alive.
  #stores;
  #id;
  #trigger;
  #destroy;
  #owner;
  #previousContexts;
  // The context a callback runs in. It never changes, so it is built once.
  #scope;
  #registered = false;
  static {
    enterResource = (resource, omitFrame) => {
      const previous = captureContext();
      const stack = resource[kStack]();
      stack.push(previous);
      host.setAsyncContext(resource[kScope](omitFrame));
      if (hooks.size === 0) return;
      try { emit('before', [resource[kId]()]); }
      catch (error) { host.setAsyncContext(stack.pop()); throw error; }
    };
    leaveResource = resource => {
      const stack = resource[kStack]();
      if (!stack.length) throw error('ERR_ASYNC_CALLBACK', 'No active async resource scope');
      try { if (hooks.size !== 0) emit('after', [resource[kId]()]); }
      finally { host.setAsyncContext(stack.pop()); }
    };
    // The runtime's own callbacks: fn(a, b, c) in the resource's scope, with no
    // rest arguments and no scope stack.
    invokeIn = (resource, fn, a, b, c) => {
      const previous = captureContext();
      host.setAsyncContext(resource[kScope](false));
      if (hooks.size !== 0) {
        try { emit('before', [resource[kId]()]); }
        catch (error) { host.setAsyncContext(previous); throw error; }
      }
      try { return fn(a, b, c); }
      finally {
        try { if (hooks.size !== 0) emit('after', [resource[kId]()]); }
        finally { host.setAsyncContext(previous); }
      }
    };
  }
  [kId]() { return this.#id; }
  [kStack]() { return this.#previousContexts ??= []; }
  [kScope](omitFrame) {
    if (omitFrame && usesContextFrames()) return frameScope(this.#id, this.#trigger, this.#owner ?? this);
    return this.#scope ??= { stores: this.#stores, id: this.#id, trigger: this.#trigger, resource: this.#owner ?? this };
  }
  constructor(type, options = {}, token, owner, explicitId) {
    if (typeof type !== 'string') throw error('ERR_INVALID_ARG_TYPE', 'The "type" argument must be a string');
    if (type.length === 0 && Array.from(hooks).some(hook => hook.callbacks.init !== undefined)) throw error('ERR_ASYNC_TYPE', 'Invalid name for async "type"');
    const trigger = typeof options === 'number' ? options : options.triggerAsyncId ?? executionAsyncId();
    if (!Number.isSafeInteger(trigger) || trigger < -1) throw error('ERR_INVALID_ASYNC_ID', `Invalid triggerAsyncId value: ${trigger}`, RangeError);
    this.#stores = captureContext()?.stores;
    this.#id = token === resourceOwnerToken && typeof explicitId === 'number' && explicitId !== -1 ? explicitId : nextId++;
    this.#trigger = trigger;
    this.#destroy = { id: this.#id, destroyed: false, promise: false };
    this.#owner = token === resourceOwnerToken ? owner : undefined;
    if (!(typeof options === 'object' && options.requireManualDestroy)) {
      finalizer.register(this, this.#destroy, this.#destroy);
      this.#registered = true;
    }
    if (hooks.size !== 0) emit('init', [this.#id, type, trigger, this.#owner ?? this]);
  }
  asyncId() { return this.#id; }
  triggerAsyncId() { return this.#trigger; }
  runInAsyncScope(fn, thisArg, ...args) {
    checkFunction(fn);
    enterResource(this);
    try { return apply(fn, thisArg, args); }
    finally { leaveResource(this); }
  }
  emitDestroy() {
    if (this.#registered) { this.#registered = false; finalizer.unregister(this.#destroy); }
    enqueueDestroy(this.#destroy);
    return this;
  }
  bind(fn, thisArg) {
    checkFunction(fn);
    const resource = this;
    const bound = function(...args) { return resource.runInAsyncScope(fn, thisArg === undefined ? this : thisArg, ...args); };
    Object.defineProperty(bound, 'length', { value: fn.length, configurable: true });
    Object.defineProperty(bound, 'asyncResource', { value: this, writable: true, configurable: true, enumerable: true });
    return bound;
  }
  static bind(fn, type, thisArg) {
    checkFunction(fn);
    return new AsyncResource(type ?? (fn.name || 'bound-anonymous-fn')).bind(fn, thisArg);
  }
}

// The runtime's own resources (ticks, timers, native requests) behave like an
// AsyncResource created with requireManualDestroy, without its validation and private
// state. It is its own destroy record for enqueueDestroy.
class InternalResource {
  constructor(type, owner, explicitId) {
    if (typeof type !== 'string') throw error('ERR_INVALID_ARG_TYPE', 'The "type" argument must be a string');
    if (hooks.size !== 0 && type.length === 0 && Array.from(hooks).some(hook => hook.callbacks.init !== undefined)) throw error('ERR_ASYNC_TYPE', 'Invalid name for async "type"');
    const context = captureContext();
    // Only the stores: the whole context would keep the resource that was current alive.
    this.stores = context?.stores;
    this.id = typeof explicitId === 'number' && explicitId !== -1 ? explicitId : nextId++;
    this.trigger = context?.id ?? 1;
    this.owner = owner;
    this.destroyed = false;
    this.promise = false;
    this.scope = undefined;
    this.stack = undefined;
    if (hooks.size !== 0) emit('init', [this.id, type, this.trigger, owner ?? this]);
  }
  [kId]() { return this.id; }
  [kStack]() { return this.stack ??= []; }
  [kScope](omitFrame) {
    if (omitFrame && usesContextFrames()) return frameScope(this.id, this.trigger, this.owner ?? this);
    return this.scope ??= { stores: this.stores, id: this.id, trigger: this.trigger, resource: this.owner ?? this };
  }
  asyncId() { return this.id; }
  triggerAsyncId() { return this.trigger; }
  runInAsyncScope(fn, thisArg, ...args) {
    checkFunction(fn);
    enterResource(this);
    try { return apply(fn, thisArg, args); }
    finally { leaveResource(this); }
  }
  emitDestroy() { enqueueDestroy(this); return this; }
}

class AsyncContextFrame extends Map {}
const frameDescriptors = Object.getOwnPropertyDescriptors(Map.prototype);
delete frameDescriptors.constructor;
Object.defineProperties(AsyncContextFrame.prototype, frameDescriptors);
Object.setPrototypeOf(AsyncContextFrame.prototype, null);
function usesContextFrames() { return host.asyncContextFrame !== false; }

// With --no-async-context-frame the stores are Node's legacy layout: a null-prototype
// object keyed by each storage's kResourceStore symbol, which resources keep under
// internal/async_hooks async_local_storage_context_symbol.
function legacyStores(stores) { return Object.assign({ __proto__: null }, stores); }
class AsyncLocalStorage {
  #defaultValue;
  #name;
  constructor(options = {}) {
    if (options === null || typeof options !== 'object') throw error('ERR_INVALID_ARG_TYPE', 'The "options" argument must be an object');
    if (!usesContextFrames()) {
      this.kResourceStore = Symbol('kResourceStore');
      this.enabled = true;
    }
    this.#defaultValue = options.defaultValue;
    this.#name = options.name === undefined ? '' : `${options.name}`;
  }
  get name() { return this.#name; }
  disable() {
    const context = captureContext();
    if (usesContextFrames()) { context?.stores?.delete(this); return; }
    this.enabled = false;
  }
  getStore() {
    const stores = captureContext()?.stores;
    if (usesContextFrames()) return stores?.has(this) ? stores.get(this) : this.#defaultValue;
    if (!this.enabled || stores === undefined || !(this.kResourceStore in stores)) return this.#defaultValue;
    return stores[this.kResourceStore];
  }
  enterWith(store) {
    const context = captureContext();
    let stores;
    if (usesContextFrames()) {
      stores = new AsyncContextFrame(context?.stores);
      stores.set(this, store);
    } else {
      this.enabled = true;
      stores = legacyStores(context?.stores);
      stores[this.kResourceStore] = store;
    }
    host.setAsyncContext({ stores, id: context?.id, trigger: context?.trigger, resource: context?.resource });
  }
  run(store, callback, ...args) {
    checkFunction(callback, 'callback');
    if (Object.is(store, this.getStore())) return apply(callback, null, args);
    if (usesContextFrames()) {
      const prior = this.getStore();
      this.enterWith(store);
      try { return apply(callback, null, args); }
      finally { this.enterWith(prior); }
    }
    // Node's legacy run restores only this storage's slot, so another storage's
    // enterWith inside callback stays in force after it.
    const oldStore = captureContext()?.stores?.[this.kResourceStore];
    this.enterWith(store);
    try { return apply(callback, null, args); }
    finally {
      const context = captureContext();
      const stores = legacyStores(context?.stores);
      stores[this.kResourceStore] = oldStore;
      host.setAsyncContext({ stores, id: context?.id, trigger: context?.trigger, resource: context?.resource });
    }
  }
  exit(callback, ...args) {
    checkFunction(callback, 'callback');
    if (usesContextFrames()) return this.run(undefined, callback, ...args);
    if (!this.enabled) return apply(callback, null, args);
    // Node disables the storage while callback runs, so resources made there do not
    // take the store; here they take the context, so it goes without the store.
    const previous = captureContext();
    if (previous?.stores === undefined || !(this.kResourceStore in previous.stores)) return apply(callback, null, args);
    const stores = legacyStores(previous.stores);
    delete stores[this.kResourceStore];
    host.setAsyncContext({ stores, id: previous.id, trigger: previous.trigger, resource: previous.resource });
    try { return apply(callback, null, args); }
    finally { host.setAsyncContext(previous); }
  }
  withScope(store) {
    return new RunScope(this, store);
  }
  static bind(fn) { return AsyncResource.bind(fn); }
  static snapshot() {
    const resource = new AsyncResource('bound-anonymous-fn');
    return function(fn, ...args) { return resource.runInAsyncScope(fn, undefined, ...args); };
  }
}

// Engine tokens are monotonic and distinct from public async IDs. Metadata must
// never strongly retain a Promise, otherwise its destroy event cannot occur.
function nativeEvent(event, token, parent, resource, parentResource) {
  if (promiseObserver !== undefined) promiseObserver(event, token, parentResource !== undefined);
  if (event === 0) {
    const state = { id: nextId++, trigger: nativeResources.get(parent)?.id ?? executionAsyncId(),
      resource: new WeakRef(resource), destroyed: false, promise: true };
    nativeResources.set(token, state);
    emitPromise('init', resource, parentResource);
    emit('init', [state.id, 'PROMISE', state.trigger, resource], true);
    return;
  }
  const state = nativeResources.get(token);
  if (state === undefined) {
    // Late-enabled promise hooks still observe resources constructed before
    // token tracking began. Do not invent async IDs or synthesize init events.
    if (event === 1) emitPromise('before', resource);
    else if (event === 2) emitPromise('after', resource);
    else if (event === 3) emitPromise('settled', resource);
    return;
  }
  if (event === 1) {
    const context = captureContext();
    host.setAsyncContext({ stores: context?.stores, id: state.id, trigger: state.trigger, resource: state.resource });
    emitPromise('before', resource);
    emit('before', [state.id], true);
  } else if (event === 2) {
    emitPromise('after', resource);
    emit('after', [state.id], true);
    // The native job dispatcher restores its saved context, including on OOM.
  } else if (event === 3) {
    emitPromise('settled', resource);
    emit('promiseResolve', [state.id], true);
  }
}
function nativeDestroy(token) {
  if (promiseObserver !== undefined) promiseObserver(4, token, false);
  const state = nativeResources.get(token);
  if (state === undefined) return;
  nativeResources.delete(token);
  enqueueDestroy(state);
}

const asyncWrapProviders = Object.freeze({
  __proto__: null,
  NONE: 0, DIRHANDLE: 1, DNSCHANNEL: 2, ELDHISTOGRAM: 3,
  FILEHANDLE: 4, FILEHANDLECLOSEREQ: 5, BLOBREADER: 6, FSEVENTWRAP: 7,
  FSREQCALLBACK: 8, FSREQPROMISE: 9, GETADDRINFOREQWRAP: 10, GETNAMEINFOREQWRAP: 11,
  HEAPSNAPSHOT: 12, HTTP2SESSION: 13, HTTP2STREAM: 14, HTTP2PING: 15, HTTP2SETTINGS: 16,
  HTTPINCOMINGMESSAGE: 17, HTTPCLIENTREQUEST: 18, LOCKS: 19, JSSTREAM: 20,
  JSUDPWRAP: 21, MESSAGEPORT: 22, PIPECONNECTWRAP: 23, PIPESERVERWRAP: 24, PIPEWRAP: 25,
  PROCESSWRAP: 26, PROMISE: 27, QUERYWRAP: 28, QUIC_ENDPOINT: 29, QUIC_LOGSTREAM: 30,
  QUIC_SESSION: 31, QUIC_STREAM: 32, QUIC_UDP: 33, SHUTDOWNWRAP: 34, SIGNALWRAP: 35,
  STATWATCHER: 36, STREAMPIPE: 37, TCPCONNECTWRAP: 38, TCPSERVERWRAP: 39, TCPWRAP: 40,
  TTYWRAP: 41, UDPSENDWRAP: 42, UDPWRAP: 43, SIGINTWATCHDOG: 44, WORKER: 45,
  WORKERCPUPROFILE: 46, WORKERCPUUSAGE: 47, WORKERHEAPPROFILE: 48,
  WORKERHEAPSNAPSHOT: 49, WORKERHEAPSTATISTICS: 50, WRITEWRAP: 51, ZLIB: 52,
  CHECKPRIMEREQUEST: 53, PBKDF2REQUEST: 54, KEYPAIRGENREQUEST: 55, KEYGENREQUEST: 56,
  KEYEXPORTREQUEST: 57, ARGON2REQUEST: 58, CIPHERREQUEST: 59, DERIVEBITSREQUEST: 60,
  HASHREQUEST: 61, RANDOMBYTESREQUEST: 62, RANDOMPRIMEREQUEST: 63, SCRYPTREQUEST: 64,
  SIGNREQUEST: 65, TLSWRAP: 66, VERIFYREQUEST: 67,
});
module.exports = { AsyncLocalStorage, AsyncResource, createHook, executionAsyncId, triggerAsyncId, executionAsyncResource, asyncWrapProviders };
Object.defineProperties(module.exports, {
  _setPromiseHooks: { value: setPromiseHooks },
  _createResource: { value: (type, owner, id) => new InternalResource(type, owner, id) },
  _enterResource: { value: (resource, omitFrame = false) => enterResource(resource, omitFrame) },
  _leaveResource: { value: resource => leaveResource(resource) },
  _invoke: { value: invokeIn },
  // Whether any enabled hook observes resource callbacks; a hot runtime path may skip a resource's scope when none does.
  _hooksActive: { value: () => hooks.size !== 0 },
  _captureContext: { value: captureContext },
  _runWithContext: { value: runWithContext },
  _nativeEvent: { value: nativeEvent },
  _nativeDestroy: { value: nativeDestroy },
  _setPromiseObserver: { value: setPromiseObserver },
  _drainDestroy: { value: drainDestroy },
  // Node's newAsyncId: the next id from the same counter every resource takes its id from.
  _newAsyncId: { value: () => nextId++ },
  _hookFields: { value: hookFields },
  _getPromiseHooks: { value: getPromiseHooks },
  // Node's async_wrap.queueDestroyAsyncId: a destroy event for an id with no resource.
  _queueDestroyId: { value: id => { if (hooks.size !== 0) pendingDestroy.push({ id, destroyed: true }); } },
});
