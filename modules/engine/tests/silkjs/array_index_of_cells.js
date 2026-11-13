// SilkJS regression test for Array.prototype.indexOf and includes searching
// for an object or symbol (an identity scan of fast arrays) from every start,
// past holes, on non-fast arrays and on array-likes. Expected values from Node.
var r = [];
var a = {}, b = {}, s = Symbol('s'), t = Symbol('t'), f = function () {};
var xs = [1, 'a', undefined, null, a, NaN, s, b, a, f, -0];
for (var i = -12; i <= 12; i += 3) r.push(xs.indexOf(a, i), xs.includes(b, i), xs.indexOf(s, i), xs.includes(t, i));
r.push(xs.indexOf(f), xs.lastIndexOf(a), xs.indexOf({}), xs.includes(NaN), xs.indexOf(NaN), xs.indexOf(0), xs.includes(0));
var holes = [, , a]; holes[6] = b; r.push(holes.indexOf(a), holes.indexOf(b), holes.includes(b), holes.indexOf(undefined), holes.includes(undefined));
var big = []; for (var j = 0; j < 5000; j++) big.push(j % 2 ? undefined : { j: j });
var last = big[4998]; r.push(big.indexOf(last), big.indexOf(last, 4999), big.includes(last, -2), big.includes(last, -1));
big.length = 6000; big[5500] = s; r.push(big.indexOf(s), big.includes(s, 5501));
var like = { length: 3, 0: a, 1: s, 2: b }; r.push(Array.prototype.indexOf.call(like, b), Array.prototype.includes.call(like, s));
var proto = [a]; proto.__proto__ = Object.create(Array.prototype, { 1: { value: b } }); proto.length = 2; r.push(proto.indexOf(b));
var q = []; for (var k = 0; k < 100; k++) q.push(k ? {} : a); q[0] = undefined; r.push(q.indexOf(a), q.indexOf(q[99]));
const got = r.join();
const expected = '4,true,6,false,4,true,6,false,8,true,6,false,8,false,-1,false,4,true,6,false,4,true,6,false,8,true,6,false,-1,false,-1,false,-1,false,-1,false,9,8,-1,true,-1,10,true,2,6,true,-1,true,4998,-1,true,false,5500,false,2,true,1,-1,99';
console.log(got === expected ? 'PASS array indexOf and includes of cells' : 'FAIL ' + got);
if (got !== expected) throw new Error('indexOf/includes regressions');
