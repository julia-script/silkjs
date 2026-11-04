// SilkJS regression test for arr.push(x) appended inside the VM and for Array
// methods read through the field site cache: growth, frozen and sealed arrays,
// non-writable length, holes, a replaced or shadowed push, subclasses, proxies,
// non-arrays and push.call. Expected values come from C QuickJS.
var out=[];
var a=[]; for (var i=0;i<20;i++) out.push(a.push(i)); out.push(a.length, a[19]);
var f=Object.freeze([1]); try { f.push(2); out.push('nothrow'); } catch(e) { out.push(e instanceof TypeError, f.length); }
var s=Object.seal([1]); try { s.push(2); out.push('nothrow'); } catch(e) { out.push(e instanceof TypeError, s.length); }
var w=[1,2]; Object.defineProperty(w,'length',{writable:false}); try { w.push(3); out.push('nothrow'); } catch(e) { out.push(e instanceof TypeError, w.length); }
var h=[1,,3]; out.push(h.push(4), h.length, 1 in h);
var own=[1]; own.push=function(x){ return 'own:'+x; }; out.push(own.push(5), own.length);
class Sub extends Array {} var sub=new Sub(); out.push(sub.push(7), sub.length, sub instanceof Sub);
class Over extends Array { push(x){ return 'over:'+super.push(x); } } var ov=new Over(); out.push(ov.push(1), ov.length);
var px=new Proxy([], {set(t,k,v){ out.push('set:'+String(k)); t[k]=v; return true; }}); out.push(px.push(9));
var obj={length:0, push:Array.prototype.push}; out.push(obj.push('x'), obj[0], obj.length);
out.push(Array.prototype.push.call(a, 'c'), a.length, a.push(), a.push(1,2), a.length);
function loop(arr){ for (var j=0;j<3;j++) arr.push(j); return arr.join(); }
out.push(loop([]), loop({length:0, push:Array.prototype.push, join:Array.prototype.join}));
var saved=Array.prototype.push; Array.prototype.push=function(x){ return 'patched'; }; out.push([].push(1)); Array.prototype.push=saved;
out.push([].push(1));
var big=[]; big.length=5; out.push(big.push('e'), big.length);
var t=[1,2,3]; out.push(t.indexOf(2), t.includes(3), t.hasOwnProperty('length'), t.toString(), t.constructor===Array);
Array.prototype.extra=function(){ return 'extra'; }; out.push(t.extra()); delete Array.prototype.extra; out.push(typeof t.extra);
const got = out.join(',');
const expected = "1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,20,19,true,1,true,2,true,2,4,4,false,own:5,1,1,1,true,over:1,1,set:0,set:length,1,1,x,1,21,21,21,23,23,0,1,2,0,1,2,1,6,6,1,true,true,1,2,3,true,extra,undefined";
console.log(got === expected ? 'PASS array push inline' : 'FAIL ' + got);
if (got !== expected) throw new Error('array push inline regressions');
