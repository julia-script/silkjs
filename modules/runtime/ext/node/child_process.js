// child_process adapted from Node.js v24.22.1 lib/child_process.js and the ChildProcess
// parts of lib/internal/child_process.js: the same argument handling, validation, events
// and error shapes, on the runtime's native process host (src/ext/process_native.silk).
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';
const host = require('internal/host');
const { EventEmitter } = require('events');
const { AsyncResource } = require('async_hooks');
const { Buffer } = require('buffer');
const { Socket } = require('net');
const { setupChannel } = require('internal/child_process/ipc');
const { AbortError } = require('internal/path_events/support');
const {
  codes: { ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE, ERR_OUT_OF_RANGE },
  codedError, validateString, validateBoolean, validateFunction, validateObject, validateArray,
  validateOneOf, validateAbortSignal, convertToValidSignal, signalName, getValidatedPath,
} = require('internal/validators');
const native = (op, args = []) => host.processNative(op, args);
const MAX_BUFFER = 1024 * 1024;
const kEmptyObject = Object.freeze({ __proto__: null });
// The child gets this thread's own process.env natively, without a copy key by key.
const kInheritEnvironment = Symbol('kInheritEnvironment');
// A stream handed to a child as its stdio: the child reads it now, so this process must not.
const kIsUsedAsStdio = Symbol('kIsUsedAsStdio');

function errnoException(err, syscall) {
  const code = native('errorName', [err]);
  return Object.assign(new Error(`${syscall} ${code}`), { errno: err, code, syscall });
}
function genericNodeError(message, properties) { return Object.assign(new Error(message), properties); }
function validateArgumentNullCheck(arg, name) {
  if (typeof arg === 'string' && arg.includes('\u0000')) throw new ERR_INVALID_ARG_VALUE(name, arg, 'must be a string without null bytes');
}
function validateArgumentsNullCheck(args, name) {
  for (let i = 0; i < args.length; ++i) validateArgumentNullCheck(args[i], `${name}[${i}]`);
}
function validateTimeout(timeout) {
  if (timeout != null && !(Number.isInteger(timeout) && timeout >= 0)) throw new ERR_OUT_OF_RANGE('timeout', 'an unsigned integer', timeout);
}
function validateMaxBuffer(maxBuffer) {
  if (maxBuffer != null && !(typeof maxBuffer === 'number' && maxBuffer >= 0)) throw new ERR_OUT_OF_RANGE('options.maxBuffer', 'a positive number', maxBuffer);
}
function sanitizeKillSignal(killSignal) {
  if (typeof killSignal === 'string' || typeof killSignal === 'number') return convertToValidSignal(killSignal);
  if (killSignal != null) throw new ERR_INVALID_ARG_TYPE('options.killSignal', ['string', 'number'], killSignal);
}
const isInt32 = value => value === (value | 0);

