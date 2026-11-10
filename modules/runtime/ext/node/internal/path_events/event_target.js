'use strict';

const host = require('internal/host');
const { codes: { ERR_INVALID_ARG_TYPE }, validateInteger } = require('internal/path_events/support');
const kEvents = Symbol('events');
const kResistStopPropagation = Symbol('resistStopPropagation');
const eventState = new WeakMap();
const targets = new WeakSet();
const signalState = new WeakMap();
const controllerState = new WeakMap();
const signalToken = {};

// Composite dependencies are weak in both directions. Observed composites
// remain alive only while a live source can still trigger their listeners.
const persistentSignals = new Set();
const sourceCleanup = new FinalizationRegistry(unlinkSignals);
const dependentCleanup = new FinalizationRegistry(unlinkSignals);
const timeoutCleanup = new FinalizationRegistry(timer => clearTimeout(timer));

function updateSignalRetention(signal) {
  const state = signalState.get(signal);
  if (!state) return;
  const observed = (signal[kEvents].get('abort')?.size ?? 0) > 0;
  if (!state.aborted && ((state.timeout && (observed || state.dependents.size > 0)) ||
      (state.composite && observed && state.sources.size > 0) ||
      (state.transferred && (observed || state.dependents.size > 0)))) {
    persistentSignals.add(signal);
  } else {
    persistentSignals.delete(signal);
  }
}

function unlinkSignals(link) {
  sourceCleanup.unregister(link);
  dependentCleanup.unregister(link);
  const source = link.source.deref();
  const dependent = link.dependent.deref();
  if (source) {
    signalState.get(source).dependents.delete(link);
    updateSignalRetention(source);
  }
  if (dependent) {
    signalState.get(dependent).sources.delete(link);
    updateSignalRetention(dependent);
  }
}

