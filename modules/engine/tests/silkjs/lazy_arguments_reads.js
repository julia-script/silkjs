// SilkJS regression test for lazy arguments slots read by index and length:
// in-range and out-of-range constant indexes, a local index, negative and
// non-integer indexes, an index that is the length, holes past the end,
// sloppy and strict functions, a function that also forwards arguments with
// apply, and a later use after the object was built. Expected values come
// from C QuickJS.
var r=[];
function sum3() { return arguments[0] + arguments[1] + arguments[2]; }
function sum3s() { "use strict"; return arguments[0] + arguments[1] + arguments[2]; }
var t = 0; for (var i = 0; i < 50; i++) t += sum3(i, i, i) + sum3s(i, 1, 2); r.push(t);
r.push(sum3(1), sum3s(1, 2), sum3('a', 'b', 'c', 'd'));
function len() { return arguments.length; } r.push(len(), len(1), len(1, 2, 3, 4, 5, 6, 7, 8, 9, 10));
function at(k) { return 0; }
function each() { var s = ''; for (var j = 0; j < arguments.length; j++) s += arguments[j]; return s; } r.push(each(), each(1, 2, 3), each('x', undefined, null));
function neg() { var k = -1; return arguments[k]; } r.push(neg(1, 2));
function frac() { var k = 0.5; return arguments[k]; } r.push(frac(1, 2));
function str() { var k = 'length'; return arguments[k]; } r.push(str(1, 2, 3));
function past() { return arguments[3]; } r.push(past(1, 2, 3), past(1, 2, 3, 4));
function both() { var n = arguments.length; return n + ':' + target.apply(null, arguments); }
function target() { return Array.prototype.join.call(arguments, '/'); } r.push(both(4, 5, 6));
function later() { var k = 'length'; var a = arguments[k]; return a + arguments[0] + arguments.length; } r.push(later(7, 8));
function big() { return arguments[1000000]; } r.push(big(1));
function obj() { var k = {}; return arguments[k]; } r.push(obj(1));
function strictNeg() { "use strict"; var k = -1; return [arguments[k], arguments.length, arguments[0]].join(); } r.push(strictNeg(9));
function inner() { return arguments[0] * 2; } function outer() { return inner(arguments[0]) + arguments.length; } r.push(outer(21));
const got = r.join();
const expected = '5050,NaN,NaN,abc,0,1,10,,123,xundefinednull,,,3,,4,3:4/5/6,11,,,,1,9,43';
console.log(got === expected ? 'PASS lazy arguments reads' : 'FAIL ' + got);
if (got !== expected) throw new Error('lazy arguments read regressions');
