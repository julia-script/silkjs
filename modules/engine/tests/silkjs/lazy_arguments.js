// SilkJS regression test for functions whose only use of arguments is
// f.apply(x, arguments) (a lazy arguments slot): inline applies, a replaced
// apply that sees the object (identity, callee, length), native targets,
// strict mode, nested closures and eval that keep the real object, and
// repeated uses in one call. Expected values come from C QuickJS.
var r=[];
var Class = { create: function() { return function() { this.initialize.apply(this, arguments); } } };
var P = Class.create(); P.prototype = { initialize: function(a, b) { this.v = (a === undefined ? 0 : a) + (b === undefined ? 0 : b) + arguments.length; } };
var s = 0; for (var i = 0; i < 5; i++) s += new P(1, 2).v + new P(3).v + new P().v; r.push(s);
function fwd() { return target.apply(null, arguments); }
function target() { return arguments.length + ':' + Array.prototype.join.call(arguments, '/'); }
r.push(fwd(), fwd(1), fwd(1, 2, 3, 4, 5, 6, 7, 8, 9, 10));
var seen = [];
var fake = { apply: function(t, a) { seen.push(typeof a, a.length, a[0], a.callee === sloppy); return 'fake'; } };
function sloppy() { return fake.apply(this, arguments); }
r.push(sloppy(7, 8), seen.join('|'));
seen = [];
var fake2 = { apply: function(t, a) { seen.push(a); return seen.length; } };
function twice() { fake2.apply(null, arguments); return fake2.apply(null, arguments); }
r.push(twice(1, 2), seen[0] === seen[1], seen[0].length, Object.prototype.toString.call(seen[0]));
function strictFwd() { 'use strict'; return fake2.apply(null, arguments); }
seen = []; strictFwd(4); var thrown = 'none'; try { seen[0].callee } catch (e) { thrown = e.constructor.name } r.push(thrown);
function toNative() { return Math.max.apply(Math, arguments); } r.push(toNative(3, 9, 4), toNative());
function toBound() { return target.bind(null, 'b').apply(null, arguments); } r.push(toBound(1, 2));
function withClosure() { var g = function() { return arguments; }; var a = arguments; return target.apply(null, arguments) + a.length; } r.push(withClosure(5, 6));
function withArrow() { var f = () => arguments.length; return target.apply(null, arguments) + f(); } r.push(withArrow(5, 6, 7));
function withEval() { return eval('target.apply(null, arguments)'); } r.push(withEval(1, 2));
function readLength() { var n = arguments.length; return target.apply(null, arguments) + n; } r.push(readLength(9));
function callForm() { return target.call(null, arguments); } r.push(callForm(1));
class K { constructor() {} } function toClass() { return K.apply(null, arguments); } try { toClass(1) } catch (e) { r.push(e.constructor.name) }
function thrower() { throw new Error('inner ' + arguments.length) } function toThrower() { return thrower.apply(null, arguments); } try { toThrower(1, 2) } catch (e) { r.push(e.message) }
function self() { return this; } function toSelf() { return self.apply(5, arguments); } r.push(typeof toSelf(), toSelf() == 5);
function deep(n) { return n > 0 ? deep.apply(null, [n - 1]) : 'bottom'; } function toDeep() { return deep.apply(null, arguments); } r.push(toDeep(50));
const got = r.join();
const expected = '45,0:,1:1,10:1/2/3/4/5/6/7/8/9/10,fake,object|2|7|true,2,true,2,[object Arguments],TypeError,9,-Infinity,3:b/1/2,2:5/62,3:5/6/73,2:1/2,1:91,1:[object Arguments],TypeError,inner 2,object,true,bottom';
console.log(got === expected ? 'PASS lazy arguments' : 'FAIL ' + got);
if (got !== expected) throw new Error('lazy arguments regressions');
