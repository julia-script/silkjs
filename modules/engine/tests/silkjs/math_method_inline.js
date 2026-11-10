// SilkJS regression test for Math methods answered in the call_method arm
// (pushInline's OBJECT_METHOD_MATH): ints, floats, -0, NaN, non-number
// arguments that must take the full call, replaced methods and Math.random.
// Expected values come from V8.
var r = [];
var s = 0; for (var i = 0; i < 1000; i++) s += Math.min(i, 500) + Math.max(i, 500); r.push(s);
r.push(Math.min(1, 2), Math.max(1, 2), Math.min(1.5, -2.5), Math.max(1.5, -2.5));
r.push(1 / Math.min(0, -0), 1 / Math.max(-0, 0), Math.min(NaN, 1), Math.max(1, NaN));
r.push(Math.min(), Math.max(), Math.min(3), Math.floor(2.7), Math.ceil(-2.7), Math.abs(-3), Math.sqrt(16), Math.round(2.5));
r.push(Math.min('3', 4), Math.max(null, -1), Math.min(undefined, 1), Math.max(true, 0));
var calls = 0; var o = { valueOf: function () { calls++; return 7; } };
r.push(Math.max(o, 2), Math.min(2, o), calls);
try { Math.min(Symbol('x'), 1); } catch (e) { r.push(e.constructor.name); }
r.push(Math.pow(2, 10), Math.atan2(1, 1).toFixed(4), Math.hypot(3, 4));
var x = Math.random(); r.push(x >= 0 && x < 1);
var saved = Math.min; Math.min = function (a, b) { return 'own' + a + b; }; r.push(Math.min(1, 2)); Math.min = saved;
r.push(Math.min.call(null, 4, 3), Math.max.apply(null, [1, 9, 3]));
var M = Object.create(Math); r.push(M.max(5, 6));
var t = 0; for (var j = 0; j < 100; j++) t += Math.floor(j / 3) + Math.abs(-j); r.push(t);
const got = r.join();
const expected = '999500,1,2,-2.5,1.5,-Infinity,Infinity,NaN,NaN,Infinity,-Infinity,3,2,-2,3,4,3,3,0,NaN,1,7,2,2,TypeError,1024,0.7854,5,true,own12,3,9,6,6567';
console.log(got === expected ? 'PASS Math method inline path' : 'FAIL ' + got);
if (got !== expected) throw new Error('Math inline regressions');
