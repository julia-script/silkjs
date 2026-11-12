'use strict';

const EventEmitter = require('events');
const host = require('internal/host');
if (process.hasUncaughtExceptionCaptureCallback()) {
  throw Object.assign(new Error('A callback was registered through process.setUncaughtExceptionCaptureCallback(), which is mutually exclusive with using the `domain` module'), { code: 'ERR_DOMAIN_CALLBACK_NOT_AVAILABLE' });
}
// The stack where `domain` was required, appended to the capture-callback error below.
const domainRequireStack = new Error('require(`domain`) at this point').stack;
const { createHook } = require('async_hooks');
let stack = [];
let active = null;
const pairing = new Map();
const entered = new Map();
const vmPromises = new WeakMap();
function property(object, name, value) {
  Object.defineProperty(object, name, { configurable: true, enumerable: false, writable: true, value });
}
function setActive(value) { exports.active = active = value; }
Object.defineProperty(process, 'domain', {
  configurable: true, enumerable: true,
  get() { return active; }, set(value) { active = value; }
});
const hook = createHook({
  init(id, type, trigger, resource) {
    if (!process.domain) return;
    if (type === 'PROMISE' && !(resource instanceof Promise)) vmPromises.set(resource, process.domain);
    else property(resource, 'domain', process.domain);
    pairing.set(id, new WeakRef(process.domain));
  },
  before(id) {
    const domain = pairing.get(id)?.deref();
    if (!domain) return;
    let frames = entered.get(id);
    if (!frames) { frames = []; entered.set(id, frames); }
    frames.push(domain); domain.enter();
  },
  after(id) {
    const frames = entered.get(id);
    if (!frames) return;
    frames.pop().exit();
    if (!frames.length) entered.delete(id);
  },
  destroy(id) { pairing.delete(id); entered.delete(id); }
});
function clear() { stack.length = 0; setActive(null); }
let sentMakeCallbackDeprecation = false;
// lib/domain.js topLevelDomainCallback, the trampoline of native callbacks with no async context.
host.domainCallback = function topLevelDomainCallback(cb, ...args) {
  const domain = this.domain;
  if (exports.active && domain && !sentMakeCallbackDeprecation) {
    sentMakeCallbackDeprecation = true;
    process.emitWarning('Using a domain property in MakeCallback is deprecated. Use the async_context variant of MakeCallback or the AsyncResource class instead. ' +
      `(Triggered by calling ${cb?.name || '<anonymous>'} on ${this?.constructor?.name}.)`, 'DeprecationWarning', 'DEP0097');
  }
  if (domain) domain.enter();
  const ret = Reflect.apply(cb, this, args);
  if (domain) domain.exit();
  return ret;
};