function stdioStringToArray(stdio, channel) {
  const options = [];
  switch (stdio) {
    case 'ignore': case 'overlapped': case 'pipe': options.push(stdio, stdio, stdio); break;
    case 'inherit': options.push(0, 1, 2); break;
    default: throw new ERR_INVALID_ARG_VALUE('stdio', stdio);
  }
  if (channel) options.push(channel);
  return options;
}
// The native host's descriptor of an stdio entry: -1 a new pipe, -2 ignore, else an inherited fd.
function getValidStdio(stdio, sync) {
  let ipc;
  if (typeof stdio === 'string') stdio = stdioStringToArray(stdio);
  else if (!Array.isArray(stdio)) throw new ERR_INVALID_ARG_VALUE('stdio', stdio);
  else stdio = stdio.slice();
  while (stdio.length < 3) stdio.push(undefined);
  const result = stdio.map((entry, i) => {
    entry ??= i < 3 ? 'pipe' : 'ignore';
    if (entry === 'ignore') return { type: 'ignore', fd: -2 };
    if (entry === 'pipe' || entry === 'overlapped' || (typeof entry === 'number' && entry < 0)) return { type: 'pipe', fd: -1 };
    if (entry === 'ipc') {
      if (sync) throw codedError(Error, 'ERR_IPC_SYNC_FORK', 'IPC cannot be used with synchronous forks');
      if (ipc !== undefined) throw codedError(Error, 'ERR_IPC_ONE_PIPE', 'Child process can have only one IPC pipe');
      ipc = i;
      return { type: 'pipe', fd: -1, ipc: true };
    }
    if (entry === 'inherit') return { type: 'inherit', fd: i };
    if (typeof entry === 'number') return { type: 'fd', fd: entry };
    if (typeof entry.fd === 'number') return { type: 'fd', fd: entry.fd };
    const fd = entry._transport?.call('fileno');
    if (Number.isInteger(fd) && fd >= 0) return { type: 'wrap', fd, source: entry };
    if (ArrayBuffer.isView(entry) || typeof entry === 'string') {
      if (!sync) throw codedError(TypeError, 'ERR_INVALID_SYNC_FORK_INPUT',
        `Asynchronous forks do not support Buffer, TypedArray, DataView or string input: ${require('util').inspect(entry)}`);
      return { type: 'pipe', fd: -1 };
    }
    throw new ERR_INVALID_ARG_VALUE('stdio', entry);
  });
  return { stdio: result, ipc };
}
function nativeCwd(cwd) {
  if (cwd == null || cwd === '') return null;
  return Buffer.isBuffer(cwd) || cwd instanceof Uint8Array ? Buffer.from(cwd).toString() : cwd;
}
function nativeEnvironment(options) {
  const pairs = options[kInheritEnvironment] ? null : options.envPairs;
  return pairs == null ? null : pairs.join('\0') + (pairs.length ? '\0' : '');
}
function inheritedPairs() {
  const pairs = [];
  for (const key of Object.keys(process.env)) if (process.env[key] !== undefined) pairs.push(`${key}=${process.env[key]}`);
  return pairs;
}

