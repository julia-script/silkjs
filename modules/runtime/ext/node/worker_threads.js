'use strict';

const host = require('internal/host');
const EventEmitter = require('events');
const { _createResource: createResource } = require('async_hooks');
const { Buffer } = require('buffer');
const diagnostics = require('internal/host').diagnostics;
// A main thread that never starts a worker needs none of these; each loads on first use.
const lazy = name => { let loaded; return () => loaded ??= require(name); };
const clone = lazy('internal/worker/clone');
const ports = lazy('internal/worker/ports');
const broadcast = lazy('internal/worker/broadcast');
const messaging = lazy('internal/worker/messaging');
const lockManager = lazy('internal/worker/locks');
const runtimeOptions = lazy('internal/options');
const path = lazy('path');
const validators = lazy('internal/validators');
const nodeErrors = lazy('internal/errors');
function workerPathError(filename) {
  return clone().codedError('ERR_WORKER_PATH', "The worker script or module filename must be an absolute path or a relative path starting with './' or '../'." +
    (filename.startsWith('file://') ? ' Wrap file:// URLs with `new URL`.' : '') +
    (filename.startsWith('data:text/javascript') ? ' Wrap data: URLs with `new URL`.' : '') + ` Received "${filename}"`);
}
let profilesModule;
const profiles = () => profilesModule ??= require('internal/worker/profiles');
const SHARE_ENV = Symbol.for('nodejs.worker_threads.SHARE_ENV');
const workers = new Map();
const workerStates = new WeakMap();
let environmentData = new Map();
let control = null;
let bootstrapResult;
let installed = false;
let exitRequested = false;
let stdioSequence = 0;
const stdioCallbacks = new Map();
const controlRefs = new WeakMap();
const readableAcks = new WeakMap();
const info = host.workerNative('info', []);

