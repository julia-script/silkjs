'use strict';
// DatabaseSync, Session, SQLTagStore and backup() over sqliteNative, following
// node_sqlite.cc: the same argument checks in the same order, with its messages.
const host = require('internal/host');
const {
  native, databases, sessions, statements, token, finalizers, error, argType, invalid, argValue, outOfRange,
  stateError, isObject, isInt32, object, string, boolean, callable, optionalBoolean, path, statementOptions,
  databaseState, notInAuthorizer, database, usable, notStepping, session, readValue, binary, resultValue,
  callbackOptions, inCallback, limits, traceSuppression,
} = require('internal/sqlite/shared');
const { StatementSync, prepared, tagExecute } = require('internal/sqlite/statement');
const limitObjects = new WeakMap();
let isUint8Array;
function uint8Array(value) { return (isUint8Array ??= require('internal/util/types').isUint8Array)(value); }
const SQLITE_OPEN_READONLY = 0x1, SQLITE_OPEN_READWRITE = 0x2, SQLITE_OPEN_CREATE = 0x4, SQLITE_OPEN_URI = 0x40;
const DBCONFIG_ENABLE_FKEY = 1002, DBCONFIG_ENABLE_LOAD_EXTENSION = 1005, DBCONFIG_DEFENSIVE = 1010;
const DBCONFIG_DQS_DML = 1013, DBCONFIG_DQS_DDL = 1014;
const SQLITE_DETERMINISTIC = 0x800, SQLITE_DIRECTONLY = 0x80000;
const INT_MAX = 0x7fffffff;
const sqliteType = Symbol.for('sqlite-type');

// sqlite.db.query: like Node's channel status callback, tracing (SQLITE_TRACE_PROFILE) is on
// for every open database exactly while the channel has subscribers.
const queryChannel = 'sqlite.db.query';
const openDatabases = new Map();
let tracing = false;
function traceActive() { const dc = host.diagnosticsChannel; return dc !== undefined && dc.hasSubscribers(queryChannel); }
function applyTrace(db) { native('trace', tracing ? [db.id, new WeakRef(db.traceRoot)] : [db.id]); }
host.diagnostics.watch(queryChannel, active => {
  tracing = active;
  for (const [id, ref] of openDatabases) {
    const db = ref.deref();
    if (db === undefined || db.id !== id) { openDatabases.delete(id); continue; }
    applyTrace(db);
  }
});

function permissionEnabled() { return host.builtinLoaded('internal/permission') && require('internal/permission').enabled(); }
function functionKey(name, count) { return `${name.replace(/[A-Z]/g, c => c.toLowerCase())}\0${count}`; }
function argc(fn) { return fn.length | 0; }

