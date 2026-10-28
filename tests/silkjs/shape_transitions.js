// SilkJS regression test for shape transitions reused across objects: adds after
// deletes, prototype swaps, flag changes, many distinct shapes (parked shapes are
// destroyed and their memory reused) and large shapes grown in place. Every object
// must keep exactly its own keys, order, values and flags; results must match QuickJS.
const out = [];
function describe(o) {
  return Object.getOwnPropertyNames(o).map(k => {
    const d = Object.getOwnPropertyDescriptor(o, k);
    return k + "=" + String(d.value) + (d.writable ? "w" : "") + (d.enumerable ? "e" : "") + (d.configurable ? "c" : "");
  }).join(",");
}
for (let round = 0; round < 3; round++) {
  const a = { x: 1, y: 2 };
  const b = { x: 3 }; b.y = 4;
  const c = { y: 5 }; c.x = 6;
  delete a.y; a.z = 7; a.y = 8;
  Object.setPrototypeOf(b, null); b.w = 9;
  const d = {}; Object.defineProperty(d, "x", { value: 1, writable: false, enumerable: true, configurable: true }); d.y = 2;
  const e = {}; e.x = 1; e.y = 2;
  out.push(describe(a), describe(b), describe(c), describe(d), describe(e));
}
let sum = 0;
for (let i = 0; i < 4000; i++) {
  const o = {};
  o["k" + (i % 700)] = i;
  o.tail = i;
  if (i % 3 === 0) delete o.tail;
  o.after = 1;
  sum += Object.keys(o).length * 7 + (o.tail === undefined ? 1 : 0);
}
out.push(sum);
const big = {};
for (let i = 0; i < 40; i++) big["p" + i] = i;
const big2 = {};
for (let i = 0; i < 41; i++) big2["p" + i] = -i;
big.p40 = "own";
out.push(describe(big).length, describe(big2).length, big.p40, big2.p40, Object.keys(big).join("").length);
class P { constructor(n) { this.a = n; if (n & 1) this.b = n; this.c = n; } }
const ps = [];
for (let i = 0; i < 10; i++) ps.push(describe(new P(i)));
out.push(ps.join("|"));
const got = JSON.stringify(out);
const expected = '["x=1wec,z=7wec,y=8wec","x=3wec,y=4wec,w=9wec","y=5wec,x=6wec","x=1ec,y=2wec","x=1wec,y=2wec","x=1wec,z=7wec,y=8wec","x=3wec,y=4wec,w=9wec","y=5wec,x=6wec","x=1ec,y=2wec","x=1wec,y=2wec","x=1wec,z=7wec,y=8wec","x=3wec,y=4wec,w=9wec","y=5wec,x=6wec","x=1ec,y=2wec","x=1wec,y=2wec",75996,390,429,"own",-40,113,"a=0wec,c=0wec|a=1wec,b=1wec,c=1wec|a=2wec,c=2wec|a=3wec,b=3wec,c=3wec|a=4wec,c=4wec|a=5wec,b=5wec,c=5wec|a=6wec,c=6wec|a=7wec,b=7wec,c=7wec|a=8wec,c=8wec|a=9wec,b=9wec,c=9wec"]';
console.log(got === expected ? 'PASS shape transitions' : 'FAIL ' + got);
if (got !== expected) throw new Error('shape transition regressions');
