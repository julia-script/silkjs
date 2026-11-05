// for-of and array destructuring over fast Arrays keep the array in the iterator
// record and build the Array Iterator only when a return method could see it.
var out = [];
var a = [1, 2, 3, 4, 5]; var v1, v2, v3, v4;
[v1, v2, , v3, ...v4] = a; out.push(v1, v2, v3, JSON.stringify(v4));
var [p, q] = [7]; out.push(p, q);
var [x, y] = [1, 2]; [x, y] = [y, x]; out.push(x, y);
var sum = 0; for (var e of [1, 2, 3]) { sum += e; if (e == 2) break; } out.push(sum);
var grow = [1, 2]; var seen = []; for (var e of grow) { seen.push(e); if (grow.length < 5) grow.push(e * 10); } out.push(seen.join());
var shrink = [1, 2, 3, 4]; seen = []; for (var e of shrink) { seen.push(e); shrink.pop(); } out.push(seen.join());
var holey = [1, , 3]; seen = []; for (var e of holey) seen.push(e); out.push(seen.join('/'));
var slow = [1, 2, 3]; seen = []; for (var e of slow) { seen.push(e); if (e == 1) Object.defineProperty(slow, 2, { get: function () { return 'got'; } }); } out.push(seen.join());
var lengthy = [1, 2]; seen = []; for (var e of lengthy) { seen.push(e); if (e == 1) lengthy.length = 4; } out.push(seen.length, seen.join('/'));
function thrower() { var arr = [1, 2, 3]; try { for (var e of arr) { if (e == 2) throw new Error('boom'); } } catch (err) { return err.message; } }
out.push(thrower());
var ArrayIteratorProto = Object.getPrototypeOf([][Symbol.iterator]());
var closed = 0;
ArrayIteratorProto.return = function () { closed++; out.push('return:' + this.next().value); return {}; };
var [r1] = [10, 20, 30]; out.push(r1, closed);
for (var e of [5, 6, 7]) { if (e == 6) break; } out.push(closed);
try { for (var e of [8, 9]) { throw 1; } } catch (err) { out.push('caught', closed); }
var [r2, r3, r4] = [1, 2]; out.push(r4, closed);
delete ArrayIteratorProto.return;
var IteratorProto = Object.getPrototypeOf(ArrayIteratorProto);
Object.defineProperty(IteratorProto, 'return', { get: function () { out.push('getter'); return undefined; }, configurable: true });
var [g1] = [1, 2]; out.push(g1);
delete IteratorProto.return;
var origNext = ArrayIteratorProto.next; var calls = 0;
ArrayIteratorProto.next = function () { calls++; return origNext.call(this); };
var [n1, n2] = [3, 4]; out.push(n1, n2, calls);
ArrayIteratorProto.next = origNext;
var origIter = Array.prototype[Symbol.iterator]; var iterCalls = 0;
Array.prototype[Symbol.iterator] = function () { iterCalls++; return origIter.call(this); };
var [i1] = [9]; out.push(i1, iterCalls);
Array.prototype[Symbol.iterator] = origIter;
var own = [1, 2]; own[Symbol.iterator] = function* () { yield 'own'; }; var [o1] = own; out.push(o1);
function* gen() { for (var e of [1, 2, 3]) yield e; }
var it = gen(); out.push(it.next().value); ArrayIteratorProto.return = function () { out.push('genclose'); return {}; }; out.push(JSON.stringify(it.return(42)));
delete ArrayIteratorProto.return;
var keys = []; for (var k of [4, 5].keys()) keys.push(k); out.push(keys.join());
var mixed = ['s', { o: 1 }, 2.5]; var [m1, m2, m3] = mixed; out.push(m1, m2.o, m3);
var str = ''; for (var ch of 'ab') str += ch; out.push(str);
var big = []; for (var i = 0; i < 100; i++) big.push(i); var bs = 0; for (var e of big) bs += e; out.push(bs);
var sp = [...[1, 2, 3]]; out.push(sp.join());
function argsIter() { var [a0, a1] = arguments; return a0 + a1; } out.push(argsIter(3, 4));
var got4 = out.join('|');
const expected = "1|2|4|[5]|7||2|1|3|1,2,10,20,100|1,2|1//3|1,2,got|4|1/2//|boom|return:20|10|1|return:7|2|return:9|caught|3||3|getter|1|3|4|2|9|1|own|1|genclose|{\"value\":42,\"done\":true}|0,1|s|1|2.5|ab|4950|1,2,3|7";
console.log(got4 === expected ? 'PASS array iteration records' : 'FAIL ' + got4);
if (got4 !== expected) throw new Error('array iteration record regressions');
