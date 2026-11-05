// SilkJS regression test for leaf calls, which run small functions without a
// frame: plain getters, getters calling getters, accessors and proxies on the field
// read, primitive receivers, TDZ reads of outer bindings, missing arguments,
// array holes and out-of-range indexes, int overflow, -0, NaN, strings, strict
// and loose equality, a callee replaced mid-loop, and setters that store one
// field on plain, frozen, accessor and array receivers. Expected values come from V8.
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
const got = r.join();
const expected = '10199,,,,,3,42,-42,3,1,proxied,true,true,false,true,false,true,true,false,true,true,false,true,2147483648,true,false,2147483648,a1,0.75,-2147483649,NaN,NaN,5,6,-13,true,true,false,object,object,true,true,,ReferenceError,7,11,21,505,TypeError,2,3,9,own0,5,5,,1,49,true,1,3,n,2,0,TypeError,5,g,1,TypeError,prim';
console.log(got === expected ? 'PASS leaf calls' : 'FAIL ' + got);
if (got !== expected) throw new Error('leaf call regressions');
