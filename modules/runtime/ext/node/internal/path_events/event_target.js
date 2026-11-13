'use strict';

const { validateInteger } = require('internal/path_events/support');
const { ArrayPrototypePush } = require('internal/per_context/primordials');
// Event, CustomEvent and EventTarget are Node's (internal/event_target); this module adds
// the runtime's AbortSignal, AbortController and DOMException on top of them.
const {
  Event, CustomEvent, EventTarget, isEventTarget, kEvents, kResistStopPropagation, kTrustEvent,
  kNewListener, kRemoveListener, defineEventHandler,
} = require('internal/event_target');
// AbortSignal and AbortController follow Node.js v24.22.1 lib/internal/abort_controller.js:
// state under the same symbols, composite signals that follow their sources through
// WeakRefs in kSourceSignals/kDependantSignals, and gcPersistentSignals for observed
// timeout and composite signals. The runtime's structured clone carries transferred
// signals (internal/abort_controller), so a received signal also stays alive while it
// is observed or followed, until its port closes (kTransferred).
const signalToken = Symbol('kDontThrowSymbol');
const kAborted = Symbol('kAborted');
const kReason = Symbol('kReason');
const kTimeout = Symbol('kTimeout');
const kComposite = Symbol('kComposite');
const kFollowing = Symbol('kFollowing');
const kResultSignalWeakRef = Symbol('kResultSignalWeakRef');
const kSourceSignals = Symbol('kSourceSignals');
const kDependantSignals = Symbol('kDependantSignals');
const kTransferred = Symbol('kTransferred');
// Node's #brand: only constructed signals, not a Proxy of one or an object inheriting from one.
const signalBrands = new WeakSet();

const clearTimeoutRegistry = new FinalizationRegistry(timer => clearTimeout(timer));
const dependantSignalsCleanupRegistry = new FinalizationRegistry(
  ({ sourceSignalRef, dependantSignalRef, sourceSignalsCleanupToken }) => {
    sourceSignalsCleanupRegistry.unregister(sourceSignalsCleanupToken);

    const sourceSignal = sourceSignalRef.deref();
    if (sourceSignal === undefined) {
      return;
    }
    sourceSignal[kDependantSignals].delete(dependantSignalRef);
    updateTransferredRetention(sourceSignal);
  });

const gcPersistentSignals = new Set();

const sourceSignalsCleanupRegistry = new FinalizationRegistry(({ sourceSignalRef, composedSignalRef }) => {
  const composedSignal = composedSignalRef.deref();
  if (composedSignal !== undefined) {
    composedSignal[kSourceSignals].delete(sourceSignalRef);

    if (composedSignal[kSourceSignals].size === 0) {
      // This signal will no longer abort. There's no need to keep it in the gcPersistentSignals set.
      gcPersistentSignals.delete(composedSignal);
    }
  }
});

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

function isAbortSignal(value) {
  return ((typeof value === 'object' && value !== null) || typeof value === 'function') && value[kAborted] !== undefined;
}
function validateThisAbortSignal(obj) {
  if (obj?.[kAborted] === undefined) {
    const error = new TypeError('Value of "this" must be of type AbortSignal');
    error.code = 'ERR_INVALID_THIS';
    throw error;
  }
}

// A received transferred signal can be aborted only through its port, which holds it weakly:
// it stays alive while something could still observe that abort.
function hasStrongAbortListener(signal) {
  for (let node = signal[kEvents]?.get('abort')?.next; node !== undefined; node = node.next) {
    if (!node.removed && !node.weak) return true;
  }
  return false;
}
function updateTransferredRetention(signal, added = false) {
  if (!signal[kTransferred]) return;
  if (!signal[kAborted] && (added || signal[kDependantSignals]?.size > 0 || hasStrongAbortListener(signal))) {
    gcPersistentSignals.add(signal);
  } else {
    gcPersistentSignals.delete(signal);
  }
}

