// Objects built property by property grow straight to the size earlier objects
// of the same prototype reached. Every object must still see exactly its own
// properties, in order, whatever size its slots were given.
function check(ok, what) { if (!ok) throw new Error("failed: " + what); }
var names = "abcdefghijklmnopqrstuvwxyz".split("");
function build(n, proto) {
  var o = proto ? Object.create(proto) : {};
  for (var i = 0; i < n; i++) o[names[i]] = i;
  return o;
}
for (var round = 0; round < 200; round++) {
  var big = build(20), small = build(5), mid = build(10);
  check(Object.keys(big).length === 20 && big.t === 19, "big " + round);
  check(Object.keys(small).join() === "a,b,c,d,e" && small.f === undefined, "small " + round);
  check(Object.keys(mid).length === 10 && mid.j === 9 && !("k" in mid), "mid " + round);
  delete mid.c; mid.z = 25;
  check(Object.keys(mid).join() === "a,b,d,e,f,g,h,i,j,z", "mid after delete " + round);
  var p = { inherited: 1 }, child = build(12, p);
  check(child.inherited === 1 && Object.keys(child).length === 12 && child.l === 11, "child " + round);
}
// Values of every kind stay reachable from hinted slots across collections.
var keep = [];
for (var k = 0; k < 2000; k++) {
  var o = {}; o.a = { k: k }; o.b = "s" + k; o.c = [k]; o.d = k; o.e = k * 0.5; o.f = null;
  keep.push(o);
}
if (typeof gc == "function") gc();
for (var k = 0; k < 2000; k += 97) check(keep[k].a.k === k && keep[k].b === "s" + k && keep[k].c[0] === k && keep[k].e === k * 0.5, "kept " + k);
console.log("PASS slot growth hint");
