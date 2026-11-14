// Leaf runs that end by storing a captured variable (put_scope0 before
// return_undef) and that step it with inc/dec (js_vm_leaf, js_bytecode.leafCode).
const r = [];
// A known helper bumping a captured counter.
function counter(n) { var sum = 0; function f(a) { sum++; } for (var j = 0; j < n; j++) f(j); return sum; }
r.push(counter(1000));
// The same through closure objects, with a decrement.
function closures() { var x = 10; var up = function () { x++; }; var down = function () { x--; }; var list = [up, up, down]; for (var i = 0; i < 300; i++) list[i % 3](); return x; }
r.push(closures());
// Heap values stored over heap values: the old one is released, the new one kept.
function strings() { var last = 'start'; function keep(s) { last = s; } for (var i = 0; i < 200; i++) keep('v' + (i % 7)); var o = {}; function obj(v) { last = v; } obj(o); o.k = 1; return last.k + ':' + (last === o); }
r.push(strings());
function texts() { var last = 'start'; function keep(s) { last = s; } for (var i = 0; i < 200; i++) keep('v' + (i % 7)); return last; }
r.push(texts());
// Storing a variable over itself.
function self() { var v = { n: 1 }; function same() { v = v; } for (var i = 0; i < 50; i++) same(); return v.n; }
r.push(self());
// inc past the Int range and on non-numbers take the frame's path.
function edges() { var big = 2147483646; function bump() { big++; } bump(); bump(); bump(); var s = '5'; function str() { s++; } str(); var u; function und() { u++; } und(); return big + ',' + s + ',' + u; }
r.push(edges());
// A let captured by a helper stays checked: before its initialization it throws.
function tdz() { function set() { late = 1; } var ok; try { set(); ok = false; } catch (e) { ok = e instanceof ReferenceError; } let late = 0; set(); return ok + ':' + late; }
r.push(tdz());
// A store not followed by return stays a frame call.
function notLast() { var a = 0; function g() { a = 5; return a + 1; } return g() + a; }
r.push(notLast());
const got = r.join('|');
const expected = '1000|110|1:true|v3|1|2147483649,6,NaN|true:1|11';
console.log(got === expected ? 'PASS leaf scope store' : 'FAIL ' + got);
if (got !== expected) throw new Error('leaf scope store regressions');
