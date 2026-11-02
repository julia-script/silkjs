// SilkJS regression test for the sixth round of benchmark fast paths. Results must match QuickJS.
// Frameless WeakMap/WeakSet writes and BigInt(n), primitive method lookups, cached small decimals.
function round6() {
  const r = [];
  const wm = new WeakMap(), ws = new WeakSet(), keys = [];
  for (let i = 0; i < 20; i++) { const k = { i }; keys.push(k); r.push(wm.set(k, i) === wm, ws.add(k) === ws); }
  r.push(wm.get(keys[7]), ws.has(keys[3]), wm.has({}), wm.delete(keys[2]), wm.has(keys[2]));
  for (const bad of [1, 'x', null, undefined, Symbol.for('reg')]) {
    try { wm.set(bad, 1); r.push('nothrow'); } catch (e) { r.push(e.name); }
    try { ws.add(bad); r.push('nothrow'); } catch (e) { r.push(e.name); }
  }
  try { new BigInt(1); } catch (e) { r.push(e.name); }
  r.push(String(BigInt(5)), typeof BigInt(-7), BigInt(2147483647) * 2n === 4294967294n, String(BigInt(1.0)), String(BigInt('12')));
  try { BigInt(1.5); } catch (e) { r.push(e.name); }
  const m = new Map(); for (let i = 0; i < 50; i++) m.set(BigInt(i), i); r.push(m.get(49n), m.has(BigInt(10)));
  const nums = [0, 7, 10, 99, 100, 255, 256, 1000, -1, -255, 2147483647, -2147483648, 3.5];
  for (const n of nums) r.push(n.toString(), n + '', '' + n, String(n), (n).toString(10), n.toFixed(1));
  r.push(true.toString(), (false).valueOf(), (5).constructor === Number, (1.5).toString(2));
  Number.prototype.extra = function () { return this * 2; }; r.push((21).extra(), (1.25).extra());
  Object.defineProperty(Number.prototype, 'getter', { get() { return typeof this; }, configurable: true });
  r.push((3).getter); delete Number.prototype.getter; delete Number.prototype.extra;
  const src = [{ a: 1 }, 'x', 2n ** 70n, 4]; const copies = []; for (let i = 0; i < 5; i++) copies.push(src.slice());
  src[0].a = 9; r.push(JSON.stringify(copies[4].map(String)), copies[3][0].a, copies.length);
  let f = 0.5, g = 1; for (let i = 0; i < 10; i++) { f += i; g += 0.25; } r.push(f, g);
  return r;
}
const got = JSON.stringify(round6());
const expected = "[true,true,true,true,true,true,true,true,true,true,true,true,true,true,true,true,true,true,true,true,true,true,true,true,true,true,true,true,true,true,true,true,true,true,true,true,true,true,true,true,7,true,false,true,false,\"TypeError\",\"TypeError\",\"TypeError\",\"TypeError\",\"TypeError\",\"TypeError\",\"TypeError\",\"TypeError\",\"TypeError\",\"TypeError\",\"TypeError\",\"5\",\"bigint\",true,\"1\",\"12\",\"RangeError\",49,true,\"0\",\"0\",\"0\",\"0\",\"0\",\"0.0\",\"7\",\"7\",\"7\",\"7\",\"7\",\"7.0\",\"10\",\"10\",\"10\",\"10\",\"10\",\"10.0\",\"99\",\"99\",\"99\",\"99\",\"99\",\"99.0\",\"100\",\"100\",\"100\",\"100\",\"100\",\"100.0\",\"255\",\"255\",\"255\",\"255\",\"255\",\"255.0\",\"256\",\"256\",\"256\",\"256\",\"256\",\"256.0\",\"1000\",\"1000\",\"1000\",\"1000\",\"1000\",\"1000.0\",\"-1\",\"-1\",\"-1\",\"-1\",\"-1\",\"-1.0\",\"-255\",\"-255\",\"-255\",\"-255\",\"-255\",\"-255.0\",\"2147483647\",\"2147483647\",\"2147483647\",\"2147483647\",\"2147483647\",\"2147483647.0\",\"-2147483648\",\"-2147483648\",\"-2147483648\",\"-2147483648\",\"-2147483648\",\"-2147483648.0\",\"3.5\",\"3.5\",\"3.5\",\"3.5\",\"3.5\",\"3.5\",\"true\",false,true,\"1.1\",42,2.5,\"object\",\"[\\\"[object Object]\\\",\\\"x\\\",\\\"1180591620717411303424\\\",\\\"4\\\"]\",9,5,45.5,3.5]";
console.log(got === expected ? 'PASS perf fast paths 6' : 'FAIL ' + got);
if (got !== expected) throw new Error('perf fast path regressions');
