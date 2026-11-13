// Object.keys/values/entries, for-in, JSON.stringify and Object.assign read
// ordinary objects straight from their shapes (js_shapes.enumKeys): each case
// here must match the generic paths (expected text is node's output).
const out = [];
const log = (...a) => out.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '));
const sym = Symbol('s');
const o = { b: 1, a: 2, [sym]: 3, 10: 'ten', 2: 'two', z: undefined };
Object.defineProperty(o, 'hidden', { value: 1, enumerable: false });
Object.defineProperty(o, 'g', { get() { return 'got'; }, enumerable: true });
log(Object.keys(o), Object.values(o), Object.entries(o));
const p = { x: 1, y: 2, w: 3 }; delete p.y;
log(Object.keys(p), Object.values(p), Object.entries(p));
class A { constructor() { this.q = 1; this.r = [1, 2]; } get v() { return 5; } }
const a = new A();
log(Object.keys(a), Object.entries(a));
const d = Object.create(null); d['content-type'] = 'x'; d.etag = 'y';
log(Object.keys(d), Object.values(d));
log(Object.keys({}), Object.values({}), Object.entries({}), Object.keys('ab'), Object.keys([5, 6]), Object.entries([7]));
// for-in
function fi(obj) { const ks = []; for (const k in obj) ks.push(k); return ks; }
log(fi(o), fi(p), fi(a), fi(d), fi([1, 2]), fi('xy'));
const base = { inherited: 1 }; const child = Object.create(base); child.own = 2;
log(fi(child));
Object.prototype.polluted = 1; log(fi({ k: 1 })); delete Object.prototype.polluted; log(fi({ k: 1 }));
const del = { a: 1, b: 2, c: 3 }; const seen = []; for (const k in del) { seen.push(k); delete del.b; } log(seen);
const add = { a: 1 }; const seen2 = []; for (const k in add) { seen2.push(k); add['n' + seen2.length] = 1; } log(seen2);
const shadow = Object.create({ s: 1, t: 2 }); Object.defineProperty(shadow, 's', { value: 0, enumerable: false }); log(fi(shadow));
const nested = []; for (const k in p) for (const j in p) nested.push(k + j); log(nested);
let brk = 0; for (const k in o10()) { brk++; if (brk == 2) break; } log(brk);
function o10() { return { a: 1, b: 2, c: 3 }; }
// JSON
log(JSON.stringify({ a: 1, b: 'x"y\n', c: true, d: null, e: 2.5, f: undefined, g: () => 1, h: sym, i: [1, undefined, () => 1, sym, NaN, -0, 1e21, -1.5], j: { k: {} } }));
log(JSON.stringify(o), JSON.stringify(a), JSON.stringify(d), JSON.stringify(p));
log(JSON.stringify({ when: new Date(0) }), JSON.stringify({ m: new Map([[1, 2]]), s: new Set([1]) }));
log(JSON.stringify({ n: new Number(3), s: new String('s'), b: new Boolean(false) }));
log(JSON.stringify({ t: { toJSON() { return 'T'; } } }));
const tj = Object.create({ toJSON() { return 'P'; } }); tj.x = 1; log(JSON.stringify({ tj }));
Object.prototype.toJSON = function () { return 'OP'; }; log(JSON.stringify({ a: 1 })); delete Object.prototype.toJSON;
Array.prototype.toJSON = function () { return 'AP'; }; log(JSON.stringify({ a: [1] })); delete Array.prototype.toJSON;
const cyc = { a: {} }; cyc.a.b = cyc; try { JSON.stringify(cyc); } catch (e) { log(e.constructor.name); }
let deep = {}; let cur = deep; for (let i = 0; i < 40; i++) { cur.n = {}; cur = cur.n; } log(JSON.stringify(deep).length);
const sparse = [1, , 3]; log(JSON.stringify(sparse)); const ex = [1, 2]; ex.extra = 1; log(JSON.stringify(ex));
const big = new Array(3); log(JSON.stringify(big));
log(JSON.stringify('\ud800x é'), JSON.stringify({ '\ud800': 1, 'é"': 2 }));
log(JSON.stringify(undefined) === undefined, JSON.stringify(sym) === undefined, JSON.stringify(() => 1) === undefined);
log(JSON.stringify(1n === 1n), JSON.stringify({ 1: 'a', b: 2 }), JSON.stringify([[[]]]), JSON.stringify({ a: [] }));
try { JSON.stringify({ x: 1n }); } catch (e) { log(e.constructor.name); }
log(JSON.stringify(new Proxy({ a: 1 }, {})), JSON.stringify([new Proxy([1], {})]));
log(JSON.stringify({ a: 1 }, null, 2), JSON.stringify({ a: 1, b: 2 }, ['b']), JSON.stringify({ a: 1 }, (k, v) => v));
const getter = { get x() { return 9; } }; log(JSON.stringify(getter));
log(JSON.stringify(Object.assign(Object.create(null), { z: 1 })));
log(JSON.stringify({ a: 'x'.repeat(3) + 'y' }), JSON.stringify(['a' + String(Math.random()).slice(0, 0)]));
// Iterators are reused between loops: a loop left by break, a nested loop and
// a loop inside a generator must each keep their own state.
const gen = function* () { for (const k in { g1: 1, g2: 2 }) yield k; };
const it = gen(); log(it.next().value); log(fi({ m: 1, n: 2 })); log(it.next().value, it.next().done);
for (const k in { b1: 1, b2: 2 }) { break; } log(fi({ after: 1 }));
try { for (const k in { t1: 1 }) throw new Error('x'); } catch (e) { log(fi({ caught: 1 })); }
// Object.assign: setters, read-only and own targets keep [[Set]] semantics.
const seen3 = []; const withSetter = Object.create({ set s(v) { seen3.push(v); } });
Object.assign(withSetter, { s: 1, t: 2 }); log(seen3, Object.keys(withSetter));
const ro = Object.create(Object.freeze({ r: 1 })); try { 'use strict'; Object.assign(ro, { r: 2 }); log('no throw', ro.r); } catch (e) { log(e.constructor.name); }
const own = { a: 1, b: 2 }; Object.assign(own, { b: 3, c: 4 }); log(own);
const fixed = {}; Object.defineProperty(fixed, 'f', { value: 1, writable: false, enumerable: true }); try { Object.assign(fixed, { f: 2 }); } catch (e) { log(e.constructor.name, fixed.f); }
const proto = { p: 1 }; const inst = Object.create(proto); Object.assign(proto, { p: 2, q: 3 }); log(inst.p, inst.q);
log(Object.assign({}, { __proto__: null, x: 1 }), Object.getPrototypeOf(Object.assign({}, JSON.parse('{"__proto__": {"z": 1}}'))).z);
// The enumeration cache follows shape changes.
const grow = { a: 1 }; log(Object.keys(grow)); grow.b = 2; log(Object.keys(grow)); delete grow.a; log(Object.keys(grow), JSON.stringify(grow));
Object.defineProperty(grow, 'b', { enumerable: false }); log(Object.keys(grow), JSON.stringify(grow), fi(grow));
const wide = { 'ключ': 'значение', k: 'v€' }; log(JSON.stringify(wide), JSON.stringify(['日本', 1]));
log(JSON.stringify({ s: 'x'.repeat(600), t: 'tab\there' }).length, JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ i }))).length);
const out2 = out.join('\n');

