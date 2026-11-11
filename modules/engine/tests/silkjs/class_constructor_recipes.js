// Class constructors with frameless recipes: field initializers still run, per-closure classes with and without fields, call without new throws.
var out = [];
class A { constructor(x) { this.x = x; this.y = 1; } }
for (let i = 0; i < 5; i++) { const a = new A(i); out.push(a.x + a.y, Object.getPrototypeOf(a) === A.prototype); }
class F { f = 7; constructor(x) { this.x = x; } }
for (let i = 0; i < 3; i++) { const f = new F(i); out.push(f.f, f.x, Object.keys(f).join()); }
function mk(withField) { return withField ? class { g = 1; constructor(x) { this.x = x; } } : class { constructor(x) { this.x = x; } }; }
const C1 = mk(false), C2 = mk(true);
for (let i = 0; i < 3; i++) { out.push(Object.keys(new C1(i)).join(), Object.keys(new C2(i)).join()); }
try { A(1); } catch (e) { out.push(e.constructor.name); }
class D extends A {} out.push(Object.keys(new D(3)).join(), new D(3) instanceof D);
out.push(Reflect.construct(A, [9], D) instanceof D);
class P { #p = 1; constructor(v) { this.v = v; } get p() { return this.#p; } } out.push(new P(2).p, new P(3).v);
var __result = out.join(' ');
var __expected = "1 true 2 true 3 true 4 true 5 true 7 0 f,x 7 1 f,x 7 2 f,x x g,x x g,x x g,x TypeError x,y true true 1 3";
if (__result !== __expected) throw new Error("expected " + __expected + ", got " + __result);
