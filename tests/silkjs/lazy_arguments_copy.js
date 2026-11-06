// SilkJS regression test for a lazy arguments object copied to one other local
// (var a = arguments) and read through it by index and length: a list builder,
// a copy made only on one branch, a copy a closure captures, a copy returned
// or copied again, out-of-range and negative indexes before in-range ones,
// strict mode, a copy passed to apply, and a named property read.
var r=[];
function sc_list() { var res = null; var a = arguments; for (var i = a.length-1; i >= 0; i--) res = [a[i], res]; return res; }
r.push(JSON.stringify(sc_list(1, 2, 3)), JSON.stringify(sc_list()));
function branch(x) { var a; if (x) a = arguments; return a ? a.length : -1; } r.push(branch(1, 2), branch(0));
function captured() { var a = arguments; return function () { return a.length; }; } r.push(captured(1, 2, 3)());
function returned() { var a = arguments; return a; }
r.push(returned(4, 5).length, Array.isArray(returned()), Object.prototype.toString.call(returned(1)));
function past() { var a = arguments; return a[5]; } r.push(past(1));
function twice() { var a = arguments; var b = a; return b.length; } r.push(twice(1, 2));
function negative() { var a = arguments; var x = a[-1]; return [x, a[0], a.length].join(); } r.push(negative(7));
function strict() { "use strict"; var a = arguments; return a.length + a[0]; } r.push(strict(5));
function applied() { var a = arguments; return Math.max.apply(null, a); } r.push(applied(3, 9, 2));
function named() { var a = arguments; return a.foo; } r.push(named());
var t = 0; for (var k = 0; k < 100; k++) t += sc_list(k, k)[0]; r.push(t);
const got = r.join('|');
const expected = '[1,[2,[3,null]]]|null|2|-1|3|2|false|[object Arguments]||2|,7,1|6|9||4950';
console.log(got === expected ? 'PASS lazy arguments copy' : 'FAIL ' + got);
if (got !== expected) throw new Error('lazy arguments copy regressions');
