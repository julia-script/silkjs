// internal/child_process adapted from Node.js v24.22.1 lib/internal/child_process.js:
// ChildProcess, the stdio translation, the internal spawnSync, and the IPC channel
// (internal/child_process/ipc.js), on the runtime's native process host
// (src/ext/process_native.silk). lib/child_process.js calls these through this module's
// exports, so a test can replace them, as in Node.
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
const diagnostics = require('internal/host').diagnostics;
const { Socket } = require('net');
const { setupChannel, kChannelHandle } = require('internal/child_process/ipc');
const {
  codes: { ERR_INVALID_ARG_VALUE }, codedError, validateString, validateObject, validateArray,
  validateOneOf, convertToValidSignal, signalName,
} = require('internal/validators');
const native = (op, args = []) => host.processNative(op, args);
const MAX_BUFFER = 1024 * 1024;
// The child gets this thread's own process.env natively, without a copy key by key.
const kInheritEnvironment = Symbol('kInheritEnvironment');
// A stream handed to a child as its stdio: the child reads it now, so this process must not.
const kIsUsedAsStdio = Symbol('kIsUsedAsStdio');

function errnoException(err, syscall) {
  const code = native('errorName', [err]);
  return Object.assign(new Error(`${syscall} ${code}`), { errno: err, code, syscall });
}

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
// Node's getHandleWrapType over this runtime's stream handles (internal/net/binding).
function getHandleWrapType(stream) {
  if (stream == null || typeof stream !== 'object') return false;
  const { tcp_wrap: { TCP }, pipe_wrap: { Pipe }, tty_wrap: { TTY } } = require('internal/net/binding');
  if (stream instanceof Pipe) return 'pipe';
  if (stream instanceof TTY) return 'tty';
  if (stream instanceof TCP) return 'tcp';
  if (stream instanceof require('internal/dgram').UDP) return 'udp';
  return false;
}
// Node's entries ({ type, ... }); the native host takes nativeFd of each at spawn.
function getValidStdio(stdio, sync) {
  let ipc;
  let ipcFd;
  if (typeof stdio === 'string') stdio = stdioStringToArray(stdio);
  else if (!Array.isArray(stdio)) throw new ERR_INVALID_ARG_VALUE('stdio', stdio);
  // At least 3 stdio will be created.
  while (stdio.length < 3) stdio.push(undefined);
  stdio = stdio.reduce((acc, stdio, i) => {
    stdio ??= i < 3 ? 'pipe' : 'ignore';
    if (stdio === 'ignore') acc.push({ type: 'ignore' });
    else if (stdio === 'pipe' || stdio === 'overlapped' || (typeof stdio === 'number' && stdio < 0)) {
      acc.push({ type: stdio === 'overlapped' ? 'overlapped' : 'pipe', readable: i === 0, writable: i !== 0 });
    } else if (stdio === 'ipc') {
      if (sync || ipc !== undefined) {
        if (!sync) throw codedError(Error, 'ERR_IPC_ONE_PIPE', 'Child process can have only one IPC pipe');
        throw codedError(Error, 'ERR_IPC_SYNC_FORK', 'IPC cannot be used with synchronous forks');
      }
      // The pipe itself is made at spawn; ipc names its slot, as Node's IPC Pipe would.
      ipc = i;
      ipcFd = i;
      acc.push({ type: 'pipe', ipc: true });
    } else if (stdio === 'inherit') acc.push({ type: 'inherit', fd: i });
    else if (typeof stdio === 'number' || typeof stdio.fd === 'number') {
      acc.push({ type: 'fd', fd: typeof stdio === 'number' ? stdio : stdio.fd });
    } else if (getHandleWrapType(stdio) || getHandleWrapType(stdio.handle) || getHandleWrapType(stdio._handle)) {
      const handle = getHandleWrapType(stdio) ? stdio : getHandleWrapType(stdio.handle) ? stdio.handle : stdio._handle;
      acc.push({ type: 'wrap', wrapType: getHandleWrapType(handle), handle, _stdio: stdio });
    } else if (ArrayBuffer.isView(stdio) || typeof stdio === 'string') {
      if (!sync) throw codedError(TypeError, 'ERR_INVALID_SYNC_FORK_INPUT',
        `Asynchronous forks do not support Buffer, TypedArray, DataView or string input: ${require('util').inspect(stdio)}`);
    } else throw new ERR_INVALID_ARG_VALUE('stdio', stdio);
    return acc;
  }, []);
  return { stdio, ipc, ipcFd };
}
// The native host's descriptor of an stdio entry: -1 a new pipe, -2 ignore, else an inherited fd.
function nativeFd(entry) {
  switch (entry.type) {
    case 'ignore': return -2;
    case 'pipe': case 'overlapped': return -1;
    case 'wrap': return entry.handle.fd;
    default: return entry.fd;
  }
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
// process_wrap.cc's Process over the native child watcher: a HandleWrap that keeps the loop
// alive while referenced, until it is closed. A closed handle's exit is never reported.
class Process {
  #id; #referenced = true; #closed = false;
  constructor(id) { this.#id = id; }
  kill(signal) { return native('kill', [this.#id, signal]); }
  ref() {
    if (this.#closed) return;
    this.#referenced = true;
    native('ref', [this.#id]);
  }
  unref() {
    if (this.#closed) return;
    this.#referenced = false;
    native('unref', [this.#id]);
  }
  hasRef() { return this.#referenced && !this.#closed; }
  close(callback) {
    if (this.#closed) return;
    this.#closed = true;
    native('unref', [this.#id]);
    if (typeof callback === 'function') process.nextTick(() => Reflect.apply(callback, this, []));
  }
  get closed() { return this.#closed; }
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
    diagnostics.publish('child_process', { process: this });
  }
  _onexit(exitCode, signal) {
    if (signal) this.signalCode = signalName(signal) ?? null;
    else this.exitCode = exitCode;
    this.stdin?.destroy();
    this._handle?.close();
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
    const tracing = diagnostics.tracing('child_process.spawn');
    tracing?.start.publish({ process: this, options });
    const result = native('spawn', [options.file, argv.map(String).join('\0') + '\0', nativeEnvironment(options),
      nativeCwd(options.cwd), stdio.map(nativeFd), flags, options.uid >>> 0, options.gid >>> 0, (code, signal) => {
        if (handle?.closed) return;
        host.invokeResource(this._resource, this._onexit, this, [code, signal], false);
        host.checkpoint();
      }]);
    let err = 0, handle;
    if (typeof result === 'number') {
      err = result;
      const code = native('errorName', [err]);
      if (code !== 'EACCES' && code !== 'EAGAIN' && code !== 'EMFILE' && code !== 'ENFILE' && code !== 'ENOENT') {
        this._resource.emitDestroy();
        tracing?.error.publish({ process: this, error: errnoException(err, 'spawn') });
        throw errnoException(err, 'spawn');
      }
      tracing?.error.publish({ process: this, error: errnoException(err, 'spawn') });
      process.nextTick(() => this._onexit(err, 0));
      if (code === 'EMFILE' || code === 'ENFILE') return err;
      this.pid = undefined;
    } else {
      this._handle = handle = new Process(result[0]);
      this.pid = result[1];
      tracing?.end.publish({ process: this });
      process.nextTick(() => this.emit('spawn'));
    }
    this.stdio = [];
    for (let i = 0; i < stdio.length; i++) {
      const entry = stdio[i];
      const fd = err ? -1 : result[i + 2];
      if (entry.type === 'wrap' && !err) {
        // Like Node: the parent stops reading a stream the child now reads.
        entry.handle.reading = false;
        entry.handle.readStop?.();
        const source = entry._stdio;
        source.pause?.();
        source.readableFlowing = false;
        if (source._readableState) source._readableState.reading = false;
        source[kIsUsedAsStdio] = true;
      }
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
      const err = this._handle.kill(signal);
      if (err === 0) { this.killed = true; return true; }
      const code = native('errorName', [err]);
      if (code === 'ESRCH') { /* Already dead. */ }
      else if (code === 'EINVAL' || code === 'ENOSYS') throw errnoException(err, 'kill');
      else this.emit('error', errnoException(err, 'kill'));
    }
    return false;
  }
  ref() { this._handle?.ref(); }
  unref() { this._handle?.unref(); }
  [Symbol.dispose]() { if (!this.killed) this.kill(); }
}

// Node's spawn_sync.spawn(options) on the native host. options.stdio holds getValidStdio
// entries; an entry's input (stdin's, here) is written to the child. The result's error is
// an errno, as the binding gives it.
function spawn(options) {
  const stdio = options.stdio;
  const input = stdio[0]?.input;
  const exactInput = input == null ? new ArrayBuffer(0) : input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
  const argv = options.args.map(String).join('\0') + '\0';
  let flags = 0;
  if (options.uid != null) flags |= 1;
  if (options.gid != null) flags |= 2;
  const raw = native('spawnSync', [options.file, argv, nativeEnvironment(options), nativeCwd(options.cwd),
    stdio.map(entry => entry.input != null ? -1 : nativeFd(entry)), flags, options.uid >>> 0, options.gid >>> 0, exactInput, options.timeout || 0,
    options.maxBuffer ?? MAX_BUFFER, options.killSignal || convertToValidSignal('SIGTERM')]);
  let result;
  if (typeof raw === 'number') result = { error: raw, status: null, signal: null, output: null, pid: 0 };
  else {
    const output = stdio.map((entry, i) => {
      if (i === 0 || (entry.type !== 'pipe' && entry.type !== 'overlapped')) return null;
      // Buffer.from(arrayBuffer) without its type checks: raw[i + 4] is a fresh ArrayBuffer.
      return Object.setPrototypeOf(new Uint8Array(raw[i + 4]), Buffer.prototype);
    });
    result = { status: raw[3] ? null : raw[2], signal: raw[3] ? signalName(raw[3]) ?? null : null, output, pid: raw[1] };
    if (raw[0]) result.error = raw[0];
  }
  return result;
}
const spawn_sync = { spawn };

// lib/internal/child_process.js spawnSync.
function spawnSync(options) {
  const result = spawn_sync.spawn(options);
  if (result.output && options.encoding && options.encoding !== 'buffer') {
    for (let i = 0; i < result.output.length; i++) {
      if (!result.output[i]) continue;
      result.output[i] = result.output[i].toString(options.encoding);
    }
  }
  result.stdout = result.output?.[1];
  result.stderr = result.output?.[2];
  if (result.error) {
    result.error = errnoException(result.error, 'spawnSync ' + options.file);
    result.error.path = options.file;
    result.error.spawnargs = options.args.slice(1);
  }
  return result;
}

module.exports = {
  spawn_sync,
  ChildProcess,
  kChannelHandle,
  setupChannel,
  getValidStdio,
  stdioStringToArray,
  spawnSync,
  // This runtime's own, for lib/child_process.js.
  errnoException,
  kInheritEnvironment,
};
