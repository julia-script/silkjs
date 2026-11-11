// Argument validators adapted from Node.js v24.22.1 lib/internal/validators.js and
// lib/internal/errors.js. Messages and codes match Node's, so tests and callers that
// compare them see the same text.
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
// Node's argument errors and validators (lib/internal/errors.js, lib/internal/validators.js),
// with the same codes, classes and messages, for modules that validate as Node does.
let inspect;
function lazyInspect(value, options) { inspect ??= require('util').inspect; return inspect(value, options); }

// As in Node, each error is an instance of a subclass of its base class whose toString and
// stack lead with "Name [CODE]".
const nodeErrorClasses = new Map();
function nodeErrorClass(Base) {
  let NodeError = nodeErrorClasses.get(Base);
  if (NodeError === undefined) {
    NodeError = class NodeError extends Base {
      toString() { return `${this.name} [${this.code}]: ${this.message}`; }
    };
    nodeErrorClasses.set(Base, NodeError);
  }
  return NodeError;
}
function makeError(Base, code, message) {
  const error = new (nodeErrorClass(Base))(message);
  Object.defineProperty(error, 'code', { value: code, enumerable: true, writable: true, configurable: true });
  if (typeof error.stack === 'string' && error.stack.startsWith(`${error.name}: `)) error.stack = `${error.name} [${code}]: ${error.stack.slice(error.name.length + 2)}`;
  return error;
}

// Node's SystemError: "<prefix>: <syscall> returned <code> (<message>) <path> => <dest>",
// with info holding the context and errno, syscall, path and dest reading through to it.
const systemErrorPrefixes = {
  ERR_FS_CP_DIR_TO_NON_DIR: 'Cannot overwrite non-directory with directory',
  ERR_FS_CP_EEXIST: 'Target already exists',
  ERR_FS_CP_EINVAL: 'Invalid src or dest',
  ERR_FS_CP_FIFO_PIPE: 'Cannot copy a FIFO pipe',
  ERR_FS_CP_NON_DIR_TO_DIR: 'Cannot overwrite directory with non-directory',
  ERR_FS_CP_SOCKET: 'Cannot copy a socket file',
  ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY: 'Cannot overwrite symlink in subdirectory of self',
  ERR_FS_CP_UNKNOWN: 'Cannot copy an unknown file type',
  ERR_FS_EISDIR: 'Path is a directory',
};
class SystemError extends Error {
  constructor(key, context) {
    super();
    let message = `${systemErrorPrefixes[key]}: ${context.syscall} returned ${context.code} (${context.message})`;
    if (context.path !== undefined) message += ` ${context.path}`;
    if (context.dest !== undefined) message += ` => ${context.dest}`;
    this.code = key;
    Object.defineProperties(this, {
      name: { value: 'SystemError', enumerable: false, writable: true, configurable: true },
      message: { value: message, enumerable: false, writable: true, configurable: true },
      info: { value: context, enumerable: true, configurable: true, writable: false },
      errno: { get() { return context.errno; }, set: value => { context.errno = value; }, enumerable: true, configurable: true },
      syscall: { get() { return context.syscall; }, set: value => { context.syscall = value; }, enumerable: true, configurable: true },
    });
    if (context.path !== undefined) Object.defineProperty(this, 'path', { get() { return context.path; }, set: value => { context.path = value; }, enumerable: true, configurable: true });
    if (context.dest !== undefined) Object.defineProperty(this, 'dest', { get() { return context.dest; }, set: value => { context.dest = value; }, enumerable: true, configurable: true });
    if (typeof this.stack === 'string') {
      const newline = this.stack.indexOf('\n');
      this.stack = `SystemError [${key}]: ${message}${newline === -1 ? '' : this.stack.slice(newline)}`;
    }
  }
  toString() { return `${this.name} [${this.code}]: ${this.message}`; }
}
function systemError(key, context) { return new SystemError(key, context); }

