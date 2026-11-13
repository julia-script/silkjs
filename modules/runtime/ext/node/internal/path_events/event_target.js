'use strict';

const { validateInteger } = require('internal/path_events/support');
// Event, CustomEvent and EventTarget are Node's (internal/event_target); this module adds
// the runtime's AbortSignal, AbortController and DOMException on top of them.
const {
  Event, CustomEvent, EventTarget, isEventTarget, kEvents, kResistStopPropagation, kTrustEvent,
  kNewListener, kRemoveListener,
} = require('internal/event_target');
// AbortSignal state lives under a symbol on the signal, as Node keeps kAborted and kReason, so
// the brand check also passes for a Proxy of a signal.
const kSignalState = Symbol('kSignalState');
const signalState = {
  get(value) { return (typeof value === 'object' && value !== null) || typeof value === 'function' ? value[kSignalState] : undefined; },
  has(value) { return signalState.get(value) !== undefined; },
};
// Node's #brand: only constructed signals, not a Proxy of one or an object inheriting from one.
const signalBrands = new WeakSet();
const controllerState = new WeakMap();
const signalToken = {};

// Composite dependencies are weak in both directions. Observed composites
// remain alive only while a live source can still trigger their listeners.
const persistentSignals = new Set();
const sourceCleanup = new FinalizationRegistry(unlinkSignals);
const dependentCleanup = new FinalizationRegistry(unlinkSignals);
const timeoutCleanup = new FinalizationRegistry(timer => clearTimeout(timer));

// Whether a listener that is not weak (kWeakHandler) waits for abort: only those keep a
// timeout or composite signal alive, as in Node. `added` is one just added, which
// EventTarget announces before the first listener's list is in kEvents.
function strongAbortListener(signal) {
  for (let node = signal[kEvents]?.get('abort')?.next; node !== undefined; node = node.next) {
    if (!node.removed && !node.weak) return true;
  }
  return false;
}
// Node's lib/internal/abort_controller.js customInspect.
function customInspect(self, obj, depth, options) {
  if (depth < 0)
    return self;

  const opts = Object.assign({}, options, {
    depth: options.depth === null ? null : options.depth - 1,
  });

  return `${self.constructor.name} ${require('internal/util/inspect').inspect(obj, opts)}`;
}
const customInspectSymbol = Symbol.for('nodejs.util.inspect.custom');

function updateSignalRetention(signal, added = false) {
  const state = signalState.get(signal);
  if (!state) return;
  const observed = added || strongAbortListener(signal);
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
const { kDeserialize } = require('internal/worker/js_transferable');
const exceptionState = new WeakMap();
class DOMException extends Error {
  constructor(message = '', options = 'Error') {
    message = `${message}`;
    super(message);
    delete this.message;
    if (options && typeof options === 'object') {
      const { name } = options;
      exceptionState.set(this, { message, name: `${name}` });
      if ('cause' in options) {
        Object.defineProperty(this, 'cause', { value: options.cause, configurable: true, writable: true, enumerable: false });
      }
    } else {
      exceptionState.set(this, { message, name: `${options}` });
    }
  }
  get name() { return exceptionData(this).name; }
  get message() { return exceptionData(this).message; }
  get code() { return exceptionNames.indexOf(exceptionData(this).name) + 1; }
  // Node's per-context DOMException: a cloned one (internal/worker/clone_dom_exception)
  // gets its name, message and stack back here.
  [kDeserialize](data) {
    exceptionState.set(this, { message: data.message, name: data.name });
    this.stack = data.stack;
  }
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
    item.dispatchEvent(new Event('abort', { [kTrustEvent]: true }));
  }
}
let sequenceOfSignals;
class AbortSignal extends EventTarget {
  constructor(token) {
    if (token !== signalToken) {
      const error = new TypeError('Illegal constructor');
      error.code = 'ERR_ILLEGAL_CONSTRUCTOR';
      throw error;
    }
    super();
    signalBrands.add(this);
    // Signals warn about no listener count (Node: kMaxEventTargetListeners = 0).
    this[require('events').kMaxEventTargetListeners] = 0;
    Object.defineProperty(this, kSignalState, { value: {
      aborted: false, reason: undefined, onabort: null, handler: null,
      dependents: new Set(), sources: new Set(), composite: false, timeout: false,
      reference: new WeakRef(this),
    }, writable: true });
  }
  [kNewListener](size, type, listener, once, capture, passive, weak) {
    super[kNewListener](size, type, listener, once, capture, passive, weak);
    if (type === 'abort') updateSignalRetention(this, !weak);
  }
  [kRemoveListener](size, type, listener, capture) {
    super[kRemoveListener](size, type, listener, capture);
    if (type === 'abort') updateSignalRetention(this);
  }
  [customInspectSymbol](depth, options) {
    return customInspect(this, { aborted: this.aborted }, depth, options);
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
    // Node's converters['sequence<AbortSignal>'] (lib/internal/abort_controller.js).
    const { converters, createSequenceConverter } = require('internal/webidl');
    sequenceOfSignals ??= createSequenceConverter(converters.AbortSignal);
    const sources = sequenceOfSignals(signals, { __proto__: null, context: 'signals' });
    const signal = new AbortSignal(signalToken);
    for (const source of sources) {
      // The internal state, not the getters: a source may have its own aborted or reason.
      const sourceState = signalData(source);
      if (sourceState.aborted) return AbortSignal.abort(sourceState.reason);
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
  [customInspectSymbol](depth, options) {
    return customInspect(this, { signal: this.signal }, depth, options);
  }
}
Object.defineProperty(AbortController.prototype, Symbol.toStringTag, { value: 'AbortController', configurable: true });

module.exports = {
  Event, CustomEvent, EventTarget, AbortController, AbortSignal, DOMException,
  isEventTarget, kEvents, kResistStopPropagation,
  isAbortSignal: value => signalState.has(value),
  isAbortSignalInstance: value => signalBrands.has(value),
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
