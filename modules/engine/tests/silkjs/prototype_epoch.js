// Prototype reads and planned constructs skip their prototype walk while no
// prototype has changed (RuntimeState.shapeEpoch); every kind of change must
// still be seen.
var out = [];
function A() {} A.prototype.m = function () { return 'A' }; A.prototype.v = 1;
function B() {} B.prototype = Object.create(A.prototype); B.prototype.n = function () { return 'B' };
function C() {} C.prototype = Object.create(B.prototype);
var c = new C(), b = new B();
function rd(o) { return o.v }
function rm(o) { return o.m() }
var s = 0; for (var i = 0; i < 100; i++) { s += rd(c) + rd(b) } out.push(s, rm(c), rm(b));
A.prototype.v = 5; out.push(rd(c), rd(b));
B.prototype.v = 7; out.push(rd(c), rd(b));
delete B.prototype.v; out.push(rd(c));
Object.defineProperty(A.prototype, 'v', { get: function () { return 'g' }, configurable: true }); out.push(rd(c), rd(b));
Object.setPrototypeOf(C.prototype, { v: 'z' }); out.push(rd(c), rd(b));
// Many own properties push a prototype's shape to dictionary mode.
var D = function () {}; for (var i = 0; i < 40; i++) D.prototype['p' + i] = i;
var d = new D(); function rp(o) { return o.p7 } var t = 0;
for (var i = 0; i < 50; i++) t += rp(d); out.push(t);
D.prototype.p7 = 100; out.push(rp(d)); delete D.prototype.p7; out.push(rp(d));
D.prototype.p7 = 8; out.push(rp(d));
// Planned constructs: a setter appearing on the prototype chain must run.
function P(x) { this.x = x } var arr = [];
for (var i = 0; i < 100; i++) arr.push(new P(i));
var seen = 0; Object.defineProperty(Object.prototype, 'x', { set: function (v) { seen += v }, configurable: true });
for (var i = 0; i < 10; i++) arr.push(new P(1));
out.push(seen, Object.prototype.hasOwnProperty.call(arr[105], 'x'));
delete Object.prototype.x;
var q = new P(3); out.push(q.x);
P.prototype.q = 3; t = 0; for (var i = 0; i < 100; i++) t += arr[i].q; out.push(t);
P.prototype.q = 4; t = 0; for (var i = 0; i < 100; i++) t += arr[i].q; out.push(t);
Object.prototype.zz = 9; out.push(c.zz, arr[3].zz); delete Object.prototype.zz; out.push(c.zz);
// Swapping a prototype object for another one.
function E() {} E.prototype = { w: 1 }; var e = new E(); function rw(o) { return o.w }
for (var i = 0; i < 20; i++) rw(e); Object.setPrototypeOf(E.prototype, { w2: 2 }); out.push(rw(e));
Object.setPrototypeOf(e, { w: 'swapped' }); out.push(rw(e));
// Memoized adds (transitions) and recipe constructs: a setter appearing on the
// chain after the memo was verified must run.
var seenB = [];
function mk(i) { var o = {}; o.a = i; o.bb = i * 2; return o }
for (var i = 0; i < 50; i++) mk(i);
Object.defineProperty(Object.prototype, 'bb', { set: function (v) { seenB.push(v) }, configurable: true });
var mo = mk(5); out.push(mo.a, Object.prototype.hasOwnProperty.call(mo, 'bb'), seenB.join());
delete Object.prototype.bb; mo = mk(6); out.push(mo.bb);
function K(x, y) { this.x = x; this.y = y } K.prototype.f = 1; for (var i = 0; i < 50; i++) new K(i, i);
var kz = 0; Object.defineProperty(K.prototype, 'y', { set: function (v) { kz += v }, configurable: true });
var kk = new K(1, 7); out.push(kk.x, kk.y === undefined, kz);
var expected = '[200,"A","A",5,5,7,7,5,"g","g","z","g",350,100,null,8,10,false,3,300,400,9,9,null,1,"swapped",5,false,"10",12,1,true,7]';
var got = JSON.stringify(out);
console.log(got == expected ? "PASS prototype epoch" : "FAIL prototype epoch " + got);
if (got != expected) throw new Error("prototype epoch regressions");