function flushStdio(subprocess) {
  for (const stream of subprocess.stdio || []) if (stream && stream.readable && !stream[kIsUsedAsStdio] && stream !== subprocess.stdin) stream.resume();
}
function maybeClose(subprocess) {
  if (++subprocess._closesGot === subprocess._closesNeeded) {
    subprocess.emit('close', subprocess.exitCode, subprocess.signalCode);
    subprocess._resource.emitDestroy();
  }
}
class ChildProcess extends EventEmitter {
  constructor() {
    super();
    this._closesNeeded = 1;
    this._closesGot = 0;
    this.connected = false;
    this.signalCode = null;
    this.exitCode = null;
    this.killed = false;
    this.spawnfile = null;
    this._handle = null;
    this._resource = new AsyncResource('PROCESSWRAP');
  }
  _onexit(exitCode, signal) {
    if (signal) this.signalCode = signalName(signal) ?? null;
    else this.exitCode = exitCode;
    this.stdin?.destroy();
    this._handle = null;
    if (exitCode < 0) {
      const syscall = this.spawnfile ? 'spawn ' + this.spawnfile : 'spawn';
      const err = errnoException(exitCode, syscall);
      if (this.spawnfile) err.path = this.spawnfile;
      err.spawnargs = this.spawnargs.slice(1);
      this.emit('error', err);
    } else {
      this.emit('exit', this.exitCode, this.signalCode);
    }
    process.nextTick(flushStdio, this);
    maybeClose(this);
  }
  spawn(options) {
    validateObject(options, 'options');
    const { stdio, ipc } = getValidStdio(options.stdio || 'pipe', false);
    options.stdio = stdio;
    validateOneOf(options.serialization, 'options.serialization', [undefined, 'json', 'advanced']);
    const serialization = options.serialization || 'json';
    if (ipc !== undefined) {
      if (options[kInheritEnvironment]) { options.envPairs = inheritedPairs(); options[kInheritEnvironment] = false; }
      else if (options.envPairs === undefined) options.envPairs = [];
      else validateArray(options.envPairs, 'options.envPairs');
      options.envPairs.push(`NODE_CHANNEL_FD=${ipc}`, `NODE_CHANNEL_SERIALIZATION_MODE=${serialization}`);
    }
    validateString(options.file, 'options.file');
    this.spawnfile = options.file;
    if (options.args === undefined) this.spawnargs = [];
    else {
      validateArray(options.args, 'options.args');
      this.spawnargs = options.args;
    }
    let flags = options.detached ? 8 : 0;
    if (options.uid != null) flags |= 1;
    if (options.gid != null) flags |= 2;
    const argv = this.spawnargs.length ? this.spawnargs : [options.file];
    const result = native('spawn', [options.file, argv.map(String).join('\0') + '\0', nativeEnvironment(options),
      nativeCwd(options.cwd), stdio.map(entry => entry.fd), flags, options.uid >>> 0, options.gid >>> 0, (code, signal) => {
        host.invokeResource(this._resource, this._onexit, this, [code, signal], false);
        host.checkpoint();
      }]);
    let err = 0;
    if (typeof result === 'number') {
      err = result;
      const code = native('errorName', [err]);
      if (code !== 'EACCES' && code !== 'EAGAIN' && code !== 'EMFILE' && code !== 'ENFILE' && code !== 'ENOENT') {
        this._resource.emitDestroy();
        throw errnoException(err, 'spawn');
      }
      process.nextTick(() => this._onexit(err, 0));
      if (code === 'EMFILE' || code === 'ENFILE') return err;
      this.pid = undefined;
    } else {
      this._handle = result[0];
      this.pid = result[1];
      process.nextTick(() => this.emit('spawn'));
    }
    this.stdio = [];
    for (let i = 0; i < stdio.length; i++) {
      const entry = stdio[i];
      const fd = err ? -1 : result[i + 2];
      if (entry.type === 'wrap' && !err) { entry.source.pause(); entry.source[kIsUsedAsStdio] = true; }
      if (entry.type !== 'pipe') { this.stdio.push(null); continue; }
      if (entry.ipc) {
        this.stdio.push(null);
        if (!err) { this._closesNeeded++; setupChannel(this, fd, serialization, () => maybeClose(this)); }
        continue;
      }
      let stream;
      if (err) stream = new Socket({ readable: i > 0, writable: i === 0 });
      else {
        try { stream = new Socket({ fd, readable: i !== 0, writable: i === 0 || i > 2 }); }
        catch (error) { native('closeFd', [fd]); this.kill(); throw error; }
        if (i > 0) { this._closesNeeded++; stream.on('close', () => maybeClose(this)); }
      }
      this.stdio.push(stream);
    }
    this.stdin = this.stdio.length >= 1 ? this.stdio[0] : null;
    this.stdout = this.stdio.length >= 2 ? this.stdio[1] : null;
    this.stderr = this.stdio.length >= 3 ? this.stdio[2] : null;
    return err;
  }
  kill(sig) {
    const signal = sig === 0 ? sig : convertToValidSignal(sig === undefined ? 'SIGTERM' : sig);
    if (this._handle) {
      const err = native('kill', [this._handle, signal]);
      if (err === 0) { this.killed = true; return true; }
      const code = native('errorName', [err]);
      if (code === 'ESRCH') { /* Already dead. */ }
      else if (code === 'EINVAL' || code === 'ENOSYS') throw errnoException(err, 'kill');
      else this.emit('error', errnoException(err, 'kill'));
    }
    return false;
  }
  ref() { if (this._handle) native('ref', [this._handle]); }
  unref() { if (this._handle) native('unref', [this._handle]); }
  [Symbol.dispose]() { if (!this.killed) this.kill(); }
}

