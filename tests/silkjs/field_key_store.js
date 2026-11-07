// Stores through put_field and the fused put_loc_field forms keep an inline
// key (shape version and slot, or an add's memo index): each case changes
// what a warmed-up store site must see.
var out = [];

function set(o, v) { o.x = v; }
function loop(fn, n) { for (var i = 0; i < n; i++) fn(i); }

// Overwrite, then the same site on another shape, then a frozen object.
var a = { x: 0 }, b = { y: 1, x: 0 };
loop(function (i) { set(a, i); set(b, i * 2); }, 50);
out.push(a.x, b.x);
Object.freeze(a);
set(a, 99);
out.push(a.x);
var strict = (function () { "use strict"; return function (o, v) { o.x = v; }; })();
try { strict(a, 5); out.push("no throw"); } catch (e) { out.push(e instanceof TypeError); }

// The property becomes read-only, then an accessor, under a warm key.
var c = { x: 1 };
loop(function (i) { set(c, i); }, 30);
Object.defineProperty(c, "x", { writable: false });
set(c, 1000);
out.push(c.x);
var d = { x: 1 };
loop(function (i) { set(d, i); }, 30);
var seen = 0;
Object.defineProperty(d, "x", { get: function () { return -seen; }, set: function (v) { seen = v; } });
set(d, 7);
out.push(seen, d.x);

// Delete and re-add the key: the slot moves.
var e = { w: 1, x: 2, z: 3 };
loop(function (i) { set(e, i); }, 30);
delete e.w;
set(e, 42);
out.push(JSON.stringify(e));

// Adds: a warm add site, then a setter appears on the prototype.
function Point(x, y) { this.x = x; this.y = y; }
var pts = [];
loop(function (i) { pts.push(new Point(i, -i)); }, 40);
out.push(pts[39].x + pts[39].y, Object.keys(pts[5]).join());
var log = [];
Object.defineProperty(Point.prototype, "y", { set: function (v) { log.push(v); }, configurable: true });
var p = new Point(1, 2);
out.push(log.join(), p.hasOwnProperty("y"));
delete Point.prototype.y;
p = new Point(3, 4);
out.push(p.y, p.hasOwnProperty("y"));

// An add site that then meets a non-extensible object and objects with the key.
function addZ(o, v) { o.z = v; }
loop(function (i) { var o = { k: i }; addZ(o, i); }, 30);
var sealed = Object.preventExtensions({ k: 1 });
addZ(sealed, 5);
out.push(sealed.z, "z" in sealed);
var has = { k: 1, z: 0 };
addZ(has, 6);
out.push(has.z, Object.keys(has).join());

// Fused stores of a local's or an argument's value into a local's object.
function fill(n) {
  var obj = { v: 0 }, val = 0, res = [];
  for (var i = 0; i < n; i++) { val = i * 3; obj.v = val; res.push(obj.v); }
  return res[n - 1];
}
function fillArg(v) { var obj = { v: 0 }; obj.v = v; return obj.v; }
var total = 0;
loop(function (i) { total += fillArg(i); }, 40);
out.push(fill(25), total);

// Polymorphic store site.
var shapes = [{ x: 0 }, { a: 1, x: 0 }, { a: 1, b: 2, x: 0 }, { x: 0, a: 1 }];
loop(function (i) { set(shapes[i & 3], i); }, 64);
out.push(shapes.map(function (s) { return s.x; }).join());

// Array length through put_field, and a constructor with a conditional store.
var arr = [1, 2, 3, 4, 5];
loop(function (i) { arr.length = 5 - (i % 3); }, 10);
out.push(arr.length);
function Cond(a, b) { this.a = a; this.b = b ? 1 : 2; }
var conds = [];
loop(function (i) { conds.push(new Cond(i, i & 1)); }, 20);
out.push(conds[19].a, conds[19].b, conds[18].b);

var expected = "49,98,49,true,29,7,-7,{\"x\":42,\"z\":3},0,x,y,2,false,4,true,,false,6,k,z,72,780,60,61,62,63,5,19,1,2";
var got = out.join();
if (got !== expected) throw new Error("got " + got);
console.log("PASS inline store keys");