const kTypes = ['string', 'function', 'number', 'object', 'Function', 'Object', 'boolean', 'bigint', 'symbol'];
const classRegExp = /^[A-Z][a-zA-Z0-9]*$/;
function formatList(array, type = 'and') {
  switch (array.length) {
    case 0: return '';
    case 1: return `${array[0]}`;
    case 2: return `${array[0]} ${type} ${array[1]}`;
    case 3: return `${array[0]}, ${array[1]}, ${type} ${array[2]}`;
    default: return `${array.slice(0, -1).join(', ')}, ${type} ${array[array.length - 1]}`;
  }
}
function addNumericalSeparator(value) {
  let result = ''; let i = value.length; const start = value[0] === '-' ? 1 : 0;
  for (; i >= start + 4; i -= 3) result = `_${value.slice(i - 3, i)}${result}`;
  return `${value.slice(0, i)}${result}`;
}
function determineSpecificType(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  switch (typeof value) {
    case 'bigint': return `type bigint (${value}n)`;
    case 'number':
      if (value === 0) return 1 / value === -Infinity ? 'type number (-0)' : 'type number (0)';
      if (value !== value) return 'type number (NaN)';
      if (value === Infinity) return 'type number (Infinity)';
      if (value === -Infinity) return 'type number (-Infinity)';
      return `type number (${value})`;
    case 'boolean': return value ? 'type boolean (true)' : 'type boolean (false)';
    case 'symbol': return `type symbol (${String(value)})`;
    case 'function': return `function ${value.name}`;
    case 'object': {
      const name = value.constructor?.name;
      if (typeof name === 'string' && name !== '') return `an instance of ${name}`;
      return `${lazyInspect(value, { depth: -1 })}`;
    }
    case 'string':
      if (value.length > 28) value = `${value.slice(0, 25)}...`;
      if (value.indexOf("'") === -1) return `type string ('${value}')`;
      return `type string (${JSON.stringify(value)})`;
    default: {
      let text = lazyInspect(value, { colors: false });
      if (text.length > 28) text = `${text.slice(0, 25)}...`;
      return `type ${typeof value} (${text})`;
    }
  }
}

function ERR_INVALID_ARG_TYPE(name, expected, actual) {
  if (!Array.isArray(expected)) expected = [expected];
  let message = 'The ';
  if (name.endsWith(' argument')) message += `${name} `;
  else message += `"${name}" ${name.includes('.') ? 'property' : 'argument'} `;
  message += 'must be ';
  const types = []; const instances = []; const other = [];
  for (const value of expected) {
    if (kTypes.includes(value)) types.push(value.toLowerCase());
    else if (classRegExp.test(value)) instances.push(value);
    else other.push(value);
  }
  if (instances.length > 0) { const position = types.indexOf('object'); if (position !== -1) { types.splice(position, 1); instances.push('Object'); } }
  if (types.length > 0) { message += `${types.length > 1 ? 'one of type' : 'of type'} ${formatList(types, 'or')}`; if (instances.length > 0 || other.length > 0) message += ' or '; }
  if (instances.length > 0) { message += `an instance of ${formatList(instances, 'or')}`; if (other.length > 0) message += ' or '; }
  if (other.length > 0) {
    if (other.length > 1) message += `one of ${formatList(other, 'or')}`;
    else { if (other[0].toLowerCase() !== other[0]) message += 'an '; message += `${other[0]}`; }
  }
  message += `. Received ${determineSpecificType(actual)}`;
  return makeError(TypeError, 'ERR_INVALID_ARG_TYPE', message);
}
function ERR_INVALID_ARG_VALUE(name, value, reason = 'is invalid', Base = TypeError) {
  let inspected = lazyInspect(value);
  if (inspected.length > 128) inspected = `${inspected.slice(0, 128)}...`;
  return makeError(Base, 'ERR_INVALID_ARG_VALUE', `The ${name.includes('.') ? 'property' : 'argument'} '${name}' ${reason}. Received ${inspected}`);
}
function ERR_OUT_OF_RANGE(name, range, input, replaceDefaultBoolean = false) {
  let message = replaceDefaultBoolean ? name : `The value of "${name}" is out of range.`;
  let received;
  if (Number.isInteger(input) && Math.abs(input) > 2 ** 32) received = addNumericalSeparator(String(input));
  else if (typeof input === 'bigint') { received = String(input); if (input > 2n ** 32n || input < -(2n ** 32n)) received = addNumericalSeparator(received); received += 'n'; }
  else received = lazyInspect(input);
  message += ` It must be ${range}. Received ${received}`;
  return makeError(RangeError, 'ERR_OUT_OF_RANGE', message);
}
function ERR_MISSING_ARGS(...names) {
  let message = 'The ';
  const wrap = a => `"${a}"`;
  names = names.map(a => Array.isArray(a) ? a.map(wrap).join(' or ') : wrap(a));
  switch (names.length) {
    case 1: message += `${names[0]} argument`; break;
    case 2: message += `${names[0]} and ${names[1]} arguments`; break;
    default: message += `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]} arguments`;
  }
  return makeError(TypeError, 'ERR_MISSING_ARGS', `${message} must be specified`);
}

