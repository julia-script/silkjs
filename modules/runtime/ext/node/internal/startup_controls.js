'use strict';

const host = require('internal/host');
const booleanOptions = new Map([
  ['--warnings', 'warnings'], ['--deprecation', 'deprecation'],
  ['--trace-warnings', 'traceProcessWarnings'], ['--trace-deprecation', 'traceDeprecation'],
  ['--throw-deprecation', 'throwDeprecation'], ['--pending-deprecation', 'pendingDeprecation'],
  // Every ArrayBuffer the engine allocates is zero-filled, so Buffer's unsafe
  // allocations already meet --zero-fill-buffers.
  ['--zero-fill-buffers', 'zeroFillBuffers'],
  ['--abort-on-uncaught-exception', 'abortOnUncaughtException'], ['--trace-exit', 'traceExit'],
  ['--network-family-autoselection', 'networkFamilyAutoselection'],
]);
const valueOptions = new Set(['--disable-warning', '--redirect-warnings', '--unhandled-rejections', '--stack-trace-limit',
  '--network-family-autoselection-attempt-timeout']);
const rejectionModes = new Set(['throw', 'strict', 'warn', 'warn-with-error-code', 'none']);
const defaults = () => ({ warnings: true, deprecation: true, unhandledRejections: 'throw',
  networkFamilyAutoselection: true, networkFamilyAutoselectionAttemptTimeout: 250 });
let state = defaults();
const disabledWarnings = new Set();
let traceHelperShown = false;
let warningFd;
let captureCallback = null;

