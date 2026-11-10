// SilkJS regression test for x == null and x != null, which compile to a single
// undefined-or-null test, in plain expressions, branches and loops. Expected
// values come from C QuickJS.
var out=[];
var values=[undefined, null, 0, '', false, NaN, 'x', {}, [], function(){}, 0n, Symbol.iterator];
for (var i=0;i<values.length;i++) {
  var v=values[i];
  out.push(v == null, v != null, v == undefined, v != undefined, null == v, undefined != v);
  if (v == null) out.push('n'); else out.push('s');
  if (v != null) out.push('S'); else out.push('N');
  if (!(v == undefined)) out.push('u');
}
var node={next:{next:{next:null}}}, count=0;
while (node != null) { count++; node=node.next; }
out.push(count);
var o={valueOf(){ out.push('called'); return 0; }};
out.push(o == null, o != null);
var x; out.push(x == null ? 'empty' : 'full');
var y=3; out.push(y != null && y == 3);
const got = out.join(',');
const expected = "true,false,true,false,true,false,n,N,true,false,true,false,true,false,n,N,false,true,false,true,false,true,s,S,u,false,true,false,true,false,true,s,S,u,false,true,false,true,false,true,s,S,u,false,true,false,true,false,true,s,S,u,false,true,false,true,false,true,s,S,u,false,true,false,true,false,true,s,S,u,false,true,false,true,false,true,s,S,u,false,true,false,true,false,true,s,S,u,false,true,false,true,false,true,s,S,u,false,true,false,true,false,true,s,S,u,3,false,true,empty,true";
console.log(got === expected ? 'PASS loose null compare' : 'FAIL ' + got);
if (got !== expected) throw new Error('loose null compare regressions');
