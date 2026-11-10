// SilkJS regression test for target.call(thisArg, ...args) run as an inline
// call: sloppy and strict receivers, short and long argument lists, the
// arguments object, a class constructor, a throwing callee, a replaced call and
// recursion through call. Expected values come from C QuickJS.
var r=[];
function Base(a,b){ this.s = a + (b===undefined?0:b); }
function Derived(a,b,c){ Base.call(this, a, b); this.t = c; }
var sum=0; for (var i=0;i<5;i++){ var d = new Derived(1,2,3); sum += d.s + d.t + new Derived(4).s; } r.push(sum);
function g(){ return arguments.length + ':' + Array.prototype.join.call(arguments, '/'); }
r.push(g.call(), g.call(null), g.call(null,1), g.call(null,1,2,3,4,5,6,7,8,9,10));
function self(){ return this; } r.push(self.call(5) == 5, typeof self.call(5), typeof self.call(undefined), self.call(undefined) === globalThis);
function strictSelf(){ "use strict"; return this; } r.push(strictSelf.call(5) === 5, strictSelf.call(undefined) === undefined);
function k(x){ arguments[0]=9; return x; } r.push(k.call(null, 3));
function m(x){ "use strict"; arguments[0]=9; return x; } r.push(m.call(null, 3));
class C { constructor(){} } try { C.call(null) } catch(e) { r.push(e.constructor.name) }
function w(){ throw new Error('inner') } try { w.call(null, 1) } catch(e) { r.push(e.message) }
var o={ call: function(){ return 'own' } }; r.push(o.call(null, 1));
function fact(n){ return n <= 1 ? 1 : n * fact.call(null, n - 1); } r.push(fact.call(null, 10));
function many(a,b,c,d){ return [a,b,c,d].join('|'); } r.push(many.call(null, 1, 2), many.call({}, 'x', 'y', 'z', 'w', 'v'));
var bound = g.bind(null, 'b'); r.push(bound.call(null, 1));
r.push(Math.max.call(null, 3, 7, 5), String.prototype.toUpperCase.call('ab'));
function inner(){ return this.v + arguments.length; } var holder={v:10}; var acc=0; for (var j=0;j<100;j++){ acc += inner.call(holder, j, j); } r.push(acc);
const got = r.join();
const expected = '50,0:,0:,1:1,10:1/2/3/4/5/6/7/8/9/10,true,object,object,true,true,true,9,3,TypeError,inner,own,3628800,1|2||,x|y|z|w,2:b/1,7,AB,1200';
console.log(got === expected ? 'PASS call inline path' : 'FAIL ' + got);
if (got !== expected) throw new Error('call regressions');
