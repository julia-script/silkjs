// Ported from Node.js v24.22.1 lib/internal/timers.js. Copyright Node.js
// contributors. MIT license (see vendor/node-api/LICENSE).
'use strict';

// HOW and WHY the timers implementation works the way it does.
//
// Timers are crucial to Node.js. Internally, any TCP I/O connection creates a
// timer so that we can time out of connections. Additionally, many user
// libraries and applications also use timers. As such there may be a
// significantly large amount of timeouts scheduled at any given time.
// Therefore, it is very important that the timers implementation is performant
// and efficient.
//
// Note: It is suggested you first read through the lib/internal/linkedlist.js
// linked list implementation, since timers depend on it extensively. It can be
// somewhat counter-intuitive at first, as it is not actually a class. Instead,
// it is a set of helpers that operate on an existing object.
//
// In order to be as performant as possible, the architecture and data
// structures are designed so that they are optimized to handle the following
// use cases as efficiently as possible:

// - Adding a new timer. (insert)
// - Removing an existing timer. (remove)
// - Handling a timer timing out. (timeout)
//
// Whenever possible, the implementation tries to make the complexity of these
// operations as close to constant-time as possible.
// (So that performance is not impacted by the number of scheduled timers.)
//
// Object maps are kept which contain linked lists keyed by their duration in
// milliseconds.
//
/* eslint-disable node-core/non-ascii-character */
//
// ╔════ > Object Map
// ║
// ╠══
// ║ lists: { '40': { }, '320': { etc } } (keys of millisecond duration)
// ╚══          ┌────┘
//              │
// ╔══          │
// ║ TimersList { _idleNext: { }, _idlePrev: (self) }
// ║         ┌────────────────┘
// ║    ╔══  │                              ^
// ║    ║    { _idleNext: { },  _idlePrev: { }, _onTimeout: (callback) }
// ║    ║      ┌───────────┘
// ║    ║      │                                  ^
// ║    ║      { _idleNext: { etc },  _idlePrev: { }, _onTimeout: (callback) }
// ╠══  ╠══
// ║    ║
// ║    ╚════ >  Actual JavaScript timeouts
// ║
// ╚════ > Linked List
//
/* eslint-enable node-core/non-ascii-character */
//
// With this, virtually constant-time insertion (append), removal, and timeout
// is possible in the JavaScript layer. Any one list of timers is able to be
// sorted by just appending to it because all timers within share the same
// duration. Therefore, any timer added later will always have been scheduled to
// timeout later, thus only needing to be appended.
// Removal from an object-property linked list is also virtually constant-time
// as can be seen in the lib/internal/linkedlist.js implementation.
// Timeouts only need to process any timers currently due to expire, which will
// always be at the beginning of the list for reasons stated above. Any timers
// after the first one encountered that does not yet need to timeout will also
// always be due to timeout at a later time.
//
// Less-than constant time operations are thus contained in two places:
// The PriorityQueue — an efficient binary heap implementation that does all
// operations in worst-case O(log n) time — which manages the order of expiring
// Timeout lists and the object map lookup of a specific list by the duration of
// timers within (or creation of a new list). However, these operations combined
// have shown to be trivial in comparison to other timers architectures.

// Differences from Node: the async resource of a Timeout or Immediate is the
// runtime's (async_hooks _createResource), kept under kAsyncResource, and
// host.invokeTimer runs a callback in it. invokeTimer reports an exception as
// uncaught (domains included) and returns whether the callback threw, so the
// queues go on with the next callback where Node unwinds to the loop and calls
// processTimers / processImmediate again; afterThrow keeps the order of Node's
// nextTick draining across that restart. The context stores a timer keeps
// (async_context_frame, or async_local_storage_context_symbol without frames)
// are the ones its async resource runs with; removeStoresFromResource lets go
// of both.

const ReflectApply = Reflect.apply;
const ObjectCreate = Object.create;
const binding = require('internal/timers_binding');
const {
  immediateInfo,
  timeoutInfo,
} = binding;
const host = require('internal/host');
const {
  _createResource: createResource,
  _newAsyncId: newAsyncId,
  _emitInit: emitInit,
  _queueDestroyId: queueDestroyId,
  _hookFields: hookFields,
} = require('async_hooks');
// async_hook_fields indexes: init callbacks, and every callback of any kind.
const kInitHooks = 0;
const kTotalHooks = 5;
const {
  symbols: {
    async_local_storage_context_symbol,
  },
} = require('internal/async_hooks');

