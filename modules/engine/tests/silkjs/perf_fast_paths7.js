// SilkJS regression test for the seventh round of benchmark fast paths. Results must match QuickJS.
// Direct iterator opcodes, the shape transition memo across deletes, lean native calls, JS call entry.
function round7() {
  const r = [];
  // Destructuring and for-of through the direct iterator opcodes, with closes.
  const arr = [1, 2, 3, 4, 5, 6];
  for (let i = 0; i < 3; i++) { const [a, b, , c, ...rest] = arr; r.push(a, b, c, rest.join('|')); }
  let closed = 0;
  const it = { [Symbol.iterator]() { let n = 0; return { next() { n++; return { value: n, done: n > 5 }; }, return() { closed++; return {}; } }; } };
  for (const v of it) { if (v === 3) break; r.push(v); }
  const [x1, x2] = it; r.push(x1, x2, closed);
  try { for (const v of it) { if (v === 2) throw new Error('stop'); } } catch (e) { r.push(e.message, closed); }
  try { const [q] = { [Symbol.iterator]() { return { next() { return 5; } }; } }; } catch (e) { r.push(e.name); }
  for (const ch of 'hé\u{1F600}') r.push(ch.length);
  const mp = new Map([[1, 'a'], [2, 'b']]); for (const [k, v] of mp) r.push(k + v);
  // Spread then delete repeatedly: shapes stay right while the transition memo survives.
  const ref = { a: 1, b: 2, c: 3, d: 4 }; for (let k = 0; k < 4; k++) ref[k] = k;
  for (let j = 0; j < 4; j++) {
    const o = { ...ref }; delete o.a; delete o.c; delete o[1];
    o.e = j; r.push(Object.keys(o).join(','), o.b, o.e, 'a' in o, o[0], o[2]);
    const p = { ...ref, a: 10 + j }; delete p.d; r.push(JSON.stringify(p));
  }
  function P(v) { this.v = v; this.w = v * 2; } const ps = []; for (let i = 0; i < 6; i++) { const p = new P(i); if (i % 2) delete p.v; ps.push(p); }
  r.push(JSON.stringify(ps), Object.keys(new P(9)).join());
  r.push(delete ref.zz, delete ref.a, 'a' in ref, (function () { 'use strict'; try { delete Object.prototype; } catch (e) { return e.name; } })());
  // Native calls: plain Generic/GenericMagic, fewer arguments than length, throwing natives, constructs.
  const re = /b(c)?/g; r.push(String(re.exec('abcabc')), re.lastIndex, re.test('abc'), re.lastIndex, String(/z/.exec('abc')), /x/.test());
  r.push('abc'.slice(), 'abc'.indexOf(), [3, 1, 2].sort().join(), Math.max(), Math.min(1), Object.keys({ q: 1 }).length);
  r.push('a-b-c'.split('-').length, [1, 2, 3].indexOf(2), JSON.stringify(Object.assign({}, { z: 1 })), Array.isArray([]));
  try { null.toString(); } catch (e) { r.push(e.name); }
  try { Object.defineProperty(1, 'x', {}); } catch (e) { r.push(e.name); }
  try { Symbol().description.x.y; } catch (e) { r.push(e.name); }
  function deep(n) { return n === 0 ? new Error('d').stack.split('\n').length > 1 : deep(n - 1); } r.push(deep(3));
  r.push(String(new Date(0).getTime()), new Array(3).length, String(new RegExp('a', 'g')), typeof new Map().set(1, 2));
  // JS calls through call0..call3 and method calls.
  function f0() { return 1; } function f2(a, b) { return a + b; } function f1(a, b) { return b; }
  const obj = { m(a) { return a * 3; } };
  let s = 0; for (let i = 0; i < 50; i++) s += f0() + f2(i, 1) + (f1(i) === undefined ? 1 : 0) + obj.m(i);
  r.push(s, [1, 2, 3].map(function (v) { return v * 2; }).join());
  return r;
}
const got = JSON.stringify(round7());
const expected = "[1,2,4,\"5|6\",1,2,4,\"5|6\",1,2,4,\"5|6\",1,2,1,2,2,\"stop\",3,\"TypeError\",1,1,2,\"1a\",\"2b\",\"0,2,3,b,d,e\",2,0,false,0,2,\"{\\\"0\\\":0,\\\"1\\\":1,\\\"2\\\":2,\\\"3\\\":3,\\\"a\\\":10,\\\"b\\\":2,\\\"c\\\":3}\",\"0,2,3,b,d,e\",2,1,false,0,2,\"{\\\"0\\\":0,\\\"1\\\":1,\\\"2\\\":2,\\\"3\\\":3,\\\"a\\\":11,\\\"b\\\":2,\\\"c\\\":3}\",\"0,2,3,b,d,e\",2,2,false,0,2,\"{\\\"0\\\":0,\\\"1\\\":1,\\\"2\\\":2,\\\"3\\\":3,\\\"a\\\":12,\\\"b\\\":2,\\\"c\\\":3}\",\"0,2,3,b,d,e\",2,3,false,0,2,\"{\\\"0\\\":0,\\\"1\\\":1,\\\"2\\\":2,\\\"3\\\":3,\\\"a\\\":13,\\\"b\\\":2,\\\"c\\\":3}\",\"[{\\\"v\\\":0,\\\"w\\\":0},{\\\"w\\\":2},{\\\"v\\\":2,\\\"w\\\":4},{\\\"w\\\":6},{\\\"v\\\":4,\\\"w\\\":8},{\\\"w\\\":10}]\",\"v,w\",true,true,false,\"TypeError\",\"bc,c\",3,false,0,\"null\",false,\"abc\",-1,\"1,2,3\",null,1,1,3,1,\"{\\\"z\\\":1}\",true,\"TypeError\",\"TypeError\",\"TypeError\",true,\"0\",3,\"/a/g\",\"object\",5050,\"2,4,6\"]";
console.log(got === expected ? 'PASS perf fast paths 7' : 'FAIL ' + got);
if (got !== expected) throw new Error('perf fast path regressions');
