'use strict';

const trace = require('internal/trace_events');
const channels = new Map();
const activeChannels = new Map();
const finalizer = new FinalizationRegistry(name => {
  if (!channels.get(name)?.deref()) channels.delete(name);
});
function invalid(name, type) {
  return Object.assign(new TypeError(`The "${name}" argument must be of type ${type}`), { code: 'ERR_INVALID_ARG_TYPE' });
}
function checkFunction(value, name) { if (typeof value !== 'function') throw invalid(name, 'function'); }
function report(error) { process.nextTick(() => { throw error; }); }

class Channel {
  #subscribers = [];
  #stores = new Map();
  constructor(name) {
    this.name = name;
    channels.set(name, new WeakRef(this));
    finalizer.register(this, name);
  }
  #retain() {
    if (this.#subscribers.length !== 0 || this.#stores.size !== 0) activeChannels.set(this.name, this);
    else if (activeChannels.get(this.name) === this) activeChannels.delete(this.name);
  }
  get hasSubscribers() { return this.#subscribers.length !== 0 || this.#stores.size !== 0 || trace.enabled('node.diagnostics_channel'); }
  subscribe(subscription) {
    checkFunction(subscription, 'subscription');
    this.#subscribers = [...this.#subscribers, subscription];
    this.#retain();
  }
  unsubscribe(subscription) {
    const index = this.#subscribers.indexOf(subscription);
    if (index === -1) return false;
    this.#subscribers = [...this.#subscribers.slice(0, index), ...this.#subscribers.slice(index + 1)];
    this.#retain();
    return true;
  }
  publish(message) {
    trace.diagnostic(this.name);
    const subscribers = this.#subscribers;
    for (const subscriber of subscribers) {
      try { subscriber(message, this.name); } catch (error) { report(error); }
    }
  }
  bindStore(store, transform) { this.#stores.set(store, transform); this.#retain(); }
  unbindStore(store) { const removed = this.#stores.delete(store); this.#retain(); return removed; }
  runStores(message, fn, thisArg, ...args) {
    if (!this.hasSubscribers) return Reflect.apply(fn, thisArg, args);
    let run = () => { this.publish(message); return Reflect.apply(fn, thisArg, args); };
    for (const [store, transform] of this.#stores) {
      const next = run;
      run = () => {
        let context;
        try { context = transform === undefined ? message : transform(message); }
        catch (error) { report(error); return next(); }
        return store.run(context, next);
      };
    }
    return run();
  }
}
function channel(name) {
  const existing = channels.get(name)?.deref();
  if (existing) return existing;
  if (typeof name !== 'string' && typeof name !== 'symbol') throw invalid('channel', 'string or symbol');
  return new Channel(name);
}
function hasSubscribers(name) { return channels.get(name)?.deref()?.hasSubscribers ?? false; }
function subscribe(name, subscription) { channel(name).subscribe(subscription); }
function unsubscribe(name, subscription) { return channel(name).unsubscribe(subscription); }

const traceEvents = ['start', 'end', 'asyncStart', 'asyncEnd', 'error'];
class TracingChannel {
  constructor(nameOrChannels) {
    if (typeof nameOrChannels !== 'string' && (nameOrChannels === null || typeof nameOrChannels !== 'object')) {
      throw invalid('nameOrChannels', 'string or object');
    }
    for (const name of traceEvents) {
      const value = typeof nameOrChannels === 'string' ? channel(`tracing:${nameOrChannels}:${name}`) : nameOrChannels[name];
      if (!(value instanceof Channel)) throw invalid(`nameOrChannels.${name}`, 'Channel');
      Object.defineProperty(this, name, { value });
    }
  }
  get hasSubscribers() { return traceEvents.some(name => this[name].hasSubscribers); }
  subscribe(handlers) { for (const name of traceEvents) if (handlers[name]) this[name].subscribe(handlers[name]); }
  unsubscribe(handlers) {
    let done = true;
    for (const name of traceEvents) if (handlers[name] && !this[name].unsubscribe(handlers[name])) done = false;
    return done;
  }
  traceSync(fn, context = {}, thisArg, ...args) {
    if (!this.hasSubscribers) return Reflect.apply(fn, thisArg, args);
    return this.start.runStores(context, () => {
      try { return context.result = Reflect.apply(fn, thisArg, args); }
      catch (error) { context.error = error; this.error.publish(context); throw error; }
      finally { this.end.publish(context); }
    });
  }
  tracePromise(fn, context = {}, thisArg, ...args) {
    if (!this.hasSubscribers) return Reflect.apply(fn, thisArg, args);
    return this.start.runStores(context, () => {
      try {
        return Promise.resolve(Reflect.apply(fn, thisArg, args)).then(result => {
          context.result = result;
          this.asyncStart.publish(context);
          this.asyncEnd.publish(context);
          return result;
        }, error => {
          context.error = error;
          this.error.publish(context);
          this.asyncStart.publish(context);
          this.asyncEnd.publish(context);
          throw error;
        });
      } catch (error) { context.error = error; this.error.publish(context); throw error; }
      finally { this.end.publish(context); }
    });
  }
  traceCallback(fn, position = -1, context = {}, thisArg, ...args) {
    if (!this.hasSubscribers) return Reflect.apply(fn, thisArg, args);
    const callback = args.at(position);
    checkFunction(callback, 'callback');
    const tracing = this;
    args.splice(position, 1, function(error, result) {
      if (error) { context.error = error; tracing.error.publish(context); }
      else context.result = result;
      tracing.asyncStart.runStores(context, () => {
        try { return Reflect.apply(callback, this, arguments); }
        finally { tracing.asyncEnd.publish(context); }
      });
    });
    return this.start.runStores(context, () => {
      try { return Reflect.apply(fn, thisArg, args); }
      catch (error) { context.error = error; this.error.publish(context); throw error; }
      finally { this.end.publish(context); }
    });
  }
}
function tracingChannel(nameOrChannels) { return new TracingChannel(nameOrChannels); }
module.exports = { channel, hasSubscribers, subscribe, tracingChannel, unsubscribe, Channel };
