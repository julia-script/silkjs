// SilkJS regression test for the fast paths added for the benchmark work:
// 64-bit short BigInts and their VM shortcuts, 128-bit BigInt add/subtract,
// sparse Array length stores, holey reads through the prototype chain, String(n),
// array destructuring through the intrinsic iterator, string appends to arguments
// and shared strings, and rope prepends. Results must match QuickJS.
const out = [];

// BigInt: VM add/sub/mul on short values, overflow into heap values and back.
function bigints() {
  const r = [];
  let a = 9223372036854775807n, b = -9223372036854775808n, c = 3037000499n;
  r.push(String(a + 1n), String(b - 1n), String(c * c), String(c * 3037000500n), String(a * a));
  r.push(String(-a - 1n === b), String(b + 0n), String(0n - b), String(a - b), String(b - a));
  let s = 0n;
  for (let i = 0; i < 40; i++) { s += a; s -= 7n; s = s * 1n; }
  r.push(String(s), String(s - s), String(s + -s));
  let t = 1n;
  for (let i = 0; i < 70; i++) t = t * 2n;
  r.push(String(t), String(t - 1n), String(t + t), String(-t - t), String(t - t * 2n));
  const w = 2n ** 127n - 1n;
  r.push(String(w + 1n), String(-w - 1n - 1n), String(w - (-w)), String((-w - 1n) + (-1n)), String(w + -w));
  r.push(String(2n ** 64n + (2n ** 64n)), String(2n ** 64n - 2n ** 65n), String(-(2n ** 63n) - 2n ** 63n));
  let u = 5n;
  u += 9223372036854775800n;
  u += 100n;
  r.push(String(u), typeof u);
  return r;
}
out.push(bigints());

// Array length stores on sparse arrays, including a non-configurable element.
function sparse(strict) {
  const r = [];
  const a = [];
  for (let i = 0; i < 100; i++) if (i % 10 === 9) a[i] = i;
  for (let i = 100; i-- > 0;) a.length = i;
  r.push(a.length, Object.keys(a).length);
  const b = [];
  b[3] = 3; b[50] = 50; b[70] = 70;
  Object.defineProperty(b, 20, { value: 20, configurable: false, enumerable: true });
  let thrown = "none";
  try {
    if (strict) (function () { "use strict"; b.length = 5; })();
    else b.length = 5;
  } catch (e) { thrown = e.constructor.name; }
  r.push(thrown, b.length, Object.keys(b).join());
  const c = [1, 2, 3];
  Object.freeze(c);
  try { (function () { "use strict"; c.length = 0; })(); } catch (e) { r.push(e.constructor.name); }
  r.push(c.length);
  return r;
}
out.push(sparse(false), sparse(true));

// Holey reads (slice of a sparse array) that see prototype elements and getters.
function holes() {
  const r = [];
  const a = [];
  for (let i = 0; i < 30; i++) if (i % 3 === 0) a[i] = i;
  r.push(JSON.stringify(a.slice()), a.slice(5, 12).length);
  Array.prototype[4] = "p4";
  Object.prototype[7] = "o7";
  r.push(JSON.stringify(a.slice(2, 10)));
  let calls = 0;
  Object.defineProperty(Array.prototype, 8, { get() { calls++; return "g8"; }, configurable: true });
  r.push(JSON.stringify(a.slice(2, 10)), calls);
  delete Array.prototype[4]; delete Object.prototype[7]; delete Array.prototype[8];
  const o = Object.create({ 1: "proto1" });
  o.length = 3; o[0] = "own0";
  r.push(JSON.stringify(Array.prototype.slice.call(o)));
  r.push(JSON.stringify(a.slice(2, 10)));
  return r;
}
out.push(holes());

// String(n) as a function and a constructor.
out.push([String(0), String(-1), String(2147483647), String(-2147483648), typeof new String(5),
  new String(42).length, String(1.5), String(-0), String(12345678901)]);

