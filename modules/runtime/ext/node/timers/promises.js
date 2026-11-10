'use strict';

const timers = require('timers');
const {
  AbortError, validateNumber, validateObject, validateBoolean, validateAbortSignal,
  kEmptyObject,
} = require('internal/path_events/support');
const { kResistStopPropagation } = require('internal/path_events/event_target');

function optionsFor(options) {
  validateObject(options, 'options');
  const { signal, ref = true } = options;
  validateAbortSignal(signal, 'options.signal');
  validateBoolean(ref, 'options.ref');
  return { signal, ref };
}
function aborted(signal) { return new AbortError(undefined, { cause: signal.reason }); }
function schedule(immediate, delay, value, options) {
  return new Promise((resolve, reject) => {
    if (!immediate && delay !== undefined) validateNumber(delay, 'delay');
    const { signal, ref } = optionsFor(options);
    if (signal?.aborted) { reject(aborted(signal)); return; }
    const clear = immediate ? timers.clearImmediate : timers.clearTimeout;
    let settled = false;
    function cleanup() { signal?.removeEventListener('abort', onAbort); }
    function finish() {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }
    function onAbort() {
      if (settled) return;
      settled = true;
      clear(timer);
      cleanup();
      reject(aborted(signal));
    }
    const timer = immediate ? timers.setImmediate(finish) : timers.setTimeout(finish, delay);
    if (!ref) timer.unref();
    try {
      signal?.addEventListener('abort', onAbort, { once: true, [kResistStopPropagation]: true });
    } catch (error) {
      clear(timer);
      reject(error);
    }
  });
}
function setTimeout(delay, value, options = kEmptyObject) { return schedule(false, delay, value, options); }
function setImmediate(value, options = kEmptyObject) { return schedule(true, undefined, value, options); }

async function* setInterval(delay, value, options = kEmptyObject) {
  if (delay !== undefined) validateNumber(delay, 'delay');
  const { signal, ref } = optionsFor(options);
  if (signal?.aborted) throw aborted(signal);
  // Count elapsed ticks, not queued values/promises: a stalled consumer retains
  // constant space, and every elapsed tick is yielded when it resumes.
  let pending = 0;
  let wake;
  const timer = timers.setInterval(() => {
    if (pending < Number.MAX_SAFE_INTEGER) pending++;
    if (wake) { const resolve = wake; wake = undefined; resolve(); }
  }, delay);
  if (!ref) timer.unref();
  function onAbort() {
    timers.clearInterval(timer);
    if (wake) { const resolve = wake; wake = undefined; resolve(); }
  }
  try {
    signal?.addEventListener('abort', onAbort, { once: true, [kResistStopPropagation]: true });
    while (!signal?.aborted) {
      if (pending === 0) {
        await new Promise(resolve => { wake = resolve; });
        if (signal?.aborted) break;
      }
      while (pending > 0) {
        pending--;
        yield value;
      }
    }
    throw aborted(signal);
  } finally {
    timers.clearInterval(timer);
    wake = undefined;
    signal?.removeEventListener('abort', onAbort);
  }
}

const schedulers = new WeakSet();
function checkScheduler(value) {
  if (!schedulers.has(value)) throw Object.assign(new TypeError('Value of "this" must be of type Scheduler'), { code: 'ERR_INVALID_THIS' });
}
class Scheduler {
  constructor() { throw Object.assign(new TypeError('Illegal constructor'), { code: 'ERR_ILLEGAL_CONSTRUCTOR' }); }
  yield() { checkScheduler(this); return setImmediate(); }
  wait(delay, options) { checkScheduler(this); return setTimeout(delay, undefined, options); }
}
const scheduler = Object.create(Scheduler.prototype);
schedulers.add(scheduler);
module.exports = { setTimeout, setImmediate, setInterval, scheduler };
