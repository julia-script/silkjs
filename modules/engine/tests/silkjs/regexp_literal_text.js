// Regexp literal bodies and flags read straight from plain ASCII source, and
// the general scanner for everything else, give the same source, flags and
// errors.
var got = [];
var literals = [/a/, /[/]x/, /\//, /a\/b/g, /[\]/]/i, /\[/, /x/gimsuy, /\\/, /é+/u, /[é/]/,
  /(?:a|b)*?c{2,3}$/m, /A\x42/, /a/d];
for (var i = 0; i < literals.length; i++) got.push(literals[i].source + ' ' + literals[i].flags);
var errors = ['/abc', '/a\n/', '/a\\\n/', '/[/', '/a/é', '/a\\'];
for (var j = 0; j < errors.length; j++) {
  try { (0, eval)(errors[j]); got.push('ok'); } catch (e) { got.push(e.name); }
}
got.push((0, eval)('/qé/g').source, (0, eval)('/q/gé'.slice(0, 4)).flags);
var text = got.join('|');
var expected = 'a |[/]x |\\/ |a\\/b g|[\\]/] i|\\[ |x gimsuy|\\\\ |é+ u|[é/] |(?:a|b)*?c{2,3}$ m|A\\x42 |a d|SyntaxError|SyntaxError|SyntaxError|SyntaxError|SyntaxError|SyntaxError|qé|g';
console.log(text === expected ? 'PASS regexp literal text' : 'FAIL ' + text);
if (text !== expected) throw new Error('regexp literal text');
