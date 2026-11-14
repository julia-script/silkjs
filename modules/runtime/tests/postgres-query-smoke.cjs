'use strict';
// Run unchanged under Node and Silk; diff stdout. A stand-in postgres.js
// query.js (the constructor lines the loader patches, copied from postgres
// 3.4) is loaded under node_modules/postgres and, unpatched, under another
// path. Once a query settles, Silk swaps its resolve/reject arrows for a plain
// function so a finished query no longer forms a cycle with its promise
// executor; both copies must behave the same from the outside.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const source = `'use strict'
class Query extends Promise {
  constructor(strings, args) {
    let resolve
      , reject

    super((a, b) => {
      resolve = a
      reject = b
    })

    this.strings = strings
    this.args = args
    this.active = false
    this.resolve = x => (this.active = false, resolve(x))
    this.reject = x => (this.active = false, reject(x))
  }

  static get [Symbol.species]() {
    return Promise
  }

  cursor() {
    let resolve
    const promise = new Promise(r => { resolve = r })
    this.resolve = () => (this.active = false, resolve({ done: true }))
    this.reject = x => (this.active = false, resolve({ error: x }))
    return promise
  }
}
module.exports = { Query }
`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-query-'));
const patchedFile = path.join(root, 'node_modules', 'postgres', 'cjs', 'src', 'query.js');
const plainFile = path.join(root, 'lib', 'query.js');
for (const file of [patchedFile, plainFile]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
}
const patched = require(patchedFile).Query;
const plain = require(plainFile).Query;

async function settle(promise) {
  try { return ['fulfilled', await promise]; }
  catch (error) { return ['rejected', error.message]; }
}

async function run(Query) {
  const out = [];
  const a = new Query(['select 1'], []);
  a.active = true;
  a.resolve([1, 2]);
  out.push(a.active);
  a.active = true;
  a.resolve([3]);
  a.reject(new Error('late'));
  out.push(a.active, await settle(a));

  const b = new Query(['select 2'], []);
  b.active = true;
  b.reject(new Error('boom'));
  out.push(b.active);
  b.active = true;
  b.resolve('late');
  out.push(b.active, await settle(b));

  const c = new Query(['cursor'], []);
  const step = c.cursor();
  c.active = true;
  c.reject('stop');
  out.push(c.active, await step);

  const d = new Query(['then'], []);
  const chained = d.then(rows => rows.length);
  d.resolve(['x', 'y']);
  out.push(await chained, Object.getPrototypeOf(chained) === Promise.prototype);
  return out;
}

(async () => {
  const fast = await run(patched);
  const slow = await run(plain);
  assert.deepStrictEqual(fast, slow);
  fs.rmSync(root, { recursive: true, force: true });
  console.log(JSON.stringify(fast));
  console.log('postgres query smoke ok');
})();
