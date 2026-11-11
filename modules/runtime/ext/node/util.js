'use strict';

const host = require('internal/host');
const types = require('util/types');
const { inspect } = require('internal/util_inspect');
const { isDeepStrictEqual } = require('internal/util_comparisons');
const customPromisify = Symbol.for('nodejs.util.promisify.custom');
function invalid(name, expected, value) {
  const error = new TypeError('The "' + name + '" argument must be of type ' + expected + '. Received ' + inspect(value));
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}
function validateFunction(value, name) { if (typeof value !== 'function') throw invalid(name, 'function', value); }
function formatWithOptions(options, ...args) {
  if (!options || typeof options !== 'object') throw invalid('inspectOptions', 'object', options);
  if (!args.length) return '';
  const first = args[0];
  if (typeof first !== 'string') return args.map(value => typeof value === 'string' ? value : inspect(value, options)).join(' ');
  let index = 1;
  let result = first.replace(/%[%sdifjoOc]/g, token => {
    if (token === '%%') return index < args.length ? '%' : token;
    if (index >= args.length) return token;
    const value = args[index++];
    switch (token) {
      case '%s':
        if (typeof value === 'bigint') return String(value) + 'n';
        if (value !== null && typeof value === 'object' && value.toString === Object.prototype.toString) return inspect(value, Object.assign({}, options, { compact: 3, colors: false, depth: 0 }));
        return String(value);
      case '%d': return typeof value === 'bigint' ? String(value) + 'n' : typeof value === 'symbol' ? 'NaN' : String(Number(value));
      case '%i': return typeof value === 'bigint' ? String(value) + 'n' : typeof value === 'symbol' ? 'NaN' : String(parseInt(value, 10));
      case '%f': return typeof value === 'symbol' ? 'NaN' : String(parseFloat(value));
      case '%j':
        try { return JSON.stringify(value); }
        catch (error) { if (error instanceof TypeError && /circular|cyclic/i.test(error.message)) return '[Circular]'; throw error; }
      case '%o': return inspect(value, Object.assign({}, options, { showHidden: true, showProxy: true, depth: 4 }));
      case '%O': return inspect(value, options);
      case '%c': return '';
    }
  });
  for (; index < args.length; index++) result += ' ' + (typeof args[index] === 'string' ? args[index] : inspect(args[index], options));
  return result;
}
function format(...args) { return formatWithOptions({}, ...args); }
function promisify(original) {
  validateFunction(original, 'original');
  if (original[customPromisify] !== undefined) {
    const custom = original[customPromisify];
    validateFunction(custom, 'util.promisify.custom');
    Object.defineProperty(custom, customPromisify, { value: custom, configurable: true });
    return custom;
  }
  function fn(...args) {
    return new Promise((resolve, reject) => {
      args.push((error, value) => error ? reject(error) : resolve(value));
      Reflect.apply(original, this, args);
    });
  }
  Object.setPrototypeOf(fn, Object.getPrototypeOf(original));
  Object.defineProperties(fn, Object.getOwnPropertyDescriptors(original));
  Object.defineProperty(fn, customPromisify, { value: fn, configurable: true });
  return fn;
}
promisify.custom = customPromisify;
function callbackify(original) {
  validateFunction(original, 'original');
  function callbackified(...args) {
    const callback = args.pop();
    validateFunction(callback, 'last argument');
    const receiver = this;
    Reflect.apply(original, receiver, args).then(
      value => host.nextTick(() => Reflect.apply(callback, receiver, [null, value])),
      reason => {
        if (!reason) {
          const error = new Error('Promise was rejected with falsy value');
          error.code = 'ERR_FALSY_VALUE_REJECTION'; error.reason = reason; reason = error;
        }
        host.nextTick(() => Reflect.apply(callback, receiver, [reason]));
      });
  }
  const descriptors = Object.getOwnPropertyDescriptors(original);
  if (descriptors.length && typeof descriptors.length.value === 'number') descriptors.length.value++;
  if (descriptors.name && typeof descriptors.name.value === 'string') descriptors.name.value += 'Callbackified';
  Object.defineProperties(callbackified, descriptors);
  Object.setPrototypeOf(callbackified, Object.getPrototypeOf(original));
  return callbackified;
}
function inherits(ctor, superCtor) {
  if (ctor === undefined || ctor === null) throw invalid('ctor', 'function', ctor);
  if (superCtor === undefined || superCtor === null) throw invalid('superCtor', 'function', superCtor);
  if (superCtor.prototype === undefined) throw invalid('superCtor.prototype', 'object', superCtor.prototype);
  Object.defineProperty(ctor, 'super_', { value: superCtor, writable: true, configurable: true });
  Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
}
const deprecationCodes = new Set();
function deprecate(fn, message, code) {
  validateFunction(fn, 'fn');
  if (globalThis.process && process.noDeprecation) return fn;
  let warned = false;
  function deprecated(...args) {
    if (!warned) {
      warned = true;
      if (!code || !deprecationCodes.has(code)) {
        if (code) deprecationCodes.add(code);
        if (globalThis.process && typeof process.emitWarning === 'function') process.emitWarning(message, 'DeprecationWarning', code, deprecated);
        else host.stderr.write((code ? '[' + code + '] ' : '') + 'DeprecationWarning: ' + message + '\n');
      }
    }
    return new.target ? Reflect.construct(fn, args, new.target) : Reflect.apply(fn, this, args);
  }
  Object.setPrototypeOf(deprecated, fn);
  deprecated.prototype = fn.prototype;
  return deprecated;
}
function debuglog(section, callback) {
  section = String(section).toUpperCase();
  const patterns = String(host.env.NODE_DEBUG || '').split(/[\s,]+/).filter(Boolean);
  let enabled;
  const initialize = () => { enabled = patterns.some(pattern => new RegExp('^' + pattern.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i').test(section)); };
  const write = (...args) => { if (enabled) host.stderr.write(section + ' ' + (globalThis.process ? process.pid : 0) + ': ' + format(...args) + '\n'); };
  Object.defineProperty(write, 'enabled', { enumerable: true, configurable: true, get: () => enabled });
  let initialized = false;
  const logger = (...args) => {
    if (enabled === false) return;
    if (!initialized) {
      initialize(); initialized = true;
      if (typeof callback === 'function') callback(write);
    }
    return write(...args);
  };
  Object.defineProperty(logger, 'enabled', { enumerable: true, configurable: true, get() { if (enabled === undefined) initialize(); return enabled; } });
  return logger;
}
function stripVTControlCharacters(value) {
  if (typeof value !== 'string') throw invalid('str', 'string', value);
  return value.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '');
}
function toUSVString(value) {
  return String(value).replace(/[\uD800-\uDFFF]/g, (unit, index, string) => {
    const code = unit.charCodeAt(0);
    if (code <= 0xDBFF && index + 1 < string.length && string.charCodeAt(index + 1) >= 0xDC00 && string.charCodeAt(index + 1) <= 0xDFFF) return unit;
    if (code >= 0xDC00 && index > 0 && string.charCodeAt(index - 1) >= 0xD800 && string.charCodeAt(index - 1) <= 0xDBFF) return unit;
    return '\uFFFD';
  });
}
function styleText(format, text, options = {}) {
  if (typeof text !== 'string') throw invalid('text', 'string', text);
  const formats = Array.isArray(format) ? format : [format];
  let result = text;
  for (let i = formats.length - 1; i >= 0; i--) {
    const pair = inspect.colors[formats[i]];
    if (!pair) { const error = new TypeError('Unknown text format: ' + formats[i]); error.code = 'ERR_INVALID_ARG_VALUE'; throw error; }
    const stream = options.stream || host.stdout;
    if (options.validateStream !== false && (!stream.isTTY || host.env.NO_COLOR !== undefined || host.env.NODE_DISABLE_COLORS !== undefined || host.env.TERM === 'dumb')) continue;
    const start = '\x1b[' + pair[0] + 'm', end = '\x1b[' + pair[1] + 'm';
    result = start + result.split(end).join(start) + end;
  }
  return result;
}
let traceSigintStarted = false;
let traceSigintEffective = false;
function traceSigintNative(enable) {
  const status = host.processNative('traceSigint', [enable]);
  if (status < 0) throw Object.assign(new Error('Cannot watch for SIGINT signals'), { code: 'ERR_CANNOT_WATCH_SIGINT' });
  traceSigintEffective = enable;
}
function traceSigintNewListener(name) {
  if (name === 'SIGINT' && traceSigintEffective) traceSigintNative(false);
}
function traceSigintRemoveListener(name) {
  if (name === 'SIGINT' && process.listenerCount('SIGINT') === 0 && !traceSigintEffective) traceSigintNative(true);
}
function setTraceSigInt(enable) {
  if (!require('worker_threads').isMainThread) {
    throw Object.assign(new TypeError('Calling util.setTraceSigInt is not supported in workers'), { code: 'ERR_WORKER_UNSUPPORTED_OPERATION' });
  }
  // Node intentionally uses truthiness here, not validateBoolean.
  if (enable) {
    if (traceSigintStarted) return;
    traceSigintStarted = true;
    process.prependListener('newListener', traceSigintNewListener);
    process.on('removeListener', traceSigintRemoveListener);
    if (process.listenerCount('SIGINT') === 0) traceSigintNative(true);
  } else {
    if (!traceSigintStarted) return;
    traceSigintStarted = false;
    process.removeListener('newListener', traceSigintNewListener);
    process.removeListener('removeListener', traceSigintRemoveListener);
    if (traceSigintEffective) traceSigintNative(false);
  }
}
function markPromiseAsHandled(promise) {
  if (!types.isPromise(promise)) {
    const { codes: { ERR_INVALID_ARG_TYPE } } = require('internal/util_public/support');
    throw new ERR_INVALID_ARG_TYPE('promise', 'Promise', promise);
  }
  host.markPromiseAsHandled(promise);
}
function getCallSites(frameCount = 10, options) {
  const { validateObject, validateBoolean, validateInteger } = require('internal/util_public/support');
  if (options === undefined) {
    if (typeof frameCount === 'object') {
      options = frameCount;
      validateObject(options, 'options');
      if (options.sourceMap !== undefined) validateBoolean(options.sourceMap, 'options.sourceMap');
      frameCount = 10;
    } else {
      options = {};
    }
  } else {
    validateObject(options, 'options');
    if (options.sourceMap !== undefined) validateBoolean(options.sourceMap, 'options.sourceMap');
  }
  validateInteger(frameCount, 'frameCount', 1, 200);
  // util's implicit policy is the startup flag, not mutable process support.
  const sourceMap = options.sourceMap === true ||
    (require('internal/options').getOptionValue('--enable-source-maps') && options.sourceMap !== false);
  const frames = host.captureCallSites(frameCount, getCallSites);
  if (sourceMap) {
    const { mapPosition } = require('internal/source_maps');
    for (let index = 0; index < frames.length; index++)
      frames[index] = mapPosition(frames[index], { kind: 'callsite' });
  }
  return frames;
}
module.exports = {
  format, formatWithOptions, inspect, types, promisify, callbackify, inherits, deprecate, debuglog, debug: debuglog,
  isDeepStrictEqual, stripVTControlCharacters, toUSVString, styleText,
  markPromiseAsHandled, getCallSites, setTraceSigInt,
  // Placeholders keep the key order; the loop below turns each into a load-on-first-read property.
  transferableAbortController: undefined,
  transferableAbortSignal: undefined,
  aborted: undefined,
  parseArgs: undefined,
  parseEnv: undefined,
  MIMEParams: undefined,
  MIMEType: undefined,
  diff: undefined,
  getSystemErrorMap: undefined,
  getSystemErrorName: undefined,
  getSystemErrorMessage: undefined,
  convertProcessSignalToExitCode: undefined,
  debounce: undefined,
  throttle: undefined,
  TextEncoder: undefined,
  TextDecoder: undefined,
  isArray: Array.isArray, isBoolean: value => typeof value === 'boolean', isNull: value => value === null,
  isNullOrUndefined: value => value == null, isNumber: value => typeof value === 'number', isString: value => typeof value === 'string',
  isSymbol: value => typeof value === 'symbol', isUndefined: value => value === undefined, isRegExp: types.isRegExp,
  isObject: value => value !== null && typeof value === 'object', isDate: types.isDate, isError: types.isNativeError,
  isFunction: value => typeof value === 'function', isPrimitive: value => value === null || typeof value !== 'object' && typeof value !== 'function',
  isBuffer: value => require('buffer').Buffer.isBuffer(value),
  _extend: (target, source) => source && typeof source === 'object' ? Object.assign(target, source) : target,
  log: (...args) => { const date = new Date(); const stamp = date.getDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getMonth()] + ' ' + [date.getHours(), date.getMinutes(), date.getSeconds()].map(n => String(n).padStart(2, '0')).join(':'); host.stdout.write(stamp + ' - ' + format(...args) + '\n'); },
};
// The formatter is on every console.log path; argument parsing, MIME types,
// diffing and the text codecs are not, so each loads when it is first read.
for (const [name, load] of [
  ['transferableAbortController', () => require('internal/abort_controller').util.transferableAbortController],
  ['transferableAbortSignal', () => require('internal/abort_controller').util.transferableAbortSignal],
  ['aborted', () => require('internal/abort_controller').util.aborted],
  ['parseArgs', () => require('internal/util_public/parse_args').parseArgs],
  ['parseEnv', () => require('internal/util_public/parse_env').parseEnv],
  ['MIMEParams', () => require('internal/util_public/mime').MIMEParams],
  ['MIMEType', () => require('internal/util_public/mime').MIMEType],
  ['diff', () => require('internal/util_public/diff').diff],
  ['getSystemErrorMap', () => require('internal/util_public/system').getSystemErrorMap],
  ['getSystemErrorName', () => require('internal/util_public/system').getSystemErrorName],
  ['getSystemErrorMessage', () => require('internal/util_public/system').getSystemErrorMessage],
  ['convertProcessSignalToExitCode', () => require('internal/util_public/system').convertProcessSignalToExitCode],
  ['debounce', () => require('internal/util_public/debounce')],
  ['throttle', () => require('internal/util_public/throttle')],
  ['TextEncoder', () => require('internal/web/encoding').TextEncoder],
  ['TextDecoder', () => require('internal/web/encoding').TextDecoder],
]) {
  const settle = value => Object.defineProperty(module.exports, name, { value, writable: true, enumerable: true, configurable: true });
  Object.defineProperty(module.exports, name, {
    enumerable: true, configurable: true,
    get() { const value = load(); settle(value); return value; },
    set(value) { settle(value); },
  });
}
