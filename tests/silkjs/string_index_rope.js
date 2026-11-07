// text[i] reads: a `+=` rope is flattened on the first index read, Latin-1
// units come from the unit-string cache, and everything else (wide units, out
// of range, non-Int keys) keeps the generic answer.
const out = [];
let rope = '';
for (let i = 0; i < 300; i++) rope += (i % 7 == 0 ? ' ' : '') + 'ab' + (i % 13) + ' ';
function scan(e) { let n = 0; for (let i = 0; i < e.length; i++) { if (e[i] == ' ') n++; } return n; }
out.push(scan(rope), scan(rope.split('').join('')));
function arg(e, i) { return e[i]; }
out.push(arg(rope, 0), arg(rope, 1), String(arg(rope, rope.length)), String(arg(rope, -1)));
let wide = 'x';
for (let i = 0; i < 50; i++) wide += 'é€' + i;
out.push(wide[1], wide[2], wide.length, wide[wide.length - 1]);
const box = { s: rope };
out.push(box.s[2], rope['3'], String(rope[1.5]), rope['length']);
let joined = '';
for (let i = 0; i < 40; i++) { joined += String.fromCharCode(65 + (i % 26)); if (joined[i] !== String.fromCharCode(65 + (i % 26))) out.push('bad ' + i); }
out.push(joined);
const captured = 'pq' + rope;
const reader = () => { let t = ''; for (let i = 0; i < 4; i++) t += captured[i]; return t; };
out.push(reader());
const got = out.join('\n');
const expected = "343\n343\n \na\nundefined\nundefined\né\n€\n191\n9\nb\n0\nundefined\n1312\nABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMN\npq a";
console.log(got === expected ? 'PASS string index rope' : 'FAIL ' + got);
if (got !== expected) throw new Error('string index regressions');