function createSignalTimeout(reference, delay) {
  const timer = setTimeout(() => {
    const signal = reference.deref();
    if (signal) {
      timeoutCleanup.unregister(signal);
      abortSignal(signal, new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    }
  }, delay);
  timer.unref?.();
  return timer;
}

const exceptionNames = [
  'IndexSizeError', 'DOMStringSizeError', 'HierarchyRequestError', 'WrongDocumentError',
  'InvalidCharacterError', 'NoDataAllowedError', 'NoModificationAllowedError',
  'NotFoundError', 'NotSupportedError', 'InUseAttributeError', 'InvalidStateError',
  'SyntaxError', 'InvalidModificationError', 'NamespaceError', 'InvalidAccessError',
  'ValidationError', 'TypeMismatchError', 'SecurityError', 'NetworkError', 'AbortError',
  'URLMismatchError', 'QuotaExceededError', 'TimeoutError', 'InvalidNodeTypeError', 'DataCloneError',
];
const exceptionConstants = [
  'INDEX_SIZE_ERR', 'DOMSTRING_SIZE_ERR', 'HIERARCHY_REQUEST_ERR', 'WRONG_DOCUMENT_ERR',
  'INVALID_CHARACTER_ERR', 'NO_DATA_ALLOWED_ERR', 'NO_MODIFICATION_ALLOWED_ERR',
  'NOT_FOUND_ERR', 'NOT_SUPPORTED_ERR', 'INUSE_ATTRIBUTE_ERR', 'INVALID_STATE_ERR',
  'SYNTAX_ERR', 'INVALID_MODIFICATION_ERR', 'NAMESPACE_ERR', 'INVALID_ACCESS_ERR',
  'VALIDATION_ERR', 'TYPE_MISMATCH_ERR', 'SECURITY_ERR', 'NETWORK_ERR', 'ABORT_ERR',
  'URL_MISMATCH_ERR', 'QUOTA_EXCEEDED_ERR', 'TIMEOUT_ERR', 'INVALID_NODE_TYPE_ERR', 'DATA_CLONE_ERR',
];
const exceptionState = new WeakMap();
class DOMException extends Error {
  constructor(message = '', name = 'Error') {
    message = String(message);
    super(message);
    delete this.message;
    exceptionState.set(this, { message, name: String(name) });
  }
  get name() { return exceptionData(this).name; }
  get message() { return exceptionData(this).message; }
  get code() { return exceptionNames.indexOf(exceptionData(this).name) + 1; }
}
function exceptionData(value) {
  const data = exceptionState.get(value);
  if (!data) throw new TypeError('Value of this must be of DOMException');
  return data;
}
for (let i = 0; i < exceptionConstants.length; i++) {
  const descriptor = { value: i + 1, enumerable: true };
  Object.defineProperty(DOMException, exceptionConstants[i], descriptor);
  Object.defineProperty(DOMException.prototype, exceptionConstants[i], descriptor);
}
Object.defineProperty(DOMException.prototype, Symbol.toStringTag, { value: 'DOMException', configurable: true });

function eventData(value) {
  const data = eventState.get(value);
  if (!data) throw new TypeError('Value of this must be of Event');
  return data;
}
class Event {
  constructor(type, options = {}) {
    if (arguments.length === 0) throw new TypeError('The "type" argument must be specified');
    if (options !== null && typeof options !== 'object' && typeof options !== 'function') {
      throw new ERR_INVALID_ARG_TYPE('options', 'Object', options);
    }
    eventState.set(this, {
      type: String(type), bubbles: !!options?.bubbles, cancelable: !!options?.cancelable,
      composed: !!options?.composed, canceled: false, stopped: false, immediate: false,
      dispatching: false, passive: false, target: null, currentTarget: null,
      timeStamp: typeof performance === 'object' ? performance.now() : Date.now(), trusted: false,
    });
    Object.defineProperty(this, 'isTrusted', { enumerable: true, get: () => eventData(this).trusted });
  }
  get type() { return eventData(this).type; }
  get target() { return eventData(this).target; }
  get srcElement() { return this.target; }
  get currentTarget() { return eventData(this).currentTarget; }
  get eventPhase() { return eventData(this).dispatching ? Event.AT_TARGET : Event.NONE; }
  get bubbles() { return eventData(this).bubbles; }
  get cancelable() { return eventData(this).cancelable; }
  get composed() { return eventData(this).composed; }
  get timeStamp() { return eventData(this).timeStamp; }
  get defaultPrevented() { return eventData(this).canceled; }
  get cancelBubble() { return eventData(this).stopped; }
  set cancelBubble(value) { if (value) this.stopPropagation(); }
  get returnValue() { return !this.defaultPrevented; }
  set returnValue(value) { if (!value) this.preventDefault(); }
  stopPropagation() { eventData(this).stopped = true; }
  stopImmediatePropagation() {
    const state = eventData(this);
    state.stopped = state.immediate = true;
  }
  preventDefault() {
    const state = eventData(this);
    if (state.cancelable && !state.passive) state.canceled = true;
  }
  composedPath() { const state = eventData(this); return state.dispatching ? [state.target] : []; }
  initEvent(type, bubbles = false, cancelable = false) {
    const state = eventData(this);
    if (state.dispatching) return;
    state.type = String(type);
    state.bubbles = !!bubbles;
    state.cancelable = !!cancelable;
    state.canceled = state.stopped = state.immediate = state.trusted = false;
    state.target = null;
  }
}
for (const [name, value] of Object.entries({ NONE: 0, CAPTURING_PHASE: 1, AT_TARGET: 2, BUBBLING_PHASE: 3 })) {
  Object.defineProperty(Event, name, { value, enumerable: true });
  Object.defineProperty(Event.prototype, name, { value, enumerable: true });
}
Object.defineProperty(Event.prototype, Symbol.toStringTag, { value: 'Event', configurable: true });
const customEventState = new WeakMap();
class CustomEvent extends Event {
  constructor(type, options = {}) {
    if (arguments.length === 0) throw new TypeError('The "type" argument must be specified');
    super(type, options);
    customEventState.set(this, options?.detail ?? null);
  }
  get detail() {
    if (!customEventState.has(this)) throw new TypeError('Value of this must be of CustomEvent');
    return customEventState.get(this);
  }
}
Object.defineProperty(CustomEvent.prototype, Symbol.toStringTag, { value: 'CustomEvent', configurable: true });

function validateTarget(target) {
  if (!targets.has(target)) throw new TypeError('Value of this must be of EventTarget');
}
function captureOption(options) { return typeof options === 'boolean' ? options : !!options?.capture; }
function removeNode(target, type, node) {
  if (node.removed) return;
  const root = target[kEvents].get(type);
  node.removed = true;
  if (node.previous) node.previous.next = node.next;
  else root.next = node.next;
  if (node.next) node.next.previous = node.previous;
  else root.last = node.previous;
  if (--root.size === 0) target[kEvents].delete(type);
  node.abortDispose?.();
  if (type === 'abort') updateSignalRetention(target);
}
class EventTarget {
  constructor() {
    targets.add(this);
    Object.defineProperty(this, kEvents, { value: new Map() });
    const events = require('events');
    this[events.kMaxEventTargetListeners] = events.defaultMaxListeners;
    this[events.kMaxEventTargetListenersWarned] = false;
  }
  addEventListener(type, listener, options = {}) {
    validateTarget(this);
    if (arguments.length < 2) throw new TypeError('The "type" and "listener" arguments must be specified');
    type = String(type);
    if (options !== null && typeof options !== 'object' && typeof options !== 'boolean') {
      throw new ERR_INVALID_ARG_TYPE('options', ['Object', 'boolean'], options);
    }
    if (listener === undefined || listener === null) return;
    if (typeof listener !== 'function' && typeof listener !== 'object') {
      throw new ERR_INVALID_ARG_TYPE('listener', ['EventListener', 'function'], listener);
    }
    const signal = typeof options === 'object' ? options?.signal : undefined;
    if (signal !== undefined && !signalState.has(signal)) throw new ERR_INVALID_ARG_TYPE('options.signal', 'AbortSignal', signal);
    if (signal?.aborted) return;
    const capture = captureOption(options);
    let root = this[kEvents].get(type);
    for (let node = root?.next; node; node = node.next) {
      if (node.listener === listener && node.capture === capture) return;
    }
    if (!root) this[kEvents].set(type, root = { next: undefined, last: undefined, size: 0 });
    const node = {
      listener, capture, once: !!options?.once, passive: !!options?.passive,
      resistant: !!options?.[kResistStopPropagation], previous: root.last,
      next: undefined, removed: false, abortDispose: undefined,
    };
    if (root.last) root.last.next = node;
    else root.next = node;
    root.last = node;
    root.size++;
    if (type === 'abort') updateSignalRetention(this);
    if (signal) {
      const remove = () => removeNode(this, type, node);
      signal.addEventListener('abort', remove, { once: true, [kResistStopPropagation]: true });
      node.abortDispose = () => signal.removeEventListener('abort', remove);
    }
    const events = require('events');
    const max = this[events.kMaxEventTargetListeners];
    if (max > 0 && root.size > max && !this[events.kMaxEventTargetListenersWarned]) {
      this[events.kMaxEventTargetListenersWarned] = true;
      const warning = new Error(`Possible EventTarget memory leak detected. ${root.size} ${type} listeners added to ${this.constructor.name}. MaxListeners is ${max}. Use events.setMaxListeners() to increase limit`);
      Object.assign(warning, { name: 'MaxListenersExceededWarning', target: this, type, count: root.size });
      process.emitWarning(warning);
    }
  }
  removeEventListener(type, listener, options = {}) {
    validateTarget(this);
    if (arguments.length < 2) throw new TypeError('The "type" and "listener" arguments must be specified');
    type = String(type);
    const capture = captureOption(options);
    for (let node = this[kEvents].get(type)?.next; node; node = node.next) {
      if (node.listener === listener && node.capture === capture) {
        removeNode(this, type, node);
        return;
      }
    }
  }
  dispatchEvent(event) {
    validateTarget(this);
    if (!eventState.has(event)) throw new ERR_INVALID_ARG_TYPE('event', 'Event', event);
    const state = eventData(event);
    if (state.dispatching) {
      const error = new Error(`The event "${state.type}" is already being dispatched`);
      error.code = 'ERR_EVENT_RECURSION';
      throw error;
    }
    state.dispatching = true;
    state.target = state.currentTarget = this;
    const listeners = [];
    for (let node = this[kEvents].get(state.type)?.next; node; node = node.next) listeners.push(node);
    try {
      for (const node of listeners) {
        if (node.removed || (state.immediate && !node.resistant)) continue;
        if (node.once) removeNode(this, state.type, node);
        state.passive = node.passive;
        try {
          const callback = typeof node.listener === 'function' ? node.listener : node.listener.handleEvent;
          if (typeof callback !== 'function') continue;
          const result = Reflect.apply(callback, typeof node.listener === 'function' ? this : node.listener, [event]);
          if (result !== null && result !== undefined && typeof result.then === 'function') {
            result.then(undefined, error => host.nextTick(() => { throw error; }));
          }
        } catch (error) {
          host.nextTick(() => { throw error; });
        }
      }
    } finally {
      state.dispatching = state.passive = state.stopped = state.immediate = false;
      state.currentTarget = null;
    }
    return !state.canceled;
  }
}
Object.defineProperty(EventTarget.prototype, Symbol.toStringTag, { value: 'EventTarget', configurable: true });

function signalData(signal) {
  const state = signalState.get(signal);
  if (!state) throw new TypeError('Value of this must be of AbortSignal');
  return state;
}
function abortSignal(signal, reason) {
  if (signalData(signal).aborted) return;
  const pending = [signal];
  signalData(signal).aborted = true;
  signalData(signal).reason = reason;
  for (let i = 0; i < pending.length; i++) {
    const state = signalData(pending[i]);
    for (const link of state.dependents) {
      const dependent = link.dependent.deref();
      if (!dependent) {
        unlinkSignals(link);
        continue;
      }
      const dependentState = signalData(dependent);
      if (dependentState.aborted) continue;
      dependentState.aborted = true;
      dependentState.reason = reason;
      pending.push(dependent);
    }
  }
  for (const item of pending) {
    const state = signalData(item);
    for (const link of state.sources) unlinkSignals(link);
    for (const link of state.dependents) unlinkSignals(link);
    persistentSignals.delete(item);
    const event = new Event('abort');
    eventData(event).trusted = true;
    item.dispatchEvent(event);
  }
}
class AbortSignal extends EventTarget {
  constructor(token) {
    if (token !== signalToken) {
      const error = new TypeError('Illegal constructor');
      error.code = 'ERR_ILLEGAL_CONSTRUCTOR';
      throw error;
    }
    super();
    signalState.set(this, {
      aborted: false, reason: undefined, onabort: null, handler: null,
      dependents: new Set(), sources: new Set(), composite: false, timeout: false,
      reference: new WeakRef(this),
    });
  }
  get aborted() { return signalData(this).aborted; }
  get reason() { return signalData(this).reason; }
  throwIfAborted() { const state = signalData(this); if (state.aborted) throw state.reason; }
  get onabort() { return signalData(this).onabort; }
  set onabort(callback) {
    const state = signalData(this);
    state.onabort = typeof callback === 'function' ? callback : null;
    if (state.onabort && !state.handler) {
      state.handler = event => signalData(this).onabort?.call(this, event);
      this.addEventListener('abort', state.handler);
    } else if (!state.onabort && state.handler) {
      this.removeEventListener('abort', state.handler);
      state.handler = null;
    }
  }
  static abort(reason = new DOMException('This operation was aborted', 'AbortError')) {
    const signal = new AbortSignal(signalToken);
    signalData(signal).aborted = true;
    signalData(signal).reason = reason;
    return signal;
  }
  static timeout(delay) {
    validateInteger(delay, 'delay', 0, 0xffffffff);
    const signal = new AbortSignal(signalToken);
    const state = signalData(signal);
    state.timeout = true;
    const timer = createSignalTimeout(state.reference, delay);
    timeoutCleanup.register(signal, timer, signal);
    return signal;
  }
  static any(signals) {
    if (signals === null || signals === undefined || typeof signals[Symbol.iterator] !== 'function') {
      throw new ERR_INVALID_ARG_TYPE('signals', 'Iterable', signals);
    }
    const sources = Array.from(signals);
    for (let i = 0; i < sources.length; i++) {
      if (!signalState.has(sources[i])) throw new ERR_INVALID_ARG_TYPE(`signals[${i}]`, 'AbortSignal', sources[i]);
    }
    const signal = new AbortSignal(signalToken);
    for (const source of sources) {
      if (source.aborted) return AbortSignal.abort(source.reason);
    }
    const state = signalData(signal);
    state.composite = true;
    const roots = new Set();
    for (const source of sources) {
      const sourceState = signalData(source);
      if (sourceState.composite) {
        for (const link of sourceState.sources) roots.add(link.source);
      } else {
        roots.add(sourceState.reference);
      }
    }
    for (const reference of roots) {
      const source = reference.deref();
      if (!source) continue;
      const link = { source: reference, dependent: state.reference };
      signalData(source).dependents.add(link);
      state.sources.add(link);
      sourceCleanup.register(source, link, link);
      dependentCleanup.register(signal, link, link);
      updateSignalRetention(source);
    }
    return signal;
  }
}
Object.defineProperty(AbortSignal.prototype, Symbol.toStringTag, { value: 'AbortSignal', configurable: true });
class AbortController {
  constructor() { controllerState.set(this, new AbortSignal(signalToken)); }
  get signal() {
    const signal = controllerState.get(this);
    if (!signal) throw new TypeError('Value of this must be of AbortController');
    return signal;
  }
  abort(reason = new DOMException('This operation was aborted', 'AbortError')) { abortSignal(this.signal, reason); }
}
Object.defineProperty(AbortController.prototype, Symbol.toStringTag, { value: 'AbortController', configurable: true });

module.exports = {
  Event, CustomEvent, EventTarget, AbortController, AbortSignal, DOMException,
  isEventTarget: value => targets.has(value), kEvents, kResistStopPropagation,
  isAbortSignal: value => signalState.has(value),
  createAbortSignal: () => {
    const signal = new AbortSignal(signalToken);
    signalData(signal).transferred = true;
    return signal;
  },
  closeTransferredSignal: signal => {
    signalData(signal).transferred = false;
    updateSignalRetention(signal);
  },
  abortSignal,
  isDOMException: value => exceptionState.has(value),
};
