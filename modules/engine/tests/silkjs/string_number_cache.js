// SilkJS regression test for the one-entry cache of the last string a numeric
// operator converted: repeated and alternating strings, strings that change
// between uses, non-compact strings, float and non-numeric text, and both
// operand orders. Expected values come from node.
var r = [];
var s = "12345", t = "678", u = "1.5", w = "abc", big = "1".repeat(40), r1 = 0;
for (var i = 0; i < 5; i++) { r1 += s | 0; r1 += (t * 2); r1 += 1 - u; r1 += (s >> 1); }
r.push(r1, w | 0, w * 1, big * 1 > 1e38, 0 | big, "9" - 1, 3 * "4", "7" < 8, 9 > "10");
var k = "1"; for (var j = 0; j < 4; j++) { k = k + "1"; r.push(k | 0); }
var mixed = ["5", "6", "5", "7"], m = 0;
for (var q = 0; q < mixed.length; q++) m = m * 10 + (mixed[q] | 0);
r.push(m);
const got = r.join();
const expected = '99362.5,0,NaN,true,0,8,12,true,false,11,111,1111,11111,5657';
if (got !== expected) throw new Error('string number cache: got ' + got);
console.log('ok');
