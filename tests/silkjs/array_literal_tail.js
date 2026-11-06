// Small array literals keep their elements in the array's own cell. Growth,
// shrinking, holes, conversion to a slow array, sorting with a comparator that
// drops the last reference, and collection must all keep working.
var failures = 0;
function check(ok, what) { if (!ok) { failures++; if (failures < 10) console.log("bad", what); } }
var keep = [];
for (var i = 0; i < 3000; i++) {
  var a = [i, i + 1, "s" + i, {k: i}, [i]];
  check(a.length == 5 && a[0] === i && a[2] === "s" + i && a[3].k === i && a[4][0] === i, "literal " + i);
  a.push(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17);
  check(a.length == 22 && a[21] === 17 && a[3].k === i, "grown " + i);
  var b = [1, 2, 3];
  b.length = 1; b.push(9);
  check(b.join() == "1,9", "shrink " + i);
  var c = [1, 2, 3, 4];
  c[10] = 5;
  check(c.length == 11 && c[3] === 4 && c[10] === 5 && !(5 in c), "holes " + i);
  var d = [3, 1, 2];
  d.foo = "bar"; d.baz = 1; d.qux = 2;
  check(d.foo == "bar" && d.qux === 2 && d.sort().join() == "1,2,3", "named " + i);
  var e = [5, 4, 3, 2, 1, 0, 9, 8, 7, 6, 15, 14, 13, 12, 11, 10];
  check(e.slice().sort(function (x, y) { return x - y; })[15] === 15, "sort16 " + i);
  var f = [i, i];
  delete f[0];
  check(!(0 in f) && f[1] === i, "delete " + i);
  if (i % 100 == 0) keep.push(a, b, c, d, e, f);
  var g = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
  check(g.reduce(function (s, x) { return s + x; }, 0) == 171, "long " + i);
}
// A comparator that drops the array's last outside reference while sorting.
var holder = { arr: [3, 2, 1, 0] };
var sorted = holder.arr.sort(function (x, y) { holder.arr = null; return x - y; });
check(sorted.join() == "0,1,2,3", "sort drops holder");
if (typeof gc == "function") gc();
check(keep[0][3].k === 0 && keep[keep.length - 6][21] === 17 && keep[1].join() == "1,9", "kept after gc");
var cyc = [0, 0]; cyc[0] = cyc; cyc = null;
if (typeof gc == "function") gc();
console.log(failures == 0 ? "PASS array literal tail" : "FAIL array literal tail " + failures);
if (failures != 0) throw new Error("array literal tail regressions");
