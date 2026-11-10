// SilkJS regression test for RegExp exec result arrays built with their slots
// and values in the array's own cell (allocate.shapedArray) and freed through
// js_gc.finishFastArray: captures, unset groups, named groups, more captures
// than fit in the cell, and results grown or kept alive. Expected values come from Node.
var r = [];
var m = /(a)(b)?(c)/.exec("xxabcabc"); r.push(JSON.stringify(m), m.index, m.input, m.length, m.groups, Array.isArray(m));
var n = /(?<x>q)/.exec("aq"); r.push(n.groups.x, n.index);
var big = /(a)(a)(a)(a)(a)(a)(a)(a)(a)(a)(a)(a)(a)(a)(a)(a)(a)(a)/.exec("aaaaaaaaaaaaaaaaaaaa"); r.push(big.length, big[17]);
m.push(5); m.foo = 1; r.push(m.length, m[4], m.foo); m.length = 1; r.push(JSON.stringify(m));
var all = []; for (var i = 0; i < 50; i++) all.push(/b(c)/.exec("abc")); r.push(all[49][1], all.length);
var o = { k: 1 }; var keep = /(x)/.exec("x"); keep[1] = o; keep = null; r.push(o.k);
var last; for (var j = 0; j < 1000; j++) last = /(\d+)/.exec("ab" + j); r.push(last[1], last.index);
const got = r.join();
const expected = '["abc","a","b","c"],2,xxabcabc,4,,true,q,1,19,a,5,5,1,["abc"],c,50,1,999,2';
console.log(got === expected ? 'PASS regexp result arrays' : 'FAIL ' + got);
if (got !== expected) throw new Error('regexp result array regressions');