// The constructor is a plain function so a call without new throws Node's error.
function DatabaseSync(location, options) {
  if (new.target === undefined) throw error('ERR_CONSTRUCT_CALL_REQUIRED', 'Cannot call constructor without `new`', TypeError);
  location = path(location);
  const config = { readOnly: false, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, timeout: 0, readBigInts: false, returnArrays: false, allowBareNamedParameters: true, allowUnknownNamedParameters: false, defensive: true, limits: [] };
  let open = true, allowExtension = false;
  if (arguments.length > 1) {
    object(options);
    open = optionalBoolean(options, 'open', open);
    config.readOnly = optionalBoolean(options, 'readOnly', config.readOnly);
    config.enableForeignKeyConstraints = optionalBoolean(options, 'enableForeignKeyConstraints', config.enableForeignKeyConstraints);
    config.enableDoubleQuotedStringLiterals = optionalBoolean(options, 'enableDoubleQuotedStringLiterals', config.enableDoubleQuotedStringLiterals);
    allowExtension = optionalBoolean(options, 'allowExtension', allowExtension);
    const timeout = options.timeout;
    if (timeout !== undefined) { if (!isInt32(timeout)) throw invalid('options.timeout', 'an integer'); config.timeout = timeout; }
    for (const key of ['readBigInts', 'returnArrays', 'allowBareNamedParameters', 'allowUnknownNamedParameters', 'defensive']) config[key] = optionalBoolean(options, key, config[key]);
    const initial = options.limits;
    if (initial !== undefined) {
      if (!isObject(initial)) throw invalid('options.limits', 'an object');
      for (let i = 0; i < limits.length; i++) {
        const value = initial[limits[i]];
        if (value === undefined) continue;
        if (!isInt32(value)) throw invalid(`options.limits.${limits[i]}`, 'an integer');
        if (value < 0) throw outOfRange(`The "options.limits.${limits[i]}" argument must be non-negative.`);
        config.limits[i] = value;
      }
    }
  }
  const state = { id: 0, path: location, options: config, allowExtension, extensions: allowExtension, generation: 0, statementGeneration: 0, executing: 0, callbacks: 0, authorizing: false, functionRoots: new Map(), authorizerRoot: undefined, traceRoot: undefined };
  // The trace callback holds the database weakly: native code keeps it only through a WeakRef.
  const self = new WeakRef(this);
  state.traceRoot = (_mode, _key, args) => {
    if (traceSuppression.depth) return;
    const object = self.deref();
    if (object === undefined) return;
    const payload = { __proto__: null, sql: args[0], database: object, duration: args[1] };
    inCallback(state, () => host.diagnostics.publish(queryChannel, payload));
  };
  databases.set(this, state);
  this[sqliteType] = 'node:sqlite';
  if (open) openDatabase(this, state);
}
function openDatabase(self, db) {
  if (db.id) throw stateError('database is already open');
  const o = db.options;
  const id = native('open', [db.path, (o.readOnly ? SQLITE_OPEN_READONLY : SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE) | SQLITE_OPEN_URI]);
  try {
    native('config', [id, DBCONFIG_DQS_DML, +o.enableDoubleQuotedStringLiterals]);
    native('config', [id, DBCONFIG_DQS_DDL, +o.enableDoubleQuotedStringLiterals]);
    native('config', [id, DBCONFIG_ENABLE_FKEY, +o.enableForeignKeyConstraints]);
    native('config', [id, DBCONFIG_DEFENSIVE, +o.defensive]);
    native('timeout', [id, o.timeout]);
    for (let i = 0; i < limits.length; i++) if (o.limits[i] !== undefined) native('limit', [id, i, o.limits[i]]);
    if (db.allowExtension) {
      if (permissionEnabled()) throw error('ERR_LOAD_SQLITE_EXTENSION', 'Cannot load SQLite extensions when the permission model is enabled.');
      native('config', [id, DBCONFIG_ENABLE_LOAD_EXTENSION, 1]);
    }
  } catch (e) { native('close', [id]); throw e; }
  db.id = id; db.generation++; db.extensions = db.allowExtension;
  openDatabases.set(id, new WeakRef(db));
  finalizers.register(self, { id }, self);
  if (traceActive()) { tracing = true; applyTrace(db); }
}
function limitsObject(owner) {
  const result = {};
  for (let i = 0; i < limits.length; i++) Object.defineProperty(result, limits[i], {
    enumerable: true,
    get: () => native('limit', [database(owner).id, i, -1]),
    set: value => {
      const db = usable(owner);
      let next;
      if (typeof value !== 'number') throw argType('Limit value must be a non-negative integer or Infinity.');
      if (value === Infinity) next = INT_MAX;
      else if (!isInt32(value)) throw argType('Limit value must be a non-negative integer or Infinity.');
      else if (value < 0) throw outOfRange('Limit value must be non-negative.');
      else next = value;
      native('limit', [db.id, i, next]);
    },
  });
  return result;
}
function closeNative(id) { traceSuppression.depth++; try { native('close', [id]); } finally { traceSuppression.depth--; } }