const async_id_symbol = Symbol('asyncId');
const trigger_async_id_symbol = Symbol('triggerId');
const kAsyncResource = Symbol('asyncResource');

const kHasPrimitive = Symbol('kHasPrimitive');

const {
  ERR_OUT_OF_RANGE,
} = require('internal/errors').codes;
const {
  validateFunction,
  validateNumber,
} = require('internal/validators');

const L = require('internal/linkedlist');
const PriorityQueue = require('internal/priority_queue');

const kInspect = Symbol.for('nodejs.util.inspect.custom');
let debug = (...args) => {
  debug = require('internal/util/debuglog').debuglog('timer', (fn) => {
    debug = fn;
  });
  debug(...args);
};

const AsyncContextFrame = require('internal/async_context_frame');

const async_context_frame = Symbol('kAsyncContextFrame');
// AsyncContextFrame.enabled (a getter) fixes its answer on first use; the hot paths keep it here.
let framesEnabled;

function removeStoresFromResource(resource) {
  if (framesEnabled ??= AsyncContextFrame.enabled) {
    if (resource[async_context_frame] !== undefined) {
      resource[async_context_frame] = undefined;
    }
  } else if (resource[async_local_storage_context_symbol] !== undefined) {
    resource[async_local_storage_context_symbol] = undefined;
  }
  // The runtime's async resource holds the same stores for its callback scope.
  const asyncResource = resource[kAsyncResource];
  if (asyncResource !== undefined) {
    asyncResource.stores = undefined;
    asyncResource.scope = undefined;
  }
}

function cleanTimer(timer) {
  removeStoresFromResource(timer);
  timer._onTimeout = undefined;
  timer._timerArgs = undefined;
}

function cleanImmediate(immediate) {
  removeStoresFromResource(immediate);
  immediate._onImmediate = undefined;
  immediate._argv = undefined;
}

function enqueueRemoveStoresFromResource(resource) {
  host.enqueueMicrotask(() => removeStoresFromResource(resource));
}

function enqueueRemoveStoresIfNotReinserted(resource) {
  host.enqueueMicrotask(() => {
    if (!resource._idleNext && !resource._idlePrev)
      removeStoresFromResource(resource);
  });
}

// *Must* match Environment::ImmediateInfo::Fields in src/env.h.
const kCount = 0;
const kRefCount = 1;
const kHasOutstanding = 2;

// Timeout values > TIMEOUT_MAX are set to 1.
const TIMEOUT_MAX = 2 ** 31 - 1;

let timerListId = Number.MIN_SAFE_INTEGER;

const kRefed = Symbol('refed');

let nextExpiry = Infinity;
// timeoutInfo is an Int32Array that contains the reference count of Timeout
// objects at index 0.
timeoutInfo[0] = 0;

// This is a priority queue with a custom sorting function that first compares
// the expiry times of two lists and if they're the same then compares their
// individual IDs to determine which list was created first.
const timerListQueue = new PriorityQueue(compareTimersLists, setPosition);

// Object map containing linked lists of timers, keyed and sorted by their
// duration in milliseconds.
//
// - key = time in milliseconds
// - value = linked list
const timerListMap = { __proto__: null };

// This stores all the known timer async ids to allow users to clearTimeout and
// clearInterval using those ids, to match the spec and the rest of the web
// platform.
const knownTimersById = { __proto__: null };

function initAsyncResource(resource, type) {
  const asyncResource = createResource(type, resource);
  resource[async_id_symbol] = asyncResource.id;
  resource[trigger_async_id_symbol] = asyncResource.trigger;
  resource[kAsyncResource] = asyncResource;
  if (framesEnabled ??= AsyncContextFrame.enabled)
    resource[async_context_frame] = asyncResource.stores;
  else if (asyncResource.stores !== undefined)
    resource[async_local_storage_context_symbol] = asyncResource.stores;
}

function emitDestroy(resource) {
  const asyncResource = resource[kAsyncResource];
  // An Immediate keeps its id on itself, as Node's do (see Immediate).
  if (asyncResource === undefined) queueDestroyId(resource[async_id_symbol]);
  else asyncResource.emitDestroy();
}

