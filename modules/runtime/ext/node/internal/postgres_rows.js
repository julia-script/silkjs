'use strict';

// DataRow decoding for an installed postgres.js (porsager/postgres): the
// loader patches its connection.js so data() hands each run of DataRow
// messages to rows(), which builds them natively (host pgRows) as postgres.js
// would. Anything it does not cover (raw or forEach queries, transforms,
// custom or non-integer parsers, unusual column names) returns 0 and the
// package's own DataRow runs.
const { pgRows } = require('internal/host');

// Columns arrays (one per RowDescription) to their row template or null.
const templates = new WeakMap();
const TEXT = 0, INTEGER = 1, BOOLEAN = 2;
const integerTypes = [21, 23, 26];
const MAX_COLUMNS = 16;

function kindOf(column) {
  const parser = column.parser;
  if (parser === undefined) return TEXT;
  if (typeof parser !== 'function' || parser.array === true) return -1;
  const source = Function.prototype.toString.call(parser);
  if (source === 'x => +x' && integerTypes.includes(column.type)) return INTEGER;
  if (source === "x => x === 't'" && column.type === 16) return BOOLEAN;
  return -1;
}

function makeTemplate(columns) {
  if (columns.length === 0 || columns.length >= MAX_COLUMNS) return null;
  const template = {};
  for (let i = 0; i < columns.length; i++) {
    const column = columns[i];
    const name = column.name;
    const kind = kindOf(column);
    // Index-like names land in elements and __proto__ sets the prototype:
    // the package's own code keeps their behaviour.
    if (kind < 0 || typeof name !== 'string' || name === '__proto__' || name === '' || String(name >>> 0) === name) return null;
    if (Object.prototype.hasOwnProperty.call(template, name)) return null;
    template[name] = kind;
  }
  return template;
}

function rows(incoming, query, result, count, transform) {
  if (query.isRaw || query.forEachFn || transform.value.from || transform.row.from) return 0;
  const columns = query.statement && query.statement.columns;
  if (!columns) return 0;
  let template = templates.get(columns);
  if (template === undefined) {
    template = makeTemplate(columns);
    templates.set(columns, template);
  }
  return template === null ? 0 : pgRows(incoming, template, result, count);
}

module.exports = rows;