let emittedDEP0190Already = false;
function normalizeSpawnArguments(file, args, options) {
  validateString(file, 'file');
  validateArgumentNullCheck(file, 'file');
  if (file.length === 0) throw new ERR_INVALID_ARG_VALUE('file', file, 'cannot be empty');
  if (Array.isArray(args)) args = args.slice();
  else if (args == null) args = [];
  else if (typeof args !== 'object') throw new ERR_INVALID_ARG_TYPE('args', 'object', args);
  else { options = args; args = []; }
  validateArgumentsNullCheck(args, 'args');
  if (options === undefined) options = kEmptyObject;
  else validateObject(options, 'options');
  options = { __proto__: null, ...options };
  let cwd = options.cwd;
  if (cwd != null) cwd = getValidatedPath(cwd, 'options.cwd');
  if (options.detached != null) validateBoolean(options.detached, 'options.detached');
  if (options.uid != null && !isInt32(options.uid)) throw new ERR_INVALID_ARG_TYPE('options.uid', 'int32', options.uid);
  if (options.gid != null && !isInt32(options.gid)) throw new ERR_INVALID_ARG_TYPE('options.gid', 'int32', options.gid);
  if (options.shell != null && typeof options.shell !== 'boolean' && typeof options.shell !== 'string') {
    throw new ERR_INVALID_ARG_TYPE('options.shell', ['boolean', 'string'], options.shell);
  }
  if (options.argv0 != null) {
    validateString(options.argv0, 'options.argv0');
    validateArgumentNullCheck(options.argv0, 'options.argv0');
  }
  if (options.windowsHide != null) validateBoolean(options.windowsHide, 'options.windowsHide');
  let { windowsVerbatimArguments } = options;
  if (windowsVerbatimArguments != null) validateBoolean(windowsVerbatimArguments, 'options.windowsVerbatimArguments');
  if (options.shell) {
    validateArgumentNullCheck(options.shell, 'options.shell');
    if (args.length > 0 && !emittedDEP0190Already) {
      process.emitWarning('Passing args to a child process with shell option true can lead to security ' +
        'vulnerabilities, as the arguments are not escaped, only concatenated.', 'DeprecationWarning', 'DEP0190');
      emittedDEP0190Already = true;
    }
    const command = args.length > 0 ? `${file} ${args.join(' ')}` : file;
    file = typeof options.shell === 'string' ? options.shell : process.platform === 'android' ? '/system/bin/sh' : '/bin/sh';
    args = ['-c', command];
  }
  args.unshift(typeof options.argv0 === 'string' ? options.argv0 : file);
  let envPairs;
  const inherit = !options.env || options.env === process.env;
  if (!inherit) {
    envPairs = [];
    const env = options.env;
    // Prototype values are intentionally included.
    for (const key in env) {
      const value = env[key];
      if (value !== undefined) {
        validateArgumentNullCheck(key, `options.env['${key}']`);
        validateArgumentNullCheck(value, `options.env['${key}']`);
        envPairs.push(`${key}=${value}`);
      }
    }
  }
  return { __proto__: null, ...options, args, cwd, detached: !!options.detached, envPairs, [kInheritEnvironment]: inherit, file,
    windowsHide: !!options.windowsHide, windowsVerbatimArguments: !!windowsVerbatimArguments };
}

function abortChildProcess(child, killSignal, reason) {
  if (!child) return;
  try {
    if (child.kill(killSignal)) child.emit('error', new AbortError(undefined, { cause: reason }));
  } catch (err) { child.emit('error', err); }
}
function spawn(file, args, options) {
  options = normalizeSpawnArguments(file, args, options);
  validateTimeout(options.timeout);
  validateAbortSignal(options.signal, 'options.signal');
  const killSignal = sanitizeKillSignal(options.killSignal);
  const child = new ChildProcess();
  child.spawn(options);
  if (options.timeout > 0) {
    let timeoutId = setTimeout(() => {
      if (timeoutId) {
        try { child.kill(killSignal); } catch (err) { child.emit('error', err); }
        timeoutId = null;
      }
    }, options.timeout);
    child.once('close', () => { if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; } });
  }
  if (options.signal) {
    const signal = options.signal;
    const onAbortListener = () => abortChildProcess(child, killSignal, options.signal.reason);
    if (signal.aborted) process.nextTick(onAbortListener);
    else {
      const disposable = require('internal/path_events/abort_listener').addAbortListener(signal, onAbortListener);
      child.once('exit', () => disposable[Symbol.dispose]());
    }
  }
  return child;
}

