// Small planned constructors move each argument once, including permutations.
function One(a) { this.a = a; }
function Two(a, b) { this.a = b; this.b = a; }
function Three(a, b, c) { this.a = c; this.b = a; this.c = b; }
function Four(a, b, c, d) { this.a = d; this.b = b; this.c = a; this.d = c; }
function Shared(a, b) { this.a = a; this.b = a; this.c = b; }
function assert(ok) { if (!ok) throw new Error('planned small constructor'); }
var cases = [undefined, null, true, -17, 1.25, 'word', {v: 6}, [7], function () { return 8; }, 9n, Symbol('ten')];
for (var i = 0; i < 500; i++) {
  var a = cases[i % cases.length], b = {v: i}, c = ['c', i], d = 'd' + i;
  var one = new One(a), two = new Two(a, b), three = new Three(a, b, c), four = new Four(a, b, c, d);
  assert(one.a === a && two.a === b && two.b === a);
  assert(three.a === c && three.b === a && three.c === b);
  assert(four.a === d && four.b === b && four.c === a && four.d === c);
  assert(Object.keys(three).join(',') === 'a,b,c');
  var shared = new Shared(b, c); assert(shared.a === shared.b && shared.a.v === i && shared.c === c);
  var few = new Three(a), extra = new Three(a, b, c, {unused: i});
  assert(few.a === undefined && few.b === a && few.c === undefined);
  assert(extra.a === c && extra.b === a && extra.c === b);
}
// Keep objects alive across unrelated allocations and later release shared trees.
var tree = null;
for (var j = 0; j < 1000; j++) tree = new Three(tree, {v: j}, tree);
for (var k = 999; k >= 0; k--) { assert(tree.a === tree.b && tree.c.v === k); tree = tree.b; }
assert(tree === null);
console.log('PASS planned small constructors');
