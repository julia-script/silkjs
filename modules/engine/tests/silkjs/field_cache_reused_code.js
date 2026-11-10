// SilkJS regression test for the get_field site cache: bytecode freed after an
// eval can have its address reused by new bytecode that reads another property
// of an object with the same shape at the same offset; the cached slot of the
// old site must not answer for it (CodeLoad failed with "not a function").
// Expected values come from C QuickJS.
function Mock() { this.a = 1; this.b = 2; this.c = 3; this.d = 4; this.e = 5; this.f = 6; }
var names = ['a', 'b', 'c', 'd', 'e', 'f'];
var indirect = eval;
var bad = [];
for (var i = 0; i < 300; i++) {
  var j = i % 6;
  var got = indirect('var m = new Mock(); var s = 0; for (var k = 0; k < 3; k++) s = s + m.' + names[j] + '; s');
  if (got !== 3 * (j + 1) && bad.length < 3) bad.push(i + ':' + got);
}
if (bad.length !== 0) throw new Error('field cache: wrong reads ' + bad.join());
print('ok');
