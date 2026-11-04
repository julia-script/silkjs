// SilkJS regression test for the delete operator's in-place object path: strict
// and sloppy rejection, arrays, proxies, primitives, the global object, compaction,
// symbols and accessors. Expected values come from C QuickJS.
var out=[];
var o={a:1,b:2}; out.push(delete o.a, 'a' in o, delete o.zz, Object.keys(o).join());
var f=Object.freeze({x:1}); out.push(delete f.x, f.x);
(function(){ "use strict"; try { delete f.x; out.push('nothrow'); } catch(e) { out.push(e instanceof TypeError, e.message); } })();
var arr=[1,2,3]; out.push(delete arr[1], arr.length, 1 in arr, delete arr.length, arr.length);
var p=new Proxy({q:1},{deleteProperty(t,k){ out.push('trap:'+String(k)); return delete t[k]; }}); out.push(delete p.q, delete p[5]);
var pr=new Proxy({}, {deleteProperty(){ return false; }}); out.push(delete pr.z);
(function(){ "use strict"; try { delete pr.z; out.push('nothrow2'); } catch(e) { out.push(e instanceof TypeError); } })();
out.push(delete "abc".length, delete (5).x, delete Math.PI);
var g=globalThis; g.tmpv=3; out.push(delete g.tmpv, typeof tmpv);
var big={}; for (var i=0;i<30;i++) big['k'+i]=i; for (var i=0;i<25;i++) delete big['k'+i]; out.push(Object.keys(big).join(), big.k27);
var sym=Symbol('s'); var so={[sym]:1}; out.push(delete so[sym], Object.getOwnPropertySymbols(so).length);
var dk={}; dk[1]=1; dk['1.5']=2; out.push(delete dk[1], delete dk['1.5'], Object.keys(dk).length);
var getter={get x(){ return 1 }}; out.push(delete getter.x, 'x' in getter);
const got = out.join(',');
const expected = "true,false,true,b,false,1,true,could not delete property,true,3,false,false,3,trap:q,trap:5,true,true,false,true,false,true,false,true,undefined,k25,k26,k27,k28,k29,27,true,0,true,true,0,true,false";
console.log(got === expected ? 'PASS delete operator' : 'FAIL ' + got);
if (got !== expected) throw new Error('delete operator regressions');