let warnedNegativeNumber = false;
let warnedNotNumber = false;

class Timeout {
  // Timer constructor function.
  // The entire prototype is defined in lib/timers.js
  constructor(callback, after, args, isRepeat, isRefed) {
    if (after === undefined) {
      after = 1;
    } else {
      after *= 1; // Coalesce to number or NaN
    }

    if (!(after >= 1 && after <= TIMEOUT_MAX)) {
      if (after > TIMEOUT_MAX) {
        process.emitWarning(`${after} does not fit into` +
                            ' a 32-bit signed integer.' +
                            '\nTimeout duration was set to 1.',
                            'TimeoutOverflowWarning');
      } else if (after < 0 && !warnedNegativeNumber) {
        warnedNegativeNumber = true;
        process.emitWarning(`${after} is a negative number.` +
                            '\nTimeout duration was set to 1.',
                            'TimeoutNegativeWarning');
      } else if (Number.isNaN(after) && !warnedNotNumber) {
        warnedNotNumber = true;
        process.emitWarning(`${after} is not a number.` +
                            '\nTimeout duration was set to 1.',
                            'TimeoutNaNWarning');
      }
      after = 1; // Schedule on next tick, follows browser behavior
    }

    this._idleTimeout = after;
    this._idlePrev = this;
    this._idleNext = this;
    this._idleStart = null;
    this._onTimeout = callback;
    this._timerArgs = args;
    this._repeat = isRepeat ? after : null;
    this._destroyed = false;

    if (isRefed)
      incRefCount();
    this[kRefed] = isRefed;
    this[kHasPrimitive] = false;

    initAsyncResource(this, 'Timeout');
  }

  // Make sure the linked list only shows the minimal necessary information.
  [kInspect](_, options) {
    const { inspect } = require('internal/util/inspect');
    return inspect(this, {
      ...options,
      // Only inspect one level.
      depth: 0,
      // It should not recurse.
      customInspect: false,
    });
  }

  refresh() {
    // A suspended socket timeout is cleared as far as anything can tell: refreshing a
    // cleared timer does nothing.
    if (this._onTimeout === suspendedTimeout) return this;
    // active() or unrefActive(), by the timer's current state.
    insertGuarded(this, this[kRefed]);

    return this;
  }

  unref() {
    if (this[kRefed]) {
      this[kRefed] = false;
      if (!this._destroyed)
        decRefCount();
    }
    return this;
  }

  ref() {
    if (!this[kRefed]) {
      this[kRefed] = true;
      if (!this._destroyed)
        incRefCount();
    }
    return this;
  }

  hasRef() {
    return this[kRefed];
  }
}

class TimersList {
  constructor(expiry, msecs) {
    this._idleNext = this; // Create the list with the linkedlist properties to
    this._idlePrev = this; // Prevent any unnecessary hidden class changes.
    this.expiry = expiry;
    this.id = timerListId++;
    this.msecs = msecs;
    this.priorityQueuePosition = null;
  }

  // Make sure the linked list only shows the minimal necessary information.
  [kInspect](_, options) {
    const { inspect } = require('internal/util/inspect');
    return inspect(this, {
      ...options,
      // Only inspect one level.
      depth: 0,
      // It should not recurse.
      customInspect: false,
    });
  }
}

// A linked list for storing `setImmediate()` requests
class ImmediateList {
  constructor() {
    this.head = null;
    this.tail = null;
  }

  // Appends an item to the end of the linked list, adjusting the current tail's
  // next pointer and the item's previous pointer where applicable
  append(item) {
    if (this.tail !== null) {
      this.tail._idleNext = item;
      item._idlePrev = this.tail;
    } else {
      this.head = item;
    }
    this.tail = item;
  }

  // Removes an item from the linked list, adjusting the pointers of adjacent
  // items and the linked list's head or tail pointers as necessary
  remove(item) {
    if (item._idleNext) {
      item._idleNext._idlePrev = item._idlePrev;
    }

    if (item._idlePrev) {
      item._idlePrev._idleNext = item._idleNext;
    }

    if (item === this.head)
      this.head = item._idleNext;
    if (item === this.tail)
      this.tail = item._idlePrev;

    item._idleNext = null;
    item._idlePrev = null;
  }
}

