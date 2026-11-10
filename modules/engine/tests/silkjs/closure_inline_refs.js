// SilkJS regression test for closure reference tables kept in the function
// cell's own tail: closures capturing 1 to 10 variables (both sides of the
// inline limit), closures that outlive their creators and are freed in bulk
// (cells parked and reused), properties added to a closure past its inline slots,
// constructors made by closures, nested closures reusing outer captures, and
// closures captured by a scope. Expected values come from V8.
var r = [];
function maker(n) {
  var a = n, b = n + 1, c = n + 2, d = n + 3, e = n + 4, f = n + 5, g = n + 6, h = n + 7, i = n + 8, j = n + 9;
  return [
    function () { return a; },
    function () { return a + b; },
    function () { return a + b + c + d; },
    function () { return a + b + c + d + e + f + g; },
    function () { return a + b + c + d + e + f + g + h; },
    function () { return a + b + c + d + e + f + g + h + i + j; },
    function () { a++; j--; return a * 1000 + j; }
  ];
}
var total = 0, kept = [];
for (var k = 0; k < 400; k++) {
  var fs = maker(k);
  for (var m = 0; m < fs.length; m++) total += fs[m]();
  if (k % 50 === 0) kept.push(fs);
}
r.push(total);
var keptSum = 0;
for (var k = 0; k < kept.length; k++) keptSum += kept[k][6]() + kept[k][5]();
r.push(keptSum);
function counter(start) { var n = start; var f = function () { return ++n; }; return f; }
var c = counter(10);
c.label = 'x'; c.p1 = 1; c.p2 = 2; c.p3 = 3; c.p4 = 4; c.p5 = 5;
r.push(c(), c(), c.label + c.p5, Object.keys(c).length, c.name, c.length);
function classMaker(base) { var b = base; function K(v) { this.v = v + b; } K.prototype.get = function () { return this.v * b; }; return K; }
var K = classMaker(3);
var o = new K(4);
r.push(o.v, o.get(), o instanceof K, K.prototype.constructor === K);
function outer(x) { var y = x * 2; return function (z) { var w = z + y; return function () { return x + y + w; }; }; }
r.push(outer(1)(2)(), outer(5)(1)());
function scoped(p, q) { var s = p * q; var fns = []; for (var t = 0; t < 3; t++) fns.push(function () { return s + t + p; }); return fns.map(function (f) { return f(); }).join(','); }
r.push(scoped(2, 3));
var garbage = 0;
for (var round = 0; round < 30; round++) {
  var ring = [];
  for (var k = 0; k < 100; k++) { (function (k) { var self = { f: null }; self.f = function () { return self.f === null ? 0 : k; }; ring.push(self); })(k); }
  garbage += ring[round].f();
}
r.push(garbage);
var result = r.join('|');
var expected = '82877000|1431816|11|12|x5|6|f|0|7|21|true|true|7|26|11,11,11|435';
console.log(result === expected ? 'PASS closure inline refs' : 'FAIL ' + result);
if (result !== expected) throw new Error('closure inline refs regressions');
