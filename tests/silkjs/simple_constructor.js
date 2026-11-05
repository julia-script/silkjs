// Constructors whose body only stores arguments into `this` may build their
// objects without a frame. Every observable behaviour must match running the
// body: missing arguments, setters and read-only properties on the prototype
// chain, non-extensible prototypes, more stores than inline slots, new.target
// prototypes, and prototype changes between calls.
var failures = 0;
function check(ok, what) { if (!ok) { failures++; if (failures < 10) console.log("bad", what); } }

function P2(a, b) { this.a = a; this.b = b; }
function P4(a, b, c, d) { this.w = d; this.x = c; this.y = b; this.z = a; }
function P6(a, b, c, d) { this.a = a; this.b = b; this.c = c; this.d = d; this.e = a; this.f = b; }
function Same(a, b) { this.v = a; this.v = b; }

for (var i = 0; i < 3000; i++) {
  var p = new P2(i, "s" + i);
  check(p.a === i && p.b === "s" + i && Object.keys(p).join() == "a,b", "p2 " + i);
  var q = new P2(i);
  check(q.a === i && q.b === undefined && q.hasOwnProperty("b"), "p2 missing " + i);
  var r = new P2();
  check(r.a === undefined && Object.keys(r).length == 2, "p2 none " + i);
  var s = new P2(1, 2, 3, 4);
  check(s.a === 1 && s.b === 2, "p2 extra " + i);
  var w = new P4(1, 2, 3, 4);
  check(Object.keys(w).join() == "w,x,y,z" && w.w === 4 && w.z === 1, "p4 " + i);
  var six = new P6(1, 2, 3, 4);
  check(Object.keys(six).join() == "a,b,c,d,e,f" && six.f === 2 && six.e === 1 && six.d === 4, "p6 " + i);
  var same = new Same(1, 2);
  check(same.v === 2 && Object.keys(same).length == 1, "same " + i);
  // Objects keep their own references to argument values.
  var o = {n: i};
  var held = new P2(o, [i]);
  o = null;
  check(held.a.n === i && held.b[0] === i, "held " + i);
  // Arguments stored twice, or not at all, keep every reference.
  var first = {m: i}, second = [i], third = {t: i};
  var twice = new P6(first, second, third, "x" + i);
  first = second = third = null;
  check(twice.a === twice.e && twice.b === twice.f && twice.a.m === i && twice.f[0] === i && twice.c.t === i, "twice " + i);
  var unused = {u: i};
  var dropped = new P2("k" + i, unused, unused, {});
  check(dropped.b === unused && unused.u === i, "extra kept " + i);
}

// A setter appears on the prototype after many fast constructions.
function S(a) { this.k = a; }
for (var j = 0; j < 500; j++) check(new S(j).k === j, "s " + j);
var seen = [];
Object.defineProperty(S.prototype, "k", { set: function (v) { seen.push(v); }, get: function () { return "got"; }, configurable: true });
var sk = new S(7);
check(seen.length == 1 && seen[0] === 7 && !sk.hasOwnProperty("k") && sk.k === "got", "setter on prototype");
delete S.prototype.k;
check(new S(8).hasOwnProperty("k"), "setter removed");

// A read-only property on Object.prototype shadows the add (sloppy: silently ignored).
function T(a) { this.ro = a; }
for (var k = 0; k < 500; k++) check(new T(k).ro === k, "t " + k);
Object.defineProperty(Object.prototype, "ro", { value: "fixed", writable: false, configurable: true });
var tr = new T(9);
check(!tr.hasOwnProperty("ro") && tr.ro === "fixed", "read-only on Object.prototype");
delete Object.prototype.ro;
check(new T(10).ro === 10, "read-only removed");

// Strict constructors throw on the read-only add.
function U(a) { "use strict"; this.ro2 = a; }
for (var m = 0; m < 500; m++) check(new U(m).ro2 === m, "u " + m);
Object.defineProperty(U.prototype, "ro2", { value: 0, writable: false });
var threw = false; try { new U(1); } catch (e) { threw = e instanceof TypeError; }
check(threw, "strict read-only throws");

// A frozen prototype only blocks inherited read-only names, not new own ones.
function V(a, b) { this.p = a; this.q = b; }
for (var n = 0; n < 500; n++) new V(n, n);
Object.freeze(V.prototype);
var vv = new V(1, 2);
check(vv.p === 1 && vv.q === 2, "frozen prototype");

// new.target selects the prototype; Reflect.construct takes another path but must agree.
function W(a) { this.m = a; }
function Other() {}
Other.prototype.tag = "other";
for (var r2 = 0; r2 < 500; r2++) {
  var made = Reflect.construct(W, [r2], Other);
  check(made.m === r2 && made.tag === "other" && made instanceof Other, "reflect " + r2);
}
class Sub extends W { constructor(a) { super(a); this.extra = 1; } }
for (var c = 0; c < 500; c++) { var sb = new Sub(c); check(sb.m === c && sb.extra === 1 && sb instanceof Sub, "sub " + c); }

// Prototype swaps between calls.
function X(a) { this.val = a; }
for (var x = 0; x < 2000; x++) {
  if (x == 700) X.prototype = { hello: 1 };
  if (x == 1400) X.prototype = Object.create(null);
  var xo = new X(x);
  check(xo.val === x, "x val " + x);
  if (x >= 700 && x < 1400) check(xo.hello === 1, "x proto " + x);
  if (x >= 1400) check(Object.getPrototypeOf(xo) !== null && xo.hello === undefined, "x null-proto fallback " + x);
}

// Objects built this way stay ordinary: deletes, more adds, preventExtensions.
for (var y = 0; y < 500; y++) {
  var e = new P2(y, y);
  delete e.a; e.c = 3;
  check(Object.keys(e).join() == "b,c", "edit " + y);
  Object.preventExtensions(e);
  e.d = 1;
  check(e.d === undefined, "non-extensible " + y);
}
if (typeof gc == "function") gc();
check(new P2(1, 2).b === 2, "after gc");

console.log(failures == 0 ? "PASS simple constructor" : "FAIL simple constructor " + failures);
if (failures != 0) throw new Error("simple constructor regressions");
