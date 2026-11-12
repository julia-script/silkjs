'use strict';
// SQLite schema and Storage interception semantics adapted from Node.js
// src/node_webstorage.cc and lib/internal/webstorage.js (24.22.3-pre), checked
// against the Node.js 24.22.2 binary.
// Copyright Node.js contributors. All rights reserved.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to
// deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
// sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
// FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
// IN THE SOFTWARE.

const { DatabaseSync } = require('internal/sqlite/database');
const { Buffer } = require('buffer');
const host = require('internal/host');
const states = new WeakMap();
host.types.isStorage = host.isStorage;
const schema = `
PRAGMA encoding = 'UTF-16le';
PRAGMA busy_timeout = 3000;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = memory;
PRAGMA optimize;
CREATE TABLE IF NOT EXISTS nodejs_webstorage(
  key BLOB NOT NULL, value BLOB NOT NULL, PRIMARY KEY(key)
) STRICT;
CREATE TABLE IF NOT EXISTS nodejs_webstorage_state(
  max_size INTEGER NOT NULL DEFAULT 10485760,
  total_size INTEGER NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 0,
  single_row_ INTEGER NOT NULL DEFAULT 1 CHECK(single_row_ = 1),
  PRIMARY KEY(single_row_)
) STRICT;
CREATE TRIGGER IF NOT EXISTS nodejs_quota_insert
AFTER INSERT ON nodejs_webstorage FOR EACH ROW BEGIN
  UPDATE nodejs_webstorage_state
    SET total_size = total_size + length(NEW.key) + length(NEW.value);
  SELECT RAISE(ABORT, 'QuotaExceeded') WHERE EXISTS (
    SELECT 1 FROM nodejs_webstorage_state WHERE total_size > max_size
  );
END;
CREATE TRIGGER IF NOT EXISTS nodejs_quota_update
AFTER UPDATE ON nodejs_webstorage FOR EACH ROW BEGIN
  UPDATE nodejs_webstorage_state SET total_size = total_size +
    ((length(NEW.key) + length(NEW.value)) - (length(OLD.key) + length(OLD.value)));
  SELECT RAISE(ABORT, 'QuotaExceeded') WHERE EXISTS (
    SELECT 1 FROM nodejs_webstorage_state WHERE total_size > max_size
  );
END;
CREATE TRIGGER IF NOT EXISTS nodejs_quota_delete
AFTER DELETE ON nodejs_webstorage FOR EACH ROW BEGIN
  UPDATE nodejs_webstorage_state
    SET total_size = total_size - (length(OLD.key) + length(OLD.value));
END;
INSERT OR IGNORE INTO nodejs_webstorage_state (total_size) VALUES (0);
`;