class DatabaseSyncMethods {
  open() { openDatabase(this, databaseState(this)); }
  close() {
    const db = database(this);
    if (db.callbacks || db.executing) throw stateError('database cannot be closed while in a callback');
    closeNative(db.id);
    openDatabases.delete(db.id);
    db.id = 0;
    db.generation++;
    db.functionRoots.clear();
    db.authorizerRoot = undefined;
    finalizers.unregister(this);
  }
  [Symbol.dispose]() { try { this.close(); } catch {} }
  prepare(sql, options) {
    const db = usable(this);
    if (typeof sql !== 'string') throw invalid('sql', 'a string');
    const config = statementOptions(options, db.options);
    const id = native('prepare', [db.id, sql]);
    if (id === 0) throw argValue('The SQL query contains no statements.');
    return prepared(this, id, config);
  }
  exec(sql) {
    const db = usable(this);
    if (typeof sql !== 'string') throw invalid('sql', 'a string');
    db.executing++;
    try { native('exec', [db.id, sql]); } finally { db.executing--; }
  }
  function(name, options, fn) {
    const db = usable(this);
    if (typeof name !== 'string') throw invalid('name', 'a string');
    let opts = { useBigIntArguments: false, varargs: false, deterministic: false, directOnly: false };
    if (arguments.length < 3) fn = options;
    else opts = callbackOptions(options);
    if (typeof fn !== 'function') throw invalid('function', 'a function');
    const count = opts.varargs ? -1 : argc(fn);
    const wrapper = (_mode, _token, args) => inCallback(db, () => {
      for (let i = 0; i < args.length; i++) args[i] = readValue(args[i], opts.useBigIntArguments);
      return resultValue(Reflect.apply(fn, undefined, args));
    });
    const flags = 1 | (opts.deterministic ? SQLITE_DETERMINISTIC : 0) | (opts.directOnly ? SQLITE_DIRECTONLY : 0);
    native('function', [db.id, name, count, flags, 0, new WeakRef(wrapper), +opts.useBigIntArguments]);
    db.functionRoots.set(functionKey(name, count), wrapper);
  }
  createTagStore(maxSize) {
    const db = database(this); notInAuthorizer(db);
    let capacity = 1000;
    if (maxSize !== undefined) {
      if (typeof maxSize !== 'number') throw argType('The "maxSize" argument must be a positive integer.');
      if (Math.floor(maxSize) !== maxSize || maxSize <= 0 || maxSize > INT_MAX) throw outOfRange('The "maxSize" argument must be a positive integer.');
      capacity = maxSize;
    }
    return new SQLTagStore(token, this, capacity);
  }
  location(dbName) {
    const db = database(this);
    let name = 'main';
    if (dbName !== undefined) name = string(dbName, 'dbName');
    return native('location', [db.id, name]);
  }
  aggregate(name, options) {
    const db = usable(this);
    if (typeof name !== 'string') throw invalid('name', 'a string');
    object(options);
    const start = options.start;
    if (start === undefined) throw invalid('options.start', 'a function or a primitive value');
    const step = options.step;
    if (typeof step !== 'function') throw invalid('options.step', 'a function');
    const resultOption = options.result;
    const opts = {};
    for (const key of ['useBigIntArguments', 'varargs', 'directOnly']) opts[key] = optionalBoolean(options, key, false);
    const inverse = options.inverse;
    if (inverse !== undefined && typeof inverse !== 'function') throw invalid('options.inverse', 'a function');
    const result = typeof resultOption === 'function' ? resultOption : undefined;
    let count = -1;
    if (!opts.varargs) count = Math.max(argc(step) - 1, (inverse ? argc(inverse) : argc(step)) - 1, 0);
    const groups = new Map();
    const wrapper = (mode, key, args) => inCallback(db, () => {
      try {
        let group = groups.get(key);
        if (!group) { group = { value: typeof start === 'function' ? Reflect.apply(start, null, []) : start, window: false }; groups.set(key, group); }
        if (mode === 1 || mode === 4) {
          for (let i = 0; i < args.length; i++) args[i] = readValue(args[i], opts.useBigIntArguments);
          group.value = Reflect.apply(mode === 1 ? step : inverse, undefined, [group.value, ...args]);
          return undefined;
        }
        if (mode === 2 && group.window) { groups.delete(key); return undefined; }
        if (mode === 3) group.window = true;
        const value = resultValue(result ? Reflect.apply(result, null, [group.value]) : group.value);
        if (mode === 2) groups.delete(key);
        return value;
      } catch (e) { groups.delete(key); throw e; }
    });
    native('function', [db.id, name, count, 1 | (opts.directOnly ? SQLITE_DIRECTONLY : 0), inverse ? 2 : 1, new WeakRef(wrapper), +opts.useBigIntArguments]);
    db.functionRoots.set(functionKey(name, count), wrapper);
  }
  createSession(options) {
    let table, name = 'main';
    if (arguments.length > 0) {
      object(options);
      if (Object.prototype.hasOwnProperty.call(options, 'table')) { const value = options.table; if (typeof value !== 'string') throw invalid('options.table', 'a string'); table = value; }
      if (Object.prototype.hasOwnProperty.call(options, 'db')) { const value = options.db; if (typeof value !== 'string') throw invalid('options.db', 'a string'); name = value; }
    }
    const db = usable(this);
    return new Session(token, this, native('session', [db.id, name, table === '' ? undefined : table]));
  }
  applyChangeset(changeset, options) {
    const db = usable(this);
    if (!uint8Array(changeset)) throw invalid('changeset', 'a Uint8Array');
    let conflict, filter;
    if (arguments.length > 1 && options !== undefined) {
      object(options);
      const onConflict = options.onConflict;
      if (onConflict !== undefined) conflict = callable(onConflict, 'options.onConflict');
      if (Object.prototype.hasOwnProperty.call(options, 'filter')) filter = callable(options.filter, 'options.filter');
    }
    const wrapper = (mode, _key, args) => inCallback(db, () => {
      if (mode === 5) return filter ? !!Reflect.apply(filter, null, args) : true;
      if (!conflict) return 2;
      const result = Reflect.apply(conflict, null, args);
      return isInt32(result) ? result : -1;
    });
    return native('apply', [db.id, ...binary(changeset), wrapper]);
  }
  enableLoadExtension(allow) {
    const db = usable(this);
    boolean(allow, 'allow');
    if (allow && !db.allowExtension) throw stateError('Cannot enable extension loading because it was disabled at database creation.');
    db.extensions = allow;
    native('config', [db.id, DBCONFIG_ENABLE_LOAD_EXTENSION, +allow]);
  }
  enableDefensive(active) {
    const db = usable(this);
    boolean(active, 'active');
    native('config', [db.id, DBCONFIG_DEFENSIVE, +active]);
  }
  loadExtension(filename, entryPoint) {
    const db = database(this);
    if (!db.allowExtension || !db.extensions) throw stateError('extension loading is not allowed');
    notInAuthorizer(db);
    if (typeof filename !== 'string') throw invalid('path', 'a string');
    if (permissionEnabled()) require('internal/permission').check('fs.read', filename);
    const message = native('loadExtension', [db.id, filename, entryPoint === undefined ? '' : String(entryPoint)]);
    if (message !== undefined) throw error('ERR_LOAD_SQLITE_EXTENSION', message);
  }
  serialize(dbName) {
    const db = usable(this);
    let name = 'main';
    if (dbName !== undefined) name = string(dbName, 'dbName');
    return new Uint8Array(native('serialize', [db.id, name]) ?? 0);
  }
  deserialize(buffer, options) {
    const db = database(this);
    if (db.callbacks || db.executing) throw stateError('database cannot be deserialized while in a callback');
    if (!uint8Array(buffer)) throw invalid('buffer', 'a Uint8Array');
    if (!buffer.byteLength) throw argValue('The "buffer" argument must not be empty.');
    let name = 'main';
    if (arguments.length > 1 && options !== undefined) {
      object(options);
      const value = options.dbName;
      if (value !== undefined) name = string(value, 'options.dbName');
    }
    db.statementGeneration++;
    traceSuppression.depth++;
    try { native('deserialize', [db.id, name, ...binary(buffer)]); } finally { traceSuppression.depth--; }
  }
  setAuthorizer(callback) {
    const db = usable(this);
    if (callback === null) { native('authorizer', [db.id]); db.authorizerRoot = undefined; return; }
    if (typeof callback !== 'function') throw invalid('callback', 'a function or null');
    // AuthorizerCallback: a thrown error or a bad code denies the action and is rethrown.
    const wrapper = (_mode, _key, args) => inCallback(db, () => {
      db.authorizing = true;
      let result;
      try { result = Reflect.apply(callback, undefined, args); } finally { db.authorizing = false; }
      if (!isInt32(result)) throw new TypeError('Authorizer callback must return an integer authorization code');
      if (result !== 0 && result !== 1 && result !== 2) throw new RangeError('Authorizer callback returned a invalid authorization code');
      return result;
    });
    native('authorizer', [db.id, new WeakRef(wrapper)]);
    db.authorizerRoot = wrapper;
  }
  get isOpen() { return !!databaseState(this).id; }
  get isTransaction() { return native('transaction', [database(this).id]); }
  get limits() {
    databaseState(this);
    let result = limitObjects.get(this);
    if (!result) { result = limitsObject(this); limitObjects.set(this, result); }
    return result;
  }
}
DatabaseSync.prototype = DatabaseSyncMethods.prototype;
Object.defineProperty(DatabaseSync.prototype, 'constructor', { value: DatabaseSync, writable: true, enumerable: false, configurable: true });
Object.defineProperty(DatabaseSync, 'prototype', { writable: false });

