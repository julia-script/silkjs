'use strict';

const host = require('internal/host');
const { codedError } = require('internal/worker/clone');
const pending = new Map();
let sequence = 0;

function notRunning() { return codedError('ERR_WORKER_NOT_RUNNING', 'Worker instance not running', Error); }
function failure(status, operation) {
  if (status === 3) return notRunning();
  if (status === 16 && operation === 0) return codedError('ERR_CPU_PROFILE_TOO_MANY', 'There are too many CPU profiles', Error);
  if (status === 16 && operation === 2) return codedError('ERR_HEAP_PROFILE_HAVE_BEEN_STARTED', 'heap profiler have been started', Error);
  return codedError('ERR_OPERATION_FAILED', `Worker profiling operation failed (errno ${status})`, Error);
}
function finish(id, error, result) {
  const request = pending.get(id);
  if (!request) return;
  pending.delete(id);
  request.retain(request.state.control, -1);
  request.state.resource.runInAsyncScope(error ? request.reject : request.resolve, undefined, error || result);
}
function send(id, request) {
  request.sent = true;
  try {
    const interval = request.operation === 0 ? 1000 : request.operation === 2 ? 524288 : 0;
    const capacity = request.operation === 0 ? 16384 : request.operation === 2 ? 2048 : 0;
    const status = host.profileRequest(request.state.id, id, request.operation, interval, capacity);
    if (status !== 0) finish(id, failure(status, request.operation));
  } catch (error) { finish(id, error); }
}
function request(state, operation, retain) {
  if (!state || state.exited) return Promise.reject(notRunning());
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const entry = { state, operation, retain, resolve, reject, sent: false };
    retain(state.control, 1);
    pending.set(id, entry);
    // The native owner registry is attached before the worker announces online.
    // Never dispatch via the guest message loop: native interrupts service work
    // even while the target is executing synchronous JavaScript.
    if (state.online) send(id, entry);
  });
}
function online(state) {
  state.online = true;
  for (const [id, entry] of pending) if (entry.state === state && !entry.sent) send(id, entry);
}
function poll() {
  let activity = false;
  let reply;
  while ((reply = host.profilePoll()) !== null) {
    activity = true;
    const entry = pending.get(reply.id);
    if (!entry) continue;
    if (reply.status !== 0) { finish(reply.id, failure(reply.status, entry.operation)); continue; }
    const result = reply.encoding === 0 ? JSON.parse(reply.data) : reply.data;
    finish(reply.id, null, result);
  }
  return activity;
}
function exited(state) {
  for (const [id, entry] of pending) if (entry.state === state) finish(id, notRunning());
}
function stopped(result, heap) {
  if (result === null) throw codedError(heap ? 'ERR_HEAP_PROFILE_NOT_STARTED' : 'ERR_CPU_PROFILE_NOT_STARTED', heap ? 'heap profile not started' : 'CPU profile not started', Error);
  return JSON.stringify(heap ? require('internal/inspector_profiles').samplingProfile(result, false) : result);
}
class CPUProfileHandle {
  #state;
  #retain;
  #promise;
  constructor(state, retain) { this.#state = state; this.#retain = retain; }
  stop() {
    if (!this.#promise) this.#promise = request(this.#state, 1, this.#retain).then(result => stopped(result, false));
    return this.#promise;
  }
}
class HeapProfileHandle {
  #state;
  #retain;
  #promise;
  constructor(state, retain) { this.#state = state; this.#retain = retain; }
  stop() {
    if (!this.#promise) this.#promise = request(this.#state, 3, this.#retain).then(result => stopped(result, true));
    return this.#promise;
  }
}
if (Symbol.asyncDispose) {
  CPUProfileHandle.prototype[Symbol.asyncDispose] = async function() { await this.stop(); };
  HeapProfileHandle.prototype[Symbol.asyncDispose] = async function() { await this.stop(); };
}
function startCpuProfile(state, retain) { return request(state, 0, retain).then(() => new CPUProfileHandle(state, retain)); }
function startHeapProfile(state, retain) { return request(state, 2, retain).then(() => new HeapProfileHandle(state, retain)); }
function getHeapSnapshot(state, options = {}, retain) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw codedError('ERR_INVALID_ARG_TYPE', 'The options argument must be an object');
  const { exposeInternals = false, exposeNumericValues = false } = options;
  for (const [name, value] of [['exposeInternals', exposeInternals], ['exposeNumericValues', exposeNumericValues]]) {
    if (typeof value !== 'boolean') throw codedError('ERR_INVALID_ARG_TYPE', `The options.${name} property must be a boolean`);
  }
  if (exposeNumericValues) throw codedError('ERR_NOT_SUPPORTED', 'Numeric-value heap snapshot exposure is not supported by this runtime', Error);
  return request(state, 4, retain).then(snapshot => {
    const buffer = require('buffer').Buffer.from(snapshot);
    return require('stream').Readable.from([buffer], { objectMode: false });
  });
}
function getHeapStatistics(state, retain) {
  return request(state, 5, retain).then(heap => ({
    total_heap_size: heap.heapTotal,
    used_heap_size: heap.heapUsed,
    external_memory: heap.external,
    silk: heap.silk,
  }));
}
module.exports = { startCpuProfile, startHeapProfile, getHeapSnapshot, getHeapStatistics, online, poll, exited };
