// SilkJS regression test for how `new` reads newTarget.prototype: the own
// data-property fast path, and the generic getter for proxies, bound functions
// and non-object prototypes. Results must match QuickJS.
const out = [];
class A { constructor() { this.k = 1; } }
out.push(Object.getPrototypeOf(new A()) === A.prototype);
function F() {}
F.prototype = { tag: "custom" };
out.push(new F().tag);
F.prototype = 42; // not an object: the realm's Object.prototype is used
out.push(Object.getPrototypeOf(new F()) === Object.prototype);
function G() {}
const proxied = new Proxy(G, { get(t, k) { return k === "prototype" ? { tag: "proxied" } : t[k]; } });
out.push(Reflect.construct(G, [], proxied).tag);
const bound = G.bind(null);
out.push(Object.getPrototypeOf(new bound()) === G.prototype);
out.push(Object.getPrototypeOf(Reflect.construct(G, [], bound)) === Object.prototype);
class B extends A {}
const b = new B();
out.push(Object.getPrototypeOf(b) === B.prototype, b.k);
out.push(Object.getPrototypeOf(Reflect.construct(Date, [0], F)) === Date.prototype);
for (let i = 0; i < 3; i++) {
  F.prototype = i % 2 ? { n: i } : null;
  const o = new F();
  out.push(o.n, Object.getPrototypeOf(o) === Object.prototype);
}
const got = JSON.stringify(out);
const expected = '[true,"custom",true,"proxied",true,true,true,1,true,null,true,1,false,null,true]';
console.log(got === expected ? 'PASS new target prototype' : 'FAIL ' + got);
if (got !== expected) throw new Error('new target prototype regressions');
