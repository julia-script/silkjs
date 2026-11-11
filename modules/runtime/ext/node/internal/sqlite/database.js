'use strict';
const {
  native, databases, sessions, token, finalizers, error, invalid, stateError,
  object, string, boolean, callable, integer, path, statementOptions, database,
  session, readValue, binary, isBinary, resultValue, callbackOptions, inCallback, limits,
} = require('internal/sqlite/shared');
const { StatementSync } = require('internal/sqlite/statement');
const limitObjects = new WeakMap();
function flags(options) { return 1 | (options.deterministic ? 0x800 : 0) | (options.directOnly ? 0x80000 : 0); }
function limitValue(value, name) { return value === Infinity ? 0x7fffffff : integer(value, name); }
class DatabaseSync {
  constructor(filename, options = {}) {
    filename = path(filename);
    object(options);
    const config = statementOptions(options);
    for (const [key, fallback] of Object.entries({ open: true, readOnly: false, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false, defensive: true })) config[key] = options[key] === undefined ? fallback : boolean(options[key], `options.${key}`);
    config.timeout = options.timeout === undefined ? 0 : integer(options.timeout, 'options.timeout');
    config.limits = {};
    if (options.limits !== undefined) {
      object(options.limits, 'options.limits');
      for (const key of limits) if (options.limits[key] !== undefined) config.limits[key] = limitValue(options.limits[key], `options.limits.${key}`);
    }
    databases.set(this, { id: 0, path: filename, options: config, generation: 0, statementGeneration: 0, executing: 0, callbacks: 0, authorizing: false, extensions: false, functionRoots: new Map(), authorizerRoot: undefined });
    if (config.open) this.open();
  }
  open() {
    const db = database(this, false);
    if (db.id) throw stateError('database is already open');
    const o = db.options;
    const id = native('open', [db.path, o.readOnly ? 1 : 6]);
    try {
      native('config', [id, 1002, +o.enableForeignKeyConstraints]);
      native('config', [id, 1013, +o.enableDoubleQuotedStringLiterals]);
      native('config', [id, 1014, +o.enableDoubleQuotedStringLiterals]);
      native('config', [id, 1010, +o.defensive]);
      native('enableExtension', [id, +o.allowExtension]);
      native('timeout', [id, o.timeout]);
      for (let i = 0; i < limits.length; i++) if (o.limits[limits[i]] !== undefined) native('limit', [id, i, o.limits[limits[i]]]);
    } catch (e) { native('close', [id]); throw e; }
    db.id = id; db.generation++; db.extensions = o.allowExtension;
    finalizers.register(this, { id }, this);
  }
  close() {
    const db = database(this);
    if (db.callbacks || db.executing) throw stateError('database cannot be closed while in a callback');
    native('close', [db.id]);
    db.id = 0;
    db.generation++;
    db.functionRoots.clear();
    db.authorizerRoot = undefined;
    finalizers.unregister(this);
  }
  [Symbol.dispose]() { const db = database(this, false); if (db.id) { try { this.close(); } catch {} } }
  get isOpen() { return !!database(this, false).id; }
  get isTransaction() { return native('transaction', [database(this).id]); }
  get limits() {
    database(this, false);
    let result = limitObjects.get(this);
    if (!result) {
      result = Object.create(null);
      for (let i = 0; i < limits.length; i++) Object.defineProperty(result, limits[i], {
        enumerable: true,
        get: () => native('limit', [database(this).id, i, -1]),
        set: value => { native('limit', [database(this).id, i, limitValue(value, limits[i])]); },
      });
      limitObjects.set(this, result);
    }
    return result;
  }
  location(name = 'main') { return native('location', [database(this).id, string(name, 'dbName')]); }
  exec(sql) {
    const db = database(this); string(sql, 'sql'); db.executing++;
    try { native('exec', [db.id, sql]); } finally { db.executing--; }
  }
  prepare(sql, options = {}) {
    const db = database(this); string(sql, 'sql'); const config = statementOptions(options, db.options);
    const id = native('prepare', [db.id, sql]);
    try { return new StatementSync(token, this, id, config); } catch (e) { native('release', [id]); throw e; }
  }
  function(name, options, fn) {
    const db = database(this); string(name, 'name');
    if (arguments.length < 3) { fn = options; options = {}; }
    const opts = callbackOptions(options); callable(fn, 'function');
    const count = opts.varargs ? -1 : integer(fn.length, 'function.length');
    const wrapper = (_mode, _token, args) => inCallback(db, () => {
      for (let i = 0; i < args.length; i++) args[i] = readValue(args[i], opts.useBigIntArguments);
      return resultValue(Reflect.apply(fn, undefined, args));
    });
    native('function', [db.id, name, count, flags(opts), 0, new WeakRef(wrapper), +opts.useBigIntArguments]);
    db.functionRoots.set(`${name.replace(/[A-Z]/g, c => c.toLowerCase())}\0${count}`, wrapper);
  }
  aggregate(name, options) {
    const db = database(this); string(name, 'name'); const opts = callbackOptions(options);
    const start = options.start; const step = callable(options.step, 'options.step');
    if (start === undefined) throw invalid('options.start', 'function or a primitive value');
    const result = typeof options.result === 'function' ? options.result : undefined;
    const inverse = options.inverse === undefined ? undefined : callable(options.inverse, 'options.inverse');
    const count = opts.varargs ? -1 : Math.max(step.length - 1, inverse ? inverse.length - 1 : 0, 0);
    integer(count, 'options.step.length', -1);
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
    native('function', [db.id, name, count, flags(opts), inverse ? 2 : 1, new WeakRef(wrapper), +opts.useBigIntArguments]);
    db.functionRoots.set(`${name.replace(/[A-Z]/g, c => c.toLowerCase())}\0${count}`, wrapper);
  }
  createSession(options = {}) {
    const db = database(this); object(options);
    const name = options.db === undefined ? 'main' : string(options.db, 'options.db');
    const table = options.table === undefined ? undefined : string(options.table, 'options.table');
    return new Session(token, this, native('session', [db.id, name, table]));
  }
  applyChangeset(changeset, options = {}) {
    const db = database(this);
    if (!(changeset instanceof Uint8Array)) throw invalid('changeset', 'Uint8Array');
    object(options);
    const conflict = options.onConflict === undefined ? undefined : callable(options.onConflict, 'options.onConflict');
    const filter = Object.prototype.hasOwnProperty.call(options, 'filter') ? callable(options.filter, 'options.filter') : undefined;
    const wrapper = (mode, _key, args) => inCallback(db, () => {
      if (mode === 5) return filter ? !!Reflect.apply(filter, null, args) : true;
      if (!conflict) return 2;
      const result = Reflect.apply(conflict, null, args);
      return typeof result === 'number' && Number.isInteger(result) && result >= -0x80000000 && result <= 0x7fffffff ? result : -1;
    });
    return native('apply', [db.id, ...binary(changeset), wrapper]);
  }
  enableLoadExtension(allow) {
    const db = database(this); boolean(allow, 'allow');
    if (allow && !db.options.allowExtension) throw error('ERR_INVALID_STATE', 'Cannot enable extension loading because it was disabled at database creation.');
    native('enableExtension', [db.id, +allow]); db.extensions = allow;
  }
  enableDefensive(active) { native('config', [database(this).id, 1010, +boolean(active, 'active')]); }
  loadExtension(filename, entryPoint = '') {
    const db = database(this);
    if (!db.extensions) throw stateError('extension loading is not allowed');
    const message = native('loadExtension', [db.id, string(filename, 'path'), string(entryPoint, 'entryPoint')]);
    if (message !== undefined) throw error('ERR_LOAD_SQLITE_EXTENSION', message);
  }
  setAuthorizer(callback) {
    const db = database(this);
    if (callback === null) { native('authorizer', [db.id]); db.authorizerRoot = undefined; return; }
    callable(callback, 'callback');
    const wrapper = (_mode, _key, args) => inCallback(db, () => {
      db.authorizing = true;
      try { const result = Reflect.apply(callback, undefined, args); return typeof result === 'number' && Number.isInteger(result) && result >= 0 && result <= 2 ? result : -1; } finally { db.authorizing = false; }
    });
    native('authorizer', [db.id, new WeakRef(wrapper)]);
    db.authorizerRoot = wrapper;
  }
  serialize(name = 'main') { return new Uint8Array(native('serialize', [database(this).id, string(name, 'dbName')])); }
  deserialize(buffer, options = {}) {
    const db = database(this);
    if (db.callbacks || db.executing) throw stateError('database cannot be deserialized while in a callback');
    if (!(buffer instanceof Uint8Array)) throw invalid('buffer', 'Uint8Array');
    if (!buffer.byteLength) throw error('ERR_INVALID_ARG_VALUE', 'The "buffer" argument must not be empty.', TypeError);
    object(options); const name = options.dbName === undefined ? 'main' : string(options.dbName, 'options.dbName');
    db.statementGeneration++;
    native('deserialize', [db.id, name, ...binary(buffer)]);
  }
  createTagStore(maxSize = 1000) { database(this); integer(maxSize, 'maxSize', 1); return new SQLTagStore(token, this, maxSize); }
}
class Session {
  constructor(secret, db, id) { if (secret !== token) throw error('ERR_ILLEGAL_CONSTRUCTOR', 'Illegal constructor', TypeError); sessions.set(this, { db, id, generation: database(db).generation }); finalizers.register(this, { id }, this); }
  changeset() { return new Uint8Array(native('changeset', [session(this).id])); }
  patchset() { return new Uint8Array(native('patchset', [session(this).id])); }
  close() { const s = session(this); native('close', [s.id]); s.id = 0; finalizers.unregister(this); }
  [Symbol.dispose]() { const s = sessions.get(this); if (!s) throw error('ERR_INVALID_THIS', 'Invalid Session', TypeError); const db = databases.get(s.db); if (s.id && db.id && db.generation === s.generation) { try { this.close(); } catch {} } }
}
const tagStores = new WeakMap();
function tagStore(value) { const s = tagStores.get(value); if (!s) throw error('ERR_INVALID_THIS', 'Invalid SQLTagStore', TypeError); return s; }
function tagStatement(store, strings, args) {
  const s = tagStore(store); const db = database(s.db);
  if (!Array.isArray(strings) || strings.length !== args.length + 1 || strings.some(part => typeof part !== 'string')) throw invalid('stringElements', 'Array of strings');
  if (args.length && args[0] !== null && typeof args[0] === 'object' && !isBinary(args[0])) throw error('ERR_INVALID_ARG_TYPE', 'Provided value cannot be bound to SQLite parameter 1.', TypeError);
  const sql = strings.join('?');
  if (s.generation !== db.generation || s.statementGeneration !== db.statementGeneration) { s.cache.clear(); s.generation = db.generation; s.statementGeneration = db.statementGeneration; }
  let stmt = s.cache.get(sql);
  if (stmt) s.cache.delete(sql);
  else stmt = s.db.prepare(sql);
  if (native('parameters', [require('internal/sqlite/shared').statements.get(stmt).id]).length !== args.length) { stmt.close(); throw error('ERR_INVALID_ARG_VALUE', 'SQLite parameters must be bound using template literal placeholders.', TypeError); }
  s.cache.set(sql, stmt);
  if (s.cache.size > s.capacity) s.cache.delete(s.cache.keys().next().value);
  return stmt;
}
class SQLTagStore {
  constructor(secret, db, capacity) { if (secret !== token) throw error('ERR_ILLEGAL_CONSTRUCTOR', 'Illegal constructor', TypeError); const s = database(db); tagStores.set(this, { db, capacity, cache: new Map(), generation: s.generation, statementGeneration: s.statementGeneration }); }
  all(strings, ...args) { return tagStatement(this, strings, args).all(...args); }
  get(strings, ...args) { return tagStatement(this, strings, args).get(...args); }
  run(strings, ...args) { return tagStatement(this, strings, args).run(...args); }
  iterate(strings, ...args) { return tagStatement(this, strings, args).iterate(...args); }
  get size() { return tagStore(this).cache.size; }
  get capacity() { return tagStore(this).capacity; }
  get db() { return tagStore(this).db; }
  clear() { tagStore(this).cache.clear(); }
}
function backup(sourceDb, filename, options = {}) {
  const db = database(sourceDb); filename = path(filename); object(options);
  const source = options.source === undefined ? 'main' : string(options.source, 'options.source');
  const target = options.target === undefined ? 'main' : string(options.target, 'options.target');
  const rate = options.rate === undefined ? 100 : integer(options.rate, 'options.rate', 1);
  const progress = options.progress === undefined ? undefined : callable(options.progress, 'options.progress');
  return new Promise((resolve, reject) => {
    let id;
    try { id = native('backup', [db.id, filename, source, target]); } catch (e) { reject(e); return; }
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
module.exports = { DatabaseSync, Session, backup };
