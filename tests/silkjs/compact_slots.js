// Exercise the same access sites across inline, grown, and separate slot storage.
function check(ok, message) { if (!ok) throw new Error(message); }
function Pair(a, b) { this.a = a; this.b = b; }
function read(o) { return o.a; }
function write(o, v) { o.b = v; }
function leaf() { return this.a; }
function fused(o, v) { o.a = v; return o.a; }
var keep = [];
for (var round = 0; round < 300; round++) {
  var small = new Pair({ n: round }, 's' + round);
  var grown = new Pair({ n: round + 1 }, 'g' + round);
  for (var i = 0; i < 20; i++) grown['p' + i] = { n: i };
  for (var i = 0; i < 20; i++) delete grown['p' + i];
  var plain = { a: { n: round + 2 }, b: 'p' + round };
  var array = []; array.a = { n: round + 3 }; array.b = 'a' + round;
  var variants = [small, grown, plain, array];
  for (var j = 0; j < variants.length; j++) {
    var o = variants[j];
    check(read(o).n === round + j, 'cached read ' + j);
    check(leaf.call(o).n === round + j, 'leaf read ' + j);
    var value = { n: round * 4 + j };
    write(o, value);
    check(o.b === value, 'cached write ' + j);
    check(fused(o, value) === value, 'fused read/write ' + j);
    var child = Object.create(o);
    check(read(child) === value, 'inherited read ' + j);
    Object.defineProperty(o, 'a', { get: leaf.bind({ a: value }), configurable: true });
    check(read(child) === value, 'getter after cache ' + j);
    Object.defineProperty(o, 'a', { value: value, writable: true, configurable: true });
    check(read(child) === value, 'data after getter ' + j);
  }
  small.b = grown; grown.b = small;
  if (round % 30 === 0) keep.push(small);
  if (typeof gc === 'function' && round % 20 === 0) gc();
}
if (typeof gc === 'function') gc();
for (var k = 0; k < keep.length; k++) {
  check(keep[k].b.b === keep[k], 'retained cycle');
  check(keep[k].a.n === k * 120, 'retained slot');
}
console.log('PASS compact slots');
