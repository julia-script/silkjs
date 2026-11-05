// A returning call frees the cycles among the variables its closures captured
// and those closures (a recursive local function is one) without waiting for
// a cycle collection. Closures that escape, or that something else still
// reaches, must keep working, and so must everything they capture.
var failures = 0;
function check(ok, what) { if (!ok) { failures++; if (failures < 10) console.log("bad", what); } }

// The plain case: a recursive local closure that dies with its frame.
function sumTo(n) {
  var loop = function (i, acc) { return i > n ? acc : loop(i + 1, acc + i); };
  return loop(0, 0);
}
for (var i = 0; i < 2000; i++) check(sumTo(i % 50) === (i % 50) * (i % 50 + 1) / 2, "sumTo " + i);

// Mutual recursion: two closures capturing each other's cells.
function parity(n) {
  var even = function (k) { return k === 0 ? true : odd(k - 1); };
  var odd = function (k) { return k === 0 ? false : even(k - 1); };
  return even(n);
}
for (var i = 0; i < 2000; i++) check(parity(i % 30) === (i % 30 % 2 === 0), "parity " + i);

// The recursive closure escapes: returned, stored, captured by an escaping one.
function counter(start) {
  var count = start;
  var next = function () { count++; return next; };
  return next;
}
var counters = [];
for (var i = 0; i < 500; i++) counters.push(counter(i));
for (var i = 0; i < counters.length; i++) check(counters[i]()()() === counters[i], "escaped self " + i);

function maker(tag) {
  var self = function () { return self; };
  var reader = function () { return tag + ":" + (self() === self); };
  return reader;
}
var readers = [];
for (var i = 0; i < 500; i++) readers.push(maker("t" + i));
for (var i = 0; i < readers.length; i++) check(readers[i]() === "t" + i + ":true", "reader " + i);

// Something outside the set holds the closure: an object, an array, its
// own prototype object (prototype.constructor points back).
var holders = [], protos = [];
function stash(i) {
  var f = function () { return f.mark; };
  f.mark = i;
  if (i % 2) holders.push({ f: f }); else holders.push([f]);
  return 0;
}
function withPrototype(i) {
  var C = function () { this.v = i; };
  C.prototype.get = function () { return this.v + (C === this.constructor ? 0 : 1000); };
  protos.push(C.prototype);
  return new C().get();
}
for (var i = 0; i < 400; i++) { stash(i); check(withPrototype(i) === i, "prototype " + i); }
for (var i = 0; i < holders.length; i++) {
  var f = (i % 2) ? holders[i].f : holders[i][0];
  check(f() === i, "held " + i);
}
for (var i = 0; i < protos.length; i++) check(new protos[i].constructor().get() === i, "proto ctor " + i);

// A dying cycle that also captured long-lived values: those stay intact.
var shared = { hits: 0 };
function touch(n) {
  var keep = shared, list = [n, n + 1];
  var walk = function (k) { if (k > 0) { keep.hits++; return walk(k - 1); } return list[0] + list[1]; };
  return walk(3);
}
for (var i = 0; i < 1000; i++) check(touch(i) === 2 * i + 1, "touch " + i);
check(shared.hits === 3000, "shared hits " + shared.hits);

// Many captured variables (more than the frame keeps track of) and nesting.
function wide(n) {
  var a = 1, b = 2, c = 3, d = 4, e = 5, f = 6, g = 7, h = 8, i = 9, j = 10, k = 11, l = 12, m = 13, o = 14, p = 15, q = 16, r = 17, s = 18;
  var rec = function (x) { return x <= 0 ? a + b + c + d + e + f + g + h + i + j + k + l + m + o + p + q + r + s : rec(x - 1); };
  var inner = function () { var deeper = function (y) { return y ? deeper(y - 1) : rec(n); }; return deeper(2); };
  return inner();
}
for (var i = 0; i < 300; i++) check(wide(i % 7) === 171, "wide " + i);

// Weak references see the cycle's closure go away only once it is unreachable.
var weak = [], live = [];
function weakCycle(i) {
  var f = function () { return f; };
  weak.push(new WeakRef(f));
  if (i % 3 == 0) live.push(f);
  return 0;
}
for (var i = 0; i < 300; i++) weakCycle(i);
for (var i = 0; i < 300; i += 3) check(weak[i].deref() === live[i / 3], "weak live " + i);

// Generators and async functions keep their own frames.
function* gen(n) { var again = function (k) { return k ? again(k - 1) : n; }; yield again(2); yield again(1); }
for (var i = 0; i < 200; i++) { var it = gen(i); check(it.next().value === i && it.next().value === i, "generator " + i); }

if (typeof gc == "function") gc();
for (var i = 0; i < counters.length; i++) check(counters[i]() === counters[i], "after gc " + i);
console.log(failures == 0 ? "PASS frame closure cycles" : "FAIL frame closure cycles " + failures);
if (failures != 0) throw new Error("frame closure cycle regressions");
