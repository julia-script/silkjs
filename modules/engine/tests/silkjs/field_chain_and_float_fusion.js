// SilkJS regression test for the dispatch-free continuations in the VM:
// js_vm_property_ops.chainFields (a.b.c read in one step), js_vm_operators
// fusedProduct and fusedOperand (a load or a product followed by mul, add or
// sub on Float64 operands), and the global `undefined` compiled as a constant.
// Expected values come from V8.
var out = [];
function show(v) { return Object.is(v, -0) ? '-0' : typeof v === 'number' ? String(v) : typeof v + ':' + String(v); }
// Field chains: own slots, then a getter, a prototype field, a missing field, null, a string and a changed shape.
var leafObject = { d: 1.5, e: 's', n: null, z: -0 };
var o = { a: { b: { c: leafObject } }, x: 3 };
function chain(p) { var q = p; return [q.a.b.c.d, p.a.b.c.e, q.a.b.c.n, p.a.b.c.z, q.x, p.a.b.c.missing].map(show).join(); }
function throwing(p) { try { return p.a.b.c.n.k; } catch (e) { return e instanceof TypeError; } }
for (var i = 0; i < 3; i++) out.push(chain(o), throwing(o));
var proto = { inherited: { v: 9 } };
var withGetter = Object.create(proto, { a: { get: function () { return { b: { c: { d: 'got' + (this.count = (this.count | 0) + 1) } } }; }, enumerable: true } });
withGetter.own = { inherited: { v: 2.25 }, text: 'abc' };
function mixed(p) { var q = p; return [q.a.b.c.d, p.inherited.v, q.own.inherited.v, p.own.text.length, q.count].map(show).join(); }
for (var i = 0; i < 3; i++) out.push(mixed(withGetter));
function reshape(p, k) { var q = p; if (k) { q.a.b = { extra: 1, c: { first: 0, d: 'moved' } }; } return show(q.a.b.c.d); }
out.push(reshape(o, 0), reshape(o, 0), reshape(o, 1), reshape(o, 0));
function temp(p) { var q = p; return show(q.make.inner.value) + show(p.make.inner.value); }
var maker = { n: 0, get make() { return { inner: { value: ++this.n + 0.5 } }; } };
for (var i = 0; i < 3; i++) out.push(temp(maker));
// Fused arithmetic: Float64, Int, mixed, strings, objects with valueOf, NaN, infinities and signed zeros.
function sum(a, b, c) { var x = a, y = b, z = c; return show(z + x * y) + show(z - x * y) + show(x * y + z) + show(x * y - z) + show(x - y) + show(x + y) + show(x * y * z); }
function fields(v, w) { var p = v, q = w; return show(p.x * q.x + p.y * q.y) + show(p.x * q.y - p.y * q.x) + show(p.x - q.x) + show(p.y + q.s) + show(q.s + p.x * p.y) + show(p.x * q.s); }
var counter = 0, box = { valueOf: function () { counter++; return 2.5; } };
var numbers = [[1.5, 2.5, 0.25], [2, 3, 4], [0.1, 0.2, 0.3], [-0, 5.5, -0], [0, -5.5, 0], [1e308, 10.5, -Infinity], [NaN, 1.5, 2.5], [1.5, 2, 'x'], ['2', 1.5, 0.5], [box, 1.5, box], [2.5, 3n === 3n ? 1.5 : 0, null], [1.5, undefined, 2.5], [0.5, 2147483647, 2147483647]];
for (var i = 0; i < numbers.length; i++) out.push(sum(numbers[i][0], numbers[i][1], numbers[i][2]));
var vectors = [[{ x: 1.5, y: 2.5, s: 'str' }, { x: 0.5, y: -0.25, s: 2.5 }], [{ x: 3, y: 4, s: 0.5 }, { x: 0.5, y: 2, s: 'q' }], [{ x: -0, y: 0.5, s: box }, { x: 0, y: -0, s: box }]];
for (var k = 0; k < 2; k++) for (var i = 0; i < vectors.length; i++) out.push(fields(vectors[i][0], vectors[i][1]));
out.push(counter);
function big(a, b) { var x = a, y = b; try { return show(x * y) + show(x - y); } catch (e) { return e instanceof TypeError; } }
out.push(big(3n, 4n), big(3n, 1.5), big(1.5, 3n));
// The global undefined: comparisons, typeof, shadowing by a parameter, a local and an eval var.
function test(p) { if (p === undefined) p = 4; return (p == undefined ? 1 : p !== undefined ? typeof undefined + p : 0); }
function shadow(undefined) { return undefined; }
function local() { var undefined = 7; return undefined; }
function evalVar() { eval('var undefined = 8'); return undefined; }
function withScope(w) { with (w) { return undefined; } }
out.push(test(), test(2), test(null), shadow(5), local(), evalVar(), withScope({ undefined: 9 }), withScope({}), void 0 === undefined, [undefined].length, show(undefined + 1));
try { undefined = 3; } catch (e) { out.push('threw'); }
out.push(undefined, (function () { 'use strict'; try { undefined = 3; return 'no throw'; } catch (e) { return e instanceof TypeError; } })());
const got = out.join('|');
const expected = '1.5,string:s,object:null,-0,3,undefined:undefined|true|1.5,string:s,object:null,-0,3,undefined:undefined|true|1.5,string:s,object:null,-0,3,undefined:undefined|true|string:got1,9,2.25,3,1|string:got2,9,2.25,3,2|string:got3,9,2.25,3,3|1.5|1.5|string:moved|string:moved|1.52.5|3.54.5|5.56.5|4-3.543.5-140.9375|10-2102-1524|0.320.279999999999999970.32-0.27999999999999997-0.10.300000000000000040.006000000000000001|-00-00-5.55.50|000-05.5-5.5-0|NaN-InfinityNaNInfinity1e+3081e+308-Infinity|NaNNaNNaNNaNNaNNaNNaN|string:x3NaNstring:3xNaN-0.53.5NaN|3.5-2.53.52.50.5string:21.51.5|6.25-1.256.251.25149.375|3.75-3.753.753.75140|NaNNaNNaNNaNNaNNaNNaN|3221225470.51073741823.53221225470.5-1073741823.5-2147483646.52147483647.52305843007066210300|0.125-1.625156.253.75|9.542.5string:4qstring:q12NaN|-00-032.5-0|0.125-1.625156.253.75|9.542.5string:4qstring:q12NaN|-00-032.5-0|18|bigint:12bigint:-1|true|true|undefined4|undefined2|1|5|7|8|9||true|1|NaN||true';
console.log(got === expected ? 'PASS field chain and float fusion' : 'FAIL ' + got);
if (got !== expected) throw new Error('field chain and float fusion regressions');
