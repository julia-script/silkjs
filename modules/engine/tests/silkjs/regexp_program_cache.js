// SilkJS regression test: compiled RegExp bytecode is reused by pattern and flags text
// (RuntimeState.regexpPrograms), so re-evaluated sources and repeated RegExp() calls
// skip compiling. A hit must match both texts exactly. Expected values come from V8.
var r = [];
for (var i = 0; i < 3; i++) {
  r.push(eval('/a.c/i.test("ABC") + "," + /a.c/.test("ABC") + "," + /a.c/m.flags'));
  r.push(new RegExp('x+y', 'g').exec('axxyb')[0] + new RegExp('x+y').global);
  r.push(String(new RegExp('x+y', 'gy').sticky) + new RegExp('x+y', 'ig').flags);
}
// Same length, first, middle and last unit: same cache slot, different patterns.
r.push(/abxd/.test('abxd') + ',' + /abyd/.test('abxd') + ',' + /abxd/.test('abyd'));
r.push(new RegExp('ab' + 'xd').test('abxd') + ',' + new RegExp('a' + 'byd').test('abyd'));
// Wide patterns, and the same text in Latin-1 and wide strings.
r.push(/ā+/.exec('xāā')[0].length + ',' + new RegExp('ā+').test('ā'));
// An invalid pattern still throws every time, even after a valid one shares its slot.
for (var k = 0; k < 2; k++) {
  try { new RegExp('a(b'); r.push('no error'); } catch (e) { r.push(e.name); }
}
// Many distinct patterns evict each other and still compile correctly.
var hits = 0;
for (var j = 0; j < 200; j++) { if (new RegExp('n' + j + '$').test('n' + j)) hits++; }
for (var j = 0; j < 200; j++) { if (new RegExp('n' + j + '$').test('n' + (j + 1))) hits++; }
r.push(hits);
const got = r.join(';');
const expected = 'true,false,m;xxyfalse;truegi;true,false,m;xxyfalse;truegi;true,false,m;xxyfalse;truegi;true,false,false;true,true;2,true;SyntaxError;SyntaxError;200';
console.log(got === expected ? 'PASS regexp program cache' : 'FAIL ' + JSON.stringify(got));
if (got !== expected) throw new Error('regexp program cache regressions');
