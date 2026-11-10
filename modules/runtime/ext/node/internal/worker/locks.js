'use strict';

const host = require('internal/host');
const { codedError } = require('internal/worker/clone');
const { DOMException } = require('internal/path_events/event_target');
const { validateAbortSignal } = require('internal/path_events/support');
const token = {};
const lockStates = new WeakMap();
const requests = new Map();
const abortError = () => new DOMException('The operation was aborted', 'AbortError');
const unsupported = message => new DOMException(message, 'NotSupportedError');
function domString(value) {
  if (typeof value === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
  return String(value);
}
class Lock {
  constructor(key, name, mode) {
    if (key !== token) throw codedError('ERR_ILLEGAL_CONSTRUCTOR', 'Illegal constructor');
    lockStates.set(this, { name, mode });
  }
  get name() {
    const state = lockStates.get(this);
    if (!state) throw codedError('ERR_INVALID_THIS', 'Value of this must be of type Lock');
    return state.name;
  }
  get mode() {
    const state = lockStates.get(this);
    if (!state) throw codedError('ERR_INVALID_THIS', 'Value of this must be of type Lock');
    return state.mode;
  }
}
function finish(request, error, result, failed) {
  if (request.finished) return;
  request.finished = true;
  requests.delete(request.id);
  request.signal?.removeEventListener('abort', request.abort);
  // A steal may have happened since the callback settled but before its native
  // notification was polled. Resolve according to synchronized ownership.
  if (host.workerNative('lockStatus', [request.id]) === 2) { failed = true; error = abortError(); }
  host.workerNative('lockRelease', [request.id]);
  if (failed) request.reject(error); else request.resolve(result);
}
function invoke(request, status) {
  if (request.finished || request.started) return;
  if (status === 2) { finish(request, abortError(), undefined, true); return; }
  if (status === 0) return;
  const call = () => {
    if (request.finished) return;
    if (request.signal?.aborted) { finish(request, request.signal.reason, undefined, true); return; }
    request.started = true;
    let result;
    try { result = request.callback(status === 3 ? null : new Lock(token, request.name, request.mode)); }
    catch (error) { finish(request, error, undefined, true); return; }
    Promise.resolve(result).then(value => finish(request, undefined, value, false), error => finish(request, error, undefined, true));
  };
  if (request.signal) Promise.resolve().then(call); else call();
}
class LockManager {
  constructor(key) {
    if (key !== token) throw codedError('ERR_ILLEGAL_CONSTRUCTOR', 'Illegal constructor');
  }
  async request(name, options, callback = undefined) {
    if (callback === undefined) { callback = options; options = undefined; }
    name = domString(name);
    if (typeof callback !== 'function') throw codedError('ERR_INVALID_ARG_TYPE', 'The callback argument must be a function');
    if (options === undefined || typeof options === 'function' || options === null) options = {};
    if (typeof options !== 'object') throw codedError('ERR_INVALID_ARG_TYPE', 'The options argument must be an object');
    // WebIDL dictionary conversion precedes semantic validation.
    const modeValue = options.mode;
    const mode = modeValue === undefined ? 'exclusive' : domString(modeValue);
    if (mode !== 'exclusive' && mode !== 'shared') throw codedError('ERR_INVALID_ARG_VALUE', `mode '${mode}' is not a valid enum value of type LockMode.`);
    const ifAvailable = !!options.ifAvailable;
    const steal = !!options.steal;
    const signal = options.signal;
    if (signal !== undefined && (signal === null || (typeof signal !== 'object' && typeof signal !== 'function')))
      throw codedError('ERR_INVALID_ARG_TYPE', 'signal is not an object.');
    validateAbortSignal(signal, 'options.signal');
    if (signal?.aborted) throw signal.reason;
    if (name[0] === '-') throw unsupported('Lock name may not start with hyphen');
    if (ifAvailable && steal) throw unsupported('ifAvailable and steal are mutually exclusive');
    if (steal && mode !== 'exclusive') throw unsupported('mode: "shared" and steal are mutually exclusive');
    if (signal && (steal || ifAvailable)) throw unsupported('signal cannot be used with steal or ifAvailable');
    return new Promise((resolve, reject) => {
      const id = host.workerNative('lockRequest', [name, mode === 'shared', steal, ifAvailable]);
      const request = { id, name, mode, callback, signal, resolve, reject, started: false, finished: false, abort: undefined };
      requests.set(id, request);
      if (signal) {
        request.abort = () => {
          if (!request.started) finish(request, signal.reason || abortError(), undefined, true);
        };
        try { signal.addEventListener('abort', request.abort, { once: true }); }
        catch (error) { finish(request, error, undefined, true); return; }
      }
      invoke(request, host.workerNative('lockStatus', [id]));
    });
  }
  async query() {
    if (!(this instanceof LockManager)) throw codedError('ERR_INVALID_THIS', 'Value of this must be of type LockManager');
    const snapshot = { held: [], pending: [] };
    for (const [name, shared, owner, status] of host.workerNative('lockQuery', [])) {
      snapshot[status === 1 ? 'held' : 'pending'].push({ name, mode: shared ? 'shared' : 'exclusive', clientId: `node-${process.pid}-${owner}` });
    }
    return snapshot;
  }
}
for (const key of ['name', 'mode']) Object.defineProperty(Lock.prototype, key, { enumerable: true });
for (const key of ['request', 'query']) Object.defineProperty(LockManager.prototype, key, { enumerable: true });
Object.defineProperty(Lock.prototype, Symbol.toStringTag, { value: 'Lock', configurable: true });
Object.defineProperty(LockManager.prototype, Symbol.toStringTag, { value: 'LockManager', configurable: true });
const locks = new LockManager(token);
function dispatch(event) {
  const request = requests.get(event.request);
  if (!request) return;
  if (event.status === 2) finish(request, abortError(), undefined, true);
  else invoke(request, event.status);
}
module.exports = { locks, dispatch };
