'use strict';
// State and helpers shared by vm (Script, contexts) and internal/vm/module_wrap
// (vm modules): the contexts made by vm.createContext, argument errors, syntax
// diagnostics and running a compiled handle under a timeout or SIGINT watch.
const host = require('internal/host');
const contexts = new WeakMap();
const { ERR_INVALID_ARG_TYPE } = require('internal/path_events/support').codes;
// Node's ERR_INVALID_ARG_TYPE wording, with what was received.
function invalid(name, expected, value) { return new ERR_INVALID_ARG_TYPE(name, expected, value); }
function error(code, message, Type = TypeError) {
  return Object.assign(new Type(message), { code });
}
function contextData(value) {
  const data = contexts.get(value);
  if (!data) throw value === null || typeof value !== 'object' ? invalid('object', 'object', value) : invalid('contextifiedObject', 'vm.Context', value);
  return data;
}
function isContext(value) {
  if (value === null || typeof value !== 'object') throw invalid('object', 'object', value);
  return contexts.has(value);
}
// Parser locations are real lexical coordinates. Presentation offsets never
// alter source bytes, directive prologues, line continuations, or parser state.
function syntaxDiagnostic(cause, source, filename, line, column, prefix = 0) {
  if (!cause || cause.name !== 'SyntaxError' || !Number.isInteger(cause.lineNumber)) throw cause;
  const sourceLine = cause.lineNumber;
  const sourceColumn = cause.columnNumber - (sourceLine === 1 ? prefix : 0);
  const lines = source.split(/\r\n|[\n\r\u2028\u2029]/);
  const text = lines[sourceLine - 1] || '';
  cause.lineNumber = (sourceLine + line) | 0;
  cause.columnNumber = (sourceColumn + (sourceLine === 1 ? column : 0)) | 0;
  cause.fileName = filename;
  const frames = typeof cause.stack === 'string' ? cause.stack.split('\n').slice(1).join('\n') : '';
  const caret = text.slice(0, Math.max(0, sourceColumn - 1)).replace(/[^\t]/g, ' ') +
    (cause.columnNumber === 0 ? '' : '^');
  cause.stack = `${filename}:${cause.lineNumber}\n${text}\n${caret}\n\n${cause.name}: ${cause.message}\n${frames}`;
  // decorateErrorStack: the stack holds the arrow, so the fatal report adds none.
  host.decoratedErrors.add(cause);
  throw cause;
}
const terminationErrors = new WeakSet();
function terminationError(code, message) {
  const result = error(code, message, Error);
  terminationErrors.add(result);
  return result;
}
// DecorateErrorStack (node_errors.cc), for a script run with displayErrors: a
// native error leaving the script gets the arrow of where it was thrown before
// its stack, once. It runs before any rethrow here, which would move the site.
function decorateErrorStack(cause, script) {
  try {
    if (!require('util/types').isNativeError(cause) || host.decoratedErrors.has(cause)) return;
    const arrow = require('internal/fatal_report').arrow(cause, false, script.filename, script.line, script.column, script.source);
    const stack = cause.stack;
    if (arrow === undefined || typeof stack !== 'string') return;
    cause.stack = arrow + '\n' + stack;
    host.decoratedErrors.add(cause);
  } catch {}
}
// The SIGINT listeners a breakOnSigint run takes away until it ends, if any.
function runBegin(breakOnSigint, wrapSignals) {
  if (!breakOnSigint || !wrapSignals || process.listenerCount('SIGINT') === 0) return undefined;
  const listeners = process.rawListeners('SIGINT');
  process.removeAllListeners('SIGINT');
  return listeners;
}
function runEnd(listeners) {
  if (listeners) for (let i = 0; i < listeners.length; i++) process.addListener('SIGINT', listeners[i]);
}
// What a run that threw cause throws. display: the script (filename and offsets)
// whose errors are decorated, if any.
function runFailure(cause, timeout, display) {
  if (cause && typeof cause.message === 'string' && cause.message.startsWith('ERR_SCRIPT_EXECUTION_TIMEOUT:')) {
    return terminationError('ERR_SCRIPT_EXECUTION_TIMEOUT', `Script execution timed out${timeout ? ` after ${timeout}ms` : ''}`);
  }
  if (cause && typeof cause.message === 'string' && cause.message.startsWith('ERR_SCRIPT_EXECUTION_INTERRUPTED:')) {
    return terminationError('ERR_SCRIPT_EXECUTION_INTERRUPTED', 'Script execution was interrupted by `SIGINT`');
  }
  if (cause && typeof cause.message === 'string' && cause.message.startsWith('ERR_CANNOT_WATCH_SIGINT:')) {
    return error('ERR_CANNOT_WATCH_SIGINT', 'Cannot watch for SIGINT signals', Error);
  }
  if (display !== undefined) decorateErrorStack(cause, display);
  return cause;
}
// The script's own error leaves as ContextifyScript's TryCatch::ReThrow does: the
// message (and its arrow) stays where the script threw.
function rethrow(cause, failure) {
  if (failure === cause) host.rethrow(cause);
  throw failure;
}
// Script methods call host.vmRun themselves between runBegin and runEnd: in Node
// the run is ContextifyScript's native method, which no stack shows.
function run(handle, { timeout, breakOnSigint }, afterEvaluate, wrapSignals = true, display = undefined) {
  const listeners = runBegin(breakOnSigint, wrapSignals);
  let result;
  try { result = host.vmRun(handle, timeout, afterEvaluate, breakOnSigint); }
  catch (cause) { runEnd(listeners); rethrow(cause, runFailure(cause, timeout, display)); }
  runEnd(listeners);
  return result;
}


// makeContextifyScript of Node's lib/internal/vm.js, over the vm module's Script.
// The runtime has no V8 code cache, so cachedData and produceCachedData are
// ignored, and each script is its own host-defined option.
const kInternalImportModuleDynamically = Symbol('kInternalImportModuleDynamically');

function makeContextifyScript(code, filename, lineOffset, columnOffset, cachedData,
                              produceCachedData, parsingContext, hostDefinedOptionId,
                              importModuleDynamically) {
  const { Script } = require('vm');
  const options = { __proto__: null, filename, lineOffset, columnOffset };
  if (importModuleDynamically !== undefined) options[kInternalImportModuleDynamically] = importModuleDynamically;
  return new Script(code, options);
}

module.exports = {
  contexts, error, invalid, contextData, isContext, syntaxDiagnostic, terminationErrors, terminationError, run, runBegin, runEnd, runFailure, rethrow,
  kInternalImportModuleDynamically, makeContextifyScript,
};
