'use strict';

const { MockTimers } = require('internal/test_runner/mock_timers');
const host = require('internal/host');
const { validateObject, validateBoolean, validateInteger, validateFunction,
  codes: { ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE } } = require('internal/util_public/support');
function invalid(message) { return new ERR_INVALID_ARG_VALUE('options', undefined, message); }
function callable(value, name = 'implementation') { validateFunction(value, name); }
function timesOption(options) {
  validateObject(options, 'options');
  const { times = Infinity } = options;
  if (times !== Infinity) validateInteger(times, 'options.times', 1);
  return times;
}
let moduleWarningEmitted = false;

class MockFunctionContext {
  constructor(original, implementation, restore, times) {
    this._original = original;
    this._implementation = implementation;
    this._restore = restore;
    this._times = times;
    this._calls = [];
    this._once = new Map();
  }
  get calls() { return this._calls.slice(); }
  callCount() { return this._calls.length; }
  mockImplementation(implementation) { callable(implementation); this._implementation = implementation; }
  mockImplementationOnce(implementation, onCall) {
    callable(implementation);
    onCall ??= this._calls.length;
    validateInteger(onCall, 'onCall', this._calls.length);
    this._once.set(onCall, implementation);
  }
  restore() { if (this._restore) this._restore(); else this._implementation = this._original; }
  resetCalls() { this._calls = []; }
  _invoke(receiver, args, target, newTarget) {
    const index = this._calls.length;
    const implementation = this._once.get(index) || this._implementation;
    this._once.delete(index);
    if (index + 1 === this._times) this.restore();
    const call = { arguments: args, error: undefined, result: undefined, stack: new Error(), target, this: receiver };
    try {
      call.result = target ? Reflect.construct(implementation, args, newTarget) : Reflect.apply(implementation, receiver, args);
      if (target) call.this = call.result;
      return call.result;
    } catch (error) { call.error = error; throw error; }
    finally { this._calls.push(call); }
  }
}

class MockTracker {
  constructor() { this._mocks = []; this._timers = undefined; }
  get timers() { return this._timers ||= new MockTimers(); }
  _create(original, implementation, options, restore) {
    callable(original, 'original'); callable(implementation);
    const times = timesOption(options);
    const context = new MockFunctionContext(original, implementation, restore, times);
    const proxy = new Proxy(original, {
      apply(_target, receiver, args) { return context._invoke(receiver, args); },
      construct(target, args, newTarget) { return context._invoke(undefined, args, target, newTarget); },
      get(target, key, receiver) { return key === 'mock' ? context : Reflect.get(target, key, receiver); },
    });
    this._mocks.push(context);
    return proxy;
  }
  fn(original = function() {}, implementation = original, options = {}) {
    if (original !== null && typeof original === 'object') {
      options = original; original = function() {}; implementation = original;
    } else if (implementation !== null && typeof implementation === 'object') { options = implementation; implementation = original; }
    return this._create(original, implementation, options);
  }
  method(object, methodName, implementation, options = {}) {
    if (typeof methodName !== 'string' && typeof methodName !== 'symbol') throw new ERR_INVALID_ARG_TYPE('methodName', ['string', 'symbol'], methodName);
    if (typeof object !== 'function') validateObject(object, 'object');
    if (implementation !== null && typeof implementation === 'object') { options = implementation; implementation = undefined; }
    if (implementation !== undefined) callable(implementation);
    timesOption(options);
    const { getter = false, setter = false } = options;
    validateBoolean(getter, 'options.getter'); validateBoolean(setter, 'options.setter');
    if (getter && setter) throw invalid('getter and setter cannot both be true');
    let owner = object;
    let descriptor;
    while (owner && !(descriptor = Object.getOwnPropertyDescriptor(owner, methodName))) owner = Object.getPrototypeOf(owner);
    const key = getter ? 'get' : setter ? 'set' : 'value';
    const original = descriptor?.[key];
    if (typeof original !== 'function') throw new ERR_INVALID_ARG_VALUE('methodName', original, 'must be a method');
    const proxy = this._create(original, implementation === undefined ? original : implementation, options, () => {
      if (typeof methodName === 'string') Object.defineProperty(object, methodName, descriptor);
      else proxy.mock._implementation = undefined;
    });
    try { Object.defineProperty(object, methodName, { ...descriptor, [key]: proxy }); }
    catch (error) { this._mocks.pop(); throw error; }
    return proxy;
  }
  getter(object, name, implementation, options = {}) {
    if (implementation !== null && typeof implementation === 'object') { options = implementation; implementation = undefined; }
    validateObject(options, 'options');
    if (options.getter === false) throw invalid('getter cannot be false');
    return this.method(object, name, implementation, { ...options, getter: options.getter === undefined ? true : options.getter });
  }
  setter(object, name, implementation, options = {}) {
    if (implementation !== null && typeof implementation === 'object') { options = implementation; implementation = undefined; }
    validateObject(options, 'options');
    if (options.setter === false) throw invalid('setter cannot be false');
    return this.method(object, name, implementation, { ...options, setter: options.setter === undefined ? true : options.setter });
  }
  restoreAll() { for (const context of this._mocks) context.restore(); }
  reset() { this.restoreAll(); this._mocks = []; this._timers?.reset(); }
  module(specifier, options = {}) {
    if (!moduleWarningEmitted) {
      moduleWarningEmitted = true;
      process.emitWarning('Module mocking is an experimental feature and might change at any time', 'ExperimentalWarning');
    }
    if (typeof specifier !== 'string') {
      if (!(specifier instanceof require('url').URL)) throw new ERR_INVALID_ARG_TYPE('specifier', ['string', 'URL'], specifier);
      specifier = specifier.href;
    }
    validateObject(options, 'options');
    const { cache = false } = options;
    validateBoolean(cache, 'options.cache');
    const exports = Object.create(null);
    if ('exports' in options) validateObject(options.exports, 'options.exports');
    if ('namedExports' in options) validateObject(options.namedExports, 'options.namedExports');
    if ('exports' in options && ('namedExports' in options || 'defaultExport' in options))
      throw invalid('exports cannot be used with namedExports or defaultExport');
    if ('exports' in options) Object.defineProperties(exports, Object.getOwnPropertyDescriptors(options.exports));
    if ('namedExports' in options) Object.defineProperties(exports, Object.getOwnPropertyDescriptors(options.namedExports));
    if ('defaultExport' in options) Object.defineProperty(exports, 'default', Object.getOwnPropertyDescriptor(options, 'defaultExport'));
    const caller = host.captureCallSites(1, MockTracker.prototype.module)[0]?.scriptName;
    const context = host.loader.mockModule(specifier, caller, exports, cache);
    this._mocks.push(context);
    return context;
  }
  [Symbol.dispose]() { this.reset(); }
}
if (!host.experimentalTestModuleMocks) delete MockTracker.prototype.module;
module.exports = { MockTracker };
