'use strict';

const host = require('internal/host');
const booleanOptions = new Map([
  ['--warnings', 'warnings'], ['--deprecation', 'deprecation'],
  ['--trace-warnings', 'traceProcessWarnings'], ['--trace-deprecation', 'traceDeprecation'],
  ['--throw-deprecation', 'throwDeprecation'], ['--pending-deprecation', 'pendingDeprecation'],
  ['--abort-on-uncaught-exception', 'abortOnUncaughtException'], ['--trace-exit', 'traceExit'],
]);
const valueOptions = new Set(['--disable-warning', '--redirect-warnings', '--unhandled-rejections', '--stack-trace-limit']);
const rejectionModes = new Set(['throw', 'strict', 'warn', 'warn-with-error-code', 'none']);
const state = { warnings: true, deprecation: true, unhandledRejections: 'throw' };
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
  state.redirectWarnings ||= process.env.NODE_REDIRECT_WARNINGS;
  if (state.warnings && process.env.NODE_NO_WARNINGS !== '1') process.on('warning', onWarning);
  if (state.abortOnUncaughtException) host.abortOnUncaughtException = abortOnUncaughtException;
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
        process.on('exit', () => { try { fs.closeSync(warningFd); } catch {} });
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
function handleUncaught(error, origin) {
  if (origin === 'uncaughtException' && state.abortOnUncaughtException && captureCallback === null) abortOnUncaughtException(error);
  process.emit('uncaughtExceptionMonitor', error, origin);
  if (captureCallback !== null) { captureCallback(error); return; }
  if (!process.emit('uncaughtException', error, origin)) {
    require('internal/process_report').onUncaughtException(error);
    throw error;
  }
}

module.exports = {
  valueError, applyOption, initialize, emitWarning, handleUncaught, traceExit,
  setUncaughtExceptionCaptureCallback, hasUncaughtExceptionCaptureCallback: () => captureCallback !== null,
  getOptionValue(name) {
    if (name === '--unhandled-rejections') return state.unhandledRejections;
    if (name === '--pending-deprecation') return !!host.pendingDeprecation;
    if (name === '--disable-warning') return [...disabledWarnings];
    if (name === '--redirect-warnings') return state.redirectWarnings || '';
    const key = booleanOptions.get(name);
    return key ? state[key] : undefined;
  },
};
