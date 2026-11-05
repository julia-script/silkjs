'use strict';

const { inspect } = require('internal/util_inspect');
const { isDeepEqual, isDeepStrictEqual, isPartialStrictEqual } = require('internal/util_comparisons');
const types = require('util/types');
const noException = Symbol('no exception');
const settings = Symbol('assert options');
function coded(Type, code, message) { const error = new Type(message); error.code = code; return error; }
function missing() { throw coded(TypeError, 'ERR_MISSING_ARGS', 'The "actual" and "expected" arguments must be specified'); }
function validateFunction(value, name) { if (typeof value !== 'function') throw coded(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "' + name + '" argument must be of type function. Received ' + inspect(value)); }
function errorMessage(actual, expected, operator) {
  const a = inspect(actual, { depth: 10, sorted: true });
  const b = inspect(expected, { depth: 10, sorted: true });
  switch (operator) {
    case 'strictEqual': return 'Expected values to be strictly equal:\n\n' + a + ' !== ' + b + '\n';
    case 'deepStrictEqual': return 'Expected values to be strictly deep-equal:\n+ actual - expected\n\n+ ' + a.replace(/\n/g, '\n+ ') + '\n- ' + b.replace(/\n/g, '\n- ');
    case 'deepEqual': return 'Expected values to be loosely deep-equal:\n\n' + a + '\n\nshould loosely deep-equal\n\n' + b;
    case 'notStrictEqual': return 'Expected "actual" to be strictly unequal to:\n\n' + b;
    case 'notDeepStrictEqual': return 'Expected "actual" not to be strictly deep-equal to:\n\n' + b;
    case 'notDeepEqual': return 'Expected "actual" not to be loosely deep-equal to:\n\n' + b;
    default: return a + ' ' + operator + ' ' + b;
  }
}
class AssertionError extends Error {
  constructor(options) {
    if (!options || typeof options !== 'object') throw coded(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "options" argument must be of type object');
    const generatedMessage = options.message == null;
    super(generatedMessage ? errorMessage(options.actual, options.expected, options.operator) : String(options.message));
    this.generatedMessage = generatedMessage;
    this.code = 'ERR_ASSERTION';
    this.actual = options.actual;
    this.expected = options.expected;
    this.operator = options.operator;
    Object.defineProperty(this, 'name', { value: 'AssertionError', configurable: true, writable: true });
    if (Error.captureStackTrace) Error.captureStackTrace(this, options.stackStartFn || AssertionError);
    else if (typeof this.stack === 'string') this.stack = this.stack.replace(/^Error(?=:)/, 'AssertionError [ERR_ASSERTION]');
  }
  toString() { return this.name + ' [' + this.code + ']: ' + this.message; }
  [inspect.custom](depth, options) { return inspect(this, Object.assign({}, options, { customInspect: false, depth: 0 })); }
}
function failWith(actual, expected, message, operator, fn) {
  if (message instanceof Error) throw message;
  throw new AssertionError({ actual, expected, message, operator, stackStartFn: fn });
}
function ok(value, message) {
  if (!value) {
    const generated = message == null;
    if (generated) message = arguments.length === 0 ? 'No value argument passed to `assert.ok()`' : 'The expression evaluated to a falsy value:\n\n  ' + inspect(value) + '\n';
    try { failWith(value, true, message, '==', ok); }
    catch (error) { if (error instanceof AssertionError) error.generatedMessage = generated; throw error; }
  }
}
function fail(actual, expected, message, operator, stackStartFn) {
  if (arguments.length < 2) { message = actual; actual = undefined; expected = undefined; operator = 'fail'; }
  const generated = message === undefined && arguments.length === 0;
  if (generated) message = 'Failed';
  try { failWith(actual, expected, message, operator || '!=', stackStartFn || fail); }
  catch (error) { if (generated && error instanceof AssertionError) error.generatedMessage = true; throw error; }
}
function equal(actual, expected, message) { if (arguments.length < 2) missing(); if (actual != expected && !(Number.isNaN(actual) && Number.isNaN(expected))) failWith(actual, expected, message, '==', equal); }
function notEqual(actual, expected, message) { if (arguments.length < 2) missing(); if (actual == expected || Number.isNaN(actual) && Number.isNaN(expected)) failWith(actual, expected, message, '!=', notEqual); }
function strictEqual(actual, expected, message) { if (arguments.length < 2) missing(); if (!Object.is(actual, expected)) failWith(actual, expected, message, 'strictEqual', strictEqual); }
function notStrictEqual(actual, expected, message) { if (arguments.length < 2) missing(); if (Object.is(actual, expected)) failWith(actual, expected, message, 'notStrictEqual', notStrictEqual); }
function deepEqual(actual, expected, message) { if (arguments.length < 2) missing(); if (!isDeepEqual(actual, expected)) failWith(actual, expected, message, 'deepEqual', deepEqual); }
function notDeepEqual(actual, expected, message) { if (arguments.length < 2) missing(); if (isDeepEqual(actual, expected)) failWith(actual, expected, message, 'notDeepEqual', notDeepEqual); }
function deepStrictEqual(actual, expected, message) { if (arguments.length < 2) missing(); if (!isDeepStrictEqual(actual, expected, !!(this && this[settings] && this[settings].skipPrototype))) failWith(actual, expected, message, 'deepStrictEqual', deepStrictEqual); }
function notDeepStrictEqual(actual, expected, message) { if (arguments.length < 2) missing(); if (isDeepStrictEqual(actual, expected, !!(this && this[settings] && this[settings].skipPrototype))) failWith(actual, expected, message, 'notDeepStrictEqual', notDeepStrictEqual); }
function partialDeepStrictEqual(actual, expected, message) { if (arguments.length < 2) missing(); if (!isPartialStrictEqual(actual, expected)) failWith(actual, expected, message, 'partialDeepStrictEqual', partialDeepStrictEqual); }
function getActual(fn) { validateFunction(fn, 'fn'); try { fn(); } catch (error) { return error; } return noException; }
function isPromise(value) { return value !== null && typeof value === 'object' && typeof value.then === 'function' && typeof value.catch === 'function'; }
async function waitForActual(value) {
  if (typeof value === 'function') {
    value = value();
    if (!isPromise(value)) throw coded(TypeError, 'ERR_INVALID_RETURN_VALUE', 'Expected instance of Promise to be returned from the "promiseFn" function but got ' + inspect(value));
  } else if (!isPromise(value)) throw coded(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "promiseFn" argument must be of type function or an instance of Promise');
  try { await value; } catch (error) { return error; }
  return noException;
}
function validateExpected(expected, negative) {
  if (expected == null || typeof expected === 'string' || typeof expected === 'function' || types.isRegExp(expected)) return;
  if (typeof expected !== 'object' || negative) throw coded(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "error" argument must be of type function or an instance of RegExp' + (negative ? '' : ' or Object'));
  if (!types.isNativeError(expected) && Object.keys(expected).length === 0) throw coded(TypeError, 'ERR_INVALID_ARG_VALUE', 'The argument \'error\' may not be an empty object');
}
function matches(actual, expected) {
  if (types.isRegExp(expected)) return RegExp.prototype.test.call(expected, String(actual));
  if (typeof expected === 'function') {
    if (expected.prototype !== undefined && actual instanceof expected) return true;
    if (expected === Error || Error.isPrototypeOf(expected)) return false;
    return Reflect.apply(expected, {}, [actual]) === true;
  }
  if (actual === null || typeof actual !== 'object') return false;
  const keys = Object.keys(expected);
  if (types.isNativeError(expected)) keys.push('name', 'message');
  return keys.every(key => key in actual && (typeof actual[key] === 'string' && types.isRegExp(expected[key]) ? RegExp.prototype.test.call(expected[key], actual[key]) : isDeepStrictEqual(actual[key], expected[key])));
}
function expects(actual, expected, message, fn, negative, async, suppliedMessage) {
  validateExpected(expected, negative);
  if (typeof expected === 'string') {
    if (suppliedMessage) throw coded(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "error" argument must not be a string when a message is supplied');
    if (!negative && actual !== noException && (actual === expected || actual && actual.message === expected)) throw coded(TypeError, 'ERR_AMBIGUOUS_ARGUMENT', 'The "error/message" argument is ambiguous. The error message is identical to the message.');
    message = expected; expected = undefined;
  }
  if (negative) {
    if (actual === noException) return;
    if (expected == null || matches(actual, expected)) {
      if (message instanceof Error) throw message;
      failWith(actual, undefined, 'Got unwanted ' + (async ? 'rejection' : 'exception') + (message ? ': ' + message : '.') + '\nActual message: ' + (actual && actual.message !== undefined ? JSON.stringify(actual.message) : inspect(actual)), fn.name, fn);
    }
    throw actual;
  }
  if (actual === noException) {
    if (message instanceof Error) throw message;
    failWith(undefined, expected, 'Missing expected ' + (async ? 'rejection' : 'exception') + (expected && expected.name ? ' (' + expected.name + ')' : '') + (message ? ': ' + message : '.'), fn.name, fn);
  }
  if (expected != null && !matches(actual, expected)) failWith(actual, expected, message, fn.name, fn);
}
function throws(fn, expected, message) { expects(getActual(fn), expected, message, throws, false, false, arguments.length >= 3); }
function doesNotThrow(fn, expected, message) { expects(getActual(fn), expected, message, doesNotThrow, true, false, arguments.length >= 3); }
async function rejects(fn, expected, message) { expects(await waitForActual(fn), expected, message, rejects, false, true, arguments.length >= 3); }
async function doesNotReject(fn, expected, message) { expects(await waitForActual(fn), expected, message, doesNotReject, true, true, arguments.length >= 3); }
function ifError(value) {
  if (value === null || value === undefined) return;
  const error = new AssertionError({ actual: value, expected: null, operator: 'ifError', message: 'ifError got unwanted exception: ' + (value && value.message || inspect(value)), stackStartFn: ifError });
  if (value && typeof value.stack === 'string') error.stack += '\nCaused by: ' + value.stack;
  throw error;
}
function testMatch(string, regexp, message, negative, fn) {
  if (!types.isRegExp(regexp)) throw coded(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "regexp" argument must be an instance of RegExp');
  const success = typeof string === 'string' && RegExp.prototype.test.call(regexp, string);
  if (typeof string !== 'string' || success === negative) {
    const generated = message == null;
    if (generated) message = typeof string !== 'string' ? 'The "string" argument must be of type string. Received type ' + typeof string + ' (' + inspect(string) + ')' : 'The input ' + (negative ? 'was expected to not match' : 'did not match') + ' the regular expression ' + inspect(regexp) + '. Input:\n\n' + inspect(string) + '\n';
    try { failWith(string, regexp, message, fn.name, fn); }
    catch (error) { if (error instanceof AssertionError) error.generatedMessage = generated; throw error; }
  }
}
function match(string, regexp, message) { testMatch(string, regexp, message, false, match); }
function doesNotMatch(string, regexp, message) { testMatch(string, regexp, message, true, doesNotMatch); }
const methods = { ok, fail, equal, notEqual, deepEqual, notDeepEqual, strictEqual, notStrictEqual, deepStrictEqual, notDeepStrictEqual, partialDeepStrictEqual, throws, doesNotThrow, rejects, doesNotReject, ifError, match, doesNotMatch };
class Assert {
  constructor(options = {}) {
    if (options.diff !== undefined && options.diff !== 'simple' && options.diff !== 'full') throw coded(TypeError, 'ERR_INVALID_ARG_VALUE', 'The options.diff must be "simple" or "full"');
    Object.defineProperty(this, settings, { value: Object.assign({ strict: true, skipPrototype: false }, options) });
    this.AssertionError = AssertionError;
    if (this[settings].strict) Object.assign(this, { equal: strictEqual, notEqual: notStrictEqual, deepEqual: deepStrictEqual, notDeepEqual: notDeepStrictEqual });
  }
}
Object.assign(Assert.prototype, methods);
function strict(value, message) { return Reflect.apply(ok, undefined, arguments); }
Object.assign(ok, methods, { AssertionError, Assert, strict });
Object.assign(strict, ok, { equal: strictEqual, notEqual: notStrictEqual, deepEqual: deepStrictEqual, notDeepEqual: notDeepStrictEqual });
strict.strict = strict;
module.exports = ok;