const expected = "[\"2\",\"10\",\"b\",\"a\",\"z\",\"g\"] [\"two\",\"ten\",1,2,null,\"got\"] [[\"2\",\"two\"],[\"10\",\"ten\"],[\"b\",1],[\"a\",2],[\"z\",null],[\"g\",\"got\"]]\n[\"x\",\"w\"] [1,3] [[\"x\",1],[\"w\",3]]\n[\"q\",\"r\"] [[\"q\",1],[\"r\",[1,2]]]\n[\"content-type\",\"etag\"] [\"x\",\"y\"]\n[] [] [] [\"0\",\"1\"] [\"0\",\"1\"] [[\"0\",7]]\n[\"2\",\"10\",\"b\",\"a\",\"z\",\"g\"] [\"x\",\"w\"] [\"q\",\"r\"] [\"content-type\",\"etag\"] [\"0\",\"1\"] [\"0\",\"1\"]\n[\"own\",\"inherited\"]\n[\"k\",\"polluted\"]\n[\"k\"]\n[\"a\",\"c\"]\n[\"a\"]\n[\"t\"]\n[\"xx\",\"xw\",\"wx\",\"ww\"]\n2\n{\"a\":1,\"b\":\"x\\\"y\\n\",\"c\":true,\"d\":null,\"e\":2.5,\"i\":[1,null,null,null,null,0,1e+21,-1.5],\"j\":{\"k\":{}}}\n{\"2\":\"two\",\"10\":\"ten\",\"b\":1,\"a\":2,\"g\":\"got\"} {\"q\":1,\"r\":[1,2]} {\"content-type\":\"x\",\"etag\":\"y\"} {\"x\":1,\"w\":3}\n{\"when\":\"1970-01-01T00:00:00.000Z\"} {\"m\":{},\"s\":{}}\n{\"n\":3,\"s\":\"s\",\"b\":false}\n{\"t\":\"T\"}\n{\"tj\":\"P\"}\n\"OP\"\n{\"a\":\"AP\"}\nTypeError\n242\n[1,null,3]\n[1,2]\n[null,null,null]\n\"\\ud800x\u2028\u00e9\" {\"\\ud800\":1,\"\u00e9\\\"\":2}\ntrue true true\ntrue {\"1\":\"a\",\"b\":2} [[[]]] {\"a\":[]}\nTypeError\n{\"a\":1} [[1]]\n{\n  \"a\": 1\n} {\"b\":2} {\"a\":1}\n{\"x\":9}\n{\"z\":1}\n{\"a\":\"xxxy\"} [\"a\"]\ng1\n[\"m\",\"n\"]\ng2 true\n[\"after\"]\n[\"caught\"]\n[1] [\"t\"]\nTypeError\n{\"a\":1,\"b\":3,\"c\":4}\nTypeError 1\n2 3\n{\"x\":1} 1\n[\"a\"]\n[\"a\",\"b\"]\n[\"b\"] {\"b\":2}\n[] {} []\n{\"\u043a\u043b\u044e\u0447\":\"\u0437\u043d\u0430\u0447\u0435\u043d\u0438\u0435\",\"k\":\"v\u20ac\"} [\"\u65e5\u672c\",1]\n624 1891";
if (out2 !== expected) {
  const a = out2.split('\n'), b = expected.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) console.log('line ' + i + ': got ' + a[i] + ' want ' + b[i]);
  throw new Error('object enumeration fast paths');
}
console.log('PASS object enumeration fast paths');
