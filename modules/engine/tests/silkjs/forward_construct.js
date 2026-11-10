// new F() where F is `function () { this.initialize.apply(this, arguments); }`
// runs initialize as the construct frame itself; everything observable must
// match the two calls it stands for.
var r = [];
function V() { this.initialize.apply(this, arguments); }
V.prototype = { initialize: function (x, y, z) { this.x = x ? x : 0; this.y = y ? y : 0; this.z = z ? z : 0; } };
var t = 0;
for (var i = 0; i < 300; i++) { var v = new V(i, i + 1); t += v.x + v.y + v.z; }
r.push(t, new V().x, new V(1, 2, 3, 4).z, new V(5) instanceof V);
function C() { this.initialize.apply(this, arguments); }
C.prototype.initialize = function (a, b) { if (!a) a = 7; if (!b) b = 8; this.a = a; this.b = b; return { other: true }; };
var c = new C(0, 2); r.push(c.a, c.b, c.other === undefined, c instanceof C);
function N() { this.initialize.apply(this, arguments); }
N.prototype.initialize = function () { return [typeof new.target, arguments.length, arguments[1]]; };
var n = new N(1, 'two', 3); r.push(n instanceof N, Object.keys(n).length);
var seen; N.prototype.initialize = function () { seen = [typeof new.target, arguments.length, arguments[1], this instanceof N]; };
new N(1, 'two', 3); r.push(seen.join('/'));
function Swap() { this.initialize.apply(this, arguments); }
Swap.prototype.initialize = function (k) { Swap.prototype.initialize = null; this.k = k; };
var s1 = new Swap(4); r.push(s1.k); try { new Swap(5); r.push('no'); } catch (e) { r.push(e.constructor.name); }
function NotFn() { this.initialize.apply(this, arguments); }
NotFn.prototype.initialize = 3; try { new NotFn(); } catch (e) { r.push(e.constructor.name); }
class K { constructor() { this.k = 1; } }
function WithClass() { this.initialize.apply(this, arguments); }
WithClass.prototype.initialize = K; try { new WithClass(); r.push('no'); } catch (e) { r.push(e.constructor.name); }
function Getter() { this.initialize.apply(this, arguments); }
Object.defineProperty(Getter.prototype, 'initialize', { get: function () { r.push('got'); return function (q) { this.q = q; }; } });
r.push(new Getter(6).q);
function OwnApply() { this.initialize.apply(this, arguments); }
var init = function (q) { this.q = q; }; init.apply = function (self, args) { self.q = 'custom' + args.length; };
OwnApply.prototype.initialize = init; r.push(new OwnApply(1, 2).q);
function Thrower() { this.initialize.apply(this, arguments); }
Thrower.prototype.initialize = function (m) { throw new Error('bad ' + m); };
try { new Thrower('x'); } catch (e) { r.push(e.message); }
function Arrow() { this.initialize.apply(this, arguments); }
var outer = { tag: 'outer' };
Arrow.prototype.initialize = (function () { var self = this; return () => { self.hit = (self === outer); }; }).call(outer);
var ar = new Arrow(); r.push(outer.hit, ar.hit === undefined);
function Bound() { this.initialize.apply(this, arguments); }
Bound.prototype.initialize = function (w) { this.w = w; this.bound = this.tag; }.bind({ tag: 'b' });
var bd = new Bound(2); r.push(bd.w === undefined, bd.bound === undefined);
function Gen() { this.initialize.apply(this, arguments); }
Gen.prototype.initialize = function* (g) { this.g = g; };
var gn = new Gen(3); r.push(gn.g === undefined);
function Strict() { "use strict"; this.initialize.apply(this, arguments); }
Strict.prototype.initialize = function (s) { "use strict"; this.s = s; };
r.push(new Strict(9).s);
function Deep() { this.initialize.apply(this, arguments); }
Deep.prototype.initialize = function (d) { this.d = d; if (d > 0) this.child = new Deep(d - 1); };
var dp = new Deep(5), depth = 0; while (dp.child) { dp = dp.child; depth++; } r.push(depth, dp.d);
var saved = Function.prototype.apply;
Function.prototype.apply = function (self, args) { self.patched = args.length; };
var pv = new V(1, 2); Function.prototype.apply = saved;
r.push(pv.patched, pv.x === undefined);
function Proto() { this.initialize.apply(this, arguments); }
Proto.prototype.initialize = function () { this.own = Object.getPrototypeOf(this) === Proto.prototype; };
r.push(new Proto().own, Reflect.construct(Proto, [], V).own);
const got = r.join();
const expected = '90000,0,3,true,7,2,true,true,true,0,undefined/3/two/true,4,TypeError,TypeError,TypeError,got,6,custom2,bad x,true,true,true,true,true,9,5,0,2,true,true,';
console.log(got === expected ? 'PASS forward construct' : 'FAIL ' + got);
if (got !== expected) throw new Error('forward construct regressions');
