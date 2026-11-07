// SilkJS regression test for deferred compilation of functions that capture
// outer variables: the deferred stub's var-ref operands are rewritten by scope
// planning, and the function is finished on its first call. Covers shared
// mutable captures, nesting several levels deep, captured arguments, loop
// bindings, functions called late, never-called siblings, eval and arrows.
// Expected values come from C QuickJS.
var r=[];
function outer(){ var a=1, b=2; function f(){ return a+b; } function g(){ a++; return a; } function never(){ return a*b*1000; } return [f,g]; }
var p=outer(); r.push(p[0](), p[1](), p[0](), p[1]());
function o2(){ var x=10; return function(){ var y=1; return function(){ return x+y; }; }; }
r.push(o2()()());
function o3(n){ return function(){ return function(){ return function(){ n++; return n; }; }; }; }
var t=o3(5)()(); r.push(t(), t());
function args(a, b){ return function(){ return a + '-' + b + '-' + arguments.length; }; }
r.push(args('p', 'q')(1, 2, 3));
var fs=[]; for (let i=0;i<4;i++){ fs.push(function(){ return i*i; }); } r.push(fs.map(function(f){ return f(); }).join('/'));
function counter(){ var c=0; return { inc: function(){ return ++c; }, get: function(){ return c; }, reset: function(){ c=0; } }; }
var k=counter(); k.inc(); k.inc(); var g1=k.get(); k.reset(); r.push(g1, k.get(), k.inc());
function late(){ var v='early'; var f=function(){ return v; }; v='late'; return f; } r.push(late()());
function withEval(){ var z=3; return function(){ return eval('z*2'); }; } r.push(withEval()());
function arrows(){ var self='me'; var a=() => () => self + this.tag; return a; } r.push(arrows.call({tag:'!'})()());
function shadow(){ var s=1; function inner(){ var s=2; return function(){ return s; }; } return inner()() + s; } r.push(shadow());
function recur(){ var depth=0; function down(n){ depth++; return n ? down(n-1) : depth; } return down; } r.push(recur()(4));
const got = r.join();
const expected = '3,2,4,3,11,6,7,p-q-3,0/1/4/9,2,0,1,late,6,me!,3,5';
console.log(got === expected ? 'PASS deferred capturing closures' : 'FAIL ' + got);
if (got !== expected) throw new Error('deferred closure regressions');