// Create a single linked list instance only once at startup
const immediateQueue = new ImmediateList();

function incRefCount() {
  if (timeoutInfo[0]++ === 0) {
    binding.toggleTimerRef(true);
  }
}

function decRefCount() {
  if (--timeoutInfo[0] === 0) {
    binding.toggleTimerRef(false);
  }
}

// Schedule or re-schedule a timer.
// The item must have been enroll()'d first.
function active(item) {
  insertGuarded(item, true);
}

// Internal APIs that need timeouts should use `unrefActive()` instead of
// `active()` so that they do not unnecessarily keep the process open.
function unrefActive(item) {
  insertGuarded(item, false);
}

// The underlying logic for scheduling or re-scheduling a timer.
//
// Appends a timer onto the end of an existing timers list, or creates a new
// list if one does not already exist for the specified timeout duration.
function insertGuarded(item, refed) {
  const msecs = item._idleTimeout;
  if (msecs < 0 || msecs === undefined)
    return;

  insert(item, msecs);

  const isDestroyed = item._destroyed;
  if (isDestroyed || !item[async_id_symbol]) {
    item._destroyed = false;
    initAsyncResource(item, 'Timeout');
  }

  const wasRefed = item[kRefed];
  if (isDestroyed) {
    if (refed)
      incRefCount();
  } else if (refed === !wasRefed) {
    if (refed)
      incRefCount();
    else
      decRefCount();
  }
  if (wasRefed !== refed)
    item[kRefed] = refed;
}

function insert(item, msecs, start = binding.getLibuvNow()) {
  // Truncate so that accuracy of sub-millisecond timers is not assumed.
  msecs = Math.trunc(msecs);
  item._idleStart = start;

  // Use an existing list if there is one, otherwise we need to make a new one.
  let list = timerListMap[msecs];
  if (list === undefined) {
    debug('no %d list was found in insert, creating a new one', msecs);
    const expiry = start + msecs;
    timerListMap[msecs] = list = new TimersList(expiry, msecs);
    timerListQueue.insert(list);

    if (nextExpiry > expiry) {
      binding.scheduleTimer(msecs);
      nextExpiry = expiry;
    }
  }

  // Already the newest of this list (a refresh of the latest timer): appending
  // again would unlink and relink it in the same place.
  if (list._idleNext !== item)
    L.append(list, item);
}

function setUnrefTimeout(callback, after) {
  // Type checking identical to setTimeout()
  validateFunction(callback, 'callback');

  const timer = new Timeout(callback, after, undefined, false, false);
  insert(timer, timer._idleTimeout);

  return timer;
}

// Just like setUnrefTimeout() but reuses `timer` if it is a Timeout that is
// no longer scheduled (fired or cleared), avoiding the allocation of a new
// Timeout on rearm. `arg` is passed to `callback` when the timer fires.
function reuseOrCreateUnrefTimeout(timer, callback, after, arg) {
  if (timer !== undefined && timer !== null &&
      timer._destroyed && timer._repeat === null && !timer[kHasPrimitive]) {
    timer._idleTimeout = after;
    timer._onTimeout = callback;
    const args = timer._timerArgs;
    if (args === undefined) {
      timer._timerArgs = [arg];
    } else {
      args[0] = arg;
    }
    // Re-inserts the timer and re-initializes its async resource, so
    // async_hooks observes the same init/destroy sequence as if a new
    // Timeout had been allocated.
    unrefActive(timer);
    return timer;
  }

  timer = new Timeout(callback, after, [arg], false, false);
  insert(timer, timer._idleTimeout);

  return timer;
}

// A socket timeout set to 0 while it runs (an HTTP request starting on a keep-alive
// connection) and set again soon after (the response finishing) costs a destroy and a
// new async resource each time. With no async hook to see them, the timer stays in its
// list with this callback instead: it fires as a cleared timer would have been destroyed
// (listOnTimeout), and refreshUnrefTimeout() arms it again in place.
function suspendedTimeout() {}

function quietUnrefTimer(timer) {
  return timer !== undefined && timer !== null && hookFields[kTotalHooks] === 0 &&
    !timer._destroyed && timer._idleNext !== null && !timer[kRefed] &&
    timer._repeat === null && !timer[kHasPrimitive];
}

