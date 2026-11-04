// SilkJS regression test for OP_define_array_el appending straight into a fast
// Array (rest elements, spread, holes, prototype setters that a define must
// ignore). Expected values come from C QuickJS.
var out=[];
var src=[1,2,3,4,5];
var [a, b, , c, ...rest] = src; out.push(JSON.stringify([a,b,c,rest]), rest.length);
var [...all] = "héllo"; out.push(all.join("|"), all.length);
var s=[...src, ...[6,7], 8]; out.push(s.join(), s.length);
var h=[0, , 2]; var t=[...h]; out.push(JSON.stringify(t), 1 in t);
function g(){ return [...arguments]; } out.push(JSON.stringify(g(1,"x",null)));
var o={x:1}; var [...objs]=[o,o]; out.push(objs[0]===o, objs[1]===o);
Object.defineProperty(Array.prototype, "7", { set(v){ out.push("setter"); }, configurable: true });
var big=[...[0,1,2,3,4,5,6,7,8]]; out.push(big.length, big[7]); delete Array.prototype[7];
var many=[]; for (var i=0;i<100;i++) many.push(i); var [first, ...tail]=many; out.push(tail.length, tail[98], first);
var m=new Map([[1,"a"],[2,"b"]]); out.push(JSON.stringify([...m]), JSON.stringify([...m.keys()]));
const got = out.join('\n');
const expected = "[1,2,4,[5]]\n1\nh|é|l|l|o\n5\n1,2,3,4,5,6,7,8\n8\n[0,null,2]\ntrue\n[1,\"x\",null]\ntrue\ntrue\n9\n7\n99\n99\n0\n[[1,\"a\"],[2,\"b\"]]\n[1,2]";
console.log(got === expected ? 'PASS define array element' : 'FAIL ' + got);
if (got !== expected) throw new Error('define array element regressions');
