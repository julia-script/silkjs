'use strict';

// Adapted from Node.js v24.22.1 lib/diagnostics_channel.js (MIT). Channels without
// subscribers use the Channel prototype; the first subscriber or bound store switches the
// object to ActiveChannel, so publishing to an unobserved channel is one empty call.

const trace = require('internal/trace_events');
const { codes: { ERR_INVALID_ARG_TYPE }, validateFunction } = require('internal/errors');

function triggerUncaught(error) { process.nextTick(() => { throw error; }); }

// A channel stays reachable while it has subscribers or stores, even if user code drops it.
class WeakReference {
  #weak; #strong = null; #count = 0;
  constructor(value) { this.#weak = new WeakRef(value); }
  get() { return this.#weak.deref(); }
  incRef() { if (this.#count++ === 0) this.#strong = this.#weak.deref(); return this.#count; }
  decRef() { if (--this.#count === 0) this.#strong = null; return this.#count; }
}

// Can't delete when the reference count reaches 0 as it could increment again.
// Only GC can be used as a valid time to clean up the channels map.
class WeakRefMap extends Map {
  #finalizers = new FinalizationRegistry(key => { if (!this.has(key)) this.delete(key); });
  set(key, value) { this.#finalizers.register(value, key); return super.set(key, new WeakReference(value)); }
  get(key) { return super.get(key)?.get(); }
  has(key) { return !!this.get(key); }
  incRef(key) { return super.get(key)?.incRef(); }
  decRef(key) { return super.get(key)?.decRef(); }
}

function markActive(channel) {
  Object.setPrototypeOf(channel, ActiveChannel.prototype);
  channel._subscribers = [];
  channel._stores = new Map();
}

function maybeMarkInactive(channel) {
  if (!channel._subscribers.length && !channel._stores.size) {
    Object.setPrototypeOf(channel, Channel.prototype);
    channel._subscribers = undefined;
    channel._stores = undefined;
  }
}

function defaultTransform(data) { return data; }

function wrapStoreRun(store, data, next, transform = defaultTransform) {
  return () => {
    let context;
    try { context = transform(data); }
    catch (error) { triggerUncaught(error); return next(); }
    return store.run(context, next);
  };
}

class ActiveChannel {
  subscribe(subscription) {
    validateFunction(subscription, 'subscription');
    this._subscribers = this._subscribers.slice();
    this._subscribers.push(subscription);
    channels.incRef(this.name);
  }
  unsubscribe(subscription) {
    const index = this._subscribers.indexOf(subscription);
    if (index === -1) return false;
    this._subscribers = [...this._subscribers.slice(0, index), ...this._subscribers.slice(index + 1)];
    channels.decRef(this.name);
    maybeMarkInactive(this);
    return true;
  }
  bindStore(store, transform) {
    if (!this._stores.has(store)) channels.incRef(this.name);
    this._stores.set(store, transform);
  }
  unbindStore(store) {
    if (!this._stores.has(store)) return false;
    this._stores.delete(store);
    channels.decRef(this.name);
    maybeMarkInactive(this);
    return true;
  }
  get hasSubscribers() { return true; }
  publish(data) {
    trace.diagnostic(this.name);
    const subscribers = this._subscribers;
    for (let i = 0; i < (subscribers?.length || 0); i++) {
      try {
        const onMessage = subscribers[i];
        onMessage(data, this.name);
      } catch (error) { triggerUncaught(error); }
    }
  }
  runStores(data, fn, thisArg, ...args) {
    let run = () => { this.publish(data); return Reflect.apply(fn, thisArg, args); };
    for (const [store, transform] of this._stores.entries()) run = wrapStoreRun(store, data, run, transform);
    return run();
  }
}

class Channel {
  constructor(name) {
    this._subscribers = undefined;
    this._stores = undefined;
    this.name = name;
    this._index = undefined;
    channels.set(name, this);
  }
  static [Symbol.hasInstance](instance) {
    const prototype = Object.getPrototypeOf(instance);
    return prototype === Channel.prototype || prototype === ActiveChannel.prototype;
  }
  subscribe(subscription) {
    validateFunction(subscription, 'subscription');
    markActive(this);
    this.subscribe(subscription);
  }
  unsubscribe() { return false; }
  bindStore(store, transform) {
    markActive(this);
    this.bindStore(store, transform);
  }
  unbindStore() { return false; }
  // The node.diagnostics_channel trace category observes every publish.
  get hasSubscribers() { return trace.enabled('node.diagnostics_channel'); }
  publish() { trace.diagnostic(this.name); }
  runStores(data, fn, thisArg, ...args) {
    if (this.hasSubscribers) this.publish(data);
    return Reflect.apply(fn, thisArg, args);
  }
}

const channels = new WeakRefMap();

function channel(name) {
  const existing = channels.get(name);
  if (existing) return existing;
  if (typeof name !== 'string' && typeof name !== 'symbol') throw ERR_INVALID_ARG_TYPE('channel', ['string', 'symbol'], name);
  return new Channel(name);
}
function subscribe(name, subscription) { return channel(name).subscribe(subscription); }
function unsubscribe(name, subscription) { return channel(name).unsubscribe(subscription); }
function hasSubscribers(name) {
  const existing = channels.get(name);
  if (!existing) return false;
  return existing.hasSubscribers;
}

const traceEvents = ['start', 'end', 'asyncStart', 'asyncEnd', 'error'];

function assertChannel(value, name) {
  if (!(value instanceof Channel)) throw ERR_INVALID_ARG_TYPE(name, ['Channel'], value);
}
function tracingChannelFrom(nameOrChannels, name) {
  if (typeof nameOrChannels === 'string') return channel(`tracing:${nameOrChannels}:${name}`);
  if (typeof nameOrChannels === 'object' && nameOrChannels !== null) {
    const value = nameOrChannels[name];
    assertChannel(value, `nameOrChannels.${name}`);
    return value;
  }
  throw ERR_INVALID_ARG_TYPE('nameOrChannels', ['string', 'object', 'TracingChannel'], nameOrChannels);
}

class TracingChannel {
  constructor(nameOrChannels) {
    for (let i = 0; i < traceEvents.length; ++i) {
      const eventName = traceEvents[i];
      Object.defineProperty(this, eventName, { __proto__: null, value: tracingChannelFrom(nameOrChannels, eventName) });
    }
  }
  get hasSubscribers() {
    return this.start?.hasSubscribers || this.end?.hasSubscribers || this.asyncStart?.hasSubscribers ||
      this.asyncEnd?.hasSubscribers || this.error?.hasSubscribers;
  }
  subscribe(handlers) {
    for (let i = 0; i < traceEvents.length; ++i) {
      const name = traceEvents[i];
      if (!handlers[name]) continue;
      this[name]?.subscribe(handlers[name]);
    }
  }
  unsubscribe(handlers) {
    let done = true;
    for (let i = 0; i < traceEvents.length; ++i) {
      const name = traceEvents[i];
      if (!handlers[name]) continue;
      if (!this[name]?.unsubscribe(handlers[name])) done = false;
    }
    return done;
  }
  traceSync(fn, context = {}, thisArg, ...args) {
    if (!this.hasSubscribers) return Reflect.apply(fn, thisArg, args);
    const { start, end, error } = this;
    return start.runStores(context, () => {
      try {
        const result = Reflect.apply(fn, thisArg, args);
        context.result = result;
        return result;
      } catch (err) {
        context.error = err;
        error.publish(context);
        throw err;
      } finally {
        end.publish(context);
      }
    });
  }
  tracePromise(fn, context = {}, thisArg, ...args) {
    if (!this.hasSubscribers) return Reflect.apply(fn, thisArg, args);
    const { start, end, asyncStart, asyncEnd, error } = this;
    function reject(err) {
      context.error = err;
      error.publish(context);
      asyncStart.publish(context);
      asyncEnd.publish(context);
      return Promise.reject(err);
    }
    function resolve(result) {
      context.result = result;
      asyncStart.publish(context);
      asyncEnd.publish(context);
      return result;
    }
    return start.runStores(context, () => {
      try {
        let promise = Reflect.apply(fn, thisArg, args);
        // Convert thenables to native promises.
        if (!(promise instanceof Promise)) promise = Promise.resolve(promise);
        return Promise.prototype.then.call(promise, resolve, reject);
      } catch (err) {
        context.error = err;
        error.publish(context);
        throw err;
      } finally {
        end.publish(context);
      }
    });
  }
  traceCallback(fn, position = -1, context = {}, thisArg, ...args) {
    if (!this.hasSubscribers) return Reflect.apply(fn, thisArg, args);
    const { start, end, asyncStart, asyncEnd, error } = this;
    function wrappedCallback(err, res) {
      if (err) {
        context.error = err;
        error.publish(context);
      } else {
        context.result = res;
      }
      // Using runStores here enables manual context failure recovery.
      asyncStart.runStores(context, () => {
        try { return Reflect.apply(callback, this, arguments); }
        finally { asyncEnd.publish(context); }
      });
    }
    const callback = args.at(position);
    validateFunction(callback, 'callback');
    args.splice(position, 1, wrappedCallback);
    return start.runStores(context, () => {
      try { return Reflect.apply(fn, thisArg, args); }
      catch (err) {
        context.error = err;
        error.publish(context);
        throw err;
      } finally {
        end.publish(context);
      }
    });
  }
}

function tracingChannel(nameOrChannels) { return new TracingChannel(nameOrChannels); }

module.exports = { channel, hasSubscribers, subscribe, tracingChannel, unsubscribe, Channel };
// Built-in publishers find the channels through internal/dc once this module is loaded.
require('internal/host').diagnosticsChannel = module.exports;
