// Derived class constructors run in inline construct frames: results, throws, returns, super() through recipes, built-in bases.
var out = [];
class A { constructor(x) { this.x = x; this.y = 1; } }
class B extends A { constructor(x) { super(x); this.z = 2; } }
for (let i = 0; i < 3; i++) { const b = new B(i); out.push(Object.keys(b).join(), b instanceof B, b.x); }
class C extends A { constructor() { return { o: 1 }; } } out.push(JSON.stringify(new C()));
class D extends A { constructor() { } } try { new D(); } catch (e) { out.push(e.constructor.name); }
class E extends A { constructor() { super(1); return 5; } } try { new E(); } catch (e) { out.push(e.constructor.name); }
class G extends A { constructor() { super(1); return undefined; } } out.push(new G().x);
class H extends A { constructor() { out.push(new.target === H); super(2); throw new Error('boom'); } } try { new H(); } catch (e) { out.push(e.message); }
class I extends Array { constructor(...a) { super(...a); this.tag = 't'; } } const ii = new I(1, 2, 3); out.push(ii.length, ii.tag, ii instanceof I, Array.isArray(ii));
class J extends A {} out.push(Object.keys(new J(4)).join());
class K extends B { constructor() { super(7); this.k = 1; } } out.push(Object.keys(new K()).join());
class L extends A { f = 3; constructor(x) { super(x); } } out.push(Object.keys(new L(1)).join());
function deepB(n) { class X extends A { constructor() { super(n); if (n > 0) this.c = deepB(n - 1); } } return new X(); } out.push(JSON.stringify(deepB(3)).length);
class M extends Error { constructor(m) { super(m); this.name = 'M'; } } out.push(String(new M('hi')), new M('x') instanceof Error);
class N extends Promise { constructor(f) { super(f); } } out.push(new N(r => r(1)) instanceof N);
out.push(Reflect.construct(B, [5], K).constructor === K);
var __result = out.join(' ');
var __expected = "x,y,z true 0 x,y,z true 1 x,y,z true 2 {\"o\":1} ReferenceError TypeError 1 true boom 3 t true true x,y x,y,z,k x,y,f 67 M: hi true true true";
if (__result !== __expected) throw new Error("expected " + __expected + ", got " + __result);
