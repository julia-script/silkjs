// A never-called `(a, b) => a - b` comparator is still a deferred-compile stub
// when sort first sees it; sort finishes it so the number-pair shortcut applies,
// and every result matches calling the comparator.
const out = [];
out.push([3, 1, 2, -7, 2.5, 0, -0].sort((x, y) => x - y).join());
out.push([3, 1, 2, -7, 2.5].sort((x, y) => y - x).join());
out.push([5, 4, 3].sort(function (p, q) { return p - q; }).join());
// An inconsistent comparator: the order must match the one calling it gives.
out.push([NaN, 3, 1, NaN, 2].sort((a, b) => a - b).map(String).join());
out.push(["10", 9, "1", 2].sort((a, b) => a - b).join());
out.push([1, 2, 3].sort((a, b) => b - a + 0).join());
let calls = 0;
const counted = (a, b) => { calls++; return a - b; };
[4, 2, 9, 1].sort(counted);
out.push(calls > 0);
const big = []; for (let i = 0; i < 200; i++) big.push((i * 7919) % 211);
out.push(big.sort((a, b) => a - b).every((v, i, a) => i === 0 || a[i - 1] <= v));
const got = out.join('\n');
const expected = "-7,0,0,1,2,2.5,3\n3,2.5,2,1,-7\n3,4,5\nNaN,1,3,NaN,2\n1,2,9,10\n3,2,1\ntrue\ntrue";
console.log(got === expected ? 'PASS sort numeric comparator' : 'FAIL ' + got);
if (got !== expected) throw new Error('sort numeric comparator regressions');
