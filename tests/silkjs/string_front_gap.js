// s = piece + s writes into a gap ahead of s's text. Every reader must start at
// the text, and appends, conversions and keys must see the same string.
// Expected values come from V8.
const r = [];
var s = '';
for (var i = 0; i < 3000; i++) s = String.fromCharCode(97 + i % 26) + s;
r.push(s.length, s.charCodeAt(0), s.charCodeAt(2999), s.slice(0, 5), s.slice(-5), s.indexOf('zyx'), s.lastIndexOf('cba'));
// Appends after prepends keep the gap and the text.
for (var i = 0; i < 40; i++) s += 'END';
r.push(s.length, s.slice(2995, 3010), s.endsWith('ENDEND'));
// Prepends past 8 KiB stay flat and correct, with copies taken midway.
var big = '', mid;
for (var i = 0; i < 5000; i++) { big = 'ab' + big; if (i === 3333) mid = big; }
r.push(big.length, mid.length, big.endsWith(mid), big === 'ab'.repeat(5000));
// The string as a property key, a Map key, in a compare and a regexp.
var o = {}; var k = ''; for (var i = 0; i < 70; i++) k = 'k' + k;
o[k] = 1; r.push(o['k'.repeat(70)], Object.keys(o)[0].length);
var m = new Map(); m.set(k, 2); r.push(m.get('k'.repeat(70)), k === 'k'.repeat(70), k < 'k'.repeat(71), k > 'k'.repeat(69));
r.push(/k{70}/.test(k), k.replace(/k/g, 'x').slice(0, 3), JSON.stringify(k.slice(0, 4)), k.split('kk').length);
// A wide piece in front of a gapped string, then a wide string prepended to.
var w = '', v;
for (var i = 0; i < 90; i++) w = 'w' + w;
w = 'λ' + w; v = w;
for (var i = 0; i < 20; i++) w = 'q' + w;
r.push(w.length, w.charCodeAt(20), v.length, w.slice(-3), v.charCodeAt(0));
// A shared string is never written in front of.
var p = 'tail', q;
for (var i = 0; i < 200; i++) { q = p; p = 'z' + p; }
r.push(q.length, p.length, p.slice(1) === q, q.charAt(0));
// Number conversion and String methods on a gapped string.
var d = ''; for (var i = 0; i < 70; i++) d = (i % 10) + d;
r.push(d.slice(0, 6), d.length, d.toUpperCase().length, d.trim().length, (' ' + d).trim() === d, d.codePointAt(69));
const got = r.join('|');
const expected = '3000|106|97|jihgf|edcba|10|2997|3120|edcbaENDENDENDE|true|10000|6668|true|true|1|70|2|true|true|true|true|xxx|"kkkk"|36|111|955|91|www|955|203|204|true|z|987654|70|70|70|true|48';
console.log(got === expected ? 'PASS string front gap' : 'FAIL ' + got);
if (got !== expected) throw new Error('string front gap regressions');
