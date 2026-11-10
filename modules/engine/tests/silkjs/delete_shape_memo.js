// Objects that delete a property leave the shared shape chain; later objects
// built the same way must still see their own keys, in order, after the
// unhashed shape changes in place, dies, and its memory is reused.
function build(i) {
  var o = { a: 1 };
  o.b = 2; o.c = 3;
  if (i % 3 == 0) { delete o.b; o.d = i; }
  if (i % 5 == 0) { delete o.a; o.b = i; }
  return o;
}
var failures = 0;
for (var i = 0; i < 3000; i++) {
  var o = build(i);
  var expected = ["a", "b", "c"];
  if (i % 3 == 0) expected = ["a", "c", "d"];
  if (i % 5 == 0) { expected = expected.filter(function (k) { return k != "a"; }); if (expected.indexOf("b") < 0) expected.push("b"); }
  var keys = Object.keys(o).join();
  if (keys != expected.join()) { failures++; if (failures < 5) console.log("bad keys", i, keys, expected.join()); }
  if (i % 3 == 0 && o.d !== i) failures++;
  if (i % 5 == 0 && o.b !== i) failures++;
  var p = { x: 1, y: 2 };
  delete p.y; p.y = 3; p.z = 4;
  if (Object.keys(p).join() != "x,y,z" || p.y !== 3 || p.z !== 4) failures++;
}
var s = { a: 1, b: 2 }, t = { a: 1, b: 2 };
delete s.b; s.c = 1;
t.c = 2;
if (Object.keys(t).join() != "a,b,c" || t.b !== 2 || t.c !== 2) failures++;
var arr = [1, 2, 3]; delete arr[1];
if (arr.length != 3 || 1 in arr) failures++;
var keyed = {}; keyed[7] = 1; keyed["x"] = 2; delete keyed[7]; delete keyed["x"];
if (Object.keys(keyed).length != 0) failures++;
console.log(failures == 0 ? "PASS delete shape memo" : "FAIL delete shape memo " + failures);
if (failures != 0) throw new Error("delete shape memo regressions");
