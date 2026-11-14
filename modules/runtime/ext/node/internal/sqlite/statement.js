'use strict';
const { native, databases, statements, token, finalizers, release, statement, runnable, notInAuthorizer, notStepping, finalized, stateError, error, argValue, invalid, isObject, bindValue, isBinary, readValue } = require('internal/sqlite/shared');
// s.stepped: the statement may be mid-result, so the next bind resets it first.
function reset(s, checked = true) { s.stepped = false; if (checked) return native('reset', [s.id]); try { native('reset', [s.id]); } catch {} }
function bind(s, args) {
  s.resetGeneration++;
  if (s.stepped) reset(s);
  const names = s.parameters;
  // sqlite3_clear_bindings has nothing to clear on a statement without parameters.
  if (names.length) native('clear', [s.id]);
  let first = 0;
  if (args.length && isObject(args[0]) && !isBinary(args[0])) {
    const named = args[0];
    let bare;
    if (s.options.allowBareNamedParameters) {
      bare = new Map();
      for (let i = 0; i < names.length; i++) {
        const name = names[i];
        if (name === null) continue;
        const short = name.slice(1);
        if (bare.has(short) && names[bare.get(short) - 1] !== name) throw stateError(`Cannot create bare named parameter '${short}' because of conflicting names '${names[bare.get(short) - 1]}' and '${name}'.`);
        bare.set(short, i + 1);
      }
    }
    for (const key of Object.getOwnPropertyNames(named)) {
      let index = names.indexOf(key) + 1;
      if (!index && bare) index = bare.get(key) || 0;
      if (!index) { if (s.options.allowUnknownNamedParameters) continue; throw stateError(`Unknown named parameter '${key}'`); }
      bindValue(s.id, index, named[key]);
    }
    first = 1;
  }
  let index = 1;
  for (let i = first; i < args.length; i++) {
    while (index <= names.length && names[index - 1] !== null && !names[index - 1].startsWith('?')) index++;
    bindValue(s.id, index++, args[i]);
  }
}
// Steps up to max rows (0 for all) natively. Rows are built in native code with a
// shared shape per call; fix flags values that still need JS finishing: blobs
// arrive as ArrayBuffers, and an out-of-range integer stops the call as a BigInt.
function fetch(s, max) {
  const fix = [0];
  const big = s.options.readBigInts, arrays = s.options.returnArrays;
  s.stepped = true;
  const rows = native('rows', [s.id, +big, +arrays, max, fix, s.template]);
  // A full read leaves the statement reset.
  if (max === 0) s.stepped = false;
  // A private row that carries the result shape into the next read of this statement.
  if (fix.length > 1) { s.template = fix[1]; fix.length = 1; }
  if (fix[0]) {
    for (const row of rows) {
      if (arrays) { for (let i = 0; i < row.length; i++) row[i] = readValue(row[i], big); }
      else { for (const key of Object.keys(row)) row[key] = readValue(row[key], big); }
    }
  }
  return rows;
}
function execution(s, fn) {
  const db = databases.get(s.db);
  s.busy = true;
  db.executing++;
  try { return fn(); } finally { s.busy = false; db.executing--; }
}
function execute(self, args, mode) {
  const s = runnable(self);
  bind(s, args);
  return run(s, mode);
}
function run(s, mode) {
  return execution(s, () => {
    let resetDone = false;
    try {
      if (mode === 'iterate') { resetDone = true; return new StatementSyncIterator(token, s.self.deref()); }
      // A full read resets the statement natively once it is done.
      if (mode === 'all') { const rows = fetch(s, 0); resetDone = true; return rows; }
      if (mode === 'get') { const rows = fetch(s, 1); return rows.length ? rows[0] : undefined; }
      s.stepped = true;
      const code = native('step', [s.id]);
      reset(s);
      resetDone = true;
      const [changes, lastInsertRowid] = native('changes', [databases.get(s.db).id, +s.options.readBigInts]);
      return { changes, lastInsertRowid };
    } finally { if (!resetDone) reset(s, false); }
  });
}
const iteratorStates = new WeakMap();
const iteratorPrototype = typeof Iterator === 'function' ? Iterator.prototype : Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
function doneResult() { return { __proto__: null, done: true, value: null }; }
class StatementSyncIterator {
  constructor(secret, stmt) { if (secret !== token) throw error('ERR_ILLEGAL_CONSTRUCTOR', 'Illegal constructor', TypeError); const s = statements.get(stmt); iteratorStates.set(this, { stmt, generation: s.resetGeneration, done: false }); }
  next() {
    const iterator = iteratorStates.get(this);
    if (!iterator) throw error('ERR_INVALID_THIS', 'Invalid SQLite iterator', TypeError);
    const s = statement(iterator.stmt);
    // A drained iterator touches no SQLite state, so it stays usable from a callback.
    if (iterator.done) return doneResult();
    notInAuthorizer(databases.get(s.db));
    notStepping(s);
    if (s.resetGeneration !== iterator.generation) throw stateError('iterator was invalidated');
    return execution(s, () => {
      const rows = fetch(s, 1);
      if (rows.length) return { __proto__: null, done: false, value: rows[0] };
      reset(s, false); iterator.done = true;
      return doneResult();
    });
  }
  return() {
    const iterator = iteratorStates.get(this);
    if (!iterator) throw error('ERR_INVALID_THIS', 'Invalid SQLite iterator', TypeError);
    const s = statement(iterator.stmt);
    if (!iterator.done) {
      notInAuthorizer(databases.get(s.db));
      notStepping(s);
      execution(s, () => reset(s, false));
    }
    iterator.done = true;
    return doneResult();
  }
}
Object.setPrototypeOf(StatementSyncIterator.prototype, iteratorPrototype);
function closeStatement(self, s) { release(s.id); s.id = 0; finalizers.unregister(self); }
class StatementSync {
  constructor(secret, db, id, options) {
    if (secret !== token) throw error('ERR_ILLEGAL_CONSTRUCTOR', 'Illegal constructor', TypeError);
    const owner = databases.get(db);
    const s = { db, id, self: new WeakRef(this), generation: owner.generation, statementGeneration: owner.statementGeneration, options, resetGeneration: 0, busy: false, stepped: false, parameters: native('parameters', [id]), template: undefined };
    statements.set(this, s);
    finalizers.register(this, { id }, this);
  }
  all(...args) { return execute(this, args, 'all'); }
  iterate(...args) { return execute(this, args, 'iterate'); }
  get(...args) { return execute(this, args, 'get'); }
  run(...args) { return execute(this, args, 'run'); }
  columns() {
    return native('columns', [statement(this).id]).map(([name, column, table, database, type]) => ({ __proto__: null, column, database, name, table, type }));
  }
  get sourceSQL() { return native('source', [statement(this).id]); }
  get expandedSQL() {
    const expanded = native('expanded', [statement(this).id]);
    if (expanded === null) throw Object.assign(new Error('Expanded SQL text would exceed configured limits'), { code: 'ERR_SQLITE_ERROR' });
    return expanded;
  }
  setAllowBareNamedParameters(enabled) { const s = statement(this); if (typeof enabled !== 'boolean') throw invalid('allowBareNamedParameters', 'a boolean'); s.options.allowBareNamedParameters = enabled; }
  setAllowUnknownNamedParameters(enabled) { const s = statement(this); if (typeof enabled !== 'boolean') throw invalid('enabled', 'a boolean'); s.options.allowUnknownNamedParameters = enabled; }
  setReadBigInts(readBigInts) { const s = statement(this); if (typeof readBigInts !== 'boolean') throw invalid('readBigInts', 'a boolean'); s.options.readBigInts = readBigInts; }
  setReturnArrays(returnArrays) { const s = statement(this); if (typeof returnArrays !== 'boolean') throw invalid('returnArrays', 'a boolean'); s.options.returnArrays = returnArrays; }
  close() { const s = statement(this); notStepping(s); closeStatement(this, s); }
  // Disposal is idempotent: a finalized statement is a no-op even inside a callback.
  [Symbol.dispose]() {
    const s = statements.get(this);
    if (!s) throw error('ERR_INVALID_THIS', 'Invalid StatementSync', TypeError);
    if (finalized(s)) return;
    notStepping(s);
    closeStatement(this, s);
  }
}
function prepared(db, id, options) {
  try { return new StatementSync(token, db, id, { ...options }); } catch (e) { release(id); throw e; }
}
// SQLTagStore::ResetAndBindStatement: every argument binds by position, objects included.
function tagExecute(stmt, values, mode) {
  const s = statements.get(stmt);
  notStepping(s);
  s.resetGeneration++;
  if (s.stepped) reset(s);
  native('clear', [s.id]);
  if (s.parameters.length !== values.length) throw argValue('SQLite parameters must be bound using template literal placeholders.');
  for (let i = 0; i < values.length; i++) bindValue(s.id, i + 1, values[i]);
  return run(s, mode);
}
module.exports = { StatementSync, prepared, tagExecute };