function workerState(worker) {
  const state = workerStates.get(worker);
  if (!state) throw clone().codedError('ERR_INVALID_THIS', 'Value of this must be a Worker');
  return state;
}
function controlSend(port, message) { if (port) port.postMessage(message); }
function controlRef(port, delta) {
  const count = (controlRefs.get(port) || 0) + delta;
  controlRefs.set(port, count);
  if (count > 0) port.ref(); else port.unref();
}
function writableTo(port, fd, callbacks) {
  const pendingIds = new Set();
  return new (require('stream').Writable)({
    write(chunk, encoding, callback) {
      // Like Node's worker stdio: once the thread is exiting, no acknowledgement can
      // arrive, so each chunk completes as soon as it is posted.
      if (process._exiting) {
        try { controlSend(port, { type: 'stdio', fd, chunk, id: 0 }); callback(); } catch (error) { callback(error); }
        return;
      }
      const id = ++stdioSequence;
      pendingIds.add(id);
      controlRef(port, 1);
      callbacks.set(id, error => { pendingIds.delete(id); controlRef(port, -1); callback(error); });
      try { controlSend(port, { type: 'stdio', fd, chunk, id }); }
      catch (error) {
        const pending = callbacks.get(id);
        callbacks.delete(id);
        pending(error);
      }
    },
    final(callback) { try { controlSend(port, { type: 'stdioEnd', fd }); callback(); } catch (error) { callback(error); } },
    destroy(error, callback) {
      for (const id of pendingIds) {
        const pending = callbacks.get(id);
        callbacks.delete(id);
        pending?.(error || clone().codedError('ERR_STREAM_DESTROYED', 'Worker stream was destroyed', Error));
      }
      pendingIds.clear();
      callback(error);
    },
  });
}
function readableFrom(onRead) {
  const acks = [];
  const stream = new (require('stream').Readable)({
    read() {
      onRead?.();
      while (acks.length) acks.shift()();
    },
    destroy(error, callback) {
      while (acks.length) acks.shift()();
      callback(error);
    },
  });
  readableAcks.set(stream, acks);
  return stream;
}
function receiveStdio(stream, port, message) {
  const ack = () => controlSend(port, { type: 'stdioAck', id: message.id });
  if (!stream || stream.destroyed || stream.push(Buffer.from(message.chunk))) ack();
  else readableAcks.get(stream).push(ack);
}
function handleControl(worker, message) {
  const state = workerState(worker);
  switch (message.type) {
    case 'watch:dependency': require('internal/watch_mode/dependencies').report(message.filename); break;
    case 'error': state.errorReceived = true; state.resource.runInAsyncScope(worker.emit, worker, 'error', 'symbol' in message ? Symbol.for(message.symbol) : 'serialized' in message ? require('internal/error_serdes').deserializeError(message.serialized) : message.error); break;
    case 'stdio': {
      const stream = message.fd === 1 ? state.stdout : message.fd === 2 ? state.stderr : null;
      receiveStdio(stream, state.control, message);
      break;
    }
    case 'stdioEnd': (message.fd === 1 ? state.stdout : state.stderr)?.push(null); break;
    case 'stdioAck': {
      const callback = state.callbacks.get(message.id);
      state.callbacks.delete(message.id);
      callback?.();
      break;
    }
  }
}
function unsupported(api) {
  return clone().codedError('ERR_NOT_SUPPORTED', `${api} is not supported by SilkJS: the engine has no V8 heap generations or code range`, Error);
}
function resourceLimits(options) {
  const limits = { stackSizeMb: 4 };
  if (options === null || typeof options !== 'object') return limits;
  // SilkJS has neither generations nor a JIT code range. A whole-runtime
  // allocator budget is not a faithful implementation of any of these options.
  for (const key of ['maxOldGenerationSizeMb', 'maxYoungGenerationSizeMb', 'codeRangeSizeMb']) {
    if (typeof options[key] === 'number') throw unsupported(`Worker resourceLimits.${key}`);
  }
  const stack = options.stackSizeMb;
  if (typeof stack === 'number' && stack > 0) {
    if (!Number.isFinite(stack) || stack * 1048576 > Number.MAX_SAFE_INTEGER - 8388608 - 65535)
      throw clone().codedError('ERR_OUT_OF_RANGE', 'The options.resourceLimits.stackSizeMb property exceeds the supported native stack size', RangeError);
    limits.stackSizeMb = Math.max(0.1875, stack);
  }
  return limits;
}
function optionString(value) {
  if (typeof value === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
  return String(value);
}
function workerOptions(filename, options) {
  if (options === undefined) options = {};
  const result = {};
  // Node validates the array containers before resolving the entry, but defers
  // execArgv string conversion until after environment/name/resource parsing.
  if (options.execArgv) validators().validateArray(options.execArgv, 'options.execArgv');
  result.argv = [];
  if (options.argv) {
    validators().validateArray(options.argv, 'options.argv');
    result.argv = Array.prototype.map.call(options.argv, String);
  }
  result.eval = !!options.eval;
  if (result.eval) {
    if (typeof filename !== 'string') throw new (validators().codes.ERR_INVALID_ARG_VALUE)('options.eval', options.eval, "must be false when 'filename' is not a string");
    result.filename = filename;
  } else {
    if (filename instanceof require('url').URL) {
      if (filename.protocol === 'data:') result.filename = String(filename);
      else filename = require('url').fileURLToPath(filename);
    }
    if (!result.filename) {
      if (typeof filename !== 'string') throw new (validators().codes.ERR_INVALID_ARG_TYPE)('filename', ['string', 'URL'], filename);
      if (!path().isAbsolute(filename) && !/^\.\.?[\\/]/.test(filename)) throw workerPathError(filename);
      result.filename = path().resolve(filename);
    }
  }
  result.shareEnv = false;
  let explicitEnv = false;
  if (typeof options.env === 'object' && options.env !== null) {
    explicitEnv = true;
    result.env = {};
    for (const [key, value] of Object.entries(options.env)) Object.defineProperty(result.env, key, { value: optionString(value), enumerable: true, configurable: true, writable: true });
  } else if (options.env != null) {
    if (options.env !== SHARE_ENV)
      throw new (validators().codes.ERR_INVALID_ARG_TYPE)('options.env', ['object', 'undefined', 'null', 'worker_threads.SHARE_ENV'], options.env);
    result.shareEnv = true;
  }
  result.name = 'WorkerThread';
  result.watchReportDependencies = require('internal/watch_mode/dependencies').enabled();
  if (options.name) {
    validators().validateString(options.name, 'options.name');
    result.name = options.name.trim();
  }
  const execArgv = options.execArgv;
  const explicitExecArgv = Array.isArray(execArgv);
  result.resourceLimits = resourceLimits(options.resourceLimits);
  result.trackUnmanagedFds = !!(options.trackUnmanagedFds ?? true) || bootstrapResult?.trackUnmanagedFds === true;
  // The default environment is copied after the remaining option getters run.
  if (!explicitEnv && !result.shareEnv) {
    result.env = {};
    for (const [key, value] of Object.entries(process.env)) Object.defineProperty(result.env, key, { value: optionString(value), enumerable: true, configurable: true, writable: true });
  }
  let environment = [];
  let accepted = 0;
  if (explicitEnv || explicitExecArgv) {
    const value = (result.shareEnv ? process.env : result.env).NODE_OPTIONS || '';
    const errors = [];
    environment = runtimeOptions().parseEnvironment(value, errors);
    accepted = runtimeOptions().validateEnvironment(environment, errors);
    if (explicitEnv && value !== process.env.NODE_OPTIONS) {
      for (const arg of environment) {
        const name = arg.split('=', 1)[0];
        if (runtimeOptions().processOption(name) && !/^--(?:no-)?expose-gc$/.test(name))
          errors.push(new Error(name + ' is not allowed in NODE_OPTIONS'));
      }
    }
    if (explicitEnv && errors.length)
      throw clone().codedError('ERR_WORKER_INVALID_EXEC_ARGV', errors.map(error => error.message).join(', '), Error);
  }
  let workerArgs;
  if (explicitExecArgv) {
    workerArgs = new Array(execArgv.length);
    for (let index = 0; index < workerArgs.length; index++) workerArgs[index] = optionString(execArgv[index]);
    let checked;
    try { checked = runtimeOptions().invalidWorkerArguments(workerArgs); }
    catch (error) { throw new (nodeErrors().codes.ERR_WORKER_INVALID_EXEC_ARGV)([error.message]); }
    if (checked.invalid.length) throw new (nodeErrors().codes.ERR_WORKER_INVALID_EXEC_ARGV)(checked.invalid);
    result.execArgv = checked.execArgv;
  } else {
    result.execArgv = host.initialExecArgv.slice();
  }
  if (explicitEnv || explicitExecArgv) {
    result.runtimeArgs = environment.slice(0, accepted).concat(workerArgs ?? result.execArgv);
  } else {
    // Native options are snapshots, independent of later mutations to the public
    // execArgv array or NODE_OPTIONS environment string.
    result.runtimeArgs = host.workerRuntimeArgs.slice();
    result.reportOptions = {
      signal: process.report.signal, reportOnSignal: process.report.reportOnSignal,
      reportOnUncaughtException: process.report.reportOnUncaughtException,
    };
  }
  for (const key of ['stdin', 'stdout', 'stderr']) result[key] = !!options[key];
  result.processExposeGC = !!host.exposeGC;
  return { metadata: result, options };
}
class WorkerHandle {
  #state;
  constructor(state) { this.#state = state; }
  hasRef() { return this.#state.handleGone ? undefined : this.#state.refed; }
}
class Worker extends EventEmitter {
  constructor(filename, options) {
    super();
    const config = workerOptions(filename, options);
    const list = clone().transferList(config.options.transferList);
    const state = { id: null, online: false, exited: false, exitCode: undefined, user: null,
      control: null, resource: null, refed: true, handleGone: false,
      stdout: readableFrom(), stderr: readableFrom(), stdin: null,
      callbacks: new Map(), termination: null, resolveTermination: null, metadata: config.metadata };
    workerStates.set(this, state);
    // Like Node's, the async resource of a worker is its native handle: hasRef() reports
    // the ref state while the thread runs and undefined once the handle is gone. Node
    // creates it before the worker's ports, so async hooks see WORKER first.
    state.resource = createResource('WORKER', new WorkerHandle(state));
    const userChannel = new (ports().MessageChannel)();
    const controlChannel = new (ports().MessageChannel)();
    state.user = userChannel.port1;
    state.control = controlChannel.port1;
    state.stdin = config.metadata.stdin ? writableTo(state.control, 0, state.callbacks) : null;
    this.on('newListener', type => { if (type === 'message') state.user.ref(); });
    this.on('removeListener', type => { if (type === 'message' && this.listenerCount('message') === 0) state.user.unref(); });
    try {
      state.control.on('message', message => handleControl(this, message));
      state.control.unref();
      state.user.on('message', value => state.resource.runInAsyncScope(this.emit, this, 'message', value));
      state.user.on('messageerror', error => state.resource.runInAsyncScope(this.emit, this, 'messageerror', error));
      state.user.unref();
      controlChannel.port1.postMessage({ workerData: config.options.workerData,
        environmentData: Array.from(environmentData), parentPort: userChannel.port2,
        options: config.metadata }, [userChannel.port2, ...list]);
      state.id = host.workerNative('startWorker', [JSON.stringify(config.metadata), ports().id(controlChannel.port2), Math.floor(config.metadata.resourceLimits.stackSizeMb * 1048576), config.metadata.name]);
      // Native ownership of this endpoint moved into the new isolate.
      clone().commit({ moved: [controlChannel.port2] });
      workers.set(state.id, this);
    } catch (error) {
      for (const port of [userChannel.port1, userChannel.port2, controlChannel.port1, controlChannel.port2]) port.close();
      state.resource.emitDestroy();
      throw error;
    }
    if (!config.metadata.stdout) state.stdout.pipe(process.stdout, { end: false });
    if (!config.metadata.stderr) state.stderr.pipe(process.stderr, { end: false });
    process.nextTick(() => process.emit('worker', this));
    diagnostics.publish('worker_threads', { worker: this });
  }
  get threadId() { const state = workerState(this); return state.exited ? -1 : state.id; }
  get threadName() { const state = workerState(this); return state.exited ? null : state.metadata.name; }
  get stdin() { return workerState(this).stdin; }
  get stdout() { return workerState(this).stdout; }
  get stderr() { return workerState(this).stderr; }
  get resourceLimits() { const state = workerState(this); return state.exited ? {} : { ...state.metadata.resourceLimits }; }
  postMessage(value, transferList) {
    if (arguments.length === 0) throw clone().codedError('ERR_MISSING_ARGS', 'The value argument must be specified');
    workerState(this).user.postMessage(value, transferList);
  }
  ref() { const state = workerState(this); if (!state.exited) { host.workerNative('workerRef', [state.id, true]); state.user.ref(); state.refed = true; } return this; }
  unref() { const state = workerState(this); if (!state.exited) { host.workerNative('workerRef', [state.id, false]); state.user.unref(); state.refed = false; } return this; }
  terminate(callback) {
    const state = workerState(this);
    this.ref();
    if (typeof callback === 'function') {
      process.emitWarning('Passing a callback to worker.terminate() is deprecated. It returns a Promise instead.', 'DeprecationWarning', 'DEP0132');
      if (state.exited) return Promise.resolve();
      this.once('exit', exitCode => callback(null, exitCode));
    }
    // Like Node, a worker that has exited resolves with undefined.
    if (state.exited) return Promise.resolve();
    if (!state.termination) state.termination = new Promise(resolve => {
      state.resolveTermination = resolve;
      host.workerNative('terminate', [state.id]);
    });
    return state.termination;
  }
  getHeapSnapshot(options) { return profiles().getHeapSnapshot(workerStates.get(this), options, controlRef); }
  getHeapStatistics() { return profiles().getHeapStatistics(workerStates.get(this), controlRef); }
  startCpuProfile() { return profiles().startCpuProfile(workerStates.get(this), controlRef); }
  startHeapProfile() { return profiles().startHeapProfile(workerStates.get(this), controlRef); }
  cpuUsage(prev) {
    // Node validates synchronously, even when the worker is already dead.
    if (prev) {
      validators().validateObject(prev, 'prev');
      validators().validateNumber(prev.user, 'prev.user', 0, Number.MAX_SAFE_INTEGER);
      validators().validateNumber(prev.system, 'prev.system', 0, Number.MAX_SAFE_INTEGER);
    }
    const state = workerStates.get(this);
    if (!state || state.exited) return Promise.reject(clone().codedError('ERR_WORKER_NOT_RUNNING', 'Worker instance not running', Error));
    let usage;
    try { usage = host.workerNative('cpuUsage', [state.id]); }
    catch (cause) { return Promise.reject(clone().codedError('ERR_OPERATION_FAILED', 'Unable to read worker CPU usage: ' + cause.message, Error)); }
    if (usage === null) return Promise.reject(clone().codedError('ERR_WORKER_NOT_RUNNING', 'Worker instance not running', Error));
    return Promise.resolve(usage).then(current => ({
      user: current.user - (prev ? prev.user : 0),
      system: current.system - (prev ? prev.system : 0),
    }));
  }
}
if (Symbol.asyncDispose) Worker.prototype[Symbol.asyncDispose] = async function() { await this.terminate(); };
function setEnvironmentData(key, value) { if (value === undefined) environmentData.delete(key); else environmentData.set(key, value); }
function getEnvironmentData(key) { return environmentData.get(key); }
function receiveMessageOnPort(port) { return ports().receiveMessageOnPort(broadcast().portOf(port) || port); }
function poll() {
  const profileActivity = profilesModule ? profilesModule.poll() : false;
  const events = host.workerNative('poll', []);
  if (events.length === 0) return profileActivity;
  for (const event of events) {
    if (event.type === 'threadMessage') { messaging().dispatch(event); continue; }
    if (event.type === 'lock') { lockManager().dispatch(event); continue; }
    if (event.type === 'message' || event.type === 'close') { ports().dispatch(event); continue; }
    const worker = workers.get(event.worker);
    if (!worker) continue;
    const state = workerState(worker);
    if (event.type === 'online') {
      profiles().online(state);
      state.resource.runInAsyncScope(worker.emit, worker, 'online');
    }
    else if (event.type === 'exit' && !state.exited) {
      // Final control messages precede exit even if both wakeups coalesce.
      let message;
      while ((message = ports().receiveMessageOnPort(state.control)) !== undefined) handleControl(worker, message.message);
      while ((message = ports().receiveMessageOnPort(state.user)) !== undefined) state.resource.runInAsyncScope(worker.emit, worker, 'message', message.message);
      // Native replies are enqueued before native exit; drain once more after
      // observing exit so a concurrent final reply wins over the dead-worker error.
      profiles().poll();
      state.exited = true;
      state.exitCode = event.code;
      profiles().exited(state);
      workers.delete(state.id);
      state.control.close();
      state.user.close();
      state.stdout.push(null);
      state.stderr.push(null);
      state.stdin?.destroy();
      state.resolveTermination?.(event.code);
      try {
        if (event.initFailed && !state.errorReceived) state.resource.runInAsyncScope(worker.emit, worker, 'error',
          clone().codedError('ERR_WORKER_INIT_FAILED', 'Worker initialization failed before becoming online', Error));
        state.resource.runInAsyncScope(worker.emit, worker, 'exit', event.code);
      }
      finally {
        state.resource.emitDestroy();
        process.nextTick(() => { state.handleGone = true; });
      }
    }
  }
  return profileActivity || events.length > 0;
}
function bootstrap() {
  if (bootstrapResult !== undefined) return bootstrapResult;
  if (info.isMainThread) return bootstrapResult = null;
  control = ports().wrap(info.controlPort);
  const initial = ports().receiveMessageOnPort(control);
  if (!initial) throw new Error('Worker bootstrap envelope is missing');
  const data = initial.message;
  environmentData = new Map(data.environmentData);
  module.exports.parentPort = data.parentPort;
  module.exports.workerData = data.workerData;
  const nativeMetadata = JSON.parse(info.metadata);
  bootstrapResult = { ...nativeMetadata, ...data.options, threadId: info.threadId };
  module.exports.threadName = bootstrapResult.name;
  module.exports.resourceLimits = { ...bootstrapResult.resourceLimits };
  control.on('message', message => {
    if (message.type === 'stdioAck') {
      const callback = stdioCallbacks.get(message.id);
      stdioCallbacks.delete(message.id);
      callback?.();
    } else if (message.type === 'stdio') {
      receiveStdio(process.stdin, control, message);
    } else if (message.type === 'stdioEnd') process.stdin.push(null);
  });
  control.unref();
  return bootstrapResult;
}
// process.env, shared by every thread of the process. Like Node's: names that
// are not variables resolve on Object.prototype, values become strings (a
// Symbol throws), and only plain enumerable, writable, configurable data
// properties can be defined.
let environmentWarned = false;
function workerEnvironment() {
  const lookup = key => host.workerNative('envGet', [key]);
  const store = (key, value) => {
    if (typeof key === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
    // node_env_var.cc EnvSetter: one DEP0104 warning under --pending-deprecation.
    if (host.pendingDeprecation && !environmentWarned && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      environmentWarned = true;
      process.emitWarning('Assigning any value other than a string, number, or boolean to a process.env property is deprecated. ' +
        'Please make sure to convert the value to a string before setting process.env with it.', 'DeprecationWarning', 'DEP0104');
    }
    host.workerNative('envSet', [key, `${value}`]);
  };
  const invalidDescriptor = message => clone().codedError('ERR_INVALID_OBJECT_DEFINE_PROPERTY', message);
  return new Proxy(Object.create(null), {
    get(target, key) {
      if (typeof key === 'symbol') return undefined;
      const value = lookup(key);
      return value !== undefined ? value : Object.prototype[key];
    },
    set(target, key, value) { store(key, value); return true; },
    deleteProperty(target, key) { if (typeof key !== 'symbol') host.workerNative('envDelete', [key]); return true; },
    ownKeys() { return host.workerNative('envKeys', []); },
    has(target, key) { return typeof key !== 'symbol' && (lookup(key) !== undefined || key in Object.prototype); },
    getOwnPropertyDescriptor(target, key) {
      if (typeof key === 'symbol') return undefined;
      const value = lookup(key);
      if (value !== undefined) return { value, enumerable: true, configurable: true, writable: true };
    },
    defineProperty(target, key, descriptor) {
      if ('value' in descriptor) {
        if (!descriptor.configurable || !descriptor.writable || !descriptor.enumerable)
          throw invalidDescriptor("'process.env' only accepts a configurable, writable, and enumerable data descriptor");
        store(key, descriptor.value); return true;
      }
      if ('get' in descriptor || 'set' in descriptor)
        throw invalidDescriptor("'process.env' does not accept an accessor(getter/setter) descriptor");
      throw invalidDescriptor("'process.env' only accepts a configurable, writable, and enumerable data descriptor");
    },
    getPrototypeOf() { return Object.prototype; },
  });
}
function install(proc = process, metadata = bootstrap()) {
  if (installed) return;
  installed = true;
  if (!metadata) { proc.env = workerEnvironment(); return; }
  host.workerNative('envInit', [Object.entries(metadata.env || {}), metadata.shareEnv]);
  host.fsTracking(metadata.trackUnmanagedFds);
  require('internal/watch_mode/dependencies').initialize(
    filename => controlSend(control, { type: 'watch:dependency', filename }), metadata.watchReportDependencies === true);
  let stdinReading = false;
  const stdin = readableFrom(() => {
    if (metadata.stdin && !stdinReading) { stdinReading = true; controlRef(control, 1); }
  });
  const releaseStdin = () => {
    if (stdinReading) { stdinReading = false; controlRef(control, -1); }
  };
  stdin.on('end', releaseStdin);
  stdin.on('close', releaseStdin);
  if (!metadata.stdin) stdin.push(null);
  const stdout = writableTo(control, 1, stdioCallbacks);
  const stderr = writableTo(control, 2, stdioCallbacks);
  for (const [name, value] of Object.entries({ stdin, stdout, stderr })) Object.defineProperty(proc, name, { value, configurable: true, enumerable: true });
  proc.env = workerEnvironment();
  proc.openStdin = () => { proc.stdin.resume(); return proc.stdin; };
  proc.execArgv = metadata.execArgv;
  for (const method of ['chdir', 'abort', 'setuid', 'setgid', 'seteuid', 'setegid', 'setgroups', 'initgroups']) {
    if (typeof proc[method] === 'function') proc[method] = () => { throw clone().codedError('ERR_WORKER_UNSUPPORTED_OPERATION', `process.${method}() is not supported in workers`, Error); };
  }
  const umask = proc.umask;
  if (typeof umask === 'function') proc.umask = function(value) {
    if (arguments.length) throw clone().codedError('ERR_WORKER_UNSUPPORTED_OPERATION', 'Setting process.umask() is not supported in workers', Error);
    return umask();
  };
  proc.exit = function(code = proc.exitCode || 0) {
    if (typeof code === 'string' && code.trim()) code = Number(code);
    if (!Number.isInteger(code)) throw clone().codedError('ERR_INVALID_ARG_TYPE', 'The code argument must be an integer');
    proc.exitCode = code;
    if (!exitRequested) { exitRequested = true; proc._exiting = true; proc.emit('exit', code); }
    if (host.builtinLoaded('internal/compile_cache')) require('internal/compile_cache').flushAtExit();
    require('internal/startup_controls').traceExit(code, info.threadId);
    if (host.builtinLoaded('internal/heap_prof')) require('internal/heap_prof').finish();
    host.workerNative('requestExit', [code]);
  };
  host.workerNative('online', []);
}
function reportError(error) {
  if (!control) return false;
  if (typeof error === 'symbol') {
    controlSend(control, { type: 'error', symbol: error.description ?? '' });
    return true;
  }
  // As Node: error_serdes keeps the error's own properties (code, errno, ...) and constructor,
  // which a structured clone of an Error drops.
  try { controlSend(control, { type: 'error', serialized: require('internal/error_serdes').serializeError(error) }); }
  catch (serializationError) {
    const fallback = new Error('Worker error could not be serialized: ' + String(serializationError?.message || serializationError));
    controlSend(control, { type: 'error', error: fallback });
  }
  return true;
}
module.exports = { isMainThread: !!info.isMainThread, isInternalThread: false,
  parentPort: null, workerData: null, threadId: info.threadId, threadName: null,
  Worker, MessagePort: undefined, MessageChannel: undefined,
  BroadcastChannel: undefined, SHARE_ENV,
  postMessageToThread: undefined, locks: undefined,
  receiveMessageOnPort, moveMessagePortToContext: undefined,
  markAsUntransferable: undefined,
  isMarkedAsUntransferable: undefined,
  markAsUncloneable: undefined, getEnvironmentData, setEnvironmentData,
  resourceLimits: {} };
for (const [name, load] of [
  ['MessagePort', () => ports().MessagePort], ['MessageChannel', () => ports().MessageChannel],
  ['BroadcastChannel', () => broadcast().BroadcastChannel],
  ['postMessageToThread', () => messaging().postMessageToThread], ['locks', () => lockManager().locks],
  ['moveMessagePortToContext', () => ports().moveMessagePortToContext],
  ['markAsUntransferable', () => clone().markAsUntransferable],
  ['isMarkedAsUntransferable', () => clone().isMarkedAsUntransferable],
  ['markAsUncloneable', () => clone().markAsUncloneable],
]) {
  Object.defineProperty(module.exports, name, {
    enumerable: true, configurable: true,
    get() { const value = load(); Object.defineProperty(module.exports, name, { value, writable: true, enumerable: true, configurable: true }); return value; },
    set(value) { Object.defineProperty(module.exports, name, { value, writable: true, enumerable: true, configurable: true }); },
  });
}
Object.defineProperties(module.exports, {
  _bootstrap: { value: bootstrap }, _install: { value: install }, _poll: { value: poll },
  _reportError: { value: reportError }, _exitRequested: { get: () => exitRequested },
  _requestExit: { value: code => { exitRequested = true; host.workerNative('requestExit', [code]); } },
});
