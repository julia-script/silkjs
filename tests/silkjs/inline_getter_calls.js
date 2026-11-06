// Bytecode getters read through get_field, get_loc_field8 and get_arg_field8
// run as inline calls (js_vm.enterGetter). Covers own, class and inherited
// getters, leaf and non-leaf bodies, `this`, throws, recursion, getters that
// change the object, and lookups that must not take the getter path.
function assert(actual, expected, message) {
  if (actual !== expected) throw new Error(message + ": expected " + expected + ", got " + actual);
}
var own = { _x: 2, get x() { return this._x; }, get twice() { var t = this._x; t = t * 2; return t; } };
class Point {
  constructor(x, y) { this.x = x; this.y = y; }
  get sum() { return this.x + this.y; }
  get norm() { var s = this.x * this.x + this.y * this.y; return Math.sqrt(s); }
}
class Point3 extends Point {
  constructor(x, y, z) { super(x, y); this.z = z; }
  get sum3() { return this.sum + this.z; }
}
var deep = Object.create(Object.create(Object.create(own)));
var counter = { n: 0, get next() { this.n++; return this.n; } };
var thrower = { get bad() { throw new Error("from getter"); } };
var shadow = Object.defineProperty(Object.create(own), "x", { value: "data" });
var nested = { depth: 0, get down() { if (this.depth >= 50) return this.depth; this.depth++; return this.down; } };
var native = Object.defineProperty({}, "len", { get: Array.prototype.join.bind([1, 2, 3]) });
var setterOnly = Object.defineProperty({}, "w", { set: function (v) {} });

function fromLocal(p) { var q = p; return q.sum; }
function fromArg(p) { return p.norm; }
function fromStack(make) { return make().sum; }
function readMany(o) { var s = 0; for (var i = 0; i < 5; i++) { s += o.x; s += o.twice; } return s; }

var out = [];
for (var round = 0; round < 3; round++) {
  var p = new Point(3, 4), r = new Point3(1, 2, 3);
  out.push(own.x, own.twice, p.sum, p.norm, r.sum, r.sum3, fromLocal(p), fromArg(p),
    fromStack(function () { return new Point(5, 6); }), readMany(own), deep.x, deep.twice, shadow.x);
  counter.n = 0;
  out.push(counter.next + counter.next * 10);
  try { out.push(thrower.bad); } catch (e) { out.push("caught " + e.message); }
  try { (function (t) { var v = t.bad; out.push(v); })(thrower); } catch (e) { out.push("caught2 " + e.message); }
  nested.depth = 0;
  out.push(nested.down, native.len, setterOnly.w);
  var holder = { get self() { return this; } };
  out.push(holder.self === holder);
  "abc".length;
  out.push(Object.getOwnPropertyDescriptor(Point.prototype, "sum").get.call({ x: 1, y: 1 }));
}
var expected = [2, 4, 7, 5, 3, 6, 7, 5, 11, 30, 2, 4, "data", 21, "caught from getter", "caught2 from getter", 50, "1,2,3", undefined, true, 2];
var all = [];
for (var k = 0; k < 3; k++) all = all.concat(expected);
assert(out.length, all.length, "result count");
for (var j = 0; j < all.length; j++) assert(out[j], all[j], "result " + j);
console.log("ok");