// Generating a changeset runs SQL, so an authorizer can try to close the session meanwhile.
function generate(self, op) {
  const s = session(self);
  notInAuthorizer(databases.get(s.db));
  s.generating = true;
  try { return new Uint8Array(native(op, [s.id]) ?? 0); } finally { s.generating = false; }
}
class Session {
  constructor(secret, db, id) {
    if (secret !== token) throw error('ERR_ILLEGAL_CONSTRUCTOR', 'Illegal constructor', TypeError);
    sessions.set(this, { db, id, generation: database(db).generation, generating: false });
    finalizers.register(this, { id }, this);
  }
  changeset() { return generate(this, 'changeset'); }
  patchset() { return generate(this, 'patchset'); }
  close() {
    const s = session(this);
    if (s.generating) throw stateError('session is currently in use');
    native('close', [s.id]); s.id = 0; finalizers.unregister(this);
  }
  [Symbol.dispose]() { try { this.close(); } catch {} }
}

const tagStores = new WeakMap();
function tagStore(value) { const s = tagStores.get(value); if (!s) throw argType('This method can only be called on SQLTagStore instances.'); return s; }
// SQLTagStore::PrepareStatement: parts joined with one ? per argument, cached by SQL text.
function tagStatement(store, strings, count) {
  const s = tagStore(store);
  const db = database(s.db); notInAuthorizer(db);
  if (!Array.isArray(strings)) throw argType('First argument must be an array of strings (template literal).');
  let sql = '';
  for (let i = 0; i < strings.length; i++) {
    const part = strings[i];
    if (typeof part !== 'string') throw argType('Template literal parts must be strings.');
    sql += part;
    if (i < count) sql += '?';
  }
  if (s.generation !== db.generation || s.statementGeneration !== db.statementGeneration) { s.cache.clear(); s.generation = db.generation; s.statementGeneration = db.statementGeneration; }
  let stmt = s.cache.get(sql);
  if (stmt !== undefined) {
    s.cache.delete(sql);
    if (!statements.get(stmt).id) stmt = undefined;
  }
  if (stmt === undefined) {
    const id = native('prepare', [db.id, sql]);
    if (id === 0) throw argValue('The SQL query contains no statements.');
    stmt = prepared(s.db, id, db.options);
  }
  s.cache.set(sql, stmt);
  if (s.cache.size > s.capacity) s.cache.delete(s.cache.keys().next().value);
  return stmt;
}
class SQLTagStore {
  constructor(secret, db, capacity) {
    if (secret !== token) throw error('ERR_ILLEGAL_CONSTRUCTOR', 'Illegal constructor', TypeError);
    const s = databases.get(db);
    tagStores.set(this, { db, capacity, cache: new Map(), generation: s.generation, statementGeneration: s.statementGeneration });
  }
  run(strings, ...args) { return tagExecute(tagStatement(this, strings, args.length), args, 'run'); }
  iterate(strings, ...args) { return tagExecute(tagStatement(this, strings, args.length), args, 'iterate'); }
  get(strings, ...args) { return tagExecute(tagStatement(this, strings, args.length), args, 'get'); }
  all(strings, ...args) { return tagExecute(tagStatement(this, strings, args.length), args, 'all'); }
  clear() { tagStore(this).cache.clear(); }
  get capacity() { return tagStore(this).capacity; }
  get db() { return tagStore(this).db; }
  get size() { return tagStore(this).cache.size; }
}