function validateInteger(value, name, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'number') throw ERR_INVALID_ARG_TYPE(name, 'number', value);
  if (!Number.isInteger(value)) throw ERR_OUT_OF_RANGE(name, 'an integer', value);
  if (value < min || value > max) throw ERR_OUT_OF_RANGE(name, `>= ${min} && <= ${max}`, value);
}
function validateInt32(value, name, min = -2147483648, max = 2147483647) {
  if (typeof value !== 'number') throw ERR_INVALID_ARG_TYPE(name, 'number', value);
  if (!Number.isInteger(value)) throw ERR_OUT_OF_RANGE(name, 'an integer', value);
  if (value < min || value > max) throw ERR_OUT_OF_RANGE(name, `>= ${min} && <= ${max}`, value);
}
function validateUint32(value, name, positive = false) {
  if (typeof value !== 'number') throw ERR_INVALID_ARG_TYPE(name, 'number', value);
  if (!Number.isInteger(value)) throw ERR_OUT_OF_RANGE(name, 'an integer', value);
  const min = positive ? 1 : 0; const max = 4294967295;
  if (value < min || value > max) throw ERR_OUT_OF_RANGE(name, `>= ${min} && <= ${max}`, value);
}
function validateNumber(value, name, min = undefined, max) {
  if (typeof value !== 'number') throw ERR_INVALID_ARG_TYPE(name, 'number', value);
  if ((min != null && value < min) || (max != null && value > max) || ((min != null || max != null) && Number.isNaN(value))) {
    throw ERR_OUT_OF_RANGE(name, `${min != null ? `>= ${min}` : ''}${min != null && max != null ? ' && ' : ''}${max != null ? `<= ${max}` : ''}`, value);
  }
}
function validateString(value, name) { if (typeof value !== 'string') throw ERR_INVALID_ARG_TYPE(name, 'string', value); }
function validateBoolean(value, name) { if (typeof value !== 'boolean') throw ERR_INVALID_ARG_TYPE(name, 'boolean', value); }
function validateFunction(value, name) { if (typeof value !== 'function') throw ERR_INVALID_ARG_TYPE(name, 'Function', value); }
const kValidateObjectNone = 0; const kValidateObjectAllowNullable = 1; const kValidateObjectAllowArray = 2; const kValidateObjectAllowFunction = 4;
const kValidateObjectAllowObjects = kValidateObjectAllowArray | kValidateObjectAllowFunction;
const kValidateObjectAllowObjectsAndNull = kValidateObjectAllowNullable | kValidateObjectAllowArray | kValidateObjectAllowFunction;
function validateObject(value, name, options = kValidateObjectNone) {
  if (options === kValidateObjectNone) {
    if (value === null || Array.isArray(value)) throw ERR_INVALID_ARG_TYPE(name, 'Object', value);
    if (typeof value !== 'object') throw ERR_INVALID_ARG_TYPE(name, 'Object', value);
    return;
  }
  const throwOnNullable = (kValidateObjectAllowNullable & options) === 0;
  if (throwOnNullable && value === null) throw ERR_INVALID_ARG_TYPE(name, 'Object', value);
  const throwOnArray = (kValidateObjectAllowArray & options) === 0;
  if (throwOnArray && Array.isArray(value)) throw ERR_INVALID_ARG_TYPE(name, 'Object', value);
  const throwOnFunction = (kValidateObjectAllowFunction & options) === 0;
  const type = typeof value;
  if (type !== 'object' && (throwOnFunction || type !== 'function')) throw ERR_INVALID_ARG_TYPE(name, 'Object', value);
}
function validateOneOf(value, name, oneOf) {
  if (!oneOf.includes(value)) {
    const allowed = oneOf.map(v => typeof v === 'string' ? `'${v}'` : String(v)).join(', ');
    throw ERR_INVALID_ARG_VALUE(name, value, 'must be one of: ' + allowed);
  }
}
function validateBuffer(buffer, name = 'buffer') {
  if (!ArrayBuffer.isView(buffer)) throw ERR_INVALID_ARG_TYPE(name, ['Buffer', 'TypedArray', 'DataView'], buffer);
}
function validateArray(value, name, minLength = 0) {
  if (!Array.isArray(value)) throw ERR_INVALID_ARG_TYPE(name, 'Array', value);
  if (value.length < minLength) throw ERR_INVALID_ARG_VALUE(name, value, `must have a length of at least ${minLength}`);
}
function validateAbortSignal(signal, name) {
  if (signal !== undefined && (signal === null || typeof signal !== 'object' || !('aborted' in signal))) throw ERR_INVALID_ARG_TYPE(name, 'AbortSignal', signal);
}
function isUint32(value) { return value === (value >>> 0); }
const octalReg = /^[0-7]+$/;
const modeDesc = 'must be a 32-bit unsigned integer or an octal string';
function parseFileMode(value, name, def) {
  value ??= def;
  if (typeof value === 'string') {
    if (!octalReg.test(value)) throw ERR_INVALID_ARG_VALUE(name, value, modeDesc);
    value = parseInt(value, 8);
  }
  validateUint32(value, name);
  return value;
}
function abortError(signal) {
  const error = new Error('The operation was aborted', signal ? { cause: signal.reason } : undefined);
  error.name = 'AbortError'; error.code = 'ABORT_ERR';
  return error;
}