// clearTimeout(timer) for a socket timeout that may run again soon; false when the
// timer must be cleared for real.
function suspendUnrefTimeout(timer) {
  if (!quietUnrefTimer(timer) || timer._onTimeout === null) return false;
  timer._onTimeout = suspendedTimeout;
  return true;
}

// reuseOrCreateUnrefTimeout(timer, ...) for a timer still in its list with the same
// duration and async context: it restarts where it is. False when it must be replaced.
function refreshUnrefTimeout(timer, callback, after, arg) {
  // The timer's callback must run in the context a new timer would capture now.
  if (!quietUnrefTimer(timer) || timer._idleTimeout !== after || timer._onTimeout === null ||
      timer[kAsyncResource]?.stores !== host.getAsyncContext()?.stores) return false;
  const args = timer._timerArgs;
  if (args === undefined || args.length !== 1) return false;
  timer._onTimeout = callback;
  args[0] = arg;
  insert(timer, after);
  return true;
}

// Type checking used by timers.enroll() and Socket#setTimeout()
function getTimerDuration(msecs, name) {
  validateNumber(msecs, name);
  if (msecs < 0 || !Number.isFinite(msecs)) {
    throw new ERR_OUT_OF_RANGE(name, 'a non-negative finite number', msecs);
  }

  // Ensure that msecs fits into signed int32
  if (msecs > TIMEOUT_MAX) {
    process.emitWarning(`${msecs} does not fit into a 32-bit signed integer.` +
                        `\nTimer duration was truncated to ${TIMEOUT_MAX}.`,
                        'TimeoutOverflowWarning');
    return TIMEOUT_MAX;
  }

  return msecs;
}

function compareTimersLists(a, b) {
  const expiryDiff = a.expiry - b.expiry;
  if (expiryDiff === 0) {
    return a.id - b.id;
  }
  return expiryDiff;
}

function setPosition(node, pos) {
  node.priorityQueuePosition = pos;
}

const noArguments = [];
// An immediate's callback under async hooks, cleared on a throw as in the inline path.
function runImmediate() {
  const argv = this._argv;
  try {
    if (argv === undefined) this._onImmediate();
    else ReflectApply(this._onImmediate, this, argv);
  } catch (error) {
    this._onImmediate = undefined;
    this._argv = undefined;
    // A plain rethrow would move the throw site the uncaught report prints.
    host.rethrow(error);
  }
}

