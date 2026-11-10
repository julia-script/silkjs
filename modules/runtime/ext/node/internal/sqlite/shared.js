'use strict';
const host = require('internal/host');
const native = (op, args = []) => host.sqliteNative(op, args);
const databases = new WeakMap();
const statements = new WeakMap();
const sessions = new WeakMap();
const token = {};
const finalizers = new FinalizationRegistry(({ id }) => { try { native('release', [id]); } catch {} });
function error(code, message, Type = Error) { return Object.assign(new Type(message), { code }); }
function invalid(name, type) { return error('ERR_INVALID_ARG_TYPE', `The "${name}" argument must be of type ${type}.`, TypeError); }
function stateError(message) { return error('ERR_INVALID_STATE', message); }
function object(value, name = 'options') { if (value === null || typeof value !== 'object') throw invalid(name, 'object'); return value; }
function string(value, name) { if (typeof value !== 'string') throw invalid(name, 'string'); if (value.includes('\0')) throw error('ERR_INVALID_ARG_VALUE', `The "${name}" argument must not contain null bytes.`, TypeError); return value; }
function boolean(value, name) { if (typeof value !== 'boolean') throw invalid(name, 'boolean'); return value; }
function callable(value, name) { if (typeof value !== 'function') throw invalid(name, 'function'); return value; }
function integer(value, name, min = 0, max = 0x7fffffff) { if (typeof value !== 'number') throw invalid(name, 'number'); if (!Number.isInteger(value) || value < min || value > max) throw error('ERR_OUT_OF_RANGE', `The value of "${name}" is out of range. It must be >= ${min} and <= ${max}. Received ${value}`, RangeError); return value; }
function path(value) { if (value && typeof value === 'object' && value.protocol !== undefined) value = require('url').fileURLToPath(value); else if (require('buffer').Buffer.isBuffer(value)) value = value.toString(); return string(value, 'path'); }
const statementDefaults = { readBigInts: false, returnArrays: false, allowBareNamedParameters: true, allowUnknownNamedParameters: false };
function statementOptions(options, defaults = statementDefaults) { object(options); const result = {}; for (const key of Object.keys(statementDefaults)) result[key] = options[key] === undefined ? defaults[key] : boolean(options[key], `options.${key}`); return result; }
function database(value, access = true) { const s = databases.get(value); if (!s) throw error('ERR_INVALID_THIS', 'Value of "this" must be of type DatabaseSync', TypeError); if (access) { if (!s.id) throw stateError('database is not open'); if (s.authorizing) throw stateError('database cannot be accessed from an authorizer callback'); } return s; }
function statement(value, access = true) { const s = statements.get(value); if (!s) throw error('ERR_INVALID_THIS', 'Value of "this" must be of type StatementSync', TypeError); const db = databases.get(s.db); if (!s.id || !db.id || db.generation !== s.generation || db.statementGeneration !== s.statementGeneration) throw stateError('statement has been finalized'); if (access) { if (db.authorizing) throw stateError('database cannot be accessed from an authorizer callback'); if (s.busy) throw stateError('statement is already being executed'); } return s; }
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
function callbackOptions(options) { object(options); const out = {}; for (const key of ['useBigIntArguments', 'varargs', 'deterministic', 'directOnly']) out[key] = options[key] === undefined ? false : boolean(options[key], `options.${key}`); return out; }
function inCallback(db, fn) { db.callbacks++; try { return fn(); } finally { db.callbacks--; } }
const limits = ['length', 'sqlLength', 'column', 'exprDepth', 'compoundSelect', 'vdbeOp', 'functionArg', 'attach', 'likePatternLength', 'variableNumber', 'triggerDepth'];
module.exports = { native, databases, statements, sessions, token, finalizers, error, invalid, stateError, object, string, boolean, callable, integer, path, statementOptions, database, statement, session, sqlInteger, readValue, isBinary, binary, bindValue, resultValue, callbackOptions, inCallback, limits };
