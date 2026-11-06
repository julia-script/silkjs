// Constructed objects pin the shape chain their constructor builds, and
// instanceof caches each constructor's `prototype` slot by its shape. Both must
// track prototype changes, shape changes on the constructor, collections, and
// constructors whose objects take different paths.
var failures = 0;
function check(ok, what) { if (!ok) { failures++; if (failures < 10) console.log("bad", what); } }

function Pair(a, b) { this.car = a; this.cdr = b; }
function Wide(n) { this.a = n; this.b = n; this.c = n; this.d = n; this.e = n; this.f = n; this.g = n; this.h = n; this.i = n; }
function Branch(n) { this.x = n; if (n & 1) this.odd = true; else this.even = true; this.y = n; }

var keep = [];
for (var i = 0; i < 20000; i++) {
  var p = new Pair(i, i + 1);
  check(p.car === i && p.cdr === i + 1 && Object.keys(p).join() == "car,cdr", "pair " + i);
  var w = new Wide(i);
  check(Object.keys(w).length == 9 && w.i === i, "wide " + i);
  var b = new Branch(i);
  check(Object.keys(b).join() == (i & 1 ? "x,odd,y" : "x,even,y") && b.y === i, "branch " + i);
  if (i % 1000 == 0) keep.push(p, w, b);
  check(p instanceof Pair, "instanceof " + i);
  // A new prototype object mid-run: later pairs inherit from it.
  if (i == 7000) Pair.prototype = { kind: "second" };
  if (i == 12000) { Pair.prototype = { kind: "third" }; if (typeof gc == "function") gc(); }
  if (i > 7000 && i <= 12000) check(p.kind === "second", "proto second " + i);
  if (i > 12000) check(p.kind === "third", "proto third " + i);
  check(!(w instanceof Pair) && w instanceof Wide && w instanceof Object, "instanceof wide " + i);
}
check(keep[0].car === 0 && keep[0].kind === undefined && !(keep[0] instanceof Pair), "old pair proto");
check(keep[keep.length - 3] instanceof Pair, "new pair proto");

// instanceof follows writes to `prototype` and own Symbol.hasInstance.
function F() {}
var f = new F();
for (var j = 0; j < 100; j++) check(f instanceof F, "F " + j);
F.prototype = {};
check(!(f instanceof F), "F after prototype write");
check(new F() instanceof F, "new F");
Object.defineProperty(F, Symbol.hasInstance, { value: function (v) { return v === 42; } });
check(42 instanceof F && !(new F() instanceof F), "own hasInstance");
function G() {}
var g = new G();
for (var k = 0; k < 100; k++) check(g instanceof G, "G " + k);
Object.setPrototypeOf(G, { [Symbol.hasInstance]: function () { return true; } });
check(1 instanceof G, "G with replaced function prototype");
function H() {}
H.prototype = 5;
var threw = false; try { ({}) instanceof H; } catch (e) { threw = e instanceof TypeError; }
check(threw, "non-object prototype throws");
check(!(1 instanceof H), "primitive is not an instance");
class A { constructor() { this.q = 1; } }
class B extends A { constructor() { super(); this.r = 2; } }
for (var m = 0; m < 1000; m++) { var o = new B(); check(o instanceof A && o instanceof B && o.q + o.r == 3, "class " + m); }

console.log(failures == 0 ? "PASS construct shape pins" : "FAIL construct shape pins " + failures);
if (failures != 0) throw new Error("construct shape pin regressions");