function refreshCompositeSignal(signal) {
  if (!signal[kComposite] || signal[kAborted] || !signal[kSourceSignals]?.size) {
    return;
  }

  for (const sourceSignalWeakRef of signal[kSourceSignals]) {
    const sourceSignal = sourceSignalWeakRef.deref();
    if (sourceSignal === undefined) {
      signal[kSourceSignals].delete(sourceSignalWeakRef);
      continue;
    }

    if (sourceSignal[kAborted]) {
      abortSignal(signal, sourceSignal[kReason]);
      return;
    }
  }
}

function followCompositeSignal(signal) {
  if (signal[kFollowing] || signal[kAborted] || !signal[kSourceSignals]?.size) {
    return;
  }

  const resultSignalWeakRef = signal[kResultSignalWeakRef] ??= new WeakRef(signal);

  for (const sourceSignalWeakRef of signal[kSourceSignals]) {
    const sourceSignal = sourceSignalWeakRef.deref();
    if (sourceSignal === undefined) {
      signal[kSourceSignals].delete(sourceSignalWeakRef);
      continue;
    }

    if (sourceSignal[kAborted]) {
      abortSignal(signal, sourceSignal[kReason]);
      return;
    }

    sourceSignal[kDependantSignals] ??= new Set();
    sourceSignal[kDependantSignals].add(resultSignalWeakRef);
    updateTransferredRetention(sourceSignal);
    dependantSignalsCleanupRegistry.register(signal, {
      sourceSignalRef: sourceSignalWeakRef,
      dependantSignalRef: resultSignalWeakRef,
      sourceSignalsCleanupToken: sourceSignalWeakRef,
    });
    sourceSignalsCleanupRegistry.register(sourceSignal, {
      sourceSignalRef: sourceSignalWeakRef,
      composedSignalRef: resultSignalWeakRef,
    }, sourceSignalWeakRef);
  }

  signal[kFollowing] = true;
}

