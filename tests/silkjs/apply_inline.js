// SilkJS regression test for target.apply(thisArg, array) run as an inline
// call: mapped, unmapped and array sources, short and long lists, a reassigned
// length, a class constructor and a replaced apply. Expected values come from C QuickJS.
var r=[];
function T(){ this.initialize.apply(this, arguments); }
T.prototype.initialize = function(a,b,c){ this.s = a + b + (c===undefined?0:c); };
var sum=0; for (var i=0;i<5;i++){ sum += new T(1,2).s + new T(1,2,3).s; } r.push(sum);
function f(){ return g.apply(null, arguments); } function g(){ return arguments.length + ':' + Array.prototype.join.call(arguments, '/'); }
r.push(f(), f(1), f(1,2,3,4,5,6,7,8), f(1,2,3,4,5,6,7,8,9), g.apply(null,[4,5]));
function h(){ "use strict"; return k.apply(this, arguments); } function k(x){ arguments[0]=9; return x; } r.push(h(3));
function m(a){ a = 7; return n.apply(null, arguments); } function n(x){ return x; } r.push(m(1));
var arr=[1,2]; arr.length=1; r.push(g.apply(null, arr));
function q(){ arguments.length = 1; return g.apply(null, arguments); } r.push(q(1,2,3));
var holes=[1,,3]; r.push(g.apply(null, holes));
class C { constructor(){} } try { (function(){ C.apply(null, arguments) })() } catch(e) { r.push(e.constructor.name) }
function self(){ return this; } r.push(self.apply(5) == 5, typeof self.apply(undefined, []));
var o={ apply: function(){ return 'own' } }; r.push(o.apply(null, []));
function w(){ return w2.apply(this, arguments); } function w2(){ throw new Error('inner') } try { w(1) } catch(e) { r.push(e.message) }
const got = r.join();
const expected = '45,0:,1:1,8:1/2/3/4/5/6/7/8,9:1/2/3/4/5/6/7/8/9,2:4/5,9,7,1:1,1:1,3:1//3,TypeError,true,object,own,inner';
console.log(got === expected ? 'PASS apply inline path' : 'FAIL ' + got);
if (got !== expected) throw new Error('apply regressions');
