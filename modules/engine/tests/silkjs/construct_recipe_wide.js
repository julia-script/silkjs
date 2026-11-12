// SilkJS regression test for construct recipes with more than 8 stores
// (js_construct_eval STORES_MAX 16): 9 to 16 stores take the recipe, 17 and up
// the frame; fields plus stores, repeated keys, conditional values, object
// literals as values, and a setter added on the prototype after the plan.
const out = [];
function log(...args) { out.push(args.join(' ')) }
function mk(n) { let s = 'return class { constructor(a, b) {'; for (let i = 0; i < n; i++) s += ` this.p${i} = ${i % 3 === 0 ? 'a' : i % 3 === 1 ? i : 'b ? ' + i + ' : "z"'};`; return new Function(s + ' } }')() }
for (const n of [8, 9, 12, 15, 16, 17, 20]) { const C = mk(n); let o; for (let i = 0; i < 6; i++) o = new C(i, i & 1); log(n, JSON.stringify(o)); }
class F { #x = 1; y = 2; constructor(a) { this.a0 = a; this.a1 = 1; this.a2 = 2; this.a3 = 3; this.a4 = 4; this.a5 = 5; this.a6 = 6; this.a7 = 7; this.a8 = 8; this.a9 = 9; this.b0 = 10; this.b1 = 11; this.b2 = 12; this.b3 = 13 } x() { return this.#x } }
let f; for (let i = 0; i < 6; i++) f = new F(i); log(JSON.stringify(f), f.x(), Object.keys(f).length);
class G { constructor(a) { this.p = a; this.q = 1; this.r = 2; this.s = 3; this.t = 4; this.u = 5; this.v = 6; this.w = 7; this.x = 8; this.p = 9; this.y = 10 } }
let g; for (let i = 0; i < 6; i++) g = new G(i); log(JSON.stringify(g));
class H { constructor(a) { this.a = a; this.b = a; this.c = a; this.d = a; this.e = a; this.f = a; this.g = a; this.h = a; this.i = a; this.j = { k: a } } }
let h; for (let i = 0; i < 6; i++) h = new H(i); log(JSON.stringify(h));
class P { constructor() { this.a = 1; this.b = 2; this.c = 3; this.d = 4; this.e = 5; this.f = 6; this.g = 7; this.h = 8; this.i = 9; this.j = 10 } }
for (let i = 0; i < 4; i++) new P(); Object.defineProperty(P.prototype, 'e', { set(v) { log('setter', v) } }); log(JSON.stringify(new P()));
const got = out.join('\n');
const expected = "8 {\"p0\":5,\"p1\":1,\"p2\":2,\"p3\":5,\"p4\":4,\"p5\":5,\"p6\":5,\"p7\":7}\n9 {\"p0\":5,\"p1\":1,\"p2\":2,\"p3\":5,\"p4\":4,\"p5\":5,\"p6\":5,\"p7\":7,\"p8\":8}\n12 {\"p0\":5,\"p1\":1,\"p2\":2,\"p3\":5,\"p4\":4,\"p5\":5,\"p6\":5,\"p7\":7,\"p8\":8,\"p9\":5,\"p10\":10,\"p11\":11}\n15 {\"p0\":5,\"p1\":1,\"p2\":2,\"p3\":5,\"p4\":4,\"p5\":5,\"p6\":5,\"p7\":7,\"p8\":8,\"p9\":5,\"p10\":10,\"p11\":11,\"p12\":5,\"p13\":13,\"p14\":14}\n16 {\"p0\":5,\"p1\":1,\"p2\":2,\"p3\":5,\"p4\":4,\"p5\":5,\"p6\":5,\"p7\":7,\"p8\":8,\"p9\":5,\"p10\":10,\"p11\":11,\"p12\":5,\"p13\":13,\"p14\":14,\"p15\":5}\n17 {\"p0\":5,\"p1\":1,\"p2\":2,\"p3\":5,\"p4\":4,\"p5\":5,\"p6\":5,\"p7\":7,\"p8\":8,\"p9\":5,\"p10\":10,\"p11\":11,\"p12\":5,\"p13\":13,\"p14\":14,\"p15\":5,\"p16\":16}\n20 {\"p0\":5,\"p1\":1,\"p2\":2,\"p3\":5,\"p4\":4,\"p5\":5,\"p6\":5,\"p7\":7,\"p8\":8,\"p9\":5,\"p10\":10,\"p11\":11,\"p12\":5,\"p13\":13,\"p14\":14,\"p15\":5,\"p16\":16,\"p17\":17,\"p18\":5,\"p19\":19}\n{\"y\":2,\"a0\":5,\"a1\":1,\"a2\":2,\"a3\":3,\"a4\":4,\"a5\":5,\"a6\":6,\"a7\":7,\"a8\":8,\"a9\":9,\"b0\":10,\"b1\":11,\"b2\":12,\"b3\":13} 1 15\n{\"p\":9,\"q\":1,\"r\":2,\"s\":3,\"t\":4,\"u\":5,\"v\":6,\"w\":7,\"x\":8,\"y\":10}\n{\"a\":5,\"b\":5,\"c\":5,\"d\":5,\"e\":5,\"f\":5,\"g\":5,\"h\":5,\"i\":5,\"j\":{\"k\":5}}\nsetter 5\n{\"a\":1,\"b\":2,\"c\":3,\"d\":4,\"f\":6,\"g\":7,\"h\":8,\"i\":9,\"j\":10}";
console.log(got === expected ? 'PASS wide construct recipes' : 'FAIL ' + JSON.stringify(got));
if (got !== expected) throw new Error('wide construct recipe regressions');