function backup(sourceDb, destination, options) {
  if (arguments.length < 1 || !isObject(sourceDb)) throw invalid('sourceDb', 'an object');
  const db = database(sourceDb);
  destination = path(destination);
  let rate = 100, source = 'main', target = 'main', progress;
  if (arguments.length > 2) {
    object(options);
    const rateValue = options.rate;
    if (rateValue !== undefined) {
      if (!isInt32(rateValue)) throw invalid('options.rate', 'an integer');
      if (rateValue <= 0) throw outOfRange('The "options.rate" argument must be a positive integer.');
      rate = rateValue;
    }
    const sourceValue = options.source;
    if (sourceValue !== undefined) source = string(sourceValue, 'options.source');
    const targetValue = options.target;
    if (targetValue !== undefined) target = string(targetValue, 'options.target');
    const progressValue = options.progress;
    if (progressValue !== undefined) progress = callable(progressValue, 'options.progress');
  }
  return new Promise((resolve, reject) => {
    let id;
    try { id = native('backup', [db.id, destination, source, target]); } catch (e) { reject(e); return; }
    function finish(error, total) { try { native('release', [id]); } catch (e) { if (!error) error = e; } if (error) reject(error); else resolve(total); }
    function step() {
      try {
        database(sourceDb);
        const [status, remainingPages, totalPages] = native('backupStep', [id, rate]);
        if (progress && remainingPages !== 0) Reflect.apply(progress, null, [{ totalPages, remainingPages }]);
        if (status === 101) { finish(null, totalPages); return; }
        if (status === 5 || status === 6) setTimeout(step, 1); else setImmediate(step);
      } catch (e) { finish(e); }
    }
    setImmediate(step);
  });
}
Object.defineProperty(backup, 'length', { value: 2 });
module.exports = { DatabaseSync, Session, backup };
