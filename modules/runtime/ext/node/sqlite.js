'use strict';
const { DatabaseSync, Session, backup } = require('internal/sqlite/database');
const { StatementSync } = require('internal/sqlite/statement');
const constants = Object.create(null);
Object.assign(constants, {
  SQLITE_CHANGESET_OMIT: 0,
  SQLITE_CHANGESET_REPLACE: 1,
  SQLITE_CHANGESET_ABORT: 2,
  SQLITE_CHANGESET_DATA: 1,
  SQLITE_CHANGESET_NOTFOUND: 2,
  SQLITE_CHANGESET_CONFLICT: 3,
  SQLITE_CHANGESET_CONSTRAINT: 4,
  SQLITE_CHANGESET_FOREIGN_KEY: 5,
  SQLITE_OK: 0,
  SQLITE_DENY: 1,
  SQLITE_IGNORE: 2,
  SQLITE_COPY: 0,
});
const actions = [
  'CREATE_INDEX', 'CREATE_TABLE', 'CREATE_TEMP_INDEX', 'CREATE_TEMP_TABLE',
  'CREATE_TEMP_TRIGGER', 'CREATE_TEMP_VIEW', 'CREATE_TRIGGER', 'CREATE_VIEW',
  'DELETE', 'DROP_INDEX', 'DROP_TABLE', 'DROP_TEMP_INDEX', 'DROP_TEMP_TABLE',
  'DROP_TEMP_TRIGGER', 'DROP_TEMP_VIEW', 'DROP_TRIGGER', 'DROP_VIEW', 'INSERT',
  'PRAGMA', 'READ', 'SELECT', 'TRANSACTION', 'UPDATE', 'ATTACH', 'DETACH',
  'ALTER_TABLE', 'REINDEX', 'ANALYZE', 'CREATE_VTABLE', 'DROP_VTABLE', 'FUNCTION',
  'SAVEPOINT', 'RECURSIVE',
];
for (let i = 0; i < actions.length; i++) constants[`SQLITE_${actions[i]}`] = i + 1;
for (const key of Object.keys(constants)) Object.defineProperty(constants, key, { writable: false, configurable: false });
module.exports = { DatabaseSync, StatementSync, Session, constants, backup };
