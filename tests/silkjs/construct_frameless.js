// Constructor bodies that only store argument-derived values into `this` run
// without a frame. Results, key order, defaults, prototype setters, frozen
// prototypes, repeated keys and Class.create forwarding must match V8.
var failures = 0;
function check(ok, what) { if (!ok) { failures++; if (failures < 10) console.log("bad", what); } }
function keys(o) { return Object.keys(o).join(","); }

var Class = { create: function () { return function () { this.initialize.apply(this, arguments); }; } };
var Vector = Class.create();
Vector.prototype = {
  initialize: function (x, y, z) { this.x = (x ? x : 0); this.y = (y ? y : 0); this.z = (z ? z : 0); },
  len: function () { return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z); }
};
var Color = Class.create();
Color.prototype = {
  initialize: function (r, g, b) { if (!r) r = 0.0; if (!g) g = 0.0; if (!b) b = 0.0; this.red = r; this.green = g; this.blue = b; }
};
var Light = Class.create();
Light.prototype = { initialize: function (pos, color, intensity) { this.position = pos; this.color = color; this.intensity = (intensity ? intensity : 10.0); } };
function Point(x, y) { this.x = x || -1; this.y = !y; this.tag = null; }

for (var i = 0; i < 200; i++) {
  var v = new Vector(i, i % 3 ? 0 : 2.5, "s" + i);
  check(keys(v) === "x,y,z" && v.x === i && v.y === (i % 3 ? 0 : 2.5) && v.z === "s" + i, "vector " + i);
  check(v instanceof Vector && typeof v.len() === "number", "vector proto " + i);
  var w = new Vector();
  check(w.x === 0 && w.y === 0 && w.z === 0, "vector defaults " + i);
  var c = new Color(i % 2 ? i / 2 : 0, undefined, null);
  check(keys(c) === "red,green,blue" && c.red === (i % 2 ? i / 2 : 0) && c.green === 0 && c.blue === 0, "color " + i);
  var l = new Light(v, c);
  check(l.position === v && l.color === c && l.intensity === 10, "light " + i);
  var p = new Point(i, i % 2);
  check(keys(p) === "x,y,tag" && p.x === (i || -1) && p.y === !(i % 2) && p.tag === null, "point " + i);
}

// Extra arguments, objects as values, the receiver itself is never stored.
for (var i = 0; i < 50; i++) {
  var o = { n: i };
  var v = new Vector(o, [i], function () { return i; });
  check(v.x === o && v.y[0] === i && typeof v.z === "function", "object values " + i);
  var e = new Vector(1, 2, 3, 4, 5);
  check(keys(e) === "x,y,z" && e.z === 3, "extra args " + i);
}

// A setter added to the prototype later must run for later constructions.
var setterRuns = 0;
for (var i = 0; i < 30; i++) new Point(i, i);
Object.defineProperty(Point.prototype, "tag", { set: function (v) { setterRuns++; }, get: function () { return "proto"; }, configurable: true });
for (var i = 0; i < 30; i++) {
  var p = new Point(i, i);
  check(keys(p) === "x,y" && p.tag === "proto", "setter keys " + i + " " + keys(p));
}
check(setterRuns === 30, "setter runs " + setterRuns);

// A non-writable prototype property blocks the add (sloppy mode: silently).
function Frozen(a) { this.k = a; this.m = 2; }
for (var i = 0; i < 30; i++) check(new Frozen(i).k === i, "frozen before " + i);
Object.defineProperty(Frozen.prototype, "k", { value: "fixed", writable: false, configurable: true });
for (var i = 0; i < 30; i++) {
  var f = new Frozen(i);
  check(f.k === "fixed" && keys(f) === "m", "frozen after " + i + " " + keys(f));
}

// Repeated keys keep their first position.
function Twice(a) { this.a = a; this.b = 1; this.a = a + 1; }
for (var i = 0; i < 30; i++) { var t = new Twice(i); check(keys(t) === "a,b" && t.a === i + 1, "twice " + i); }

// Redefining initialize on the prototype is seen by the next construction.
for (var i = 0; i < 20; i++) new Vector(i, i, i);
Vector.prototype.initialize = function (x) { this.only = x; };
for (var i = 0; i < 20; i++) { var v = new Vector(i); check(keys(v) === "only" && v.only === i, "redefined " + i); }

// Subclasses and returning constructors keep their own paths.
class Base { constructor(a) { this.a = a; this.b = a * 2; } }
class Derived extends Base { constructor(a) { super(a); this.c = 3; } }
for (var i = 0; i < 30; i++) {
  var b = new Base(i), d = new Derived(i);
  check(keys(b) === "a,b" && b.b === i * 2 && keys(d) === "a,b,c" && d instanceof Base, "classes " + i);
}

if (typeof gc == "function") gc();
console.log(failures == 0 ? "PASS construct frameless" : "FAIL construct frameless " + failures);
if (failures != 0) throw new Error("frameless construction regressions");
