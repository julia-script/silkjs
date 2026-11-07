// SilkJS regression test: a constructor body whose length matches the
// all-stores pattern (push_this put_loc0, then get_loc0 get_argK put_field per
// store) without being one must still be recognized as another construct form,
// and both must build the same objects as an ordinary call.
function Color(r, g, b) {
  if (!r) r = 0.0;
  if (!g) g = 0.0;
  if (!b) b = 0.0;
  this.red = r;
  this.green = g;
  this.blue = b;
}
function Pair(a, b) { this.a = a; this.b = b; }
var out = [];
var sum = 0;
for (var i = 0; i < 200; i++) {
  var c = new Color(i & 3, 0, i);
  var p = new Pair(i, c);
  sum += c.red + c.green + c.blue + p.a;
}
out.push(sum, JSON.stringify(new Color()), JSON.stringify(new Color(1, 2, 3)), Object.keys(new Pair(1, 2)).join());
var got = out.join('|');
var expected = '40100|{"red":0,"green":0,"blue":0}|{"red":1,"green":2,"blue":3}|a,b';
console.log(got === expected ? 'PASS construct form lengths' : 'FAIL ' + JSON.stringify(got));
if (got !== expected) throw new Error('construct form regression');