function fork(modulePath, args = [], options) {
  modulePath = getValidatedPath(modulePath, 'modulePath');
  if (args == null) args = [];
  else if (typeof args === 'object' && !Array.isArray(args)) { options = args; args = []; }
  else validateArray(args, 'args');
  if (options != null) validateObject(options, 'options');
  options = { __proto__: null, ...options, shell: false };
  options.execPath ||= process.execPath;
  validateArgumentNullCheck(options.execPath, 'options.execPath');
  let execArgv = options.execArgv || process.execArgv;
  validateArgumentsNullCheck(execArgv, 'options.execArgv');
  if (execArgv === process.execArgv && process._eval != null) {
    const index = execArgv.lastIndexOf(process._eval);
    if (index > 0) {
      // Remove the -e switch to avoid fork bombing ourselves.
      execArgv = execArgv.slice();
      execArgv.splice(index - 1, 2);
    }
  }
  args = [...execArgv, modulePath, ...args];
  if (typeof options.stdio === 'string') options.stdio = stdioStringToArray(options.stdio, 'ipc');
  else if (!Array.isArray(options.stdio)) options.stdio = stdioStringToArray(options.silent ? 'pipe' : 'inherit', 'ipc');
  else if (!options.stdio.includes('ipc')) {
    throw codedError(Error, 'ERR_CHILD_PROCESS_IPC_REQUIRED', "Forked processes must have an IPC channel, missing value 'ipc' in options.stdio");
  }
  return spawn(options.execPath, args, options);
}

