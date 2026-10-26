// Object allocation, shapes, property access and method dispatch through prototypes.
class Vec {
  constructor(x, y) { this.x = x; this.y = y; }
  add(o) { return new Vec(this.x + o.x, this.y + o.y); }
  len2() { return this.x * this.x + this.y * this.y; }
}
let sum = 0;
let v = new Vec(0, 0);
const d = new Vec(1, 2);
for (let i = 0; i < 100000; i++) {
  v = v.add(d);
  const o = { a: i, b: i + 1, c: { d: i } };
  sum += o.a + o.b + o.c.d + (v.len2() & 1);
}
console.log(sum, v.x, v.y);
