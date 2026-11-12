// SilkJS regression test for class instance field initializers whose fields
// all get constants (js_bytecode.CONSTRUCT_FIELDS): the fused fields prefix
// defines them without a frame (js_vm_object_ops.initializeFields), and
// construct recipes add them to the shapes they build
// (js_construct_eval.construct). Covers private names, brands, captured
// names per class evaluation, derived classes, returned objects, duplicates
// with constructor stores and setters on the prototype.
const out = [];
function log(...args) { out.push(args.map(a => typeof a === 'object' && a !== null && !Array.isArray(a) ? JSON.stringify(a) : String(a)).join(' ')) }
class A { #a = 1; b = "s"; c = null; d; e = -5; f = 300; g = ""; static s = 1; get a() { return this.#a } constructor(x) { this.x = x } }
const o = new A(3); log(o.a, JSON.stringify(o));
class P { #p; m() { return #p in this } }
log(new P().m());
class Q { #q = 1; #m() {} t() { return this.#q } }
log(new Q().t());
class R { x = [1]; } log(new R().x.length, new R().x !== new R().x);
class S { constructor() {} y = 2 } log(new S().y);
class Base { constructor(o) { return o } }
class T extends Base { #z = 1; static has(o) { return #z in o } }
const shared = {}; new T(shared); log(T.has(shared)); try { new T(shared) } catch (e) { log(e.constructor.name, e.message) }
class U { a = 1; b = 2; } const u = new U(); log(Object.keys(u), Object.getOwnPropertyDescriptor(u,'a'));
for (let i = 0; i < 3; i++) { const C = class { #k = i; k() { return this.#k } }; log(new C().k()) }
const D = class { x = 1; constructor(){ log(Object.keys(this)) } }; new D();
// recipe paths
class E { x = 0; y = "s"; } let e; for (let i=0;i<5;i++) e = new E(); log(JSON.stringify(e));
class H { x = 0; #p = 7; constructor(a, b) { this.a = a; this.b = b } p() { return this.#p } } let h; for (let i=0;i<5;i++) h = new H(i, 2); log(JSON.stringify(h), h.p());
class Z {} let z; for (let i=0;i<5;i++) z = new Z(); log(JSON.stringify(z), z instanceof Z);
class Dup { x = 1; constructor() { this.x = 2 } } let d; for (let i=0;i<5;i++) d = new Dup(); log(d.x);
class W { a = 1; b = 2; c = 3; d = 4; e = 5; constructor(p,q,r,s,t){ this.p=p; this.q=q; this.r=r; this.s=s; this.t=t } } let w; for (let i=0;i<5;i++) w = new W(1,2,3,4,5); log(JSON.stringify(w));
function mk(v) { return class { #k = v; x = 1; constructor() { this.y = 2 } k() { return this.#k } } }
const K1 = mk(1), K2 = mk(2); for (let i=0;i<3;i++) { log(new K1().k(), new K2().k(), JSON.stringify(new K2())) }
class Sub extends H { z = 9; constructor() { super(1, 2); this.w = 3 } } let s; for (let i=0;i<5;i++) s = new Sub(); log(JSON.stringify(s), s.p());
let r; for (let i=0;i<5;i++) r = Reflect.construct(H, [5,6], Sub); log(JSON.stringify(r), Object.getPrototypeOf(r) === Sub.prototype);
class G { x = 1 } Object.defineProperty(G.prototype, 'x', { set(v) { log('setter!') } }); let g; for (let i=0;i<3;i++) g = new G(); log(Object.getOwnPropertyNames(g));
class Ret { constructor(o) { return o } }
class Fz extends Ret { a = 1 } try { new Fz(Object.freeze({})) } catch (e) { log(e.constructor.name) }
class FzP extends Ret { #a = 1 } try { new FzP(Object.preventExtensions({})) ; log('private on non-extensible ok') } catch (e) { log(e.constructor.name) }
const seen = []; const px = new Proxy({}, { defineProperty(t, k, d) { seen.push(String(k)); return Reflect.defineProperty(t, k, d) } });
class Px extends Ret { a = 1; b = "two" } new Px(px); log(seen.join(), px.a, px.b);
class Ro extends Ret { x = 2 } const ro = {}; Object.defineProperty(ro, 'x', { value: 1, writable: false, configurable: false }); try { new Ro(ro) } catch (e) { log(e.constructor.name, ro.x) }
class Many { a=1; b=2; c=3; d=4; e=5; f=6; g=7; h=8; i=9 } log(Object.keys(new Many()).length, new Many().i);
class Br { #m() { return 1 } #v = 3; t() { return this.#m() + this.#v } } for (let i = 0; i < 3; i++) log(new Br().t());
class Sym { [Symbol.iterator] = 1; 2 = "n" } log(new Sym()[Symbol.iterator], new Sym()[2]);
const got = out.join('\n');
const expected = "1 {\"b\":\"s\",\"c\":null,\"e\":-5,\"f\":300,\"g\":\"\",\"x\":3}\ntrue\n1\n1 true\n2\ntrue\nTypeError Cannot initialize #z twice on the same object\na,b {\"value\":1,\"writable\":true,\"enumerable\":true,\"configurable\":true}\n0\n1\n2\nx\n{\"x\":0,\"y\":\"s\"}\n{\"x\":0,\"a\":4,\"b\":2} 7\n{} true\n2\n{\"a\":1,\"b\":2,\"c\":3,\"d\":4,\"e\":5,\"p\":1,\"q\":2,\"r\":3,\"s\":4,\"t\":5}\n1 2 {\"x\":1,\"y\":2}\n1 2 {\"x\":1,\"y\":2}\n1 2 {\"x\":1,\"y\":2}\n{\"x\":0,\"a\":1,\"b\":2,\"z\":9,\"w\":3} 7\n{\"x\":0,\"a\":5,\"b\":6} true\nx\nTypeError\nprivate on non-extensible ok\na,b 1 two\nTypeError 1\n9 9\n4\n4\n4\n1 n";
console.log(got === expected ? 'PASS class constant fields' : 'FAIL ' + JSON.stringify(got));
if (got !== expected) throw new Error('class constant field regressions');