// Destructuring through the intrinsic Array iterator, and when it is replaced.
function destructure() {
  const r = [];
  let v1, v2, v3, v4;
  [v1, v2, , v3, ...v4] = [1, 2, 3, 4, 5, 6];
  r.push(v1, v2, v3, JSON.stringify(v4));
  const values = Array.prototype[Symbol.iterator];
  Array.prototype[Symbol.iterator] = function* () { yield "x"; yield "y"; };
  [v1, v2, v3] = [1, 2, 3];
  r.push(v1, v2, String(v3));
  Array.prototype[Symbol.iterator] = values;
  const keys = [];
  for (const k of [7, 8, 9].keys()) keys.push(k);
  for (const e of ["a", "b"].entries()) keys.push(e.join(":"));
  const like = { length: 2, 0: "l0", 1: "l1", [Symbol.iterator]: Array.prototype.values };
  const [p, q] = like;
  r.push(keys.join(), p, q);
  return r;
}
out.push(destructure());

// Appends to an argument, to shared strings, and prepends onto ropes.
function strings(n, r) {
  r = "";
  for (let i = 0; i < n; i++) r += String.fromCharCode(97 + (i % 26));
  let s = "", t = "", kept = [];
  for (let i = 0; i < n; i++) { t = s; s += "x" + (i % 10); if (i % 250 === 0) kept.push(t); }
  let p = "";
  const snapshots = [];
  for (let i = 0; i < n; i++) { p = String.fromCharCode(65 + (i % 26)) + p; if (i % 333 === 0) snapshots.push(p); }
  let q = "tail".repeat(200);
  for (let i = 0; i < 700; i++) q = "ab" + q;
  return [r.length, r.slice(-5), s.length, s.slice(-6), t.length, kept.map(k => k.length).join(),
    p.length, p.slice(0, 6), p.slice(-6), snapshots.map(x => x.length + x.slice(0, 2)).join(),
    q.length, q.slice(0, 5), q.slice(1395, 1405), q.charCodeAt(1399)];
}
out.push(strings(1000), strings(3000));

// Float formatting in fixed and exponential notation.
out.push([(0.1).toFixed(15), (1234.5678).toFixed(2), (123456789012.1).toFixed(10),
  (1e21).toFixed(2), (0.000001234).toExponential(4), (987654321.123).toPrecision(12), (255).toString(16)]);

const got = JSON.stringify(out);
const expected = '[["9223372036854775808","-9223372036854775809","9223372030926249001","9223372033963249500","85070591730234615847396907784232501249","true","-9223372036854775808","9223372036854775808","18446744073709551615","-18446744073709551615","368934881474191032000","0","0","1180591620717411303424","1180591620717411303423","2361183241434822606848","-2361183241434822606848","-1180591620717411303424","170141183460469231731687303715884105728","-170141183460469231731687303715884105729","340282366920938463463374607431768211454","-170141183460469231731687303715884105729","0","36893488147419103232","-18446744073709551616","-18446744073709551616","9223372036854775905","bigint"],[0,0,"none",21,"3,20","TypeError",3],[0,0,"TypeError",21,"3,20","TypeError",3],["[0,null,null,3,null,null,6,null,null,9,null,null,12,null,null,15,null,null,18,null,null,21,null,null,24,null,null,27]",7,"[null,3,\\"p4\\",null,6,\\"o7\\",null,9]","[null,3,\\"p4\\",null,6,\\"o7\\",\\"g8\\",9]",1,"[\\"own0\\",\\"proto1\\",null]","[null,3,null,null,6,null,null,9]"],["0","-1","2147483647","-2147483648","object",2,"1.5","0","12345678901"],[1,2,4,"[5,6]","x","y","undefined","0,1,2,0:a,1:b","l0","l1"],[1000,"hijkl",2000,"x7x8x9",1998,"0,500,1000,1500",1000,"LKJIHG","FEDCBA","1A,334VU,667QP,1000LK",2200,"ababa","bababtailt",98],[3000,"fghij",6000,"x7x8x9",5998,"0,500,1000,1500,2000,2500,3000,3500,4000,4500,5000,5500",3000,"JIHGFE","FEDCBA","1A,334VU,667QP,1000LK,1333GF,1666BA,1999WV,2332RQ,2665ML,2998HG",2200,"ababa","bababtailt",98],["0.100000000000000","1234.57","123456789012.1000061035","1e+21","1.2340e-6","987654321.123","ff"]]';
console.log(got === expected ? 'PASS perf fast paths' : 'FAIL ' + got);
if (got !== expected) throw new Error('perf fast path regressions');
