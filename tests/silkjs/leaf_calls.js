// SilkJS regression test for leaf calls, which run small functions without a
// frame: plain getters, getters calling getters, accessors and proxies on the field
// read, primitive receivers, TDZ reads of outer bindings, missing arguments,
// array holes and out-of-range indexes, int overflow, -0, NaN, strings, strict
// and loose equality, a callee replaced mid-loop, and setters that store one
// field on plain, frozen, accessor and array receivers, leaves calling leaves
// (and setters, natives and non-functions), leaves that keep declining, and
// locals read before any write, plus class constructors called without new.
// Expected values come from V8.
var r=[];
function P(x,y){ this.x=x; this.y=y; this.items=[1,2,3]; }
P.prototype.getX=function(){ return this.x; };
P.prototype.size=function(){ return this.items.length; };
P.prototype.at=function(i){ return this.items[i]; };
P.prototype.dot=function(o){ return this.x*o.x + this.y*o.y; };
P.prototype.first=function(){ return this.at(0); };
P.prototype.deep=function(){ return this.first() + this.size(); };
P.prototype.isBig=function(){ return this.x > 10 ? true : this.y >= 10; };
P.prototype.same=function(v){ return this.x === v; };
P.prototype.loose=function(v){ return this.x == v; };
P.prototype.neg=function(){ return -this.x; };
P.prototype.not=function(){ return !this.x; };
P.prototype.nil=function(){ return this.x == null; };
P.prototype.sum=function(a,b){ return a + b; };
P.prototype.diff=function(a,b){ return a - b; };
P.prototype.bits=function(a){ return (a | 0) ^ (a & 6) << 1; };
var p=new P(3,4), q=new P(5,6);
var acc=0; for (var i=0;i<200;i++){ acc += p.getX() + p.size() + p.at(i % 3) + p.dot(q) + p.deep(); } r.push(acc);
r.push(p.at(5), p.at(-1), p.at(1.5));
var holes=new P(1,1); holes.items=[1,,3]; r.push(holes.at(1), holes.size());
var acc2=new P(0,0); Object.defineProperty(acc2,'x',{get:function(){ return 42; }}); r.push(acc2.getX(), acc2.neg());
var proto=Object.create(p); r.push(proto.getX(), proto.first());
var px=new Proxy(p,{get:function(t,k){ return k==='x' ? 'proxied' : t[k]; }}); r.push(P.prototype.getX.call(px));
r.push(P.prototype.isBig.call(new P(11,0)), P.prototype.isBig.call(new P(1,10)), P.prototype.isBig.call(new P(1,9)));
r.push(p.same(3), p.same('3'), p.loose('3'), p.loose(3.0), new P(NaN,0).same(NaN), new P(null,0).nil(), new P(undefined,0).nil(), new P(0,0).nil());
r.push(Object.is(new P(0,0).neg(), -0), new P(-2147483648,0).neg(), new P('',0).not(), new P('a',0).not());
r.push(p.sum(2147483647,1), p.sum('a',1), p.sum(0.5,0.25), p.diff(-2147483648,1), p.sum(1), p.diff());
r.push(p.bits(13), p.bits(2.9), p.bits(-1));
var s1='ab', s2='a'+'b'; r.push(new P(s1,0).same(s2), new P(1,0).loose(true), new P({},0).same({}));
function self(){ return this; } function ty(){ return typeof this; }
r.push(typeof self.call(5), ty.call('s'), self.call(undefined) === globalThis);
function strictSelf(){ "use strict"; return this; } r.push(strictSelf.call(5) === 5, strictSelf.call(undefined));
var lateRead=function(){ return later; }; try { lateRead(); } catch(e) { r.push(e.constructor.name); } let later=7; r.push(lateRead());
var outer=10; function readOuter(){ return outer + 1; } r.push(readOuter()); outer=20; r.push(readOuter());
var obj={ v: 1, get(){ return this.v; } }; var t=0; for (var j=0;j<10;j++){ if (j===5) obj.get=function(){ return 100; }; t += obj.get(); } r.push(t);
function thrower(o){ return o.x; } try { thrower(null); } catch(e) { r.push(e.constructor.name); }
function arr(a){ return a.length; } r.push(arr([1,2]), arr('abc'), arr({length:9}));
var c=new P(1,2); c.at=function(i){ return 'own'+i; }; r.push(c.first());
function rec(n){ return n; } function chain(o){ return o.deep() + rec(1); } r.push(chain(p));
var big=new P(1,2); big.items=new Array(1000); big.items[999]=5; r.push(big.at(999), big.at(998));
function S(v){ this.state=v; this.n=0; }
S.prototype.mark=function(){ this.state = this.state | 4; };
S.prototype.clear=function(){ this.state = this.state & ~4; };
S.prototype.set=function(v){ this.n = v; };
S.prototype.strictSet=function(v){ "use strict"; this.n = v; };
var st=new S(1); for (var k=0;k<50;k++){ st.mark(); if (k%2) st.clear(); st.set(k); } r.push(st.state, st.n);
var shared={}; var holder2=new S(0); holder2.set(shared); holder2.set(shared); r.push(holder2.n === shared); holder2.set(1); r.push(holder2.n);
var fresh=Object.create(S.prototype); fresh.set(3); r.push(fresh.n, Object.keys(fresh).join('/'));
var frozen=Object.freeze(new S(2)); frozen.mark(); frozen.set(9); r.push(frozen.state, frozen.n);
try { frozen.strictSet(1); } catch(e) { r.push(e.constructor.name); }
var viaSetter=new S(0); var seen=[]; Object.defineProperty(viaSetter,'n',{set:function(v){ seen.push(v); }, get:function(){ return 'g'; }}); viaSetter.set(5); r.push(seen.join(), viaSetter.n);
var lenObj=[1,2,3]; S.prototype.trunc=function(){ this.length = 1; }; S.prototype.trunc.call(lenObj); r.push(lenObj.length);
try { S.prototype.set.call(undefined, 1); } catch(e) { r.push(e.constructor.name); }
try { S.prototype.strictSet.call(7, 1); } catch(e) { r.push(e.constructor.name); } S.prototype.set.call(7, 1); r.push('prim');
function Q(){ this.inner=new P(2,3); this.list=[]; this.count=0; }
Q.prototype.innerX=function(){ return this.inner.getX(); };
Q.prototype.innerDot=function(o){ return this.inner.dot(o); };
Q.prototype.twoDeep=function(){ return this.inner.deep(); };
Q.prototype.copy=function(){ this.count = this.inner.getX(); };
Q.prototype.callSetter=function(){ this.inner.setX(); return this.inner.x; };
Q.prototype.pushOne=function(v){ this.list.push(v); };
Q.prototype.notFn=function(){ return this.inner.missing(); };
Q.prototype.withArgs=function(a,b){ return this.inner.sum(a,b) + this.inner.diff(a,b); };
P.prototype.setX=function(){ this.x = this.x + 1; };
var qq=new Q(), qt=0; for (var m=0;m<300;m++){ qt += qq.innerX() + qq.innerDot(q) + qq.twoDeep() + qq.withArgs(m,1); qq.copy(); qq.pushOne(m); } r.push(qt, qq.count, qq.list.length, qq.list[299]);
r.push(qq.callSetter(), qq.callSetter(), qq.inner.x);
try { qq.notFn(); } catch(e) { r.push(e.constructor.name); }
qq.inner=null; try { qq.innerX(); } catch(e) { r.push(e.constructor.name); }
qq.inner={ getX: function(){ return 'other'; }, deep: function(){ return 'd'; } }; r.push(qq.innerX(), qq.twoDeep());
var flip=new P(1,1), ft=0; for (var n=0;n<400;n++){ flip.items = (n%2) ? [n] : [,]; ft += flip.at(0) === undefined ? 1 : flip.at(0); } r.push(ft);
function maybe(c){ var x; if (c) x = 1; return x; }
function unset(){ var y; return y; }
function later2(c){ var a = c ? 2 : 3; var b; if (a > 2) b = a; return b === undefined ? 'u' : b; }
function strictMaybe(c){ "use strict"; var z; if (c) z = this; return z; }
var mt=[]; for (var w=0;w<6;w++){ mt.push(maybe(w%2), unset(), later2(w%2), typeof strictMaybe.call(w, w%2)); } r.push(mt.join('/'));
class K { constructor(){} }
try { K(); r.push('no'); } catch(e) { r.push(e.constructor.name); }
var holdsK={ K: K }; try { holdsK.K(); r.push('no'); } catch(e) { r.push(e.constructor.name); }
function newTargetless(){ return new.target === undefined; } r.push(newTargetless());
function countArgs(){ return arguments.length; } r.push(countArgs(1,2,3));
var boundGet=function(){ return this.v; }.bind({v: 9}); r.push(boundGet());
function SC(d){ this.d=d; this.a=1; this.b=2; }
SC.prototype.ex=function(){ if (this.d == 1) { this.b = this.a * 3 + 1; } else { this.a = this.b - 1; } };
SC.prototype.tail=function(c){ if (c) { this.a = 7; } else { this.b = 8; } return 5; };
var sc1=new SC(1), sc2=new SC(0), sct=0; for (var u=0;u<200;u++){ sc1.a=u; sc1.ex(); sc2.b=u; sc2.ex(); sct += sc1.b + sc2.a + sc1.tail(u%2); } r.push(sct, sc1.a, sc2.b);
var scf=Object.freeze(new SC(1)); scf.ex(); r.push(scf.b);
var scs=new SC(0); Object.defineProperty(scs, 'a', { set: function(v){ this.seen = v; }, get: function(){ return 'g'; } }); scs.ex(); r.push(scs.seen, scs.a);
function mkGet(k){ var o={ get: function(){ return k; }, bump: function(){ k = k + 1; } }; return o; }
var cg=mkGet(3), cgt=0; for (var u2=0;u2<100;u2++){ cgt += cg.get(); if (u2 % 10 == 0) cg.bump(); } r.push(cgt);
function tdzRead(){ var f=function(){ return late; }; var out; try { out = f(); } catch(e) { out = e.constructor.name; } let late = 4; return out + f(); }
r.push(tdzRead(), tdzRead());
function dv(a,b){ return a / b; }
var dvs=[]; for (var u3=0;u3<3;u3++){ dvs.push(dv(6,3), dv(1,2), dv(1,0), dv(-1,0), dv(0,-5), 1/dv(0,-5), dv(7.5,2.5), dv(3,1.5), dv('6',2), dv(0,0)); } r.push(dvs.join(':'));
function argField(o){ return o.x; }
function locLength(){ var a = this.items; return a.length; }
function locEl(k){ var a = this.items, i = k; return a[i]; }
function argEl(a){ var i = 1; return a[i]; }
function maybeEl(c){ var a; if (c) a = this.items; var i = 0; return c ? a[i] : 'none'; }
var fz = [], fo = { items: [5, , 7] }, fs = { items: 'str' };
for (var u4 = 0; u4 < 3; u4++) {
  fz.push(argField({ x: u4 }), argField(1), argField('s'), argField(new Proxy({ x: 'p' }, {})));
  fz.push(locLength.call(fo), locLength.call(fs), locEl.call(fo, 0), locEl.call(fo, 1), locEl.call(fo, 9), locEl.call(fs, 1), locEl.call(fo, '2'));
  fz.push(argEl([1, 2]), argEl('xy'), argEl({ 1: 'one' }), maybeEl.call(fo, true), maybeEl.call(fo, false));
}
r.push(fz.join('|'));
function AC(f){ this.f = f; }
AC.prototype.get = function(){ return this.f; };
AC.prototype.size = function(){ return this.f.length; };
AC.prototype.at = function(i){ return this.f[i]; };
function AW(c){ this.c = c; }
AW.prototype.size = function(){ return this.c.size(); };
AW.prototype.at = function(i){ return this.c.at(i); };
AW.prototype.get = function(){ return this.c.get(); };
var acp = Object.create(Object.create(AC.prototype, { f: { value: [8, 9], writable: true } }));
var acg = new AC(0); Object.defineProperty(acg, 'f', { get: function(){ return ['g', 'h']; } });
var acs = [new AC([1, , 3]), new AC('str'), new AC(new Int8Array([4, 5])), new AC({ length: 'L', 1: 'o1' }), acp, acg, new AC(null), new AC(undefined)];
var az = [];
for (var u5 = 0; u5 < 3; u5++) {
  for (var q = 0; q < acs.length; q++) {
    var ac = acs[q], aw = new AW(ac);
    var one = function(f){ try { return String(f()); } catch (e) { return e.constructor.name; } };
    az.push(one(function(){ return ac.size(); }), one(function(){ return ac.at(1); }), one(function(){ return ac.at(-1); }),
      one(function(){ return ac.at(1.5); }), one(function(){ return ac.at('1'); }), one(function(){ return ac.at(7); }),
      one(function(){ return ac.at(); }), one(function(){ return typeof ac.get(); }),
      one(function(){ return aw.size(); }), one(function(){ return aw.at(2); }), one(function(){ return typeof aw.get(); }));
  }
  az.push(one(function(){ return AC.prototype.size.call('abc'); }), String(AC.prototype.get.call(5)), AC.prototype.at.call({ f: [0, 'x'] }, 1), AC.prototype.size.call({ f: 'abcd' }));
  acs[0].f.push(u5);
}
r.push(az.join('/'));
const got = r.join();
const expected = '10199,,,,,3,42,-42,3,1,proxied,true,true,false,true,false,true,true,false,true,true,false,true,2147483648,true,false,2147483648,a1,0.75,-2147483649,NaN,NaN,5,6,-13,true,true,false,object,object,true,true,,ReferenceError,7,11,21,505,TypeError,2,3,9,own0,5,5,,1,49,true,1,3,n,2,0,TypeError,5,g,1,TypeError,prim,99900,2,300,299,3,4,4,TypeError,TypeError,other,d,40200,//3/undefined/1//u/number///3/undefined/1//u/number///3/undefined/1//u/number,TypeError,TypeError,true,3,9,80600,7,199,2,1,g,840,ReferenceError4,ReferenceError4,2:0.5:Infinity:-Infinity:0:-Infinity:3:2:3:NaN:2:0.5:Infinity:-Infinity:0:-Infinity:3:2:3:NaN:2:0.5:Infinity:-Infinity:0:-Infinity:3:2:3:NaN,0|||p|3|3|5|||t|7|2|y|one|5|none|1|||p|3|3|5|||t|7|2|y|one|5|none|2|||p|3|3|5|||t|7|2|y|one|5|none,3/undefined/undefined/undefined/undefined/undefined/undefined/object/3/3/object/3/t/undefined/undefined/t/undefined/undefined/string/3/r/string/2/5/undefined/undefined/5/undefined/undefined/object/2/undefined/object/L/o1/undefined/undefined/o1/undefined/undefined/object/L/undefined/object/2/9/undefined/undefined/9/undefined/undefined/object/2/undefined/object/2/h/undefined/undefined/h/undefined/undefined/object/2/undefined/object/TypeError/TypeError/TypeError/TypeError/TypeError/TypeError/TypeError/object/TypeError/TypeError/object/TypeError/TypeError/TypeError/TypeError/TypeError/TypeError/TypeError/undefined/TypeError/TypeError/undefined/TypeError/undefined/x/4/4/undefined/undefined/undefined/undefined/undefined/undefined/object/4/3/object/3/t/undefined/undefined/t/undefined/undefined/string/3/r/string/2/5/undefined/undefined/5/undefined/undefined/object/2/undefined/object/L/o1/undefined/undefined/o1/undefined/undefined/object/L/undefined/object/2/9/undefined/undefined/9/undefined/undefined/object/2/undefined/object/2/h/undefined/undefined/h/undefined/undefined/object/2/undefined/object/TypeError/TypeError/TypeError/TypeError/TypeError/TypeError/TypeError/object/TypeError/TypeError/object/TypeError/TypeError/TypeError/TypeError/TypeError/TypeError/TypeError/undefined/TypeError/TypeError/undefined/TypeError/undefined/x/4/5/undefined/undefined/undefined/undefined/undefined/undefined/object/5/3/object/3/t/undefined/undefined/t/undefined/undefined/string/3/r/string/2/5/undefined/undefined/5/undefined/undefined/object/2/undefined/object/L/o1/undefined/undefined/o1/undefined/undefined/object/L/undefined/object/2/9/undefined/undefined/9/undefined/undefined/object/2/undefined/object/2/h/undefined/undefined/h/undefined/undefined/object/2/undefined/object/TypeError/TypeError/TypeError/TypeError/TypeError/TypeError/TypeError/object/TypeError/TypeError/object/TypeError/TypeError/TypeError/TypeError/TypeError/TypeError/TypeError/undefined/TypeError/TypeError/undefined/TypeError/undefined/x/4';
console.log(got === expected ? 'PASS leaf calls' : 'FAIL ' + got);
if (got !== expected) throw new Error('leaf call regressions');
