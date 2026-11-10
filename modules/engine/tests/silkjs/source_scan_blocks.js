// Line and column positions stay exact whatever mix of line feeds, long lines and
// non-ASCII text precedes them: the source scanners count sixteen ASCII bytes at a
// time and fall back to words and bytes around anything else.
function assert(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}
function where(source) {
  var frames = new Function(source)().split('\n');
  var m = null;
  for (var i = 0; m === null; i++) m = /:(\d+):(\d+)\)?$/.exec(frames[i]);
  return [Number(m[1]), Number(m[2])];
}
var layouts = [
  '', '\n', '\n\n\n', '\n'.repeat(17), '//a\n//b\n//c\n//d\n',
  '//' + 'x'.repeat(13) + '\n', '//' + 'x'.repeat(14) + '\n', '//' + 'x'.repeat(15) + '\n',
  '//' + 'x'.repeat(40) + '\n\n//' + 'y'.repeat(29) + '\n',
  '// café 日本語 ' + 'z'.repeat(20) + '\n',
  '/* é\néé\n' + 'w'.repeat(33) + ' */\n',
  '//' + 'v'.repeat(70) + '\r\n', '/*' + 'u'.repeat(90) + '\u00e9' + 't'.repeat(40) + '*/',
  // Runs past 64 bytes, with line feeds at the ends and the middle of a block.
  '//' + 'p'.repeat(61) + '\n' + '//' + 'r'.repeat(29) + '\n//' + 's'.repeat(100) + '\n',
  '\n'.repeat(64) + '/*' + 'o'.repeat(150) + '*/'
];
var lead = ['', ' ', '        ', '/*' + 'q'.repeat(21) + '*/ ', '"éé"; '];
var base = where('return new Error().stack');
var count = 0;
for (var i = 0; i < layouts.length; i++) {
  for (var j = 0; j < layouts.length; j++) {
    for (var k = 0; k < lead.length; k++) {
      var prefix = layouts[i] + layouts[j] + lead[k];
      var lines = prefix.split('\n').length - 1;
      var column = base[1] + prefix.length - prefix.lastIndexOf('\n') - 1;
      var got = where(prefix + 'return new Error().stack');
      assert(got[0], base[0] + lines, 'line for ' + JSON.stringify(prefix));
      assert(got[1], column, 'column for ' + JSON.stringify(prefix));
      count++;
    }
  }
}
console.log('PASS source scan blocks ' + count);
