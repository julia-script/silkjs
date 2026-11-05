'use strict';
const host = require('internal/host');
const { EventEmitter } = require('events');
const { AsyncResource } = require('async_hooks');
const { Buffer } = require('buffer');
const { Socket } = require('net');
const { signalNumber, signalName } = require('internal/process_signals');
const { setupChannel } = require('internal/child_process/ipc');
const native = (op, args = []) => host.processNative(op, args);
function invalid(name, expected) { return Object.assign(new TypeError(`The "${name}" argument must be of type ${expected}`), { code: 'ERR_INVALID_ARG_TYPE' }); }
function string(value, name) {
  if (typeof value !== 'string') throw invalid(name, 'string');
  if (value.includes('\0')) throw Object.assign(new TypeError(`The argument '${name}' must be a string without null bytes`), { code: 'ERR_INVALID_ARG_VALUE' });
  return value;
}
function nonnegative(value, name, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number') throw invalid(name, 'number');
  if (!Number.isFinite(value) || value < 0) throw Object.assign(new RangeError(`The value of "${name}" is out of range`), { code: 'ERR_OUT_OF_RANGE' });
  return value;
}
function normalize(file, args, options) {
  string(file, 'file');
  if (!file.length) throw Object.assign(new TypeError('The argument file cannot be empty'), { code: 'ERR_INVALID_ARG_VALUE' });
  if (Array.isArray(args)) args = args.slice();
  else { if (args != null) options = args; args = []; }
  if (options == null) options = {};
  if (typeof options !== 'object' || Array.isArray(options)) throw invalid('options', 'object');
  options = { ...options };
  args = args.map((arg, i) => string(String(arg), `args[${i}]`));
  let cwd = options.cwd === undefined ? process.cwd() : options.cwd;
  if (cwd && typeof cwd === 'object' && cwd.href) cwd = require('url').fileURLToPath(cwd);
  if (Buffer.isBuffer(cwd)) cwd = cwd.toString();
  string(cwd, 'options.cwd');
  let flags = options.detached ? 8 : 0;
  for (const key of ['uid', 'gid']) if (options[key] !== undefined) {
    if (!Number.isInteger(options[key]) || options[key] < 0 || options[key] > 0xffffffff) throw Object.assign(new RangeError(`${key} must be an unsigned 32-bit integer`), { code: 'ERR_OUT_OF_RANGE' });
    flags |= key === 'uid' ? 1 : 2;
  }
  const timeout = nonnegative(options.timeout, 'options.timeout', 0);
  const killSignal = signalNumber(options.killSignal);
  if (options.shell !== undefined && typeof options.shell !== 'boolean' && typeof options.shell !== 'string') throw invalid('options.shell', 'boolean or string');
  if (options.shell) {
    const command = [file, ...args].join(' ');
    file = typeof options.shell === 'string' ? string(options.shell, 'options.shell') : '/bin/sh';
    args = ['-c', command];
  }
  const argv = [options.argv0 === undefined ? file : string(options.argv0, 'options.argv0'), ...args];
  const environment = options.env === undefined ? process.env : options.env;
  if (environment === null || typeof environment !== 'object') throw invalid('options.env', 'object');
  const env = [];
  for (const key of Object.keys(environment)) if (environment[key] !== undefined) env.push(`${string(key, 'env key')}=${string(String(environment[key]), `env.${key}`)}`);
  let stdio = options.stdio;
  if (stdio === undefined || stdio === null) stdio = ['pipe', 'pipe', 'pipe'];
  else if (typeof stdio === 'string') {
    if (!['pipe', 'ignore', 'inherit', 'overlapped'].includes(stdio)) throw Object.assign(new TypeError('Invalid stdio option'), { code: 'ERR_INVALID_ARG_VALUE' });
    stdio = [stdio, stdio, stdio];
  } else if (Array.isArray(stdio)) stdio = stdio.slice();
  else throw invalid('options.stdio', 'string or Array');
  while (stdio.length < 3) stdio.push(undefined);
  let ipc = -1;
  const fds = stdio.map((entry, index) => {
    if (entry === undefined || entry === null) entry = index < 3 ? 'pipe' : 'ignore';
    if (entry === 'pipe' || entry === 'overlapped') return -1;
    if (entry === 'ipc') { if (ipc >= 0) throw Object.assign(new Error('Child process can have only one IPC pipe'), { code: 'ERR_IPC_ONE_PIPE' }); ipc = index; return -1; }
    if (entry === 'ignore') return -2;
    if (entry === 'inherit') return index;
    if (typeof entry === 'number' && Number.isInteger(entry) && entry >= 0) return entry;
    if (entry && typeof entry === 'object') {
      if (Number.isInteger(entry.fd) && entry.fd >= 0) return entry.fd;
      const fd = entry._transport?.call('fileno'); if (Number.isInteger(fd) && fd >= 0) return fd;
    }
    throw Object.assign(new TypeError(`Invalid stdio entry at index ${index}`), { code: 'ERR_INVALID_ARG_VALUE' });
  });
  const serialization = options.serialization || 'json';
  if (serialization !== 'json' && serialization !== 'advanced') throw Object.assign(new TypeError('Unknown serialization mode'), { code: 'ERR_INVALID_ARG_VALUE' });
  if (ipc >= 0) {
    for (let i = env.length - 1; i >= 0; i--) if (env[i].startsWith('NODE_CHANNEL_FD=') || env[i].startsWith('NODE_CHANNEL_SERIALIZATION_MODE=')) env.splice(i, 1);
    env.push(`NODE_CHANNEL_FD=${ipc}`, `NODE_CHANNEL_SERIALIZATION_MODE=${serialization}`);
  }
  if (options.signal !== undefined && (!options.signal || typeof options.signal.addEventListener !== 'function')) throw invalid('options.signal', 'AbortSignal');
  return { file, args, argv, options, timeout, killSignal, ipc, serialization, fds,
    nativeArgs: [file, argv.join('\0') + '\0', env.join('\0') + (env.length ? '\0' : ''), cwd, fds, flags, options.uid || 0, options.gid || 0] };
}
function spawnError(status, normalized, sync = false) {
  const code = native('errorName', [status]);
  return Object.assign(new Error(`${sync ? 'spawnSync' : 'spawn'} ${normalized.file} ${code}`), {
    errno: status, code, syscall: `${sync ? 'spawnSync' : 'spawn'} ${normalized.file}`,
    path: normalized.file, spawnargs: normalized.args.slice(),
  });
}
class ChildProcess extends EventEmitter {
  constructor() {
    super(); this.pid = undefined; this.killed = false; this.exitCode = null; this.signalCode = null;
    this.spawnfile = undefined; this.spawnargs = []; this.connected = false;
    this.stdin = null; this.stdout = null; this.stderr = null; this.stdio = [];
    this._id = 0; this._exited = false; this._closed = false; this._pendingClose = 0;
    this._resource = new AsyncResource('PROCESSWRAP');
  }
  _close() {
    if (!this._exited || this._pendingClose || this._closed) return;
    this._closed = true;
    this.emit('close', this.exitCode, this.signalCode);
    this._resource.emitDestroy();
  }
  _exit(code, signal) {
    if (this._exited) return;
    this._exited = true; this._id = 0;
    this.exitCode = signal ? null : code; this.signalCode = signalName(signal);
    clearTimeout(this._timer);
    if (this._abort) this._signal.removeEventListener('abort', this._abort);
    if (this.stdin) this.stdin.destroy();
    this.emit('exit', this.exitCode, this.signalCode);
    // Node drains unconsumed output after exit so close cannot wait forever on a full readable buffer.
    for (const stream of this.stdio) if (stream && stream !== this.stdin && !stream.readableFlowing) stream.resume();
    this._close();
  }
  kill(signal) {
    const number = signalNumber(signal);
    if (!this._id || this._exited) return false;
    const status = native('kill', [this._id, number]);
    if (status === 0) { this.killed = true; return true; }
    const code = native('errorName', [status]);
    if (code === 'ESRCH') return false;
    const error = Object.assign(new Error(`kill ${code}`), { code, errno: status, syscall: 'kill' });
    if (code === 'EINVAL' || code === 'ENOSYS') throw error;
    this.emit('error', error); return false;
  }
  ref() { if (this._id) native('ref', [this._id]); return this; }
  unref() { if (this._id) native('unref', [this._id]); return this; }
  [Symbol.dispose]() { if (!this.killed) this.kill(); }
}
function spawn(file, args, options) {
  const normalized = normalize(file, args, options);
  const child = new ChildProcess(); child.spawnfile = normalized.file; child.spawnargs = normalized.argv;
  const result = native('spawn', [...normalized.nativeArgs, (code, signal) => {
    host.invokeResource(child._resource, child._exit, child, [code, signal], false);
    host.checkpoint();
  }]);
  if (typeof result === 'number') {
    const error = spawnError(result, normalized);
    process.nextTick(() => { child._exited = true; child.exitCode = result; child.emit('error', error); child._close(); });
    return child;
  }
  child._id = result[0]; child.pid = result[1];
  for (let i = 0; i < normalized.fds.length; i++) {
    const fd = result[i + 2];
    if (fd < 0 || i === normalized.ipc) { child.stdio.push(null); continue; }
    let stream;
    try { stream = new Socket({ fd, readable: i !== 0, writable: i === 0 || i > 2 }); }
    catch (error) { native('closeFd', [fd]); child.kill(); throw error; }
    child._pendingClose++;
    stream.once('close', () => { child._pendingClose--; child._close(); });
    child.stdio.push(stream);
  }
  [child.stdin, child.stdout, child.stderr] = child.stdio;
  if (normalized.ipc >= 0) {
    child._pendingClose++;
    setupChannel(child, result[normalized.ipc + 2], normalized.serialization, () => { child._pendingClose--; child._close(); });
  }
  process.nextTick(() => child.emit('spawn'));
  if (normalized.timeout) {
    child._timer = setTimeout(() => child.kill(normalized.killSignal), normalized.timeout);
    child._timer.unref?.();
  }
  if (normalized.options.signal) {
    child._signal = normalized.options.signal;
    child._abort = () => {
      if (!child.kill(normalized.killSignal)) return;
      const error = Object.assign(new Error('The operation was aborted', { cause: child._signal.reason }), { name: 'AbortError', code: 'ABORT_ERR' });
      child.emit('error', error);
    };
    if (child._signal.aborted) process.nextTick(child._abort);
    else child._signal.addEventListener('abort', child._abort, { once: true });
  }
  return child;
}
function execFile(file, args, options, callback) {
  if (typeof args === 'function') { callback = args; args = []; options = {}; }
  else if (!Array.isArray(args)) { callback = typeof options === 'function' ? options : callback; options = args || {}; args = []; }
  else if (typeof options === 'function') { callback = options; options = {}; }
  options = { encoding: 'utf8', timeout: 0, maxBuffer: 1024 * 1024, ...(options || {}) };
  if (callback !== undefined && typeof callback !== 'function') throw invalid('callback', 'function');
  const maximum = options.maxBuffer === Infinity ? Infinity : nonnegative(options.maxBuffer, 'options.maxBuffer', 1024 * 1024);
  const timeout = nonnegative(options.timeout, 'options.timeout', 0);
  const child = spawn(file, args, { ...options, timeout: 0 });
  const terminate = () => { child.stdout?.destroy(); child.stderr?.destroy(); child.kill(options.killSignal); };
  const timer = timeout ? setTimeout(terminate, timeout) : null;
  timer?.unref?.();
  let stdout = [], stderr = [], outLength = 0, errLength = 0, error = null;
  function collect(chunk, isError) {
    const before = isError ? errLength : outLength;
    const available = Math.max(0, maximum - before);
    if (chunk.length > available) {
      if (!error) { error = Object.assign(new RangeError(`${isError ? 'stderr' : 'stdout'} maxBuffer length exceeded`), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }); terminate(); }
      chunk = chunk.subarray(0, available);
    }
    if (isError) { stderr.push(chunk); errLength += chunk.length; }
    else { stdout.push(chunk); outLength += chunk.length; }
  }
  child.stdout?.on('data', chunk => collect(Buffer.from(chunk), false));
  child.stderr?.on('data', chunk => collect(Buffer.from(chunk), true));
  child.on('error', err => { error ||= err; child.stdout?.destroy(); child.stderr?.destroy(); });
  child.once('close', (code, signal) => {
    clearTimeout(timer);
    let out = Buffer.concat(stdout, outLength), err = Buffer.concat(stderr, errLength);
    if (options.encoding && options.encoding !== 'buffer') { out = out.toString(options.encoding); err = err.toString(options.encoding); }
    if (!error && (code !== 0 || signal)) error = Object.assign(new Error(`Command failed: ${[file, ...args].join(' ')}\n${err}`), { code, killed: child.killed, signal });
    if (error) { error.cmd = [file, ...args].join(' '); error.killed = child.killed; error.signal = signal; }
    if (callback) callback(error, out, err);
    stdout = stderr = null;
  });
  return child;
}
function exec(command, options, callback) {
  string(command, 'command');
  if (typeof options === 'function') { callback = options; options = undefined; }
  return execFile(command, [], { ...(options || {}), shell: typeof options?.shell === 'string' ? options.shell : true }, callback);
}
function fork(modulePath, args, options) {
  if (modulePath && typeof modulePath === 'object' && modulePath.href) modulePath = require('url').fileURLToPath(modulePath);
  string(modulePath, 'modulePath');
  if (!Array.isArray(args)) { options = args; args = []; }
  options = { ...(options || {}) };
  let stdio = options.stdio;
  if (typeof stdio === 'string') stdio = [stdio, stdio, stdio, 'ipc'];
  else if (stdio === undefined) stdio = options.silent ? ['pipe', 'pipe', 'pipe', 'ipc'] : ['inherit', 'inherit', 'inherit', 'ipc'];
  else stdio = stdio.slice();
  if (!stdio.includes('ipc')) throw Object.assign(new Error('Forked processes must have an IPC channel'), { code: 'ERR_CHILD_PROCESS_IPC_REQUIRED' });
  let execArgv = options.execArgv === undefined ? process.execArgv || [] : options.execArgv;
  if (!Array.isArray(execArgv)) throw invalid('options.execArgv', 'Array');
  if (execArgv === process.execArgv && process._eval != null) {
    const index = execArgv.lastIndexOf(process._eval);
    if (index > 0) {
      execArgv = execArgv.slice();
      execArgv.splice(index - 1, 2);
    }
  }
  return spawn(options.execPath || process.execPath, [...execArgv, modulePath, ...args], { ...options, stdio, shell: false });
}
function spawnSync(file, args, options) {
  const normalized = normalize(file, args, options); options = normalized.options;
  if (normalized.ipc >= 0) throw Object.assign(new Error('IPC cannot be used with synchronous forks'), { code: 'ERR_IPC_SYNC_FORK' });
  let input = options.input === undefined ? Buffer.alloc(0) : options.input;
  if (typeof input === 'string') input = Buffer.from(input, options.encoding && options.encoding !== 'buffer' ? options.encoding : 'utf8');
  else if (ArrayBuffer.isView(input)) input = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  else throw invalid('options.input', 'string, Buffer, TypedArray, or DataView');
  const exactInput = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
  const maximum = options.maxBuffer === Infinity ? Infinity : nonnegative(options.maxBuffer, 'options.maxBuffer', 1024 * 1024);
  const raw = native('spawnSync', [...normalized.nativeArgs, exactInput, normalized.timeout, maximum, normalized.killSignal]);
  if (typeof raw === 'number') return { error: spawnError(raw, normalized, true), pid: 0, output: null, stdout: null, stderr: null, status: null, signal: null };
  const output = normalized.fds.map((fd, i) => {
    if (fd !== -1 || i === 0) return null;
    const value = Buffer.from(raw[i + 4]); return options.encoding && options.encoding !== 'buffer' ? value.toString(options.encoding) : value;
  });
  const result = { pid: raw[1], output, stdout: output[1], stderr: output[2], status: raw[3] ? null : raw[2], signal: signalName(raw[3]) };
  if (raw[0]) result.error = spawnError(raw[0], normalized, true);
  return result;
}
function execFileSync(file, args, options) {
  if (!Array.isArray(args)) { options = args; args = []; }
  const result = spawnSync(file, args, options);
  if (!options || options.stdio === undefined) if (result.stderr?.length) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) {
    const error = result.error || new Error(`Command failed: ${[file, ...args].join(' ')}\n${result.stderr || ''}`);
    Object.assign(error, result); throw error;
  }
  return result.stdout;
}
function execSync(command, options) {
  string(command, 'command'); return execFileSync(command, [], { ...(options || {}), shell: typeof options?.shell === 'string' ? options.shell : true });
}
const promisify = Symbol.for('nodejs.util.promisify.custom');
function promisified(fn) {
  return (...args) => {
    let child;
    const promise = new Promise((resolve, reject) => { child = fn(...args, (error, stdout, stderr) => { if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); } else resolve({ stdout, stderr }); }); });
    promise.child = child; return promise;
  };
}
exec[promisify] = promisified(exec); execFile[promisify] = promisified(execFile);
module.exports = { ChildProcess, spawn, execFile, exec, fork, spawnSync, execFileSync, execSync };
