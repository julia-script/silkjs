// node:sqlite behaviour that exercises every native SQLite entry point the runtime binds:
// statements, values, user functions, the authorizer, sessions and changesets, backups,
// serialization, column metadata, limits and extension loading. Run it under Node and the
// runtime; the printed JSON must match.
import { DatabaseSync, backup, constants } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = {};
const record = (name, fn) => {
  try { out[name] = fn(); } catch (error) { out[name] = { error: error.code ?? error.name, errcode: error.errcode, errstr: error.errstr, message: error.message }; }
};
const dir = mkdtempSync(join(tmpdir(), 'silk-sqlite-'));
const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT NOT NULL, score REAL, data BLOB, big INTEGER);
         -- a comment between statements
         INSERT INTO t VALUES (1, 'a', 1.5, x'00ff', 9007199254740993);`);

record('values', () => {
  const insert = db.prepare('INSERT INTO t(id, name, score, data, big) VALUES (?, ?, ?, ?, ?)');
  const runs = [insert.run(2, 'b', null, new Uint8Array([1, 2, 3]), 5n), insert.run(3, 'héllo', 2, Buffer.from(''), -1)];
  const read = db.prepare('SELECT id, name, score, data, typeof(big) AS kind FROM t ORDER BY id');
  const rows = read.all().map(r => ({ ...r, data: r.data && Array.from(r.data) }));
  const big = db.prepare('SELECT big FROM t ORDER BY id');
  big.setReadBigInts(true);
  let unsafe;
  try { db.prepare('SELECT big FROM t WHERE id = 1').get(); } catch (error) { unsafe = error.code; }
  return { runs, rows, big: big.all().map(r => String(r.big)), unsafe };
});
record('named', () => {
  const s = db.prepare('SELECT :a + $b AS sum, @c AS c');
  return [s.get({ a: 1, b: 2, c: 'x' }), s.get({ ':a': 4, $b: 5, '@c': null })];
});
record('arrays', () => { const s = db.prepare('SELECT id, name FROM t WHERE id < ?'); s.setReturnArrays(true); return s.all(3); });
record('iterate', () => Array.from(db.prepare('SELECT id FROM t ORDER BY id').iterate(), r => r.id));
record('sql', () => { const s = db.prepare('SELECT * FROM t WHERE id = ? AND name = ?'); s.get(1, "o'k"); return [s.sourceSQL, s.expandedSQL]; });
record('columns', () => db.prepare('SELECT t.id AS ident, name, 1 + 1 AS two FROM t').columns());
record('constraint', () => db.prepare('INSERT INTO t(id, name) VALUES (1, ?)').run('dup'));
record('syntax', () => db.exec('SELEC 1'));
record('transaction', () => { db.exec('BEGIN'); const inside = db.isTransaction; db.exec('ROLLBACK'); return [inside, db.isTransaction]; });
record('functions', () => {
  db.function('twice', { deterministic: true }, x => x * 2);
  db.function('concat', { varargs: true }, (...xs) => xs.join('-'));
  db.function('bytes', () => new Uint8Array([7, 8]));
  db.function('fails', () => { throw new Error('from js'); });
  db.aggregate('total', { start: 0, step: (acc, v) => acc + v });
  db.aggregate('window_sum', { start: 0, step: (acc, v) => acc + v, inverse: (acc, v) => acc - v, result: acc => acc * 10 });
  const r = db.prepare("SELECT twice(21) AS t, concat(1, 'b', NULL) AS c, bytes() AS b, total(id) AS s FROM t").get();
  const w = db.prepare('SELECT id, window_sum(id) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS w FROM t').all();
  let thrown;
  try { db.prepare('SELECT fails()').get(); } catch (error) { thrown = error.message; }
  return { ...r, b: Array.from(r.b), w, thrown };
});
record('authorizer', () => {
  const seen = [];
  db.setAuthorizer((action, a, b, database) => { seen.push([action, a, b, database]); return action === constants.SQLITE_READ && a === 'secret' ? constants.SQLITE_DENY : constants.SQLITE_OK; });
  db.exec('CREATE TABLE secret(x)');
  let denied;
  try { db.prepare('SELECT * FROM secret').all(); } catch (error) { denied = error.errstr; }
  db.setAuthorizer(null);
  return { denied, sample: seen.slice(0, 3) };
});
record('sessions', () => {
  const a = new DatabaseSync(':memory:'), b = new DatabaseSync(':memory:');
  for (const d of [a, b]) d.exec('CREATE TABLE s(id INTEGER PRIMARY KEY, v TEXT)');
  b.exec("INSERT INTO s VALUES (1, 'old')");
  const session = a.createSession({ table: 's' });
  a.exec("INSERT INTO s VALUES (1, 'new'), (2, 'two')");
  const changeset = session.changeset(), patchset = session.patchset();
  const conflicts = [];
  const applied = b.applyChangeset(changeset, { filter: table => table === 's', onConflict: kind => { conflicts.push(kind); return constants.SQLITE_CHANGESET_REPLACE; } });
  const aborted = b.applyChangeset(changeset, { onConflict: () => constants.SQLITE_CHANGESET_ABORT });
  return { applied, aborted, conflicts, rows: b.prepare('SELECT * FROM s ORDER BY id').all(), changeset: changeset.length > 0, patchset: patchset.length > 0 };
});
record('serialize', () => {
  const bytes = db.serialize();
  const copy = new DatabaseSync(':memory:');
  copy.deserialize(bytes);
  return { header: Buffer.from(bytes.subarray(0, 15)).toString(), rows: copy.prepare('SELECT count(*) AS n FROM t').get().n };
});
record('limits', () => { const d = new DatabaseSync(':memory:', { limits: { length: 10 } }); let error; try { d.prepare("SELECT 'more than ten'").get(); } catch (e) { error = e.errstr; } return [d.limits.length, error]; });
record('extension', () => { const d = new DatabaseSync(':memory:', { allowExtension: true }); d.enableLoadExtension(true); try { d.loadExtension(join(dir, 'missing-extension')); return 'loaded'; } catch (error) { return error.code; } });
record('dqs', () => { const d = new DatabaseSync(':memory:', { enableDoubleQuotedStringLiterals: true }); return d.prepare('SELECT "text" AS x').get(); });
const file = join(dir, 'main.db');
const disk = new DatabaseSync(file);
disk.exec('CREATE TABLE f(x); INSERT INTO f VALUES (1), (2)');
out.location = disk.location() === file;
out.backup = await backup(disk, join(dir, 'copy.db'), { rate: 1 });
out.backedUp = new DatabaseSync(join(dir, 'copy.db')).prepare('SELECT sum(x) AS s FROM f').get();
disk.close();
rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify(out, (key, value) => typeof value === 'bigint' ? `${value}n` : value, 1));
