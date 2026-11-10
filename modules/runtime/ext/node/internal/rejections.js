'use strict';

const controls = require('internal/startup_controls');
function reasonString(reason) {
  if (reason === null || (typeof reason !== 'object' && typeof reason !== 'function')) return String(reason);
  if (typeof reason === 'function') return Function.prototype.toString.call(reason);
  const types = require('util/types');
  // Do not invoke user coercion hooks while diagnosing an unhandled rejection.
  if (types.isProxy(reason)) return '#<Object>';
  if (Array.isArray(reason)) return '[object Array]';
  if (types.isDate(reason)) return '[object Date]';
  if (types.isRegExp(reason)) return '[object RegExp]';
  if (types.isTypedArray(reason)) {
    const tag = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag).get.call(reason);
    return '[object ' + tag + ']';
  }
  const prototype = Object.getPrototypeOf(reason);
  if (prototype === null || Object.hasOwn(reason, 'toString')) return '[object Object]';
  const constructor = prototype && Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value;
  const name = typeof constructor === 'function' ? Object.getOwnPropertyDescriptor(constructor, 'name')?.value : undefined;
  return '#<' + (typeof name === 'string' && name ? name : 'Object') + '>';
}
function isErrorLike(reason) {
  return reason !== null && typeof reason === 'object' && Object.hasOwn(reason, 'stack');
}
function rejectionError(reason) {
  if (isErrorLike(reason)) return reason;
  const error = new Error('This error originated either by throwing inside of an ' +
    'async function without a catch block, or by rejecting a promise which ' +
    'was not handled with .catch(). The promise rejected with the reason "' + reasonString(reason) + '".');
  error.name = 'UnhandledPromiseRejection';
  error.code = 'ERR_UNHANDLED_REJECTION';
  return error;
}
function warnUnhandled({ reason, id }) {
  const warning = new Error('Unhandled promise rejection. This error originated either by ' +
    'throwing inside of an async function without a catch block, ' +
    'or by rejecting a promise which was not handled with .catch(). ' +
    'To terminate the node process on unhandled promise ' +
    'rejection, use the CLI flag `--unhandled-rejections=strict` (see ' +
    'https://nodejs.org/api/cli.html#cli_unhandled_rejections_mode). ' +
    '(rejection id: ' + id + ')');
  warning.name = 'UnhandledPromiseRejectionWarning';
  warning.stack = warning.name + ': ' + warning.message;
  try {
    if (isErrorLike(reason)) {
      warning.stack = reason.stack;
      process.emitWarning(reason.stack, warning.name);
    } else process.emitWarning(reasonString(reason), warning.name);
  } catch {
    try { process.emitWarning(reasonString(reason), warning.name); } catch {}
  }
  process.emitWarning(warning);
}
function handle(promise, info, invoke) {
  const mode = controls.getOptionValue('--unhandled-rejections');
  if (mode === 'strict') controls.handleUncaught(rejectionError(info.reason), 'unhandledRejection');
  let handled, completed = false;
  invoke(() => {
    handled = info.domain ? info.domain.emit('error', info.reason) : process.emit('unhandledRejection', info.reason, promise);
    completed = true;
  }, undefined, []);
  if (!completed) return;
  if (mode === 'warn' || (mode === 'strict' && !handled) || (mode === 'warn-with-error-code' && !handled)) {
    warnUnhandled(info);
    if (mode === 'warn-with-error-code') process.exitCode = 1;
  } else if (mode === 'throw' && !handled) {
    controls.handleUncaught(rejectionError(info.reason), 'unhandledRejection');
  }
}
function handledWarning(id) {
  const warning = new Error('Promise rejection was handled asynchronously (rejection id: ' + id + ')');
  warning.name = 'PromiseRejectionHandledWarning';
  warning.id = id;
  Error.captureStackTrace(warning, handledWarning);
  return warning;
}
module.exports = { handle, handledWarning };