class Domain extends EventEmitter {
  constructor() { super(); this.members = []; hook.enable(); }
  enter() { setActive(this); stack.push(this); }
  exit() {
    const index = stack.lastIndexOf(this);
    if (index < 0) return;
    stack.splice(index); setActive(stack.length ? stack[stack.length - 1] : undefined);
  }
  add(member) {
    if (member.domain === this) return;
    if (member.domain) member.domain.remove(member);
    if (member === this) return;
    if (member instanceof Domain) for (let domain = this.domain; domain; domain = domain.domain) if (domain === member) return;
    property(member, 'domain', this);
    this.members.push(member);
  }
  remove(member) {
    member.domain = null;
    const index = this.members.indexOf(member);
    if (index !== -1) this.members.splice(index, 1);
  }
  run(fn, ...args) {
    this.enter();
    const result = Reflect.apply(fn, this, args);
    this.exit(); return result;
  }
  bind(fn) {
    const domain = this;
    function runBound(...args) {
      domain.enter();
      const result = Reflect.apply(fn, this, args);
      domain.exit(); return result;
    }
    property(runBound, 'domain', this);
    return runBound;
  }
  intercept(fn) {
    const domain = this;
    return function runIntercepted(error, ...args) {
      if (error instanceof Error) {
        error.domainBound = fn; error.domainThrown = false;
        property(error, 'domain', domain);
        domain.emit('error', error); return;
      }
      domain.enter();
      const result = Reflect.apply(fn, this, args);
      domain.exit(); return result;
    };
  }
  _errorHandler(error) {
    if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
      property(error, 'domain', this); error.domainThrown = true;
    }
    while (exports.active === this) this.exit();
    let caught = false;
    if (!stack.length) {
      // With the top-level domain gone nothing captures a throw from its handler, so
      // --abort-on-uncaught-exception aborts there, as V8 does when Node clears the capture.
      if (this.listenerCount('error')) {
        if (!host.abortOnUncaughtException) caught = this.emit('error', error);
        else try { caught = this.emit('error', error); } catch (next) { host.abortOnUncaughtException(next); }
      }
    } else {
      try { caught = this.emit('error', error); }
      catch (next) {
        if (!stack.length) { host.abortOnUncaughtException?.(next); throw next; }
        setActive(stack[stack.length - 1]);
        caught = process.domain._errorHandler(next);
      }
    }
    clear(); return caught;
  }
}
exports.Domain = Domain;
exports.create = exports.createDomain = () => new Domain();
exports.active = null;
exports._stack = stack;
// Called at the runtime exception boundary, before async-hook after() unwinds.
exports._handleException = (error, domain = process.domain) => domain ? domain._errorHandler(error) : false;
exports._clear = clear;
exports._associateResource = function(resource, domain) {
  property(resource, 'domain', domain);
  if (domain) pairing.set(resource.asyncId(), new WeakRef(domain));
  else pairing.delete(resource.asyncId());
};

process.hasUncaughtExceptionCaptureCallback = function() {
  return stack.some(domain => domain.listenerCount('error') > 0);
};
process.setUncaughtExceptionCaptureCallback = function() {
  const error = Object.assign(new Error('The `domain` module is in use, which is mutually exclusive with calling process.setUncaughtExceptionCaptureCallback()'), { code: 'ERR_DOMAIN_CANNOT_SET_UNCAUGHT_EXCEPTION_CAPTURE' });
  error.stack += `\n${'-'.repeat(40)}\n${domainRequireStack}`;
  throw error;
};

// Install only when domain is loaded, as Node does; ordinary emitters retain
// their original behavior until domains are explicitly enabled.
EventEmitter.usingDomains = true;
const eventInit = EventEmitter.init;
EventEmitter.init = function init(options) {
  property(this, 'domain', exports.active && !(this instanceof Domain) ? exports.active : null);
  return eventInit.call(this, options);
};
const eventEmit = EventEmitter.prototype.emit;
EventEmitter.prototype.emit = function emit(type, ...args) {
  const domain = this.domain;
  if ((type === 'error' && this.listenerCount(type)) || !domain || this === process)
    return Reflect.apply(eventEmit, this, arguments);
  if (type === 'error') {
    const error = args[0] || Object.assign(new Error('Unhandled error.'), { code: 'ERR_UNHANDLED_ERROR' });
    if (typeof error === 'object') {
      error.domainEmitter = this; property(error, 'domain', domain); error.domainThrown = false;
    }
    const original = stack.slice(), previous = process.domain;
    let index = stack.length - 1;
    while (index >= 0 && process.domain === stack[index]) --index;
    stack.splice(index + 1); setActive(stack.length ? stack[stack.length - 1] : null);
    domain.emit('error', error);
    exports._stack = stack = original; setActive(previous);
    return false;
  }
  domain.enter();
  const result = Reflect.apply(eventEmit, this, arguments);
  domain.exit(); return result;
};
process.on('newListener', (name, listener) => {
  if (name === 'uncaughtException' && listener !== clear) {
    process.removeListener(name, clear); process.prependListener(name, clear);
  }
});
process.on('removeListener', (name, listener) => {
  if (name === 'uncaughtException' && listener !== clear && process.listenerCount(name) === 1 && process.listeners(name)[0] === clear)
    process.removeListener(name, clear);
});
