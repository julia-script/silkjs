// A local closure released at frame exit before its cells are detached: every
// closure that escapes, directly or through another closure, keeps its bindings.
const r = [];
function recursive(n) { function loop(k) { return k === 0 ? 0 : n + loop(k - 1); } return loop(3); }
r.push(recursive(4));
function escapesThroughSibling() {
  var count = 0;
  function bump() { count++; return count; }
  var keep = function () { return bump() + bump(); };
  return keep;
}
var k = escapesThroughSibling(); r.push(k(), k());
function selfInOtherClosure() {
  var f = function () { return typeof f; };
  var g = function () { return f(); };
  return g;
}
r.push(selfInOtherClosure()());
function mapped(a) { var fn = function () { return a; }; a = 7; return arguments; }
var args = mapped(1); r.push(args[0]);
function mappedClosure(a) { a = function () { return a; }; return arguments; }
var m = mappedClosure(0); r.push(typeof m[0], m[0]() === m[0]);
function stored(box) { var f = function () { return f; }; box.f = f; }
var box = {}; stored(box); r.push(box.f() === box.f);
function viaArray() { var f = function () { return f; }; return [f][0]; }
var va = viaArray(); r.push(va() === va);
function nested() { var x = 1; function a() { function b() { return x + 1; } return b; } return a()(); }
r.push(nested());
var total = 0;
for (var i = 0; i < 2000; i++) total += recursive(i % 5);
r.push(total);
const got = r.join('|');
const expected = '12|3|7|function|7|function|true|true|true|2|12000';
console.log(got === expected ? 'PASS frame closure release' : 'FAIL ' + got);
if (got !== expected) throw new Error('frame closure release regressions');
