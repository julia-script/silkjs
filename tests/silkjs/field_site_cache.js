// SilkJS regression test for the get_field/put_field site cache: a site that
// cached a slot must miss after delete, compaction, accessor redefinition and
// read-only redefinition, and across many short-lived shapes. Expected values
// come from C QuickJS.
function g(o){ return o.x; }
function p(o,v){ o.x = v; }
var out=[];
var a={x:1,y:2}; for(var i=0;i<3;i++) out.push(g(a));
delete a.x; out.push(g(a));          // undefined
a.x=5; out.push(g(a));
var b={y:1,x:2}; for(i=0;i<3;i++) out.push(g(b));
Object.defineProperty(b,'x',{get:function(){return 'acc'}}); out.push(g(b));
var c={x:1}; p(c,2); p(c,3); Object.defineProperty(c,'x',{writable:false}); p(c,9); out.push(c.x);
var d={x:1}; p(d,4); Object.defineProperty(d,'x',{set:function(v){out.push('set'+v)}}); p(d,7);
// many shapes churn
for(i=0;i<20000;i++){ var o={}; o['k'+(i%50)]=i; o.x=i; if(g(o)!==i) throw 'bad'+i; delete o.x; if(g(o)!==undefined) throw 'bad2'; }
// delete + compact
var e={}; for(i=0;i<20;i++) e['p'+i]=i; e.x=99; out.push(g(e)); for(i=0;i<16;i++) delete e['p'+i]; out.push(g(e)); e.x=100; out.push(g(e));
const got = out.join();
const expected = '1,1,1,,5,2,2,2,acc,3,set7,99,99,100';
console.log(got === expected ? 'PASS field site cache' : 'FAIL ' + got);
if (got !== expected) throw new Error('field site cache regressions');
