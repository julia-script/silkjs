// SilkJS regression test for planned constructs finished from the dispatch arm
// (constructStores) and objects reusing spare cells: plain store-only
// constructors called with fewer, exactly and more arguments than declared, an
// argument stored twice, constructors whose prototype changes between calls,
// a constructor used both as a plain call target and with new, cyclic garbage
// built from constructed objects (cells parked and reused), and a non-matching
// new.target through Reflect.construct. Expected values come from V8.
var r = [];
function P(a, b) { this.car = a; this.cdr = b; }
var list = null;
for (var i = 0; i < 2000; i++) list = new P(i, list);
var sum = 0, n = 0;
for (var q = list; q !== null; q = q.cdr) { sum += q.car; n++; }
r.push(sum, n);
var short = new P(7);
r.push(short.car, short.cdr === undefined, Object.keys(short).join(','));
var long = new P(1, 2, 3);
r.push(long.car + long.cdr, Object.keys(long).length);
function Twice(a) { this.x = a; this.y = a; }
var t = 0;
for (var i = 0; i < 500; i++) { var o = new Twice({ v: i }); t += o.x.v + (o.x === o.y ? 1 : 0); }
r.push(t);
function Q(a) { this.a = a; }
var first = new Q(1);
Q.prototype = { kind: 'second' };
var second = new Q(2);
r.push(first.kind === undefined, second.kind, second.a, first instanceof Q, second instanceof Q);
var holder = {};
P.call(holder, 'h', 'i');
r.push(holder.car + holder.cdr);
var live = 0;
for (var round = 0; round < 50; round++) {
  var ring = [];
  for (var i = 0; i < 200; i++) ring.push(new P(i, null));
  for (var i = 0; i < 200; i++) ring[i].cdr = ring[(i + 1) % 200];
  live += ring[round].cdr.car;
}
r.push(live);
function Base(v) { this.v = v; }
function Other() {}
Other.prototype.tag = 'other';
var made = Reflect.construct(Base, [5], Other);
r.push(made.v, made.tag, made instanceof Other);
var result = r.join('|');
var expected = '1999000|2000|7|true|car,cdr|3|2|125250|true|second|2|false|true|hi|1275|5|other|true';
console.log(result === expected ? 'PASS planned construct stores' : 'FAIL ' + result);
if (result !== expected) throw new Error('planned construct stores regressions');
