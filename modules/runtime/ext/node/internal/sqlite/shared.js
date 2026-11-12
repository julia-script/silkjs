'use strict';
const host = require('internal/host');
const native = (op, args = []) => host.sqliteNative(op, args);
const databases = new WeakMap();
const statements = new WeakMap();
const sessions = new WeakMap();
const token = {};
// Finalizing a statement can complete it, which SQLITE_TRACE_PROFILE would report; Node's
// TraceEventSuppressionGuard keeps finalization out of sqlite.db.query, and so does this.
const traceSuppression = { depth: 0 };
function release(id) { traceSuppression.depth++; try { native('release', [id]); } finally { traceSuppression.depth--; } }
const finalizers = new FinalizationRegistry(({ id }) => { try { release(id); } catch {} });
function error(code, message, Type = Error) { return Object.assign(new Type(message), { code }); }
// node_sqlite.cc words its argument errors itself ('must be a boolean.'), unlike the
// validators in lib/ ('must be of type boolean.'); these follow the C++ wording.
function argType(message) { return error('ERR_INVALID_ARG_TYPE', message, TypeError); }
function invalid(name, description) { return argType(`The "${name}" argument must be ${description}.`); }
function argValue(message) { return error('ERR_INVALID_ARG_VALUE', message, TypeError); }
function outOfRange(message) { return error('ERR_OUT_OF_RANGE', message, RangeError); }
function stateError(message) { return error('ERR_INVALID_STATE', message); }
function isObject(value) { return (typeof value === 'object' && value !== null) || typeof value === 'function'; }
// V8's IsInt32: a number with an int32 value, not -0.
function isInt32(value) { return typeof value === 'number' && (value | 0) === value && !(value === 0 && 1 / value < 0); }
function object(value, name = 'options') { if (!isObject(value)) throw invalid(name, 'an object'); return value; }
function string(value, name) { if (typeof value !== 'string') throw invalid(name, 'a string'); return value; }
function boolean(value, name) { if (typeof value !== 'boolean') throw invalid(name, 'a boolean'); return value; }
function callable(value, name) { if (typeof value !== 'function') throw invalid(name, 'a function'); return value; }
// An optional option read the way node_sqlite.cc reads it: one Get, undefined keeps the default.
function optionalBoolean(options, key, fallback) { const value = options[key]; return value === undefined ? fallback : boolean(value, `options.${key}`); }
let isUint8Array;
// ValidateDatabasePath: a string or Uint8Array without NUL bytes, or an object whose href
// is such a string and a file: URL. URLs reach sqlite3_open_v2 whole, opened with SQLITE_OPEN_URI.
function path(value, name = 'path') {
  if (typeof value === 'string') { if (!value.includes('\0')) return value; }
  else if ((isUint8Array ??= require('internal/util/types').isUint8Array)(value)) {
    if (!value.includes(0)) return require('buffer').Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8');
  } else if (isObject(value)) {
    const href = value.href;
    if (typeof href === 'string' && !href.includes('\0')) {
      if (!URL.canParse(href)) throw error('ERR_INVALID_URL', 'Invalid URL', TypeError);
      if (!href.startsWith('file:')) throw error('ERR_INVALID_URL_SCHEME', 'The URL must be of scheme file:', TypeError);
      return href;
    }
  }
  throw argType(`The "${name}" argument must be a string, Uint8Array, or URL without null bytes.`);
}
const statementDefaults = { readBigInts: false, returnArrays: false, allowBareNamedParameters: true, allowUnknownNamedParameters: false };
// DatabaseSync::Prepare reads these four in this order; unset ones come from the database.
const statementKeys = ['returnArrays', 'readBigInts', 'allowBareNamedParameters', 'allowUnknownNamedParameters'];
function statementOptions(options, defaults) {
  const result = { readBigInts: defaults.readBigInts, returnArrays: defaults.returnArrays, allowBareNamedParameters: defaults.allowBareNamedParameters, allowUnknownNamedParameters: defaults.allowUnknownNamedParameters };
  if (options !== undefined) { object(options); for (const key of statementKeys) result[key] = optionalBoolean(options, key, result[key]); }
  return result;
}
function databaseState(value) { const s = databases.get(value); if (!s) throw error('ERR_INVALID_THIS', 'Value of "this" must be of type DatabaseSync', TypeError); return s; }
function notInAuthorizer(db) { if (db.authorizing) throw stateError('database cannot be accessed from an authorizer callback'); }
// THROW_AND_RETURN_ON_BAD_STATE(!IsOpen()) alone, and with THROW_AND_RETURN_IF_IN_AUTHORIZER.
function database(value) { const s = databaseState(value); if (!s.id) throw stateError('database is not open'); return s; }
function usable(value) { const s = database(value); notInAuthorizer(s); return s; }
function finalized(s) { const db = databases.get(s.db); return !s.id || !db.id || db.generation !== s.generation || db.statementGeneration !== s.statementGeneration; }
function statement(value) { const s = statements.get(value); if (!s) throw error('ERR_INVALID_THIS', 'Value of "this" must be of type StatementSync', TypeError); if (finalized(s)) throw stateError('statement has been finalized'); return s; }
// THROW_AND_RETURN_IF_STEPPING: only the statement being stepped is off limits.
function notStepping(s) { if (s.busy) throw stateError('statement is already being executed'); }
function runnable(value) { const s = statement(value); notInAuthorizer(databases.get(s.db)); notStepping(s); return s; }
function session(value) { const s = sessions.get(value); if (!s) throw error('ERR_INVALID_THIS', 'Value of "this" must be of type Session', TypeError); const db = database(s.db); if (!s.id || db.generation !== s.generation) throw stateError('session is not open'); return s; }
function sqlInteger(value, big) { if (typeof value !== 'bigint') return value; if (big) return value; if (value < -9007199254740991n || value > 9007199254740991n) throw error('ERR_OUT_OF_RANGE', `Value is too large to be represented as a JavaScript number: ${value}`, RangeError); return Number(value); }
function readValue(value, big) { if (value instanceof ArrayBuffer) return new Uint8Array(value); return sqlInteger(value, big); }
function isBinary(value) { return ArrayBuffer.isView(value) || value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer); }
function binary(value) { return ArrayBuffer.isView(value) ? [value.buffer, value.byteOffset, value.byteLength] : [value, 0, value.byteLength]; }
function checkBigInt(value) { if (value < -9223372036854775808n || value > 9223372036854775807n) throw error('ERR_INVALID_ARG_VALUE', 'BigInt value is too large to bind.', TypeError); return value; }
function bindValue(id, index, value) {
  if (value === null) return native('bind', [id, index, 0]);
  if (typeof value === 'number') return native('bind', [id, index, 1, value]);
  if (typeof value === 'bigint') return native('bind', [id, index, 2, checkBigInt(value)]);
  if (typeof value === 'boolean') return native('bind', [id, index, 2, value ? 1n : 0n]);
  if (typeof value === 'string') return native('bind', [id, index, 3, value]);
  if (isBinary(value)) { const [buffer, offset, length] = binary(value); return native('bind', [id, index, 4, buffer, offset, length]); }
  throw error('ERR_INVALID_ARG_TYPE', `Provided value cannot be bound to SQLite parameter ${index}.`, TypeError);
}
function resultValue(value) {
  if (value == null || typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'bigint' && value >= -9223372036854775808n && value <= 9223372036854775807n) return value;
  if (isBinary(value)) return binary(value);
  const message = typeof value === 'bigint' ? 'BigInt value is too large for SQLite' : value instanceof Promise ? 'Asynchronous user-defined functions are not supported' : 'Returned JavaScript value cannot be converted to a SQLite value';
  throw Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR', errcode: 1, errstr: 'SQL logic error' });
}
// DatabaseSync::CustomFunction's options, read in this order.
function callbackOptions(options) { object(options); const out = {}; for (const key of ['useBigIntArguments', 'varargs', 'deterministic', 'directOnly']) out[key] = optionalBoolean(options, key, false); return out; }
function inCallback(db, fn) { db.callbacks++; try { return fn(); } finally { db.callbacks--; } }
const limits = ['length', 'sqlLength', 'column', 'exprDepth', 'compoundSelect', 'vdbeOp', 'functionArg', 'attach', 'likePatternLength', 'variableNumber', 'triggerDepth'];
module.exports = { native, traceSuppression, release, databases, statements, sessions, token, finalizers, error, argType, invalid, argValue, outOfRange, stateError, isObject, isInt32, object, string, boolean, callable, optionalBoolean, path, statementDefaults, statementOptions, databaseState, notInAuthorizer, database, usable, finalized, statement, notStepping, runnable, session, sqlInteger, readValue, isBinary, binary, bindValue, resultValue, callbackOptions, inCallback, limits };
