'use strict';

const host = require('internal/host');
const booleanOptions = new Map([
  ['--warnings', 'warnings'], ['--deprecation', 'deprecation'],
  ['--trace-warnings', 'traceProcessWarnings'], ['--trace-deprecation', 'traceDeprecation'],
  ['--throw-deprecation', 'throwDeprecation'], ['--pending-deprecation', 'pendingDeprecation'],
]);
const valueOptions = new Set(['--disable-warning', '--redirect-warnings', '--unhandled-rejections']);
const rejectionModes = new Set(['throw', 'strict', 'warn', 'warn-with-error-code', 'none']);
const optionEntries = [];
for (const name of booleanOptions.keys()) optionEntries.push([name, false], ['--no-' + name.slice(2), false]);
for (const name of valueOptions) optionEntries.push([name, true]);
const state = { warnings: true, deprecation: true, unhandledRejections: 'throw' };
const disabledWarnings = new Set();
let traceHelperShown = false;
let warningFd;
let captureCallback = null;

function valueError(name, value) {
  if (valueOptions.has(name) && (value === undefined || value === '')) return name + ' requires an argument';
  if (name === '--unhandled-rejections' && !rejectionModes.has(value)) return 'invalid value for --unhandled-rejections';
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
  process.emit('uncaughtExceptionMonitor', error, origin);
  if (captureCallback !== null) { captureCallback(error); return; }
  if (!process.emit('uncaughtException', error, origin)) {
    require('internal/process_report').onUncaughtException(error);
    throw error;
  }
}

module.exports = {
  optionEntries, valueError, applyOption, initialize, emitWarning, handleUncaught,
  isValueOption: name => valueOptions.has(name),
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
