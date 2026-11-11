// SilkJS regression test for the frameless Map.prototype.set / Set.prototype.add
// path: results, chaining, key normalization and receiver checks must match the
// full native call (and QuickJS). Weak collections keep the full path.
const out = [];
const m = new Map();
out.push(m.set("a", 1) === m, m.set("b") === m, m.set(-0, "zero").set(NaN, "nan").set("a", 3).size);
out.push(JSON.stringify([...m]), m.get(0), Object.is([...m.keys()][2], 0), m.get(NaN), m.has("b"), m.get("b"));
const s = new Set();
out.push(s.add(1) === s, s.add(1).add("1").add(-0).add().size, JSON.stringify([...s]), Object.is([...s][2], 0), s.has(undefined));
class M extends Map {} class S extends Set {}
const mm = new M(), ss = new S();
out.push(mm.set(1, 2) === mm, mm.get(1), ss.add(5) === ss, ss.has(5));
for (const [f, r] of [[Map.prototype.set, new Set()], [Set.prototype.add, new Map()], [Map.prototype.set, {}], [Set.prototype.add, 1], [WeakMap.prototype.set, new WeakMap()], [WeakSet.prototype.add, new WeakSet()]]) {
  try { f.call(r, 1, 2); out.push("ok"); } catch (e) { out.push(e.constructor.name); }
}
const k = {}, wm = new WeakMap(), ws = new WeakSet();
out.push(wm.set(k, 1) === wm, wm.get(k), ws.add(k) === ws, ws.has(k));
try { new Map.prototype.set(1, 2); } catch (e) { out.push(e.constructor.name); }
const big = new Map(); for (let i = 0; i < 1000; i++) big.set("k" + i, i);
let sum = 0; for (const v of big.values()) sum += v;
out.push(big.size, sum, big.get("k999"));
const got = JSON.stringify(out);
const expected = '[true,true,4,"[[\\"a\\",3],[\\"b\\",null],[0,\\"zero\\"],[null,\\"nan\\"]]","zero",true,"nan",true,null,true,4,"[1,\\"1\\",0,null]",true,true,true,2,true,true,"TypeError","TypeError","TypeError","TypeError","TypeError","TypeError",true,1,true,true,"TypeError",1000,499500,999]';
console.log(got === expected ? 'PASS native quick writes' : 'FAIL ' + got);
if (got !== expected) throw new Error('native quick write regressions');
