// SilkJS regression test for typeof x === 'undefined' / 'function' and array
// appends (a[a.length] = x) taken without the generic step: every value kind,
// callable objects, classes, Proxies, appends past capacity, frozen, sealed and
// non-extensible arrays, non-writable length, holes and an indexed setter on
// Array.prototype. Expected values come from C QuickJS.
var r=[];
var vals=[undefined,null,0,1.5,-0,'','s',true,false,Symbol('q'),10n,{},[],function(){},class{},async function(){},function*(){},new Proxy({},{}),new Proxy(function(){},{}),Math.max,Object,new Date(0)];
var u=[],f=[];
for (var i=0;i<vals.length;i++){ u.push(typeof vals[i]==='undefined'?1:0); f.push(typeof vals[i]==='function'?1:0); }
r.push(u.join(''), f.join(''));
var undef; r.push(typeof undef==='undefined', typeof notDeclaredAnywhere==='undefined', typeof notDeclaredAnywhere==='function');
var a=[]; for (var i=0;i<100;i++) a[a.length]=i*2; r.push(a.length, a[0], a[99], a.reduce(function(s,x){return s+x},0));
var b=[1,2,3]; b[3]='x'; b[5]='y'; r.push(b.length, b[4], b.join('|'));
var c=[1,2]; Object.freeze(c); try { c[2]=3; } catch (e) { r.push('frz'); } r.push(c.length, c[2]);
var d=[1,2]; Object.seal(d); d[2]=3; r.push(d.length, d[2]);
var e=[1,2]; Object.preventExtensions(e); e[2]=3; r.push(e.length, e[2]);
var g=[1,2]; Object.defineProperty(g,'length',{writable:false}); g[2]=3; r.push(g.length, g[2]);
(function(){ 'use strict'; var h=[1]; Object.defineProperty(h,'length',{writable:false}); try { h[1]=2; r.push('no throw'); } catch (err) { r.push(err.constructor.name); } })();
var log=[]; Object.defineProperty(Array.prototype,'3',{set:function(v){ log.push('set'+v); },configurable:true});
var k=[0,1,2]; k[3]='z'; r.push(k.length, log.join(','), k.hasOwnProperty(3)); delete Array.prototype[3];
var m=[0,1,2]; m[3]='w'; r.push(m.length, m[3]);
var sub=Object.create([]); sub[0]=1; r.push(sub.length, Array.isArray(sub));
var big=[]; for (var j=0;j<5000;j++) big[j]={v:j}; var t=0; for (var j=0;j<big.length;j++) t+=big[j].v; r.push(big.length, t);
var got=r.join(',');
const expected = '1000000000000000000000,0000000000000111101110,true,true,false,100,0,198,9900,6,,1|2|3|x||y,2,,3,,2,,2,,TypeError,3,setz,false,4,w,0,false,5000,12497500';
console.log(got === expected ? 'PASS typeof tests and array appends' : 'FAIL ' + got);
if (got !== expected) throw new Error('typeof or array append regressions');