function getTimerCallbacks(runNextTicks) {
  // Set when a callback threw, until the next callback runs: Node unwinds to the
  // loop then and starts the queue again without draining nextTicks first.
  let afterThrow = false;

  // One Immediate that the native queue (ext/immediates) does not run itself: one made by
  // the constructor (async hooks, async context stores), with more arguments than it
  // takes, or whose shape changed. Returns whether its callback threw (afterThrow).
  function runSlowImmediate(context, immediate) {
    // It's possible for this Immediate to have been cleared by an earlier callback or
    // the tick queue between them: Node skips it.
    if (immediate._destroyed) return false;
    afterThrow = false;
    immediate._destroyed = true;
    host.immediateSettle(immediate[kRefed] === true);
    immediate[kRefed] = null;

    const argv = immediate._argv;
    // The callback's async context, as an InternalResource would build it.
    const scope = {
      stores: framesEnabled ? immediate[async_context_frame] : immediate[async_local_storage_context_symbol],
      id: immediate[async_id_symbol],
      trigger: immediate[trigger_async_id_symbol],
      resource: immediate,
    };
    if (hookFields[kTotalHooks] === 0) {
      // No hook observes it: host.invokeImmediate's work, inline.
      host.setAsyncContext(scope);
      try {
        try {
          if (argv === undefined) immediate._onImmediate();
          else ReflectApply(immediate._onImmediate, immediate, argv);
          afterThrow = false;
        } catch (error) {
          // Node's processImmediate clears these before the error reaches the
          // uncaught handler, which formats its stack: V8 looks method names up
          // then, so the callback's frame reads "Immediate.<anonymous>".
          immediate._onImmediate = undefined;
          immediate._argv = undefined;
          host.triggerUncaughtException(error);
          afterThrow = true;
        }
      } finally {
        host.setAsyncContext(context);
      }
    } else {
      afterThrow = host.invokeImmediate(context, scope, scope.id, runImmediate, immediate, noArguments);
    }
    if (afterThrow) {
      immediate._onImmediate = undefined;
      immediate._argv = undefined;
      enqueueRemoveStoresFromResource(immediate);
    } else {
      cleanImmediate(immediate);
    }

    emitDestroy(immediate);
    return afterThrow;
  }

  // The check phase's processImmediate runs in the native queue; it answers -1 until it
  // is set up (in a process that starts from the heap image, the native side starts empty).
  function processImmediate() {
    const refs = host.immediateRun();
    if (refs !== -1) return refs;
    setupNative();
    return host.immediateRun();
  }
  setupNative = () => host.immediateSetup(immediateTemplate(), immediateScopeTemplate, runSlowImmediate, immediateThrew, runNextTicks);

  function processTimers(now) {
    debug('process timer lists %d', now);
    nextExpiry = Infinity;

    let list;
    let ranAtLeastOneList = false;
    while ((list = timerListQueue.peek()) != null) {
      if (list.expiry > now) {
        nextExpiry = list.expiry;
        return timeoutInfo[0] > 0 ? nextExpiry : -nextExpiry;
      }
      if (ranAtLeastOneList && !afterThrow)
        runNextTicks();
      else
        ranAtLeastOneList = true;
      listOnTimeout(list, now);
    }
    return 0;
  }

  function listOnTimeout(list, now) {
    const msecs = list.msecs;

    debug('timeout callback %d', msecs);

    let ranAtLeastOneTimer = false;
    let timer;
    while ((timer = L.peek(list)) != null) {
      const diff = now - timer._idleStart;

      // Check if this loop iteration is too early for the next timer.
      // This happens if there are more timers scheduled for later in the list.
      if (diff < msecs) {
        list.expiry = Math.max(timer._idleStart + msecs, now + 1);
        list.id = timerListId++;
        timerListQueue.percolateDown(1);
        debug('%d list wait because diff is %d', msecs, diff);
        return;
      }

      if (ranAtLeastOneTimer && !afterThrow)
        runNextTicks();
      else
        ranAtLeastOneTimer = true;
      afterThrow = false;

      // The actual logic for when a timeout happens.
      L.remove(timer);

      const asyncId = timer[async_id_symbol];

      if (!timer._onTimeout || timer._onTimeout === suspendedTimeout) {
        if (!timer._destroyed) {
          timer._destroyed = true;

          cleanTimer(timer);

          if (timer[kHasPrimitive])
            delete knownTimersById[asyncId];

          if (timer[kRefed])
            timeoutInfo[0]--;

          emitDestroy(timer);
        }
        continue;
      }

      let start;
      if (timer._repeat) {
        start = binding.getLibuvNow();
      }

      const args = timer._timerArgs;
      const threw = afterThrow = host.invokeTimer(timer[kAsyncResource], timer._onTimeout, timer,
                                                  args === undefined ? noArguments : args);
      if (timer._repeat && timer._idleTimeout !== -1) {
        timer._idleTimeout = timer._repeat;
        insert(timer, timer._idleTimeout, start);
      } else if (!timer._idleNext && !timer._idlePrev) {
        if (timer._destroyed) {
          timer._onTimeout = undefined;
          timer._timerArgs = undefined;
          if (threw)
            enqueueRemoveStoresIfNotReinserted(timer);
          else
            removeStoresFromResource(timer);
        } else {
          if (threw)
            enqueueRemoveStoresIfNotReinserted(timer);
          else
            removeStoresFromResource(timer);

          timer._destroyed = true;

          if (timer[kHasPrimitive])
            delete knownTimersById[asyncId];

          if (timer[kRefed])
            timeoutInfo[0]--;

          emitDestroy(timer);
        }
      }
    }

    // If `L.peek(list)` returned nothing, the list was either empty or we have
    // called all of the timer timeouts.
    // As such, we can remove the list from the object map and
    // the PriorityQueue.
    debug('%d list empty', msecs);

    // The current list may have been removed and recreated since the reference
    // to `list` was created. Make sure they're the same instance of the list
    // before destroying.
    if (list === timerListMap[msecs]) {
      delete timerListMap[msecs];
      timerListQueue.shift();
    }
  }

  return {
    processImmediate,
    processTimers,
  };
}

