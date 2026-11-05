// Object literals whose site has run before are born with the shape their
// leading fields end with, slots filled in place as the fields run. Key order,
// repeated keys, getters and spreads after the fields, values that throw or
// suspend, and later changes to one object must all behave as in V8.
var failures = 0;
function check(ok, what) { if (!ok) { failures++; if (failures < 10) console.log("bad", what); } }
function keys(o) { return Object.keys(o).join(","); }

function pair(a, b) { return { left: a, right: b }; }
function leaf(tag) { return { array: [0, 1, 2], string: "key " + tag + " leaf", n: tag * 2 }; }
function tree(depth, tag) { return depth == 0 ? leaf(tag) : { left: tree(depth - 1, tag), right: tree(depth - 1, tag + 1) }; }

for (var i = 0; i < 300; i++) {
  var p = pair(i, "x" + i);
  check(keys(p) === "left,right" && p.left === i && p.right === "x" + i, "pair " + i);
  var t = tree(3, i);
  check(t.left.left.left.n === i * 2 && t.right.right.right.string === "key " + (i + 3) + " leaf", "tree " + i);
  check(JSON.stringify(leaf(i)) === '{"array":[0,1,2],"string":"key ' + i + ' leaf","n":' + (i * 2) + '}', "json " + i);
}

// Repeated keys keep the first position and the last value.
function repeated(x) { return { a: x, b: 2, a: x + 1, c: 3 }; }
for (var i = 0; i < 50; i++) {
  var r = repeated(i);
  check(keys(r) === "a,b,c" && r.a === i + 1 && r.b === 2, "repeated " + i);
}

// Fields before a getter, a method, a spread, a computed key and __proto__.
var proto = { inherited: 1 };
function mixed(x, extra, key) {
  return { a: x, b: x + 1, get g() { return this.a * 10; }, m() { return this.b; }, ...extra, [key]: 7, z: 9 };
}
function withProto(x) { return { a: x, __proto__: proto, b: 2 }; }
for (var i = 0; i < 60; i++) {
  var extra = i % 2 ? { s: 1, a: -1 } : { t: 2 };
  var m = mixed(i, extra, i % 3 ? "k" : "a");
  var expected = i % 2 ? "a,b,g,m,s" : "a,b,g,m,t";
  if (!(i % 3)) expected = expected; else expected += ",k";
  expected += ",z";
  check(keys(m) === expected, "mixed keys " + i + " " + keys(m));
  check(m.g === m.a * 10 && m.m() === i + 1 && m.z === 9, "mixed values " + i);
  if (!(i % 3)) check(m.a === 7, "computed overwrite " + i);
  var w = withProto(i);
  check(keys(w) === "a,b" && w.inherited === 1 && Object.getPrototypeOf(w) === proto, "proto " + i);
}

// Setters on Object.prototype do not run for literal fields.
var setterRuns = 0;
Object.defineProperty(Object.prototype, "watched", { set: function (v) { setterRuns++; }, get: function () { return "proto"; }, configurable: true });
function watchedLiteral(v) { return { watched: v, other: 1 }; }
for (var i = 0; i < 40; i++) {
  var o = watchedLiteral(i);
  check(o.watched === i && o.hasOwnProperty("watched"), "watched " + i);
}
check(setterRuns === 0, "setter ran " + setterRuns);
delete Object.prototype.watched;

// A value that throws leaves no half-built object behind; later runs are whole.
function risky(x) { if (x % 7 == 3) throw new Error("boom"); return x; }
function guarded(x) { return { a: x, b: risky(x), c: x * 3 }; }
var thrown = 0;
for (var i = 0; i < 70; i++) {
  try { var g = guarded(i); check(keys(g) === "a,b,c" && g.b === i && g.c === i * 3, "guarded " + i); }
  catch (e) { thrown++; }
}
check(thrown === 10, "thrown " + thrown);

// A generator suspended inside a literal resumes into the same object.
function* gen() { while (true) { var o = { a: 1, b: yield 0, c: 3 }; yield o; } }
var it = gen();
for (var i = 0; i < 20; i++) {
  it.next();
  var o = it.next(i).value;
  check(keys(o) === "a,b,c" && o.b === i && o.c === 3, "generator " + i);
}

// Changing one object (freeze, delete, add, redefine) leaves the next ones alone.
function point(x, y) { return { x: x, y: y }; }
var frozen = point(1, 2);
Object.freeze(frozen);
var deleted = point(3, 4);
delete deleted.x;
var grown = point(5, 6);
grown.z = 7;
var redefined = point(8, 9);
Object.defineProperty(redefined, "y", { get: function () { return 99; } });
for (var i = 0; i < 50; i++) {
  var q = point(i, -i);
  q.x = q.x + 1;
  check(keys(q) === "x,y" && q.x === i + 1 && q.y === -i && !Object.isFrozen(q), "point " + i);
  var d = Object.getOwnPropertyDescriptor(q, "y");
  check(d.writable && d.enumerable && d.configurable, "descriptor " + i);
}
check(Object.isFrozen(frozen) && frozen.x === 1, "frozen");
check(keys(deleted) === "y" && keys(grown) === "x,y,z" && redefined.y === 99, "changed objects");

// Ternaries and nested calls inside values.
function choose(i) { return { kind: i % 2 ? "odd" : "even", half: Math.floor(i / 2), sub: pair(i, i % 3 ? null : { deep: i }) }; }
for (var i = 0; i < 60; i++) {
  var c = choose(i);
  check(keys(c) === "kind,half,sub" && c.kind === (i % 2 ? "odd" : "even") && c.half === Math.floor(i / 2), "choose " + i);
  check(i % 3 ? c.sub.right === null : c.sub.right.deep === i, "choose sub " + i);
}

if (typeof gc == "function") gc();
for (var i = 0; i < 30; i++) check(keys(pair(i, i)) === "left,right", "after gc " + i);
console.log(failures == 0 ? "PASS object literal shapes" : "FAIL object literal shapes " + failures);
if (failures != 0) throw new Error("object literal shape regressions");
