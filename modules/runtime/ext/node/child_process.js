// child_process adapted from Node.js v24.22.1 lib/child_process.js: the same argument
// handling, validation, events and error shapes. ChildProcess, the stdio translation and
// the native spawnSync are internal/child_process, called through its exports as in Node.
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
const { Buffer } = require('buffer');
const child_process = require('internal/child_process');
const { ChildProcess, errnoException, getValidStdio, stdioStringToArray, kInheritEnvironment } = child_process;
const { AbortError } = require('internal/path_events/support');
const {
  codes: { ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE, ERR_OUT_OF_RANGE },
  codedError, validateString, validateBoolean, validateFunction, validateObject, validateArray,
  validateOneOf, validateAbortSignal, convertToValidSignal, signalName, getValidatedPath,
} = require('internal/validators');
const native = (op, args = []) => host.processNative(op, args);
const MAX_BUFFER = 1024 * 1024;
const kEmptyObject = Object.freeze({ __proto__: null });

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

let emittedDEP0190Already = false;
// Node's lib/child_process.js: a child of a process under the permission model gets the
// parent's permission flags through NODE_OPTIONS, unless it is given its own.
function permissionEnabled() {
  return require('internal/host').builtinLoaded('internal/permission') && require('internal/permission').enabled();
}
let permissionModelFlagsToCopy;
function getPermissionModelFlagsToCopy() {
  if (permissionModelFlagsToCopy === undefined) {
    permissionModelFlagsToCopy = ['--allow-fs-read', '--allow-fs-write', '--allow-addons', '--allow-child-process',
      '--allow-inspector', '--allow-wasi', '--allow-worker', '--allow-openssl-store', '--permission'];
  }
  return permissionModelFlagsToCopy;
}
function hasPermissionFlagInEnv(nodeOptions) {
  if (!nodeOptions) return false;
  const tokens = nodeOptions.split(/\s+/);
  return tokens.some((token) =>
    token === '--permission' ||
    token.startsWith('--permission=') ||
    token === '--permission-audit' ||
    token.startsWith('--permission-audit='),
  );
}
function copyPermissionModelFlagsToEnv(env, key, args) {
  if (args.includes('--permission') || args.includes('--permission-audit') ||
      hasPermissionFlagInEnv(env[key])) {
    return;
  }
  const flagsToCopy = getPermissionModelFlagsToCopy();
  for (const arg of process.execArgv) {
    for (const flag of flagsToCopy) {
      if (arg.startsWith(flag)) {
        env[key] = `${env[key] ? env[key] + ' ' + arg : arg}`;
      }
    }
  }
}

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
    // Set the shell, switches, and commands.
    if (process.platform === 'win32') {
      if (typeof options.shell === 'string') file = options.shell;
      else file = process.env.comspec || 'cmd.exe';
      // '/d /s /c' is used only for cmd.exe.
      if (/^(?:.*\\)?cmd(?:\.exe)?$/i.exec(file) !== null) {
        args = ['/d', '/s', '/c', `"${command}"`];
        windowsVerbatimArguments = true;
      } else args = ['-c', command];
    } else {
      if (typeof options.shell === 'string') file = options.shell;
      else if (process.platform === 'android') file = '/system/bin/sh';
      else file = '/bin/sh';
      args = ['-c', command];
    }
  }
  args.unshift(typeof options.argv0 === 'string' ? options.argv0 : file);
  let envPairs;
  let env = options.env;
  if (permissionEnabled()) {
    env = env || { ...process.env };
    copyPermissionModelFlagsToEnv(env, 'NODE_OPTIONS', args);
  }
  const inherit = !env || env === process.env;
  if (!inherit) {
    envPairs = [];
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
  options.stdio = getValidStdio(options.stdio || 'pipe', true).stdio;
  if (options.input) {
    const stdin = options.stdio[0] = { ...options.stdio[0] };
    stdin.input = options.input;
  }
  // We may want to pass data in on any given fd, ensure it is a valid buffer.
  for (let i = 0; i < options.stdio.length; i++) {
    const input = options.stdio[i]?.input;
    if (input != null) {
      const pipe = options.stdio[i] = { ...options.stdio[i] };
      if (ArrayBuffer.isView(input)) pipe.input = input;
      else if (typeof input === 'string') pipe.input = Buffer.from(input, options.encoding);
      else throw new ERR_INVALID_ARG_TYPE(`options.stdio[${i}]`, ['Buffer', 'TypedArray', 'DataView', 'string'], input);
    }
  }
  return child_process.spawnSync(options);
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
