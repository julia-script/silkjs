'use strict';

// The process.execve part of Node.js v24.22.1 lib/internal/process/per_thread.js,
// with src/node_process_methods.cc Execve: the permission check, then execve(2).
// Copyright Node.js contributors. MIT license (see vendor/node-api/LICENSE).

const host = require('internal/host');
const {
  codes: {
    ERR_FEATURE_UNAVAILABLE_ON_PLATFORM,
    ERR_INVALID_ARG_VALUE,
    ERR_WORKER_UNSUPPORTED_OPERATION,
  },
} = require('internal/errors');
const {
  validateArray,
  validateObject,
  validateString,
} = require('internal/validators');
const { emitExperimentalWarning } = require('internal/util');

let execveDiagnosticChannel;

function execve(execPath, args = [], env = process.env) {
  emitExperimentalWarning('process.execve');

  const { isMainThread } = require('worker_threads');

  if (!isMainThread) {
    throw new ERR_WORKER_UNSUPPORTED_OPERATION('Calling process.execve');
  } else if (process.platform === 'win32' || process.platform === 'os400') {
    throw new ERR_FEATURE_UNAVAILABLE_ON_PLATFORM('process.execve');
  }

  validateString(execPath, 'execPath');
  validateArray(args, 'args');

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg !== 'string' || arg.includes('\u0000')) {
      throw new ERR_INVALID_ARG_VALUE(`args[${i}]`, arg, 'must be a string without null bytes');
    }
  }

  const envArray = [];
  validateObject(env, 'env');

  for (const { 0: key, 1: value } of Object.entries(env)) {
    if (
      typeof key !== 'string' ||
      typeof value !== 'string' ||
      key.includes('\u0000') ||
      value.includes('\u0000')
    ) {
      throw new ERR_INVALID_ARG_VALUE(
        'env', env, 'must be an object with string keys and values without null bytes',
      );
    } else {
      envArray.push(`${key}=${value}`);
    }
  }

  execveDiagnosticChannel ??= require('diagnostics_channel').channel('process.execve');
  if (execveDiagnosticChannel.hasSubscribers) {
    execveDiagnosticChannel.publish({ execPath, args, env: envArray });
  }

  // Perform the system call
  _execve(execPath, args, envArray);
}

// node_process_methods.cc Execve. stdio stays open in the new image; when execve
// returns it failed, and the process aborts with the error and this stack.
function _execve(execPath, args, envArray) {
  require('internal/permission').check('child', execPath);
  const errno = host.osNative('execve', [execPath, args, envArray]);
  const name = require('util').getSystemErrorName(-errno);
  const stack = new Error().stack;
  const frames = stack.slice(stack.indexOf('\n'));
  require('fs').writeSync(2, `process.execve failed with error code ${name}${frames}\n`);
  host.osNative('abort', []);
}

module.exports = { execve };
