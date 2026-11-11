// String literals read the same whatever their length and wherever their quote,
// escape, line break or non-ASCII byte falls: the lexer scans plain runs sixteen
// bytes at a time and finishes byte by byte near the end of the source.
function assert(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
var stops = ['', '\\n', '\\\\', '\\x41', '\\u00e9', 'é', '日', '\\\n', "\\'", '\\"', '`'];
var count = 0;
for (var q = 0; q < 2; q++) {
  var quote = q === 0 ? '"' : "'";
  var other = q === 0 ? "'" : '"';
  for (var before = 0; before < 40; before++) {
    for (var s = 0; s < stops.length; s++) {
      for (var after = 0; after < 20; after += 3) {
        var body = 'a'.repeat(before) + stops[s] + other + 'b'.repeat(after);
        var literal = quote + body + quote;
        var expected = 'a'.repeat(before) + eval('"' + stops[s].replace(/^'$/, "'") + '"') + other + 'b'.repeat(after);
        // At the end of the source, in the middle and before a long tail.
        assert(eval(literal), expected, 'end ' + literal);
        assert(eval('(' + literal + ')'), expected, 'paren ' + literal);
        assert(new Function('return ' + literal + ';' + ' '.repeat(40))(), expected, 'tail ' + literal);
        // A skipped function body scans the same literal without its value.
        assert(new Function('function f() { return ' + literal + '.length } return f()')(), expected.length, 'lazy ' + literal);
        count += 4;
      }
    }
  }
}
// Unterminated literals and raw line breaks still fail, at any distance.
for (var n = 0; n < 40; n++) {
  var errors = 0;
  for (var bad of ['"' + 'c'.repeat(n), '"' + 'c'.repeat(n) + '\n"', '"' + 'c'.repeat(n) + '\r"', "'" + 'c'.repeat(n) + '"']) {
    try { eval(bad); } catch (e) { if (e instanceof SyntaxError) errors++; }
  }
  assert(errors, 4, 'errors at ' + n);
  count += 4;
}
console.log('PASS string scan blocks ' + count);
