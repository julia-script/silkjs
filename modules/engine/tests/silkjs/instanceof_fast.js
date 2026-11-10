// SilkJS regression test for the frameless instanceof path: ordinary chains,
// custom and inherited Symbol.hasInstance, proxies, bound functions, prototype
// getters and non-object prototypes. Expected values come from C QuickJS.
var r=[];
function A(){} function B(){} B.prototype=Object.create(A.prototype); var b=new B(), a=new A();
r.push(b instanceof A, b instanceof B, a instanceof B, 1 instanceof A, null instanceof A, ({}) instanceof A, [] instanceof Array, [] instanceof Object, (function(){}) instanceof Function);
class C {} class D extends C {} r.push(new D() instanceof C, new C() instanceof D);
function E(){} E.prototype=3; try { ({}) instanceof E } catch(e) { r.push(e.constructor.name) } r.push(1 instanceof E);
function F(){} Object.defineProperty(F, Symbol.hasInstance, {value: function(v){ r.push('custom'); return v===1 }}); r.push(1 instanceof F, 2 instanceof F);
var p=new Proxy({}, {getPrototypeOf(){ r.push('trap'); return A.prototype }}); r.push(p instanceof A);
var bound=A.bind(null); r.push(a instanceof bound);
try { ({}) instanceof {} } catch(e) { r.push(e.constructor.name) }
var g=()=>{}; Object.defineProperty(g,'prototype',{get(){ r.push('getter'); return A.prototype}}); r.push(a instanceof g);
var o=Object.create(null); r.push(o instanceof A);
function G(){} Object.setPrototypeOf(G, {[Symbol.hasInstance](){ r.push('protoHI'); return true }}); r.push(1 instanceof G);
var arr=[1,2]; arr[100]=1; r.push(arr instanceof Array);
const got = r.join();
const expected = 'true,true,false,false,false,false,true,true,true,true,false,TypeError,false,custom,custom,true,false,trap,true,true,TypeError,getter,true,false,protoHI,true,true';
console.log(got === expected ? 'PASS instanceof fast path' : 'FAIL ' + got);
if (got !== expected) throw new Error('instanceof regressions');
