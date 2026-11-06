// Planned constructs whose stores cover every argument move them into the object.
function P(a, b) { this.a = a; this.b = b; }
function Q(a, b) { this.b = b; this.a = a; }
function S(a, b) { this.x = b; this.y = a; }
function D(a) { this.p = a; this.q = a; }
function Gap(a, b) { this.b = b; }
var out = [];
for (var round = 0; round < 3; round++) {
  var objs = [];
  for (var i = 0; i < 50; i++) {
    var inner = { k: i };
    objs.push(new P(inner, 'v' + i));
    objs.push(new Q([i], i * 2));
    objs.push(new S('s' + i, { n: i }));
    objs.push(new D({ d: i }));
    objs.push(new Gap({ g: i }, 'b' + i));
  }
  out.push(objs[0].a.k + ',' + objs[0].b + ',' + objs[1].a[0] + ',' + objs[1].b + ',' + objs[2].x.n + ',' + objs[2].y);
  out.push(objs[3].p === objs[3].q, objs[249].b, objs[248].p.d);
}
// fewer and more arguments than the plan covers
var few = new P({ z: 1 }); var many = new P(1, 2, { extra: 3 }, 4);
out.push(few.a.z, few.b === undefined, many.a, many.b);
// an uncovered store still starts Undefined in every reused cell
var undef = 0;
for (var u = 0; u < 60; u++) { var o = new P(u); if (o.b === undefined && o.a === u) undef++; }
out.push(undef);
var keep = [];
for (var j = 0; j < 30; j++) { var shared = { s: j }; keep.push(new P(shared, shared)); }
out.push(keep[29].a === keep[29].b, keep[29].a.s, Object.keys(keep[3]).join(''));
const got = out.join('|');
const expected = '0,v0,0,0,0,s0|true|b49|49|0,v0,0,0,0,s0|true|b49|49|0,v0,0,0,0,s0|true|b49|49|1|true|1|2|60|true|29|ab';
console.log(got === expected ? 'PASS planned construct cover' : 'FAIL ' + got);
if (got !== expected) throw new Error('planned construct cover regressions');
