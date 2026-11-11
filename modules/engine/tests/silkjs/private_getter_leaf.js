// Private field reads in the dispatch arm and in frameless getters, and their brand errors.
var out = [];
class P { #p = 1; get p() { return this.#p; } static read(o) { return o.#p; } m() { return this.#p + 1; } }
const pp = new P();
for (let i = 0; i < 3; i++) out.push(pp.p, pp.m(), P.read(pp));
const fake = Object.create(P.prototype);
try { fake.p; } catch (e) { out.push(e.constructor.name); }
try { P.read({}); } catch (e) { out.push(e.constructor.name); }
try { P.read(5); } catch (e) { out.push(e.constructor.name); }
class Q { #m() { return 9; } get v() { return this.#m(); } } out.push(new Q().v);
class R { #a = 1; #b = 2; get s() { return this.#a + this.#b; } } out.push(new R().s);
class S { static #x = 4; static get x() { return S.#x; } } out.push(S.x);
class T { #o = { k: 1 }; get o() { return this.#o; } } const t = new T(); out.push(t.o === t.o, t.o.k);
var __result = out.join(' ');
var __expected = "1 2 1 1 2 1 1 2 1 TypeError TypeError TypeError 9 3 4 true 1";
if (__result !== __expected) throw new Error("expected " + __expected + ", got " + __result);