function valueError(name, value) {
  if (valueOptions.has(name) && (value === undefined || value === '')) return name + ' requires an argument';
  if (name === '--unhandled-rejections' && !rejectionModes.has(value)) return 'invalid value for --unhandled-rejections';
  if (name === '--stack-trace-limit' && !/^-?[0-9]+$/.test(value)) return 'invalid value for --stack-trace-limit';
}
function applyOption(arg) {
  const separator = arg.indexOf('=');
  const name = separator < 0 ? arg : arg.slice(0, separator);
  if (separator < 0) {
    const positive = name.startsWith('--no-') ? '--' + name.slice(5) : name;
    const key = booleanOptions.get(positive);
    if (!key) return false;
    state[key] = positive === name;
    return true;
  }
  if (!valueOptions.has(name)) return false;
  const value = arg.slice(separator + 1), error = valueError(name, value);
  if (error) throw new Error(error);
  if (name === '--disable-warning') disabledWarnings.add(value);
  else if (name === '--redirect-warnings') state.redirectWarnings = value;
  else if (name === '--network-family-autoselection-attempt-timeout') state.networkFamilyAutoselectionAttemptTimeout = Number(value);
  // A V8 flag: it sets the initial Error.stackTraceLimit and the depth of --trace-exit stacks.
  else if (name === '--stack-trace-limit') Error.stackTraceLimit = state.stackTraceLimit = Number(value);
  else state.unhandledRejections = value;
  return true;
}
function initialize() {
  for (const name of ['traceProcessWarnings', 'traceDeprecation', 'throwDeprecation']) {
    if (state[name]) process[name] = true;
  }
  if (!state.deprecation) process.noDeprecation = true;
  host.pendingDeprecation = state.pendingDeprecation ?? process.env.NODE_PENDING_DEPRECATION === '1';
  // pre_execution.js initializeDeprecations.
  if (host.pendingDeprecation) {
    process.binding = require('internal/util').deprecate(process.binding,
      'process.binding() is deprecated. Please use public APIs instead.', 'DEP0111');
  }
  state.redirectWarnings ||= process.env.NODE_REDIRECT_WARNINGS;
  if (state.warnings && process.env.NODE_NO_WARNINGS !== '1') process.on('warning', onWarning);
  if (state.abortOnUncaughtException) host.abortOnUncaughtException = abortOnUncaughtException;
  if (host.startupSnapshot.isBuildingSnapshotBuffer[0])
    require('internal/v8/startup_snapshot').namespace.addSerializeCallback(resetForSerialization);
}
function closeWarningFile() { try { require('fs').closeSync(warningFd); } catch {} }
// The options belong to the process that gave them, as Node's do: a start from a startup
// snapshot reads its own (pre_execution.js setupWarningHandler, warning.js resetForSerialization).
function resetForSerialization() {
  process.removeListener('warning', onWarning);
  if (warningFd !== undefined) { process.removeListener('exit', closeWarningFile); closeWarningFile(); }
  warningFd = undefined;
  traceHelperShown = false;
  state = defaults();
  disabledWarnings.clear();
}
function writeStderr(text) { try { require('fs').writeSync(2, text); } catch {} }
// V8 aborts when an exception reaches the top of the stack with no capture callback. Here the
// runtime's exception boundary makes that decision, before uncaughtException listeners run.
function abortOnUncaughtException(error) {
  let text;
  try { text = error instanceof Error && typeof error.stack === 'string' ? error.stack : require('util').inspect(error); }
  catch { text = '<uncaught exception>'; }
  writeStderr('Uncaught ' + text + '\n');
  host.osNative('abort', []);
}
// process.exit with --trace-exit names the exit code and prints the current stack, as Node does.
function traceExit(code, threadId, below = traceExit) {
  if (!state.traceExit) return;
  const holder = {};
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = state.stackTraceLimit ?? 10;
  Error.captureStackTrace(holder, below);
  Error.stackTraceLimit = limit;
  const frames = String(holder.stack);
  const newline = frames.indexOf('\n');
  const thread = threadId ? ', thread:' + threadId : '';
  writeStderr('(' + process.release.name + ':' + process.pid + thread + ') WARNING: Exited the environment with code ' + code +
    (newline < 0 ? '' : frames.slice(newline)) + '\n');
}
function invalidArgument(name, expected, value) {
  const { codes: { ERR_INVALID_ARG_TYPE } } = require('internal/path_events/support');
  return new ERR_INVALID_ARG_TYPE(name, expected, value);
}
function emitWarning(warning, type, code, ctor) {
  if (process.noDeprecation && type === 'DeprecationWarning') return;
  let detail;
  if (type !== null && typeof type === 'object' && !Array.isArray(type)) {
    ctor = type.ctor;
    code = type.code;
    if (typeof type.detail === 'string') detail = type.detail;
    type = type.type || 'Warning';
  } else if (typeof type === 'function') {
    ctor = type; code = undefined; type = 'Warning';
  }
  if (type !== undefined && typeof type !== 'string')
    throw invalidArgument('type', 'string', type);
  if (typeof code === 'function') { ctor = code; code = undefined; }
  else if (code !== undefined && typeof code !== 'string')
    throw invalidArgument('code', 'string', code);
  if (typeof warning === 'string') {
    warning = new Error(warning);
    warning.name = type || 'Warning';
    if (code !== undefined) warning.code = code;
    if (detail !== undefined) warning.detail = detail;
    Error.captureStackTrace(warning, ctor || emitWarning);
  } else if (!(warning instanceof Error)) {
    throw invalidArgument('warning', ['Error', 'string'], warning);
  }
  if (warning.name === 'DeprecationWarning') {
    if (process.noDeprecation) return;
    if (process.throwDeprecation) return process.nextTick(() => { throw warning; });
  }
  process.nextTick(() => process.emit('warning', warning));
}
// Node's emitWarningSync (ProcessEmitWarningSync from C++): the 'warning' event now.
function emitWarningSync(warning, type) {
  warning = new Error(warning);
  warning.name = type || 'Warning';
  Error.captureStackTrace(warning, emitWarningSync);
  process.emit('warning', warning);
}
function onWarning(warning) {
  if ((warning?.code && disabledWarnings.has(warning.code)) || (warning?.name && disabledWarnings.has(warning.name))) return;
  if (!(warning instanceof Error) || (warning.name === 'DeprecationWarning' && process.noDeprecation)) return;
  const deprecation = warning.name === 'DeprecationWarning';
  const trace = process.traceProcessWarnings || (deprecation && process.traceDeprecation);
  let message = '(' + process.release.name + ':' + process.pid + ') ';
  if (warning.code) message += '[' + warning.code + '] ';
  message += trace && warning.stack ? warning.stack : typeof warning.toString === 'function' ? warning.toString() : Error.prototype.toString.call(warning);
  if (typeof warning.detail === 'string') message += '\n' + warning.detail;
  if (!trace && !traceHelperShown) {
    const flag = deprecation ? '--trace-deprecation' : '--trace-warnings';
    message += '\n(Use `' + require('path').basename(process.argv0 || 'node', '.exe') + ' ' + flag + ' ...` to show where the warning was created)';
    traceHelperShown = true;
  }
  if (state.redirectWarnings) {
    const fs = require('fs');
    try {
      if (warningFd === undefined) {
        warningFd = fs.openSync(state.redirectWarnings, 'a');
        process.on('exit', closeWarningFile);
      }
      fs.appendFile(warningFd, message + '\n', error => { if (error) process.stderr.write(message + '\n'); });
      return;
    } catch {}
  }
  process.stderr.write(message + '\n');
}
function setUncaughtExceptionCaptureCallback(callback) {
  if (callback === null) { captureCallback = null; return; }
  if (typeof callback !== 'function') throw invalidArgument('fn', ['function', 'null'], callback);
  if (captureCallback !== null) throw Object.assign(new Error('`process.setupUncaughtExceptionCapture()` was called while a capture callback was already active'), { code: 'ERR_UNCAUGHT_EXCEPTION_CAPTURE_ALREADY_SET' });
  captureCallback = callback;
}
// process._fatalException: false when nothing handled the error, after the
// 'exit' event ran with code 1 (lib/internal/process/execution.js).
function fatalException(error, fromPromise) {
  const type = fromPromise ? 'unhandledRejection' : 'uncaughtException';
  if (!fromPromise && state.abortOnUncaughtException && captureCallback === null) abortOnUncaughtException(error);
  process.emit('uncaughtExceptionMonitor', error, type);
  if (captureCallback !== null) {
    captureCallback(error);
  } else if (!process.emit('uncaughtException', error, type)) {
    try {
      if (!process._exiting) {
        process._exiting = true;
        process.exitCode = 1;
        process.emit('exit', 1);
      }
    } catch {
      // Nothing to be done about it at this point.
    }
    return false;
  }
  return true;
}
// Exit codes Node's TriggerUncaughtException uses.
const kGenericUserError = 1;
const kInvalidFatalExceptionMonkeyPatching = 6;
const kExceptionInFatalExceptionHandler = 7;
// The at-exit work process.exit does too: the inspector's exit handshake, the
// compile cache, a --heap-prof profile.
function terminate(code) {
  if (host.builtinLoaded('internal/inspector')) require('internal/inspector')._atExit();
  if (host.builtinLoaded('internal/compile_cache')) require('internal/compile_cache').flushAtExit();
  if (host.builtinLoaded('internal/heap_prof')) require('internal/heap_prof').finish();
  host.rawStd.exit(code);
}
// TriggerUncaughtException: an error nothing caught reaches process._fatalException;
// when that leaves it unhandled, it is reported and the process exits. Returns
// only when a handler took it. A worker reports its error to the parent instead,
// so there the error is thrown on after the 'exit' event.
function handleUncaught(error, origin) {
  const fromPromise = origin === 'unhandledRejection';
  const fatal = process._fatalException;
  const mainThread = require('worker_threads').isMainThread;
  if (typeof fatal !== 'function') {
    reportFatal(error, fromPromise);
    if (!mainThread) { require('internal/worker')._requestExit(kInvalidFatalExceptionMonkeyPatching); return; }
    terminate(kInvalidFatalExceptionMonkeyPatching);
  }
  let handled;
  try {
    handled = Reflect.apply(fatal, process, [error, fromPromise]);
  } catch (thrown) {
    if (!mainThread) return workerUncaught(thrown);
    reportFatal(thrown, false);
    terminate(kExceptionInFatalExceptionHandler);
  }
  if (handled) return;
  require('internal/process_report').onUncaughtException(error);
  if (!mainThread) return workerUncaught(error);
  reportFatal(error, fromPromise);
  const code = process.exitCode;
  terminate(code === undefined ? kGenericUserError : Number(code) | 0);
}
// Node's workerOnGlobalUncaughtException (internal/main/worker_thread.js): the
// worker emits 'exit' with code 1, reports the error to its parent and exits
// with whatever code the 'exit' listeners left.
function workerUncaught(error) {
  // terminate() and process.exit() unwind the thread with an interruption,
  // which the native side ends without reporting.
  if (require('internal/worker')._exitRequested || host.workerNative('stopping', [])) throw error;
  if (!process._exiting) {
    try {
      process._exiting = true;
      process.exitCode = kGenericUserError;
      process.emit('exit', process.exitCode);
    } catch {
      // Continue regardless of error.
    }
  }
  require('internal/worker')._reportError(error);
  process.exit();
}
let printedError = false;
function reportFatal(error, fromPromise) {
  if (printedError) return;
  printedError = true;
  let text;
  try { text = require('internal/fatal_report').format(error, fromPromise); }
  catch { text = '\n' + safeString(error) + '\n'; }
  host.writeText(2, text);
}
function safeString(value) {
  try { return String(value); } catch { return '<toString() threw exception>'; }
}

module.exports = {
  valueError, applyOption, initialize, emitWarning, emitWarningSync, handleUncaught, fatalException, reportFatal, traceExit,
  setUncaughtExceptionCaptureCallback, hasUncaughtExceptionCaptureCallback: () => captureCallback !== null,
  getOptionValue(name) {
    if (name === '--unhandled-rejections') return state.unhandledRejections;
    if (name === '--pending-deprecation') return !!host.pendingDeprecation;
    if (name === '--disable-warning') return [...disabledWarnings];
    if (name === '--redirect-warnings') return state.redirectWarnings || '';
    if (name === '--network-family-autoselection-attempt-timeout') return state.networkFamilyAutoselectionAttemptTimeout;
    const key = booleanOptions.get(name);
    return key ? state[key] : undefined;
  },
};
