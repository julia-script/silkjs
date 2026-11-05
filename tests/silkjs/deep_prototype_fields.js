// SilkJS regression test for the get_field site cache on properties two and three
// prototypes up: shadowing, value changes, accessors, deletes and prototype swaps
// on each level must show at a site that already cached the read. Expected values
// come from C QuickJS.
var out=[];
function A(){} A.prototype.m=function(){ return 'A'; }; A.prototype.v=1;
function B(){} B.prototype=Object.create(A.prototype);
function C(){} C.prototype=Object.create(B.prototype);
var c=new C(), b=new B();
function read(o){ return o.v; }
function call(o){ return o.m(); }
for (var i=0;i<3;i++) out.push(read(c), call(c), read(b), call(b));
A.prototype.v=2; out.push(read(c), read(b));
B.prototype.v=3; out.push(read(c), read(b));
delete B.prototype.v; out.push(read(c));
C.prototype.v=4; out.push(read(c), read(b));
delete C.prototype.v; out.push(read(c));
Object.defineProperty(B.prototype,'v',{get(){ return 'getter'; }, configurable:true}); out.push(read(c), read(c));
delete B.prototype.v; out.push(read(c));
var Z={v:'z', m(){ return 'Z'; }};
Object.setPrototypeOf(B.prototype, Z); out.push(read(c), call(c), read(b));
Object.setPrototypeOf(B.prototype, A.prototype); out.push(read(c), call(c));
var P=new Proxy({}, {get(t,k,r){ return k==='v' ? 'proxy' : undefined; }});
function D(){} D.prototype=Object.create(P); var d=new D(); var e=Object.create(Object.create(Object.create(A.prototype)));
for (var i=0;i<2;i++) out.push(read(d), read(e), read(c));
A.prototype.v=5; out.push(read(e), read(c));
var deep=Object.create(e); out.push(read(deep), read(deep));
function many(o){ return o.toString === Object.prototype.toString; }
out.push(many(c), many(c), many(deep), many(deep));
const got = out.join(',');
const expected = "1,A,1,A,1,A,1,A,1,A,1,A,2,2,3,3,2,4,2,2,getter,getter,2,z,Z,z,2,A,proxy,2,2,proxy,2,2,5,5,5,5,true,true,true,true";
console.log(got === expected ? 'PASS deep prototype fields' : 'FAIL ' + got);
if (got !== expected) throw new Error('deep prototype field regressions');
