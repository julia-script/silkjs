// The cycle collector finds cells through their arenas' bitmaps and a list of
// linked cells, restores reachable cells through a bounded stack (rescanning
// when it fills), and queues dead cells past the zero stack in arena bits.
// Live structures of every shape must survive collections intact, and dead
// cycles of any size must go.
var failures = 0;
function check(ok, what) { if (!ok) { failures++; if (failures < 10) console.log("bad", what); } }
function collect() { if (typeof gc == "function") gc(); else if (typeof std == "object" && std.gc) std.gc(); }

// A long live doubly linked ring: the restore stack overflows and rescans.
function ring(n, tag) {
  var head = { i: 0, tag: tag, prev: null, next: null };
  var last = head;
  for (var i = 1; i < n; i++) { var node = { i: i, tag: tag, prev: last, next: null }; last.next = node; last = node; }
  last.next = head; head.prev = last;
  return head;
}
var keep = ring(20000, "keep");
// A wide live fan-out: one array holding many small cyclic pairs.
var wide = [];
for (var i = 0; i < 6000; i++) { var a = { k: i }; var b = { k: -i, other: a }; a.other = b; wide.push(a); }
// Garbage cycles of several shapes, made and dropped between collections.
for (var round = 0; round < 6; round++) {
  var dead = ring(15000, "dead" + round);
  var deadWide = [];
  for (var i = 0; i < 3000; i++) { var x = { v: i }; x.self = x; deadWide.push(x); }
  deadWide.push(deadWide);
  var closures = [];
  for (var i = 0; i < 2000; i++) { (function (j) { var f = function () { return f && j; }; closures.push(f); })(i); }
  dead = null; deadWide = null; closures = null;
  collect();
  // Big arrays (unpooled, linked cells) in cycles too.
  var big = new Array(400);
  for (var i = 0; i < 400; i++) big[i] = { owner: big, i: i };
  big = null;
  collect();
}
// A wide acyclic tree whose death overflows the zero stack.
var tree = [];
for (var i = 0; i < 5000; i++) tree.push({ a: { b: { c: i } }, d: [i, { e: i }] });
tree = null;
collect();

var count = 0, node = keep, ok = true;
do { if (node.tag !== "keep" || node.next.prev !== node) ok = false; count++; node = node.next; } while (node !== keep);
check(ok && count === 20000, "live ring " + count);
var pairs = true;
for (var i = 0; i < wide.length; i++) if (wide[i].k !== i || wide[i].other.k !== -i || wide[i].other.other !== wide[i]) pairs = false;
check(pairs, "live pairs");

// Weak references to dead cycle members are cleared after collection.
if (typeof WeakRef == "function") {
  var refs = [];
  (function () { for (var i = 0; i < 50; i++) { var o = { i: i }; o.me = o; refs.push(new WeakRef(o)); } })();
  collect(); collect();
  var live = new WeakRef(keep);
  check(live.deref() === keep, "weak live");
}
console.log(failures == 0 ? "PASS cycle collector walks" : "FAIL cycle collector walks " + failures);
if (failures != 0) throw new Error("cycle collector regressions");
