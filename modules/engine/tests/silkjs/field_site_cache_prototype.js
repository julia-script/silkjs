// SilkJS regression test for prototype entries of the get_field site cache:
// a cached prototype property must miss after the prototype changes, after an
// own property shadows it, after setPrototypeOf, after an accessor
// redefinition, and on a Proxy sharing the shape. Expected values come from C QuickJS.
function g(o){ return o.m; }
var r=[];
function K(){} K.prototype.m=1; var k=new K();
for(var i=0;i<3;i++) r.push(g(k));
K.prototype.m=2; r.push(g(k));
k.m=3; r.push(g(k)); delete k.m; r.push(g(k));
delete K.prototype.m; r.push(g(k));
K.prototype.m=4; r.push(g(k));
Object.setPrototypeOf(k,{m:5}); r.push(g(k));
var P={m:6}; var q=Object.create(P); r.push(g(q),g(q));
Object.defineProperty(P,'m',{get:function(){return 'get'}}); r.push(g(q));
var base={m:7}; var o1=Object.create(base); r.push(g(o1),g(o1));
var px=new Proxy(Object.create(base),{get:function(){return 'trap'}}); r.push(g(px));
var big={}; for(i=0;i<40;i++) big['a'+i]=i; var bo=Object.create(big); r.push(g(bo),g(bo)); bo.m='own'; r.push(g(bo)); big.m='pm'; delete bo.m; r.push(g(bo));
var arr=[1,2]; r.push(typeof g(arr)); Array.prototype.m='am'; r.push(g(arr),g(arr));
const got = r.join();
const expected = '1,1,1,2,3,2,,4,5,6,6,get,7,7,trap,,,own,pm,undefined,am,am';
console.log(got === expected ? 'PASS field site cache prototype entries' : 'FAIL ' + got);
if (got !== expected) throw new Error('field site cache prototype regressions');