function error(code, message, Type = Error) {
  return Object.assign(new Type(message), { code });
}
function sqliteError(cause) {
  if (cause.code !== 'ERR_SQLITE_ERROR') throw cause;
  if ((cause.errcode & 255) === 19) {
    throw new DOMException('Setting the value exceeded the quota', 'QuotaExceededError');
  }
  throw error('ERR_INVALID_STATE', cause.errstr || cause.message);
}
function state(value) {
  const result = states.get(value);
  if (!result) throw new TypeError('Illegal invocation');
  return result;
}
function string(value) {
  // Template substitution performs ToString, including throwing for symbols.
  return `${value}`;
}
function bytes(value) { return Buffer.from(value, 'utf16le'); }
function text(value) { return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf16le'); }
function statement(s, name, sql) {
  if (!s.db) {
    let db;
    try {
      db = new DatabaseSync(s.path, { timeout: 3000 });
      db.exec(schema);
      const version = db.prepare('SELECT schema_version FROM nodejs_webstorage_state').get().schema_version;
      if (version > 1) throw error('ERR_INVALID_STATE', 'localStorage was created with a newer version of Node.js');
      if (version < 1) db.exec('UPDATE nodejs_webstorage_state SET schema_version = 1');
      s.db = db;
    } catch (cause) {
      if (db) db.close();
      sqliteError(cause);
    }
  }
  let result = s.statements.get(name);
  if (!result) {
    result = s.db.prepare(sql);
    s.statements.set(name, result);
  }
  return result;
}
function load(s, key) {
  if (typeof key === 'symbol') return s.symbols.get(key);
  try {
    const row = statement(s, 'load', 'SELECT value FROM nodejs_webstorage WHERE key = ? LIMIT 1').get(bytes(key));
    return row === undefined ? null : text(row.value);
  } catch (cause) { sqliteError(cause); }
}
function store(s, key, value) {
  if (typeof key === 'symbol') { s.symbols.set(key, value); return; }
  value = string(value);
  try {
    statement(s, 'store', `INSERT INTO nodejs_webstorage (key, value) VALUES (?, ?)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value WHERE EXCLUDED.key = key`)
      .run(bytes(key), bytes(value));
  } catch (cause) { sqliteError(cause); }
}
function remove(s, key) {
  if (typeof key === 'symbol') { s.symbols.delete(key); return; }
  try { statement(s, 'remove', 'DELETE FROM nodejs_webstorage WHERE key = ?').run(bytes(key)); }
  catch (cause) { sqliteError(cause); }
}
function missing(name, count) {
  throw error('ERR_MISSING_ARGS', `Failed to execute '${name}' on 'Storage': ${count} argument${count === 1 ? '' : 's'} required`, TypeError);
}
function Storage() { throw error('ERR_ILLEGAL_CONSTRUCTOR', 'Illegal constructor'); }
for (const key of ['arguments', 'caller']) Object.defineProperty(Storage, key, { value: null });
delete Storage.prototype.constructor;
const methods = {
  clear() {
    const s = state(this);
    try { statement(s, 'clear', 'DELETE FROM nodejs_webstorage').run(); }
    catch (cause) { sqliteError(cause); }
    if (s.inspected) inspected(s, 'domStorageItemsCleared', {});
  },
  getItem() {
    const s = state(this);
    if (arguments.length < 1) missing('getItem', 1);
    return load(s, string(arguments[0]));
  },
  key() {
    const s = state(this);
    if (arguments.length < 1) missing('key', 1);
    const index = arguments[0] >> 0;
    if (index < 0) return null;
    try {
      const row = statement(s, 'key', 'SELECT key FROM nodejs_webstorage LIMIT 1 OFFSET ?').get(index);
      return row === undefined ? null : text(row.key);
    } catch (cause) { sqliteError(cause); }
  },
  removeItem() {
    const s = state(this);
    if (arguments.length < 1) missing('removeItem', 1);
    const key = string(arguments[0]);
    remove(s, key);
    if (s.inspected) inspected(s, 'domStorageItemRemoved', { key });
  },
  setItem() {
    const s = state(this);
    if (arguments.length < 2) missing('setItem', 2);
    const key = string(arguments[0]);
    if (!s.inspected) return store(s, key, arguments[1]);
    // As Node's InspectorLocalStorage: the method calls, not property writes, report.
    const value = string(arguments[1]);
    const oldValue = load(s, key);
    store(s, key, value);
    if (oldValue === null) inspected(s, 'domStorageItemAdded', { key, newValue: value });
    else inspected(s, 'domStorageItemUpdated', { key, oldValue, newValue: value });
  },
};
Object.defineProperty(Storage.prototype, 'length', {
  enumerable: true,
  get: function() {
    const s = state(this);
    try { return statement(s, 'length', 'SELECT count(*) AS count FROM nodejs_webstorage').get().count; }
    catch (cause) { sqliteError(cause); }
  },
});
Object.defineProperty(Object.getOwnPropertyDescriptor(Storage.prototype, 'length').get, 'name', { value: '' });
for (const key of Object.keys(methods)) Object.defineProperty(Storage.prototype, key, {
  value: methods[key], enumerable: true, writable: true, configurable: true,
});
Object.defineProperty(Storage.prototype, 'constructor', { value: Storage, writable: true, configurable: true });

function inherited(target, key) {
  const prototype = Object.getPrototypeOf(target);
  return prototype !== null && Reflect.has(prototype, key);
}
// --experimental-storage-inspection (lib/internal/inspector/webstorage.js): the
// storage methods report to the inspector's DOMStorage domain.
function inspected(s, event, params) {
  const { storageId } = require('internal/inspector_dom_storage');
  require('inspector').DOMStorage[event]({ ...params, storageId: storageId(s.isLocalStorage) });
}
function create(path, isLocalStorage, inspect) {
  const target = Object.create(Storage.prototype);
  const s = { path, db: undefined, statements: new Map(), symbols: new Map(), isLocalStorage, inspected: inspect };
  // A native exotic is necessary: Storage accepts non-configurable descriptors
  // but continues reporting configurable properties, unlike an ECMAScript Proxy.
  const result = host.createStorage(target, {
    get(target, key, receiver) {
      if (inherited(target, key)) return Reflect.get(target, key, receiver);
      const value = load(s, key);
      return value === null ? undefined : value;
    },
    set(target, key, value) { store(s, key, value); return true; },
    has(target, key) { return inherited(target, key) || load(s, key) !== null; },
    deleteProperty(target, key) { remove(s, key); return true; },
    defineProperty(target, key, descriptor) {
      if (Object.prototype.hasOwnProperty.call(descriptor, 'value')) store(s, key, descriptor.value);
      return true;
    },
    getOwnPropertyDescriptor(target, key) {
      if (inherited(target, key)) return undefined;
      const value = load(s, key);
      if (value === null) return undefined;
      return { value, writable: true, enumerable: true, configurable: true };
    },
    ownKeys() {
      try { return statement(s, 'keys', 'SELECT key FROM nodejs_webstorage').all().map(row => text(row.key)); }
      catch (cause) { sqliteError(cause); }
    },
    preventExtensions() { return false; },
    getPrototypeOf(target) { return Reflect.getPrototypeOf(target); },
    setPrototypeOf(target, prototype) { return Reflect.setPrototypeOf(target, prototype); },
    isExtensible(target) { return Reflect.isExtensible(target); },
  });
  states.set(result, s);
  return result;
}

function install(global, { localStorageFile, inspect = false } = {}) {
  let warned = false;
  function warn() {
    if (warned) return;
    warned = true;
    process.emitWarning('Web Storage is an experimental feature and might change at any time', 'ExperimentalWarning');
  }
  host.defineLazyDataProperty(global, 'Storage', () => { warn(); return Storage; });
  for (const name of ['localStorage', 'sessionStorage']) {
    let initialized = false;
    let value;
    const descriptor = {
      get [name]() {
        if (!initialized) {
          warn();
          let path = ':memory:';
          if (name === 'localStorage') {
            path = localStorageFile === undefined ? '' : localStorageFile;
            if (path === '') throw error('ERR_INVALID_ARG_VALUE', "The argument '--localstorage-file' is an invalid localStorage location. Received ''", TypeError);
            if (typeof path !== 'string') throw error('ERR_INVALID_ARG_TYPE', 'The "path" argument must be of type string or an instance of Buffer or URL.', TypeError);
            if (path.includes('\0')) throw error('ERR_INVALID_ARG_VALUE', 'The argument \'path\' must be a string, Uint8Array, or URL without null bytes.', TypeError);
          }
          value = create(path, name === 'localStorage', inspect);
          initialized = true;
        }
        return value;
      },
      set [name](replacement) { value = replacement; initialized = true; },
    };
    Object.defineProperty(global, name, { ...Object.getOwnPropertyDescriptor(descriptor, name), configurable: true, enumerable: true });
  }
}
module.exports = { install };