// Because the AbortSignal timeout cannot be canceled, we don't want the
// presence of the timer alone to keep the AbortSignal from being garbage
// collected if it otherwise no longer accessible. We also don't want the
// timer to keep the Node.js process open on it's own. Therefore, we wrap
// the AbortSignal in a WeakRef and have the setTimeout callback close
// over the WeakRef rather than directly over the AbortSignal, and we unref
// the created timer object. Separately, we add the signal to a
// FinalizerRegistry that will clear the timeout when the signal is gc'd.
function setWeakAbortSignalTimeout(weakRef, delay) {
  const timeout = setTimeout(() => {
    const signal = weakRef.deref();
    if (signal !== undefined) {
      clearTimeoutRegistry.unregister(signal);
      gcPersistentSignals.delete(signal);
      abortSignal(
        signal,
        new DOMException(
          'The operation was aborted due to timeout',
          'TimeoutError'));
    }
  }, delay);
  timeout.unref();
  return timeout;
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

// https://dom.spec.whatwg.org/#dom-abortsignal-abort
function abortSignal(signal, reason) {
  // 1. If signal is aborted, then return.
  if (signal[kAborted]) return;

  // 2. Set signal's abort reason to reason if it is given;
  //    otherwise to a new "AbortError" DOMException.
  signal[kAborted] = true;
  signal[kReason] = reason;

  // 3. Let dependentSignalsToAbort be a new list.
  const dependentSignalsToAbort = Object.setPrototypeOf([], null);

  // 4. For each dependentSignal of signal's dependent signals:
  signal[kDependantSignals]?.forEach((s) => {
    const dependentSignal = s.deref();
    // 1. If dependentSignal is not aborted, then:
    if (dependentSignal && !dependentSignal[kAborted]) {
      // 1. Set dependentSignal's abort reason to signal's abort reason.
      dependentSignal[kReason] = reason;
      dependentSignal[kAborted] = true;
      // 2. Append dependentSignal to dependentSignalsToAbort.
      ArrayPrototypePush(dependentSignalsToAbort, dependentSignal);
    }
  });

  // 5. Run the abort steps for signal
  runAbort(signal);

  // 6. For each dependentSignal of dependentSignalsToAbort,
  //    run the abort steps for dependentSignal.
  for (let i = 0; i < dependentSignalsToAbort.length; i++) {
    const dependentSignal = dependentSignalsToAbort[i];
    runAbort(dependentSignal);
    // A transitively-aborted dependent signal can never abort again, so there
    // is no longer any reason to keep it alive.
    gcPersistentSignals.delete(dependentSignal);
  }

  // Clean up the signal from gcPersistentSignals
  gcPersistentSignals.delete(signal);

  // If this is a composite signal, also remove all of its source signals from gcPersistentSignals
  // when they get dereferenced from the signal's kSourceSignals set
  if (signal[kComposite] && signal[kSourceSignals]) {
    signal[kSourceSignals].forEach((sourceWeakRef) => {
      const sourceSignal = sourceWeakRef.deref();
      if (sourceSignal) {
        gcPersistentSignals.delete(sourceSignal);
      }
    });
  }
}

// To run the abort steps for an AbortSignal signal
function runAbort(signal) {
  const event = new Event('abort', {
    [kTrustEvent]: true,
  });
  signal.dispatchEvent(event);
}

let sequenceOfSignals;
class AbortSignal extends EventTarget {
  constructor(dontThrowSymbol = undefined, init = undefined) {
    if (dontThrowSymbol !== signalToken) {
      const error = new TypeError('Illegal constructor');
      error.code = 'ERR_ILLEGAL_CONSTRUCTOR';
      throw error;
    }
    super();
    signalBrands.add(this);

    this[require('events').kMaxEventTargetListeners] = 0;
    this[kAborted] = init?.aborted ?? false;
    this[kReason] = init?.reason;
    this[kComposite] = init?.composite ?? false;
  }

  get aborted() {
    validateThisAbortSignal(this);
    refreshCompositeSignal(this);
    return !!this[kAborted];
  }

  get reason() {
    validateThisAbortSignal(this);
    refreshCompositeSignal(this);
    return this[kReason];
  }

  throwIfAborted() {
    validateThisAbortSignal(this);
    refreshCompositeSignal(this);
    if (this[kAborted]) {
      throw this[kReason];
    }
  }

  [customInspectSymbol](depth, options) {
    return customInspect(this, {
      aborted: this.aborted,
    }, depth, options);
  }

  static abort(
    reason = new DOMException('This operation was aborted', 'AbortError')) {
    return new AbortSignal(signalToken, { aborted: true, reason });
  }

  static timeout(delay) {
    validateInteger(delay, 'delay', 0, 0xffffffff);
    const signal = new AbortSignal(signalToken);
    signal[kTimeout] = true;
    clearTimeoutRegistry.register(
      signal,
      setWeakAbortSignalTimeout(new WeakRef(signal), delay),
      signal);
    return signal;
  }

  static any(signals) {
    const { converters, createSequenceConverter } = require('internal/webidl');
    sequenceOfSignals ??= createSequenceConverter(converters.AbortSignal);
    const signalsArray = sequenceOfSignals(
      signals,
      { __proto__: null, context: 'signals' },
    );

    const resultSignal = new AbortSignal(signalToken, { composite: true });
    if (!signalsArray.length) {
      return resultSignal;
    }

    resultSignal[kSourceSignals] = new Set();

    // Track if we have any timeout signals
    let hasTimeoutSignals = false;

    for (let i = 0; i < signalsArray.length; i++) {
      const signal = signalsArray[i];

      // Check if this is a timeout signal
      if (signal[kTimeout]) {
        hasTimeoutSignals = true;

        // Add the timeout signal to gcPersistentSignals to keep it alive
        // This is what the kNewListener method would do when adding abort listeners
        gcPersistentSignals.add(signal);
      }

      refreshCompositeSignal(signal);
      if (signal[kAborted]) {
        abortSignal(resultSignal, signal[kReason]);
        return resultSignal;
      }

      if (!signal[kComposite]) {
        const signalWeakRef = new WeakRef(signal);
        resultSignal[kSourceSignals].add(signalWeakRef);
      } else if (!signal[kSourceSignals]) {
        continue;
      } else {
        for (const sourceSignalWeakRef of signal[kSourceSignals]) {
          const sourceSignal = sourceSignalWeakRef.deref();
          if (!sourceSignal) {
            continue;
          }

          if (sourceSignal[kAborted]) {
            abortSignal(resultSignal, sourceSignal[kReason]);
            return resultSignal;
          }

          if (resultSignal[kSourceSignals].has(sourceSignalWeakRef)) {
            continue;
          }
          resultSignal[kSourceSignals].add(sourceSignalWeakRef);
        }
      }
    }

    if (hasTimeoutSignals && resultSignal[kSourceSignals].size > 0) {
      resultSignal[kTimeout] = true;
    }

    // Preserve abort state even if sources are collected before this signal is
    // observed. Following uses weak references so unused signals can be collected.
    followCompositeSignal(resultSignal);

    return resultSignal;
  }

  [kNewListener](size, type, listener, once, capture, passive, weak) {
    super[kNewListener](size, type, listener, once, capture, passive, weak);

    if (this[kComposite] && type === 'abort' && !this.aborted && size === 1) {
      followCompositeSignal(this);
    }

    const isTimeoutOrNonEmptyCompositeSignal = this[kTimeout] || (this[kComposite] && this[kSourceSignals]?.size);
    if (isTimeoutOrNonEmptyCompositeSignal &&
        type === 'abort' &&
        !this.aborted &&
        !weak &&
        size === 1) {
      // If this is a timeout signal, or a non-empty composite signal, and we're adding a non-weak abort
      // listener, then we don't want it to be gc'd while the listener
      // is attached and the timer still hasn't fired. So, we retain a
      // strong ref that is held for as long as the listener is registered.
      gcPersistentSignals.add(this);
    }
    if (type === 'abort' && !weak) updateTransferredRetention(this, true);
  }

  [kRemoveListener](size, type, listener, capture) {
    super[kRemoveListener](size, type, listener, capture);
    const isTimeoutOrNonEmptyCompositeSignal = this[kTimeout] || (this[kComposite] && this[kSourceSignals]?.size);
    if (isTimeoutOrNonEmptyCompositeSignal && type === 'abort' && size === 0) {
      gcPersistentSignals.delete(this);
    }
    if (type === 'abort') updateTransferredRetention(this);
  }
}
Object.defineProperty(AbortSignal.prototype, 'aborted', { enumerable: true });
Object.defineProperty(AbortSignal.prototype, Symbol.toStringTag, { value: 'AbortSignal', configurable: true });
defineEventHandler(AbortSignal.prototype, 'abort');

class AbortController {
  #signal;

  get signal() {
    this.#signal ??= new AbortSignal(signalToken);

    return this.#signal;
  }

  abort(reason = new DOMException('This operation was aborted', 'AbortError')) {
    abortSignal(this.#signal ??= new AbortSignal(signalToken), reason);
  }

  [customInspectSymbol](depth, options) {
    return customInspect(this, {
      signal: this.signal,
    }, depth, options);
  }
}
Object.defineProperty(AbortController.prototype, 'signal', { enumerable: true });
Object.defineProperty(AbortController.prototype, 'abort', { enumerable: true });

module.exports = {
  Event, CustomEvent, EventTarget, AbortController, AbortSignal, DOMException,
  isEventTarget, kEvents, kResistStopPropagation,
  isAbortSignal,
  isAbortSignalInstance: value => signalBrands.has(value),
  createAbortSignal: () => {
    const signal = new AbortSignal(signalToken);
    signal[kTransferred] = true;
    return signal;
  },
  closeTransferredSignal: signal => {
    signal[kTransferred] = false;
    gcPersistentSignals.delete(signal);
  },
  abortSignal,
  isDOMException: value => exceptionState.has(value),
};
