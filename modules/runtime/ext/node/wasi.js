'use strict';
const { wasiNative: native } = require('internal/host');
const { isMemory, getMemoryBuffer } = require('internal/web/wasm');
process.emitWarning('WASI is an experimental feature and might change at any time', 'ExperimentalWarning');
const states = new WeakMap();
const exitSentinel = Symbol('WASI exit');
const finalizers = new FinalizationRegistry(id => native(1, id));
const signatures = [
  ['args_get', 'ii'], ['args_sizes_get', 'ii'],
  ['clock_res_get', 'ii'], ['clock_time_get', 'iIi'],
  ['environ_get', 'ii'], ['environ_sizes_get', 'ii'],
  ['fd_advise', 'iIIi'], ['fd_allocate', 'iII'], ['fd_close', 'i'],
  ['fd_datasync', 'i'], ['fd_fdstat_get', 'ii'], ['fd_fdstat_set_flags', 'ii'],
  ['fd_fdstat_set_rights', 'iII'], ['fd_filestat_get', 'ii'],
  ['fd_filestat_set_size', 'iI'], ['fd_filestat_set_times', 'iIIi'],
  ['fd_pread', 'iiiIi'], ['fd_prestat_get', 'ii'], ['fd_prestat_dir_name', 'iii'],
  ['fd_pwrite', 'iiiIi'], ['fd_read', 'iiii'], ['fd_readdir', 'iiiIi'],
  ['fd_renumber', 'ii'], ['fd_seek', 'iIii'], ['fd_sync', 'i'],
  ['fd_tell', 'ii'], ['fd_write', 'iiii'], ['path_create_directory', 'iii'],
  ['path_filestat_get', 'iiiii'], ['path_filestat_set_times', 'iiiiIIi'],
  ['path_link', 'iiiiiii'], ['path_open', 'iiiiiIIii'],
  ['path_readlink', 'iiiiii'], ['path_remove_directory', 'iii'],
  ['path_rename', 'iiiiii'], ['path_symlink', 'iiiii'], ['path_unlink_file', 'iii'],
  ['poll_oneoff', 'iiii'], ['proc_exit', 'i'], ['proc_raise', 'i'],
  ['random_get', 'ii'], ['sched_yield', ''], ['sock_accept', 'iii'],
  ['sock_recv', 'iiiiii'], ['sock_send', 'iiiii'], ['sock_shutdown', 'ii'],
];
function error(Type, code, message) { const e = new Type(message); e.code = code; return e; }
function invalid(name, type) { return error(TypeError, 'ERR_INVALID_ARG_TYPE', `The "${name}" argument must be of type ${type}.`); }
function object(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid(name, 'object');
}
function fd(value, name) {
  if (typeof value !== 'number') throw invalid(name, 'number');
  if (!Number.isInteger(value) || value < 0 || value > 0x7fffffff)
    throw error(RangeError, 'ERR_OUT_OF_RANGE', `The value of "${name}" is out of range. It must be >= 0 && <= 2147483647. Received ${value}`);
  return value;
}
function stateOf(receiver) {
  const state = states.get(receiver);
  if (!state) throw error(TypeError, 'ERR_INVALID_THIS', 'Value of "this" must be of type WASI');
  return state;
}
function syscall(state, op, signature, args) {
  // Node's native binding rejects malformed direct JS calls with EINVAL.
  const invalidResult = op === 40 ? undefined : 28;
  if (args.length !== signature.length) return invalidResult;
  for (let i = 0; i < signature.length; i++) {
    if (signature[i] === 'I') { if (typeof args[i] !== 'bigint') return invalidResult; }
    else if (!Number.isInteger(args[i]) || args[i] < 0 || args[i] > 0xffffffff) return invalidResult;
  }
  if (state.memory === undefined) throw error(Error, 'ERR_WASI_NOT_STARTED', 'wasi.start() has not been called');
  // This bypasses user-defined .buffer properties and observes successful growth.
  return native(op, state.id, getMemoryBuffer(state.memory), args);
}
class WASI {
  constructor(options = {}) {
    object(options, 'options');
    if (typeof options.version !== 'string') throw invalid('options.version', 'string');
    let namespace;
    switch (options.version) {
      case 'preview1': namespace = 'wasi_snapshot_preview1'; break;
      case 'unstable': namespace = 'wasi_unstable'; break;
      default: throw error(TypeError, 'ERR_INVALID_ARG_VALUE', `The property 'options.version' must be a supported WASI version. Received '${options.version}'`);
    }
    if (options.args !== undefined && !Array.isArray(options.args)) throw invalid('options.args', 'Array');
    const args = (options.args || []).map(String);
    const env = [];
    if (options.env !== undefined) {
      object(options.env, 'options.env');
      for (const [key, value] of Object.entries(options.env)) if (value !== undefined) env.push(`${key}=${value}`);
    }
    const preopens = [];
    if (options.preopens !== undefined) {
      object(options.preopens, 'options.preopens');
      for (const [key, value] of Object.entries(options.preopens)) preopens.push(String(key), String(value));
    }
    const { stdin = 0, stdout = 1, stderr = 2 } = options;
    fd(stdin, 'options.stdin'); fd(stdout, 'options.stdout'); fd(stderr, 'options.stderr');
    const id = native(0, 0, undefined, [args.length, args, env.length, env, preopens.length / 2, preopens, stdin, stdout, stderr]);
    const state = { id, namespace, memory: undefined, instance: undefined, started: false, exitCode: 0, owner: {} };
    try {
      let returnOnExit = true;
      if (options.returnOnExit !== undefined) {
        if (typeof options.returnOnExit !== 'boolean') throw invalid('options.returnOnExit', 'boolean');
        returnOnExit = options.returnOnExit;
      }
      const imports = {};
      for (let i = 0; i < signatures.length; i++) {
        const [name, signature] = signatures[i];
        imports[name] = (...values) => syscall(state, i + 2, signature, values);
        Object.defineProperties(imports[name], {
          name: { value: `bound ${name}`, configurable: true },
          length: { value: signature.length, configurable: true },
        });
      }
      if (returnOnExit) {
        imports.proc_exit = value => { state.exitCode = value; throw exitSentinel; };
        Object.defineProperty(imports.proc_exit, 'name', { value: 'bound wasiReturnOnProcExit', configurable: true });
      }
      this.wasiImport = imports;
      states.set(this, state);
      finalizers.register(state.owner, id);
    } catch (e) { native(1, id); throw e; }
  }
  finalizeBindings(instance, { memory = instance?.exports?.memory } = {}) {
    const state = stateOf(this);
    if (state.started) throw error(Error, 'ERR_WASI_ALREADY_STARTED', 'WASI instance has already started');
    object(instance, 'instance'); object(instance.exports, 'instance.exports');
    if (!isMemory(memory)) throw invalid('instance.exports.memory', 'WebAssembly.Memory');
    state.memory = memory;
    state.instance = instance;
    state.started = true;
  }
  start(instance) {
    this.finalizeBindings(instance);
    const state = stateOf(this);
    const { _start, _initialize } = state.instance.exports;
    if (typeof _start !== 'function') throw invalid('instance.exports._start', 'function');
    if (_initialize !== undefined) throw invalid('instance.exports._initialize', 'undefined');
    try { _start(); } catch (e) { if (e !== exitSentinel) throw e; }
    return state.exitCode;
  }
  initialize(instance) {
    this.finalizeBindings(instance);
    const { _start, _initialize } = stateOf(this).instance.exports;
    if (_start !== undefined) throw invalid('instance.exports._start', 'undefined');
    if (_initialize !== undefined) {
      if (typeof _initialize !== 'function') throw invalid('instance.exports._initialize', 'function');
      _initialize();
    }
  }
  getImportObject() { return { [stateOf(this).namespace]: this.wasiImport }; }
}
module.exports = { WASI };
