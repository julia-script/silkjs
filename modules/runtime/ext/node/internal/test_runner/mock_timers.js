'use strict';

const NativeDate = Date;
const supported = ['setTimeout', 'setInterval', 'setImmediate', 'Date', 'scheduler.wait', 'AbortSignal.timeout'];
const { validateNumber, validateStringArray, validateInteger, validateAbortSignal, AbortError } = require('internal/util_public/support');
const { kResistStopPropagation } = require('internal/path_events/event_target');
function invalid(message) { return Object.assign(new TypeError(message), { code: 'ERR_INVALID_ARG_VALUE' }); }
function time(value) { if (value < 0) throw invalid('Time must be non-negative'); return value; }
class MockTimers {
  constructor() { this._enabled = false; this._now = 0; this._nextId = 1; this._queue = new Map(); this._restore = []; }
  _assert() { if (!this._enabled) throw Object.assign(new Error('MockTimers is not enabled'), { code: 'ERR_INVALID_STATE' }); }
  _patch(object, key, value) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    this._restore.push(() => { if (descriptor) Object.defineProperty(object, key, descriptor); else delete object[key]; });
    Object.defineProperty(object, key, { configurable: true, writable: true, enumerable: descriptor?.enumerable ?? true, value });
  }
  enable(options = {}) {
    if (this._enabled) throw Object.assign(new Error('MockTimers is already enabled'), { code: 'ERR_INVALID_STATE' });
    options = { ...options };
    const apis = options.apis || supported;
    validateStringArray(apis, 'options.apis');
    if (apis.some(api => !supported.includes(api))) throw invalid('Supported APIs: ' + supported.join(', '));
    if (Number.isNaN(options.now)) throw invalid('now must not be NaN');
    const now = options.now || 0;
    let dateTime;
    try { dateTime = NativeDate.prototype.getTime.call(now); } catch (_) {}
    if (dateTime === undefined) { validateNumber(now, 'initialTime'); this._now = time(now); }
    else this._now = dateTime;
    this._enabled = true;
    const owner = this;
    try {
      const timers = require('timers');
      for (const api of new Set(apis)) {
        if (api === 'scheduler.wait') {
          this._patch(require('timers/promises').scheduler, 'wait', (delay, options) => this._promise(delay, undefined, options));
          continue;
        }
        if (api === 'AbortSignal.timeout') {
          this._patch(AbortSignal, 'timeout', delay => {
            validateInteger(delay, 'delay', 0, 4294967295);
            const controller = new AbortController();
            this._schedule(() => controller.abort(), delay, false, []);
            return controller.signal;
          });
          continue;
        }
        if (api === 'Date') {
          function MockDate(...args) {
            if (!new.target) return new NativeDate(owner._now).toString();
            return Reflect.construct(NativeDate, args.length ? args : [owner._now], new.target);
          }
          Object.setPrototypeOf(MockDate, NativeDate);
          MockDate.prototype = NativeDate.prototype;
          Object.defineProperty(MockDate, 'now', { value: () => owner._now });
          Object.defineProperty(MockDate, 'isMock', { value: true, enumerable: true });
          this._patch(globalThis, 'Date', MockDate);
          continue;
        }
        const clear = api.replace('set', 'clear');
        const schedule = api === 'setImmediate' ? (fn, ...args) => this._schedule(fn, -1, false, args) :
          (fn, delay, ...args) => this._schedule(fn, delay, api === 'setInterval', args);
        const cancel = handle => this._cancel(handle);
        this._patch(globalThis, api, schedule); this._patch(globalThis, clear, cancel);
        this._patch(timers, api, schedule); this._patch(timers, clear, cancel);
        const promises = require('timers/promises');
        const promise = api === 'setImmediate' ? (value, options) => this._promise(-1, value, options) :
          api === 'setTimeout' ? (delay, value, options) => this._promise(delay, value, options) :
          (delay, value, options) => this._interval(delay, value, options);
        this._patch(promises, api, promise);
      }
    } catch (error) { this.reset(); throw error; }
  }
  _cancel(handle) {
    const timer = handle && this._queue.get(handle.id);
    if (timer && timer.handle === handle) {
      timer.repeat = false;
      this._queue.delete(timer.id);
    }
  }
  async _promise(delay, value, options) {
    const signal = options?.signal;
    if (signal) validateAbortSignal(signal, 'options.signal');
    if (signal?.aborted) throw new AbortError(undefined, { cause: signal.reason });
    let handle;
    let abort;
    try {
      await new Promise((resolve, reject) => {
        abort = () => reject(new AbortError(undefined, { cause: signal.reason }));
        signal?.addEventListener('abort', abort, { once: true, [kResistStopPropagation]: true });
        handle = this._schedule(resolve, delay, false, []);
      });
      return value;
    } finally {
      signal?.removeEventListener('abort', abort);
      this._cancel(handle);
    }
  }
  async *_interval(delay, value, options) {
    const signal = options?.signal;
    if (signal) validateAbortSignal(signal, 'options.signal');
    if (signal?.aborted) throw new AbortError(undefined, { cause: signal.reason });
    let pending = 0;
    let wake;
    const notify = () => { if (wake) { const resolve = wake; wake = undefined; resolve(); } };
    const handle = this._schedule(() => { pending++; notify(); }, delay, true, []);
    try {
      signal?.addEventListener('abort', notify, { once: true, [kResistStopPropagation]: true });
      for (;;) {
        if (!pending && !signal?.aborted) await new Promise(resolve => { wake = resolve; });
        if (signal?.aborted) throw new AbortError(undefined, { cause: signal.reason });
        while (pending) { pending--; yield value; }
      }
    } finally {
      this._cancel(handle);
      signal?.removeEventListener('abort', notify);
    }
  }
  _schedule(fn, delay, repeat, args) {
    if (delay > 2147483647) delay = 1;
    const id = this._nextId++;
    const timer = { id, runAt: this._now + delay, delay, repeat: repeat && delay !== undefined, fn, args };
    const owner = this;
    const handle = {
      id,
      ref() { return this; },
      unref() { return this; },
      hasRef() { return true; },
      refresh() { return this; },
      close() { owner._cancel(this); return this; },
      [Symbol.dispose]() { owner._cancel(this); },
    };
    timer.handle = handle;
    this._queue.set(id, timer);
    return handle;
  }
  tick(milliseconds = 1) {
    this._assert(); time(milliseconds);
    this._now += milliseconds;
    // Keep Date.now() at the advanced clock, including within callbacks, as Node does.
    const end = this._now;
    for (;;) {
      let next;
      for (const timer of this._queue.values()) if (!next || timer.runAt < next.runAt || (!(timer.runAt > next.runAt) && timer.id < next.id)) next = timer;
      if (!next || next.runAt > end) return;
      Reflect.apply(next.fn, undefined, next.args);
      this._queue.delete(next.id);
      if (next.repeat) {
        next.runAt += next.delay;
        this._queue.set(next.id, next);
      }
    }
  }
  setTime(value = 0) { validateNumber(value, 'time'); time(value); this._assert(); this._now = value; }
  runAll() {
    this._assert();
    if (!this._queue.size) return;
    let end = -Infinity;
    for (const timer of this._queue.values()) end = Math.max(end, timer.runAt);
    this.tick(end - this._now);
  }
  reset() {
    if (!this._enabled) return;
    for (let i = this._restore.length - 1; i >= 0; i--) this._restore[i]();
    this._restore = []; this._queue.clear(); this._enabled = false; this._now = 0;
  }
  [Symbol.dispose]() { this.reset(); }
}
module.exports = { MockTimers };
