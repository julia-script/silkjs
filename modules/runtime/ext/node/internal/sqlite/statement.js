'use strict';
const { native, databases, statements, token, finalizers, statement, statementOptions, stateError, error, boolean, bindValue, isBinary, readValue } = require('internal/sqlite/shared');
function reset(s, checked = true) { if (checked) return native('reset', [s.id]); try { native('reset', [s.id]); } catch {} }
function bind(s, args) {
  s.resetGeneration++;
  reset(s);
  native('clear', [s.id]);
  const names = s.parameters;
  let first = 0;
  if (args.length && args[0] !== null && typeof args[0] === 'object' && !isBinary(args[0])) {
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
function row(s) {
  const values = native('row', [s.id, +s.options.readBigInts]);
  for (let i = 0; i < values.length; i++) values[i] = readValue(values[i], s.options.readBigInts);
  if (s.options.returnArrays) return values;
  // Reprepared statements can acquire a different result schema after a DDL.
  const names = native('names', [s.id]);
  const result = Object.create(null);
  for (let i = 0; i < names.length; i++) result[names[i]] = values[i];
  return result;
}
function execution(s, fn) {
  const db = databases.get(s.db);
  s.busy = true;
  db.executing++;
  try { return fn(); } finally { s.busy = false; db.executing--; }
}
function execute(self, args, mode) {
  const s = statement(self);
  bind(s, args);
  return execution(s, () => {
    let resetDone = false;
    try {
      if (mode === 'all') { const rows = []; while (native('step', [s.id]) === 100) rows.push(row(s)); return rows; }
      const code = native('step', [s.id]);
      if (mode === 'get') return code === 100 ? row(s) : undefined;
      reset(s);
      resetDone = true;
      const [changes, lastInsertRowid] = native('changes', [databases.get(s.db).id, +s.options.readBigInts]);
      return { changes, lastInsertRowid };
    } finally { if (!resetDone) reset(s, false); }
  });
}
const iteratorStates = new WeakMap();
const iteratorPrototype = typeof Iterator === 'function' ? Iterator.prototype : Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
class StatementSyncIterator {
  constructor(secret, stmt) { if (secret !== token) throw error('ERR_ILLEGAL_CONSTRUCTOR', 'Illegal constructor', TypeError); const s = statement(stmt); iteratorStates.set(this, { stmt, generation: s.resetGeneration, done: false }); }
  next() {
    const iterator = iteratorStates.get(this);
    if (!iterator) throw error('ERR_INVALID_THIS', 'Invalid SQLite iterator', TypeError);
    const s = statement(iterator.stmt, !iterator.done);
    if (iterator.done) return Object.assign(Object.create(null), { done: true, value: null });
    if (s.resetGeneration !== iterator.generation) throw stateError('iterator was invalidated');
    return execution(s, () => {
      const code = native('step', [s.id]);
      if (code === 100) return Object.assign(Object.create(null), { done: false, value: row(s) });
      reset(s, false); iterator.done = true;
      return Object.assign(Object.create(null), { done: true, value: null });
    });
  }
  return() {
    const iterator = iteratorStates.get(this);
    if (!iterator) throw error('ERR_INVALID_THIS', 'Invalid SQLite iterator', TypeError);
    const s = statement(iterator.stmt, !iterator.done);
    if (!iterator.done) execution(s, () => reset(s, false));
    iterator.done = true;
    return Object.assign(Object.create(null), { done: true, value: null });
  }
}
Object.setPrototypeOf(StatementSyncIterator.prototype, iteratorPrototype);
class StatementSync {
  constructor(secret, db, id, options) {
    if (secret !== token) throw error('ERR_ILLEGAL_CONSTRUCTOR', 'Illegal constructor', TypeError);
    const owner = databases.get(db);
    const s = { db, id, generation: owner.generation, statementGeneration: owner.statementGeneration, options: statementOptions(options, owner.options), resetGeneration: 0, busy: false, parameters: native('parameters', [id]) };
    statements.set(this, s);
    finalizers.register(this, { id }, this);
  }
  all(...args) { return execute(this, args, 'all'); }
  get(...args) { return execute(this, args, 'get'); }
  run(...args) { return execute(this, args, 'run'); }
  iterate(...args) { const s = statement(this); bind(s, args); return new StatementSyncIterator(token, this); }
  columns() { return native('columns', [statement(this).id]).map(([name, column, table, database, type]) => ({ column, database, name, table, type })); }
  get sourceSQL() { return native('source', [statement(this, false).id]); }
  get expandedSQL() { return native('expanded', [statement(this, false).id]); }
  setAllowBareNamedParameters(enabled) { statement(this, false).options.allowBareNamedParameters = boolean(enabled, 'enabled'); }
  setAllowUnknownNamedParameters(enabled) { statement(this, false).options.allowUnknownNamedParameters = boolean(enabled, 'enabled'); }
  setReadBigInts(enabled) { statement(this, false).options.readBigInts = boolean(enabled, 'enabled'); }
  setReturnArrays(enabled) { statement(this, false).options.returnArrays = boolean(enabled, 'enabled'); }
  close() { const s = statement(this); native('close', [s.id]); s.id = 0; finalizers.unregister(this); }
  [Symbol.dispose]() { const s = statements.get(this); if (!s) throw error('ERR_INVALID_THIS', 'Invalid StatementSync', TypeError); const db = databases.get(s.db); if (s.id && db.id && db.generation === s.generation && db.statementGeneration === s.statementGeneration) this.close(); }
}
module.exports = { StatementSync };
