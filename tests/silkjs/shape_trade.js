// SilkJS regression test for adds that swap a dying shape with a parked one: fresh
// objects walk transition chains whose shapes are parked between uses, while other
// objects keep some of those shapes alive midway, drop them, or delete keys.
const out = [];
const held = [];
let total = 0;
for (let i = 0; i < 5000; i++) {
  const o = {}; o.p = i; o.q = i + 1;
  if (i % 5 === 0) { const h = {}; h.p = 1; h.q = 2; held.push(h); }
  o.r = 2; o.s = 3;
  if (i % 7 === 0) { const t = { p: 0 }; t.r = 1; held.push(t); }
  if (i % 11 === 0) { delete o.q; o.q = -1; }
  total += o.p + o.q + o.r + o.s + Object.keys(o).length;
  if (held.length > 40) {
    for (const h of held) total += Object.keys(h).join("").length;
    held.length = 0;
  }
}
for (const h of held) total += Object.keys(h).join("").length;
out.push(total);
class V { constructor(x, y) { this.x = x; this.y = y; } }
let vs = 0;
for (let i = 0; i < 3000; i++) { const v = new V(i, -i); if (i % 2) v.z = i; vs += v.x + v.y + (v.z | 0) + Object.keys(v).length; }
out.push(vs);
const got = JSON.stringify(out);
const expected = '[23911385,2257500]';
console.log(got === expected ? 'PASS shape trade' : 'FAIL ' + got);
if (got !== expected) throw new Error('shape trade regressions');
