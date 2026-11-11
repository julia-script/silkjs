// Building a string one piece at a time: `s += piece` into a variable its
// closures capture (written in place when only the scope holds s), the
// charCodeAt and fromCharCode calls made per character, and == on two strings.
function assert(actual, expected, message) {
  if (actual !== expected && !(actual !== actual && expected !== expected)) {
    throw new Error(message + ': got ' + actual + ', expected ' + expected);
  }
}
// A captured variable appended to by the function that declares it and by a closure.
function build(count) {
  var text = '', spaced = '', kept;
  function add(piece) { text += piece; }
  function addSpaced(piece) { spaced = spaced + piece; }
  for (var i = 0; i < count; i++) {
    add(String.fromCharCode(65 + i % 26));
    addSpaced('xy');
    text += '';
    if (i === count >> 1) { kept = text; }
  }
  return [text, spaced, kept];
}
var built = build(1000);
assert(built[0].length, 1000, 'captured append length');
assert(built[0].slice(0, 30), 'ABCDEFGHIJKLMNOPQRSTUVWXYZABCD', 'captured append text');
assert(built[1].length, 2000, 'captured s = s + piece length');
assert(built[2].length, 501, 'a copy taken mid-way keeps its length');
assert(built[2].slice(495), 'BCDEFG', 'a copy taken mid-way keeps its text');
assert(built[0].charCodeAt(999), 76, 'last unit');
// Another holder of the string must not see later appends.
function holders() {
  var s = 'a', first = s;
  (function () { s += 'b'; s += 'c'; })();
  var second = s;
  (function () { s += 'd'; })();
  s += 'e';
  var third = s;
  s += 'f';
  return first + '|' + second + '|' + third + '|' + s;
}
assert(holders(), 'a|abc|abcde|abcdef', 'holders keep their own text');
function snapshots() {
  var s = 'start', seen = [];
  function step() { seen.push(s); s += '0123456789abcdefghij'; s += 'x'; }
  for (var i = 0; i < 40; i++) { step(); }
  return seen[1].length + ' ' + seen[39].length + ' ' + s.length + ' ' + seen[5].slice(-3);
}
assert(snapshots(), '26 824 845 ijx', 'snapshots of a growing captured string');
// Wide pieces, long pieces and non-strings leave the in-place path.
function mixed() {
  var s = '';
  function f(piece) { s += piece; }
  f('ab'); f('ሴ'); f(7); f(null); f('0123456789012345678901234567890123456789'); f(1.5); f({ toString: function () { return 'T'; } });
  return s;
}
assert(mixed(), 'abሴ7null01234567890123456789012345678901234567891.5T', 'mixed pieces');
// A `let` in a loop body captured by a closure: each generation its own string.
var readers = [];
for (var round = 0; round < 3; round++) {
  let own = 'r' + round;
  readers.push(function () { return own; });
  own += '!'; own += round;
}
assert(readers.map(function (f) { return f(); }).join(','), 'r0!0,r1!1,r2!2', 'per-iteration captured strings');

// charCodeAt and fromCharCode with one argument, on and off their fast paths.
var sample = 'hélloሴx', codes = [];
for (var at = -1; at < 8; at++) { codes.push(sample.charCodeAt(at)); }
codes.push(sample.charCodeAt(1.5), sample.charCodeAt('2'), sample.charCodeAt(), new String('abc').charCodeAt(1));
codes.push({ charCodeAt: String.prototype.charCodeAt, toString: function () { return 'zz'; } }.charCodeAt(0));
var rope = 'left-part-of-a-rope-' + sample + '-right-part-of-a-rope';
codes.push(rope.charCodeAt(21), rope.charCodeAt(25), rope.charCodeAt(999));
assert(codes.join(','), 'NaN,104,233,108,108,111,4660,120,NaN,233,108,104,98,122,233,4660,NaN', 'charCodeAt');
var units = '';
for (var code = 0; code < 300; code += 37) { units += String.fromCharCode(code); }
units += String.fromCharCode(0x1234, 65) + String.fromCharCode(65536 + 66) + String.fromCharCode(-1).charCodeAt(0)
  + String.fromCharCode(3.7) + String.fromCharCode('67') + String.fromCharCode();
assert(escape(units), '%00%25Jo%94%B9%DE%u0103%u0128%u1234AB65535%03C', 'fromCharCode');
var replaced = String.fromCharCode; String.fromCharCode = function (c) { return '<' + c + '>'; };
assert(String.fromCharCode(65), '<65>', 'a replaced fromCharCode is called');
String.fromCharCode = replaced;
var own = new String('q'); own.charCodeAt = function (i) { return -i; };
assert(own.charCodeAt(3), -3, 'an own charCodeAt is called');

// == and != on strings of every length around a word, equal and differing at each end.
function same(a, b) { return a == b; }
function differ(a, b) { return a != b; }
for (var length = 0; length < 40; length++) {
  var base = '';
  for (var n = 0; n < length; n++) { base += String.fromCharCode(97 + n % 26); }
  var copy = base.slice(0, length >> 1) + base.slice(length >> 1);
  assert(same(base, copy), true, 'equal texts of length ' + length);
  assert(differ(base, copy), false, 'equal texts are not != at length ' + length);
  if (length > 0) {
    var head = 'Z' + base.slice(1), tail = base.slice(0, length - 1) + 'Z', middle = base.slice(0, length >> 1) + 'Z' + base.slice((length >> 1) + 1);
    assert(same(base, head), false, 'first unit differs at length ' + length);
    assert(same(base, tail), false, 'last unit differs at length ' + length);
    assert(same(base, middle), false, 'middle unit differs at length ' + length);
    assert(differ(base, tail), true, '!= on a differing last unit at length ' + length);
    assert(same(base, base + 'a'), false, 'longer text at length ' + length);
  }
}
assert(same('1', 1), true, 'string == number'); assert(same('', 0), true, 'empty string == 0');
assert(same('a', new String('a')), true, 'string == String object'); assert(same(null, undefined), true, 'null == undefined');
assert(same('éሴ', 'é' + 'ሴ'), true, 'wide texts'); assert(same('abc', 'abሴ'), false, 'wide against narrow');
assert(same('null', null), false, 'string == null'); assert(differ('x', undefined), true, 'string != undefined');