// An Immediate is its own async resource, as in Node: its id, trigger and stores are its
// own symbol properties (initAsyncResource keeps a Timeout's in a runtime resource), and
// processImmediate builds the callback's context from them.
class Immediate {
  // id: an async id createImmediate already took for its native try.
  constructor(callback, args, id) {
    this._idleNext = null;
    this._idlePrev = null;
    this._onImmediate = callback;
    this._argv = args;
    this._destroyed = false;
    // this.ref(), inline.
    this[kRefed] = true;
    if (host.immediateRefs(1) === 1) {
      binding.toggleImmediateRef(true);
    }

    const context = host.getAsyncContext();
    const asyncId = id ?? newAsyncId();
    const triggerId = context?.id ?? 1;
    this[async_id_symbol] = asyncId;
    this[trigger_async_id_symbol] = triggerId;
    const stores = context?.stores;
    if (framesEnabled ??= AsyncContextFrame.enabled)
      this[async_context_frame] = stores;
    else if (stores !== undefined)
      this[async_local_storage_context_symbol] = stores;
    if (hookFields[kInitHooks] !== 0)
      emitInit(asyncId, 'Immediate', triggerId, this);

    host.immediateEnqueue(this);
  }

  ref() {
    if (this[kRefed] === false) {
      this[kRefed] = true;

      if (host.immediateRefs(1) === 1) {
        binding.toggleImmediateRef(true);
      }
    }
    return this;
  }

  unref() {
    if (this[kRefed] === true) {
      this[kRefed] = false;
      if (host.immediateRefs(-1) === 0) {
        binding.toggleImmediateRef(false);
      }
    }
    return this;
  }

  hasRef() {
    return !!this[kRefed];
  }
}

// The native queue's (ext/immediates) templates: a plain Immediate, with the
// constructor's own properties in its order, and the async context processImmediate
// builds around its callback.
function immediateTemplate() {
  const template = ObjectCreate(Immediate.prototype);
  template._idleNext = null;
  template._idlePrev = null;
  template._onImmediate = undefined;
  template._argv = undefined;
  template._destroyed = false;
  template[kRefed] = true;
  template[async_id_symbol] = 0;
  template[trigger_async_id_symbol] = 0;
  if (framesEnabled ??= AsyncContextFrame.enabled) template[async_context_frame] = undefined;
  return template;
}
const immediateScopeTemplate = { stores: undefined, id: 0, trigger: 0, resource: undefined };
// Set up once processImmediate first runs (and again in a process that starts from the
// heap image, whose native queue starts empty).
let setupNative;
// A plain Immediate's callback threw: processImmediate's catch.
function immediateThrew(immediate, error) {
  immediate._onImmediate = undefined;
  immediate._argv = undefined;
  host.triggerUncaughtException(error);
}
// setImmediate's Immediate when its own try at the native queue (host.immediateCreate
// with id) did not make one: false before the queue is set up, undefined for an
// Immediate the queue does not take. Without an id, the constructor's.
function createImmediate(callback, argv, id, made) {
  if (id !== undefined && made === false && setupNative !== undefined && setupNative()) {
    const immediate = host.immediateCreate(callback, argv, id);
    if (typeof immediate === 'object') {
      host.timerLoop.state.immediateRefed = true;
      return immediate;
    }
  }
  return new Immediate(callback, argv, id);
}

module.exports = {
  TIMEOUT_MAX,
  kTimeout: Symbol('timeout'), // For hiding Timeouts on other internals.
  async_id_symbol,
  trigger_async_id_symbol,
  async_context_frame,
  kAsyncResource,
  Timeout,
  Immediate,
  cleanImmediate,
  cleanTimer,
  emitDestroy,
  kRefed,
  kHasPrimitive,
  initAsyncResource,
  setUnrefTimeout,
  reuseOrCreateUnrefTimeout,
  suspendUnrefTimeout,
  refreshUnrefTimeout,
  getTimerDuration,
  immediateQueue,
  getTimerCallbacks,
  createImmediate,
  immediateInfoFields: {
    kCount,
    kRefCount,
    kHasOutstanding,
  },
  active,
  unrefActive,
  insert,
  timerListMap,
  timerListQueue,
  decRefCount,
  incRefCount,
  knownTimersById,
};
