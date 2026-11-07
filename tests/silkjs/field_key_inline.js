// SilkJS regression test for the inline field-cache key that final get_field,
// get_loc_field8 and get_arg_field8 carry after their atom
// (js_vm_property_ops.readFieldKeyedAt): one site seeing many shapes, shapes
// changed under a cached key (delete, accessor, freeze), prototype and string
// receivers, and the accessor leaf forms that read through the key.
const out = [];
function getX(o) { return o.x }
const shapes = [{ x: 1 }, { y: 0, x: 2 }, { x: 3, y: 0 }, { z: 0, y: 0, x: 4 }];
let sum = 0;
for (let i = 0; i < 40; i++) sum += getX(shapes[i % 4]);
out.push(sum);
const o = { a: 1, x: 5 };
const first = getX(o); delete o.a; const second = getX(o);
Object.defineProperty(o, 'x', { get() { return 7 } });
out.push([first, second, getX(o)].join());
const p = { x: 8 }; getX(p); Object.freeze(p); out.push(getX(p));
const proto = { x: 9 }; const child = Object.create(proto);
out.push([getX(child), getX(child)].join());
proto.x = 10; out.push(getX(child));
child.x = 11; out.push([getX(child), getX(proto)].join());
String.prototype.x = 'sx'; out.push([getX('s'), getX('t')].join()); delete String.prototype.x;
out.push(getX('s'));
function viaLocal() { const q = shapes[1]; return q.x + q.y }
function viaArg(q) { return q.x }
out.push([viaLocal(), viaLocal(), viaArg(shapes[2]), viaArg(shapes[3]), viaArg({ x: 'a' })].join());
class P {
  constructor(f, g) { this.f = f; this.g = g }
  get plain() { return this.f }
  get len() { return this.f.length }
  pick(k) { return this.f === k ? this.g : this.f }
  fwd() { return this.g.plainOf() }
}
const a = new P([1, 2, 3], { plainOf() { return 'fw' } });
let s = '';
for (let i = 0; i < 3; i++) s += [a.plain.length, a.len, a.pick(a.f), a.fwd()].join('/') + ';';
out.push(s);
const b = new P('one', 'two'); out.push([b.plain, b.len, b.pick('one'), b.pick('x')].join());
const holder = { v: 1 }; let total = 0;
for (let i = 0; i < 1000; i++) { if (i === 500) { holder.w = 0; delete holder.v; holder.v = 2 } total += holder.v }
out.push(total);
const evaluated = (0, eval)('(function(o) { return o.k })');
out.push([evaluated({ k: 1 }), evaluated({ j: 0, k: 2 }), evaluated({ k: 3 })].join());
const got = out.join('\n');
const expected = "100\n5,5,7\n8\n9,9\n10\n11,10\nsx,sx\n\n2,2,3,4,a\n3/3/[object Object]/fw;3/3/[object Object]/fw;3/3/[object Object]/fw;\none,3,two,one\n1500\n1,2,3";
console.log(got === expected ? 'PASS inline field keys' : 'FAIL ' + JSON.stringify(got));
if (got !== expected) throw new Error('inline field key regressions');
