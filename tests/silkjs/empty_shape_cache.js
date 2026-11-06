// SilkJS regression test for the interned empty shape cache (js_gc.cachedEmpty):
// a prototype change or property add made in place on the shape an object
// shares with its prototype's empty shape must not reach later objects built
// on that prototype. Expected values come from Node.
var r = [];
function AC(f) { this.f = f; }
var acp = Object.create(AC.prototype);
Object.setPrototypeOf(acp, {});
var t = new AC(1);
var o = Object.create(AC.prototype);
r.push(t instanceof AC, Object.getPrototypeOf(t) === AC.prototype, o instanceof AC, Object.getPrototypeOf(o) === AC.prototype, acp instanceof AC);
function BC(f) { this.f = f; }
BC.prototype.m = function () { return 1; };
var bcp = Object.create(BC.prototype);
Object.setPrototypeOf(bcp, {});
var bcg = new BC(0);
Object.defineProperty(bcg, 'f', { get: function () { return 2; } });
var u = new BC(1);
r.push(u.f, bcg.f, u.m(), Object.keys(u).join('/'));
for (var i = 0; i < 40; i++) { var w = new BC(i); if (w.f !== i || w.m() !== 1) r.push('bad' + i); }
var P = { k: 1 };
var p1 = Object.create(P); Object.setPrototypeOf(p1, null);
var p2 = Object.create(P);
r.push(p2.k, Object.getPrototypeOf(p1) === null);
var q1 = Object.create(P); q1.x = 5; Object.setPrototypeOf(q1, Array.prototype);
var q2 = Object.create(P);
r.push(q2.x, q2.k, Object.keys(q2).length, q1.x, Array.isArray(q1));
const got = r.join();
const expected = 'true,true,true,true,false,1,2,1,f,1,true,,1,0,5,false';
console.log(got === expected ? 'PASS empty shape cache' : 'FAIL ' + got);
if (got !== expected) throw new Error('empty shape cache regressions');
