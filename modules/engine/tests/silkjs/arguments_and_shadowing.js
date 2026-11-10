// SilkJS regression test for arguments objects built as fast arrays when no
// formal is aliased, and for put_field adds that shadow a writable prototype
// data property. Expected values come from C QuickJS.
var r=[];
function a(){ return arguments } var x=a(1,2,3);
r.push(Object.prototype.toString.call(x), x.length, x[1], typeof x.callee, x.callee===a, JSON.stringify(Object.getOwnPropertyDescriptor(x,'callee')), Object.keys(x).join());
x[5]=9; r.push(x.length, Object.keys(x).join()); delete x[0]; r.push(Object.keys(x).join(), 0 in x);
function b(p){ arguments[0]=7; return p } r.push(b(), b(1));
function c(p){ p=5; return arguments[0] } r.push(c(), c(1), c(1,2));
function d(){ 'use strict'; return arguments } try { d().callee } catch(e) { r.push(e.constructor.name) }
function e(){ return [...arguments].join() + Array.prototype.slice.call(arguments,1).join() } r.push(e(1,2,3));
function F(){ this.init.apply(this, arguments) } F.prototype={ v:0, init(a,b){ this.v=a+b; this.w=b } }; var f=new F(2,3); r.push(f.v,f.w, Object.keys(f).join());
var P={ q:1 }; Object.defineProperty(P,'ro',{value:1,writable:false}); Object.defineProperty(P,'acc',{set(v){r.push('set'+v)},get(){return 0}});
var o=Object.create(P); o.q=2; o.ro=3; o.acc=4; r.push(o.q, P.q, o.ro, Object.keys(o).join());
(function(){ 'use strict'; var o2=Object.create(P); try { o2.ro=3 } catch(e) { r.push(e.constructor.name) } })();
function g(){ arguments.length=1; return Array.from(arguments) } r.push(g(1,2).join());
function h(){ Object.defineProperty(arguments,'0',{get(){return 'gg'}}); return arguments[0] } r.push(h(1));
const got = JSON.stringify(r);
const expected = "[\"[object Arguments]\",3,2,\"function\",true,\"{\\\"writable\\\":true,\\\"enumerable\\\":false,\\\"configurable\\\":true}\",\"0,1,2\",3,\"0,1,2,5\",\"1,2,5\",false,null,7,null,5,5,\"TypeError\",\"1,2,32,3\",5,3,\"v,w\",\"set4\",2,1,1,\"q\",\"TypeError\",\"1\",\"gg\"]";
console.log(got === expected ? 'PASS arguments and shadowing' : 'FAIL ' + got);
if (got !== expected) throw new Error('arguments/shadowing regressions');
