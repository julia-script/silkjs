// SilkJS regression test: literal runs with units above 255 are compared from their stored
// units, and short wide result pieces come from the substring table. Expected values come from V8.
var r = [];
function show(m) { return m === null ? 'null' : JSON.stringify(Array.prototype.slice.call(m)) + '@' + m.index; }
var s = "the quick brown ᶠᵒˣ jumped over the lazy ᵈᵒᵍ";
for (var k = 0; k < 3; k++) r.push(show(/the quick brown ᶠᵒˣ/.exec(s)), show(/lazy ᵈᵒᵍ/.exec(s)), show(/(ᶠᵒ)(ˣ)/.exec(s)));
r.push(show(/brown ᶠᵒ/.exec('the quick brown fox')), show(/ᶠᵒˣ/.exec('x ᶠᵒˣ ᶠᵒˣ')), show(/ᶠᵒˣ/g.exec('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaᶠᵒˣ')));
r.push(show(/ab(.)ᶠ/.exec('xxabcᶠ')), show(/a(ᶠᶠ)(ab)/.exec('aᶠᶠab')), 'ᶠᵒˣ-ᶠᵒˣ'.split(/-/).join('|'), 'aᶠbᶠc'.replace(/ᶠb/g, '#'));
var a = /(ᶠᵒ)/.exec('ᶠᵒ!')[1]; a += 'z'; r.push(a, /(ᶠᵒ)/.exec('ᶠᵒ?')[1]);
r.push(show(/QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQᶠ/.exec('QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQᶠ')), show(/ᶠa/i.exec('xᶠA')));
var got = r.join('\n');
const expected = "[\"the quick brown ᶠᵒˣ\"]@0\n[\"lazy ᵈᵒᵍ\"]@36\n[\"ᶠᵒˣ\",\"ᶠᵒ\",\"ˣ\"]@16\n[\"the quick brown ᶠᵒˣ\"]@0\n[\"lazy ᵈᵒᵍ\"]@36\n[\"ᶠᵒˣ\",\"ᶠᵒ\",\"ˣ\"]@16\n[\"the quick brown ᶠᵒˣ\"]@0\n[\"lazy ᵈᵒᵍ\"]@36\n[\"ᶠᵒˣ\",\"ᶠᵒ\",\"ˣ\"]@16\nnull\n[\"ᶠᵒˣ\"]@2\n[\"ᶠᵒˣ\"]@83\n[\"abcᶠ\",\"c\"]@2\n[\"aᶠᶠab\",\"ᶠᶠ\",\"ab\"]@0\nᶠᵒˣ|ᶠᵒˣ\na#ᶠc\nᶠᵒz\nᶠᵒ\n[\"QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQᶠ\"]@0\n[\"ᶠA\"]@1";
console.log(got === expected ? 'PASS regexp wide literals' : 'FAIL ' + JSON.stringify(got));
if (got !== expected) throw new Error('regexp wide literal regressions');
