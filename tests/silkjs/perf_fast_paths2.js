// SilkJS regression test for the second round of benchmark fast paths. Results must match QuickJS.
// Int toString without a frame, Array length reads, slice copies and short appends.
function round2() {
  const r = [];
  r.push((5).toString(), (-17).toString(10), (255).toString(undefined), (255).toString(16), (2147483647).toString(),
    (-2147483648).toString(), (7).toString(2), (1.5).toString());
  try { (5).toString(1); } catch (e) { r.push(e.constructor.name); }
  const saved = Number.prototype.toString;
  Number.prototype.toString = function () { return "patched"; };
  r.push((5).toString());
  Number.prototype.toString = saved;
  const sparse = []; sparse[4294967294] = 1;
  const lens = [[].length, [1, 2, 3].length, sparse.length, new Array(7).length];
  const grow = [1]; grow.length = 1e9; lens.push(grow.length);
  r.push(lens.join());
  const src = [1, "two", { three: 3 }, [4], null, undefined];
  const copy = src.slice(); copy[0] = 9;
  r.push(JSON.stringify(src.slice(1, 4)), JSON.stringify(copy), src.slice(2).length, src.slice(-2).length);
  let s = "";
  for (let i = 0; i < 300; i++) s += i % 3 === 0 ? "abcdefghijklmnopq" : "é";
  let w = "一";
  for (let i = 0; i < 50; i++) w += "z";
  r.push(s.length, s.slice(0, 20), s.charCodeAt(17), w.length, w.slice(-3));
  return r;
}
const got = JSON.stringify(round2());
const expected = "[\"5\",\"-17\",\"255\",\"ff\",\"2147483647\",\"-2147483648\",\"111\",\"1.5\",\"RangeError\",\"patched\",\"0,3,4294967295,7,1000000000\",\"[\\\"two\\\",{\\\"three\\\":3},[4]]\",\"[9,\\\"two\\\",{\\\"three\\\":3},[4],null,null]\",4,2,1900,\"abcdefghijklmnopq\u00e9\u00e9a\",233,51,\"zzz\"]";
console.log(got === expected ? 'PASS perf fast paths 2' : 'FAIL ' + got);
if (got !== expected) throw new Error('perf fast path regressions');