function codedError(Base, code, message) {
  const error = new Base(message);
  error.code = code;
  return error;
}
function unknownSignal(signal) { return codedError(TypeError, 'ERR_UNKNOWN_SIGNAL', `Unknown signal: ${signal}`); }

let signals;
const signalTable = () => signals ??= require('os').constants.signals;
let signalNames;
function signalName(number) {
  if (!signalNames) {
    signalNames = new Map();
    const table = signalTable();
    for (const key of Object.keys(table)) if (!signalNames.has(table[key])) signalNames.set(table[key], key);
  }
  return signalNames.get(number);
}
// Node's convertToValidSignal: a known signal number or a case-insensitive known name.
function convertToValidSignal(signal) {
  if (typeof signal === 'number' && signalName(signal) !== undefined) return signal;
  if (typeof signal === 'string') {
    const number = signalTable()[signal.toUpperCase()];
    if (number) return number;
  }
  throw unknownSignal(signal);
}
function isUint8Array(value) { return value instanceof Uint8Array; }
function toPathIfFileURL(value) {
  if (value == null || typeof value !== 'object' || value.href === undefined || value.protocol === undefined) return value;
  return require('url').fileURLToPath(value);
}
function validatePath(path, name = 'path') {
  if (typeof path !== 'string' && !isUint8Array(path)) throw new ERR_INVALID_ARG_TYPE(name, ['string', 'Buffer', 'URL'], path);
  if (typeof path === 'string' ? path.includes('\u0000') : path.includes(0)) {
    throw new ERR_INVALID_ARG_VALUE(name, path, 'must be a string, Uint8Array, or URL without null bytes');
  }
}
function getValidatedPath(value, name = 'path') {
  const path = toPathIfFileURL(value);
  validatePath(path, name);
  return path;
}

module.exports = {
  // The builders return the error, so `new codes.ERR_X(...)` works as well as `ERR_X(...)`.
  codes: { ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE, ERR_MISSING_ARGS, ERR_OUT_OF_RANGE },
  codedError, unknownSignal, convertToValidSignal, signalName, toPathIfFileURL, validatePath, getValidatedPath,
  makeError, SystemError, systemError, determineSpecificType, addNumericalSeparator,
  ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE, ERR_OUT_OF_RANGE, ERR_MISSING_ARGS,
  validateInteger, validateInt32, validateUint32, validateNumber, validateString, validateBoolean, validateFunction,
  validateObject, validateOneOf, validateBuffer, validateArray, validateAbortSignal, isUint32, parseFileMode, abortError,
  kValidateObjectNone, kValidateObjectAllowNullable, kValidateObjectAllowArray, kValidateObjectAllowFunction,
  kValidateObjectAllowObjects, kValidateObjectAllowObjectsAndNull,
};