function normalizeExecArgs(command, options, callback) {
  validateString(command, 'command');
  validateArgumentNullCheck(command, 'command');
  if (typeof options === 'function') { callback = options; options = undefined; }
  options = { __proto__: null, ...options };
  options.shell = typeof options.shell === 'string' ? options.shell : true;
  return { file: command, options, callback };
}
function exec(command, options, callback) {
  const opts = normalizeExecArgs(command, options, callback);
  return module.exports.execFile(opts.file, opts.options, opts.callback);
}
function normalizeExecFileArgs(file, args, options, callback) {
  if (Array.isArray(args)) args = args.slice();
  else if (args != null && typeof args === 'object') { callback = options; options = args; args = null; }
  else if (typeof args === 'function') { callback = args; options = null; args = null; }
  args ??= [];
  if (typeof options === 'function') callback = options;
  else if (options != null) validateObject(options, 'options');
  options ??= kEmptyObject;
  if (callback != null) validateFunction(callback, 'callback');
  if (options.argv0 != null) {
    validateString(options.argv0, 'options.argv0');
    validateArgumentNullCheck(options.argv0, 'options.argv0');
  }
  return { file, args, options, callback };
}
function maxBufferError(name) {
  return codedError(RangeError, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', `${name} maxBuffer length exceeded`);
}
function execFile(file, args, options, callback) {
  ({ file, args, options, callback } = normalizeExecFileArgs(file, args, options, callback));
  options = { __proto__: null, encoding: 'utf8', timeout: 0, maxBuffer: MAX_BUFFER, killSignal: 'SIGTERM', cwd: null, env: null, shell: false, ...options };
  validateTimeout(options.timeout);
  validateMaxBuffer(options.maxBuffer);
  options.killSignal = sanitizeKillSignal(options.killSignal);
  const child = spawn(file, args, {
    __proto__: null, cwd: options.cwd, env: options.env, gid: options.gid, shell: options.shell, signal: options.signal, uid: options.uid,
    windowsHide: !!options.windowsHide, windowsVerbatimArguments: !!options.windowsVerbatimArguments,
  });
  const encoding = options.encoding !== 'buffer' && Buffer.isEncoding(options.encoding) ? options.encoding : null;
  const _stdout = [];
  const _stderr = [];
  let stdoutLen = 0;
  let stderrLen = 0;
  let killed = false;
  let exited = false;
  let timeoutId;
  let ex = null;
  let cmd = file;
  function exithandler(code, signal) {
    if (exited) return;
    exited = true;
    if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
    if (!callback) return;
    const stdout = encoding || child.stdout?.readableEncoding ? _stdout.join('') : Buffer.concat(_stdout);
    const stderr = encoding || child.stderr?.readableEncoding ? _stderr.join('') : Buffer.concat(_stderr);
    if (!ex && code === 0 && signal === null) { callback(null, stdout, stderr); return; }
    if (args?.length) cmd += ` ${args.join(' ')}`;
    ex ||= genericNodeError(`Command failed: ${cmd}\n${stderr}`, {
      code: code < 0 ? native('errorName', [code]) : code, killed: child.killed || killed, signal,
    });
    ex.cmd = cmd;
    callback(ex, stdout, stderr);
  }
  function errorhandler(e) {
    ex = e;
    child.stdout?.destroy();
    child.stderr?.destroy();
    exithandler();
  }
  function kill() {
    child.stdout?.destroy();
    child.stderr?.destroy();
    killed = true;
    try { child.kill(options.killSignal); } catch (e) { ex = e; exithandler(); }
  }
  if (options.timeout > 0) {
    timeoutId = setTimeout(() => { kill(); timeoutId = null; }, options.timeout);
  }
  function collect(stream, chunks, name) {
    if (encoding) stream.setEncoding(encoding);
    let length = 0;
    stream.on('data', chunk => {
      if (options.maxBuffer === Infinity) { chunks.push(chunk); return; }
      const streamEncoding = stream.readableEncoding;
      const size = streamEncoding ? Buffer.byteLength(chunk, streamEncoding) : chunk.length;
      length += size;
      if (name === 'stdout') stdoutLen = length; else stderrLen = length;
      if (length > options.maxBuffer) {
        const truncatedLen = options.maxBuffer - (length - size);
        chunks.push(chunk.slice(0, truncatedLen));
        ex = maxBufferError(name);
        kill();
      } else chunks.push(chunk);
    });
  }
  if (child.stdout) collect(child.stdout, _stdout, 'stdout');
  if (child.stderr) collect(child.stderr, _stderr, 'stderr');
  child.addListener('close', exithandler);
  child.addListener('error', errorhandler);
  return child;
}

function spawnSync(file, args, options) {
  options = { __proto__: null, maxBuffer: MAX_BUFFER, ...normalizeSpawnArguments(file, args, options) };
  validateTimeout(options.timeout);
  validateMaxBuffer(options.maxBuffer);
  options.killSignal = sanitizeKillSignal(options.killSignal);
  const stdio = getValidStdio(options.stdio || 'pipe', true).stdio;
  const source = typeof options.stdio === 'string' || !Array.isArray(options.stdio) ? [] : options.stdio;
  let input = options.input || (source[0] && typeof source[0] === 'object' ? source[0].input : undefined);
  for (let i = 0; i < stdio.length; i++) {
    const value = i === 0 ? input : source[i]?.input;
    if (value == null) continue;
    if (ArrayBuffer.isView(value)) { if (i === 0) input = value; }
    else if (typeof value === 'string') { if (i === 0) input = Buffer.from(value, options.encoding); }
    else throw new ERR_INVALID_ARG_TYPE(`options.stdio[${i}]`, ['Buffer', 'TypedArray', 'DataView', 'string'], value);
  }
  const exactInput = input == null ? new ArrayBuffer(0) : input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
  const argv = options.args.map(String).join('\0') + '\0';
  let flags = 0;
  if (options.uid != null) flags |= 1;
  if (options.gid != null) flags |= 2;
  const raw = native('spawnSync', [options.file, argv, nativeEnvironment(options), nativeCwd(options.cwd),
    stdio.map(entry => entry.fd), flags, options.uid >>> 0, options.gid >>> 0, exactInput, options.timeout || 0,
    options.maxBuffer ?? MAX_BUFFER, options.killSignal || convertToValidSignal('SIGTERM')]);
  let result;
  if (typeof raw === 'number') result = { error: raw, status: null, signal: null, output: null, pid: 0 };
  else {
    const output = stdio.map((entry, i) => {
      if (entry.fd !== -1 || i === 0) return null;
      // Buffer.from(arrayBuffer) without its type checks: raw[i + 4] is a fresh ArrayBuffer.
      return Object.setPrototypeOf(new Uint8Array(raw[i + 4]), Buffer.prototype);
    });
    result = { status: raw[3] ? null : raw[2], signal: raw[3] ? signalName(raw[3]) ?? null : null, output, pid: raw[1] };
    if (raw[0]) result.error = raw[0];
  }
  if (result.output && options.encoding && options.encoding !== 'buffer') {
    for (let i = 0; i < result.output.length; i++) if (result.output[i]) result.output[i] = result.output[i].toString(options.encoding);
  }
  result.stdout = result.output && result.output[1];
  result.stderr = result.output && result.output[2];
  if (result.error) {
    result.error = errnoException(result.error, 'spawnSync ' + options.file);
    result.error.path = options.file;
    result.error.spawnargs = options.args.slice(1);
  }
  return result;
}
function checkExecSyncError(ret, args, cmd) {
  let err;
  if (ret.error) {
    err = ret.error;
    Object.assign(err, ret);
  } else if (ret.status !== 0) {
    let msg = 'Command failed: ';
    msg += cmd || args.join(' ');
    if (ret.stderr && ret.stderr.length > 0) msg += `\n${ret.stderr.toString()}`;
    err = genericNodeError(msg, ret);
  }
  return err;
}
function execFileSync(file, args, options) {
  ({ file, args, options } = normalizeExecFileArgs(file, args, options));
  const inheritStderr = !options.stdio;
  const ret = spawnSync(file, args, options);
  if (inheritStderr && ret.stderr) process.stderr.write(ret.stderr);
  const err = checkExecSyncError(ret, [options.argv0 || file, ...args]);
  if (err) throw err;
  return ret.stdout;
}
function execSync(command, options) {
  const opts = normalizeExecArgs(command, options, null);
  const inheritStderr = !opts.options.stdio;
  const ret = spawnSync(opts.file, opts.options);
  if (inheritStderr && ret.stderr) process.stderr.write(ret.stderr);
  const err = checkExecSyncError(ret, undefined, command);
  if (err) throw err;
  return ret.stdout;
}

function customPromiseExecFunction(orig) {
  const fn = function(...args) {
    let resolve, reject;
    const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
    promise.child = orig(...args, (err, stdout, stderr) => {
      if (err !== null) { err.stdout = stdout; err.stderr = stderr; reject(err); }
      else resolve({ stdout, stderr });
    });
    return promise;
  };
  Object.defineProperty(fn, 'name', { value: orig.name });
  return fn;
}
const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');
Object.defineProperty(exec, promisifyCustom, { enumerable: false, value: customPromiseExecFunction(exec) });
Object.defineProperty(execFile, promisifyCustom, { enumerable: false, value: customPromiseExecFunction(execFile) });
module.exports = { ChildProcess, exec, execFile, execFileSync, execSync, fork, spawn, spawnSync };
