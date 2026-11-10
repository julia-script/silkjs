// SilkJS regression test for scope functions entered inline: each call of a
// function whose captured variables live in a per-activation scope gets a fresh
// scope from the bytecode call and construct paths, with captured parameters
// copied in for fewer and more arguments than declared, closures that outlive
// their frame, throws through scope frames, constructors, recursion deep enough
// to fill the call-frame region, and calls through apply and call.
// Expected values come from V8.
var r = [];
function adder(a, b) { var f = function () { return a + (b === undefined ? 100 : b); }; return f(); }
var s = 0;
for (var i = 0; i < 300; i++) s += adder(i, i % 2 ? undefined : 1);
r.push(s, adder(), adder(1), adder(1, 2, 3));
function make(n) { var hits = 0; return function (x) { hits++; return n * x + hits; }; }
var fs = [];
for (var i = 0; i < 50; i++) fs.push(make(i));
var t = 0;
for (var j = 0; j < 3; j++) for (var i = 0; i < fs.length; i++) t += fs[i](j);
r.push(t);
function guard(k) { var seen = k; var f = function () { return seen; }; if (k % 4 === 0) throw new Error('g' + f()); return f(); }
function tryAll(n) { var sum = 0; for (var i = 0; i < n; i++) { try { sum += guard(i); } catch (e) { sum += e.message.length * 1000; } } return sum; }
r.push(tryAll(40));
function Point(x, y) { var self = this; this.x = x; this.y = y; this.norm = function () { return self.x * self.x + y * y; }; }
var acc = 0;
for (var i = 0; i < 100; i++) { var p = new Point(i, 2); acc += p.norm(); }
r.push(acc, new Point(3).norm());
function depth(n) { var me = n; var f = function () { return me; }; return n === 0 ? f() : depth(n - 1) + f(); }
r.push(depth(10), depth(1500));
function viaApply(a, b) { var g = function () { return a * b; }; return g(); }
r.push(viaApply.apply(null, [6, 7]), viaApply.call(null, 3, 5), viaApply.apply(null, [2]));
function outer(a) { var o = a; function mid(b) { var m = b; return function () { return o + m; }; } return mid(a * 2); }
var outs = [];
for (var i = 0; i < 5; i++) outs.push(outer(i));
r.push(outs.map(function (f) { return f(); }).join(','));
var result = r.join('|');
var expected = '60000|NaN|101|3|3975|27600|328750|NaN|55|1125750|42|15|NaN|0,3,6,9,12';
console.log(result === expected ? 'PASS scope inline entry' : 'FAIL ' + result);
if (result !== expected) throw new Error('scope inline entry regressions');
