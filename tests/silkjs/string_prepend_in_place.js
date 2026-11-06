// s = piece + s grows s in its own buffer; every earlier value must stay intact.
const r = [];
function prepends(n, piece) {
  var s = '', kept = [];
  for (var i = 0; i < n; i++) { s = piece + s; if (i % 97 === 0) kept.push(s); }
  return [s, kept];
}
var a = prepends(800, 'x');
r.push(a[0].length, a[0] === 'x'.repeat(800), a[1].every(function (k, i) { return k === 'x'.repeat(i * 97 + 1); }));
var b = prepends(3000, 'abc');
r.push(b[0].length, b[0] === 'abc'.repeat(3000), b[1].every(function (k, i) { return k === 'abc'.repeat(i * 97 + 1); }));
// A shared s (t holds it too) must not see the prepend.
var s = 'tail', t;
for (var i = 0; i < 300; i++) { t = s; s = String.fromCharCode(97 + i % 26) + s; }
r.push(t.length, s.length, s.slice(1) === t, t.endsWith('tail'));
// Wide pieces and wide strings take the general path.
var w = 'end';
for (var i = 0; i < 50; i++) w = (i % 2 ? 'λ' : 'q') + w;
r.push(w.length, w.charCodeAt(0), w.slice(-3));
// Appends past 8 KiB stay correct with a copy taken midway.
var big = '', mid;
for (var i = 0; i < 4000; i++) { big += 'abcd'; if (i === 2500) mid = big; }
r.push(big.length, mid.length, big.slice(0, mid.length) === mid, big === 'abcd'.repeat(4000));
const got = r.join('|');
const expected = '800|true|true|9000|true|true|303|304|true|true|53|955|end|16000|10004|true|true';
console.log(got === expected ? 'PASS string prepend in place' : 'FAIL ' + got);
if (got !== expected) throw new Error('string prepend regressions');
