// SilkJS regression test: compiled class bitmaps (with case folding), case-insensitive
// punctuation literals, and String.prototype.replace's quick path from the VM with every way
// out of it (own or prototype Symbol.replace, exec overrides, named groups, $ patterns,
// wide strings, long results, sticky and global lastIndex). Expected values come from V8.
var r = [];
// Classes with a compiled Latin-1 bitmap, with and without case folding.
var subjects = ['abc', 'ABC', 'KKk', 'sſS', 'éÉÿŸ', 'µΜμ', 'a#b#C', 'x_9-Z', '😀z'];
var patterns = [/[a-c]+/, /[a-c]+/i, /[^a-c]+/i, /[k]+/iu, /[k]+/i, /[s]+/iu, /[à-ÿ]+/i, /[µ]/i, /[µ]/iu,
  /[\w#]+/i, /#[a-z]/i, /[^\W_]+/i, /[^\W_]+/iu, /\d[a-z-]*/gi, /[É]/i, /[Ÿ]/i, /[＀-￿]/, /[^x]/u, /[^x]/];
for (var i = 0; i < patterns.length; i++) {
  for (var j = 0; j < subjects.length; j++) {
    var m = subjects[j].match(patterns[i]);
    r.push(i + ':' + j + ' ' + (m ? JSON.stringify(m[0]) + '@' + m.index : 'null'));
  }
}
// Case-insensitive literals made of punctuation, digits and letters.
r.push('xx##YV4##yy'.replace(/##yv4##/gi, '!'), 'a-1.b-1.'.replace(/-1\./gi, '+'), '##'.search(/#?#/i));
// String.prototype.replace with a RegExp: the quick path and every way out of it.
var long = ''; for (var k = 0; k < 300; k++) long += 'ab,cd;';
r.push(long.replace(/,/g, '--').length, long.replace(/;/g, '').length, long.replace(/[,;]/g, 'XYZ').slice(0, 40));
r.push('a,b,c'.replace(/,/g, ''), 'abc'.replace(/x/g, '-'), 'aaa'.replace(/a/g, ''), ''.replace(/x*/g, '+'), 'abc'.replace(/x*/g, '-'));
r.push('aĀb'.replace(/Ā/g, '-'), 'abc'.replace(/b/, 'Ā'), 'aéb'.replace(/é/, 'e'), '😀x'.replace(/(?:)/gu, '.'));
r.push('abc'.replace(/(b)/, '[$1]'), 'abc'.replace(/b/, '$&$&'), 'abc'.replace(/b/, '$$'), 'abc'.replace(/b/g, function (s) { return s.toUpperCase(); }));
var g = /b/g; g.lastIndex = 2; r.push('abcb'.replace(g, '-'), g.lastIndex);
var y = /b/y; y.lastIndex = 1; r.push('abcb'.replace(y, '-'), y.lastIndex, 'abcb'.replace(y, '-'), y.lastIndex);
var n = /b/; n.lastIndex = 3; r.push('abcb'.replace(n, '-'), n.lastIndex);
var own = /b/g; own[Symbol.replace] = function (s, t) { return 'own:' + s + t; }; r.push('abc'.replace(own, '-'));
var saved = RegExp.prototype[Symbol.replace];
RegExp.prototype[Symbol.replace] = function (s, t) { return 'proto:' + s + t; }; r.push('abc'.replace(/b/g, '-'));
RegExp.prototype[Symbol.replace] = saved; r.push('abc'.replace(/b/g, '-'));
delete RegExp.prototype[Symbol.replace]; r.push('ab/b/c'.replace(/b/g, '-'));
RegExp.prototype[Symbol.replace] = saved; r.push('abc'.replace(/b/g, '-'));
var execs = 0, oldExec = RegExp.prototype.exec;
RegExp.prototype.exec = function (s) { execs++; return oldExec.call(this, s); }; r.push('abcb'.replace(/b/g, '-'), execs);
RegExp.prototype.exec = oldExec; r.push('abcb'.replace(/b/g, '-'));
var named = /(?<x>b)/g; r.push('abcb'.replace(named, '-'), 'abcb'.replace(named, '[$<x>]'));
r.push(String.prototype.replace.call(123, /2/, 'x'), 'abc'.replace(/b/g, 7), 'abc'.replace(/b/g));
var frozen = Object.freeze(/b/g); try { 'abc'.replace(frozen, '-'); r.push('no throw'); } catch (e) { r.push(e.name); }
const got = r.join('\n');
const expected = "0:0 \"abc\"@0\n0:1 null\n0:2 null\n0:3 null\n0:4 null\n0:5 null\n0:6 \"a\"@0\n0:7 null\n0:8 null\n1:0 \"abc\"@0\n1:1 \"ABC\"@0\n1:2 null\n1:3 null\n1:4 null\n1:5 null\n1:6 \"a\"@0\n1:7 null\n1:8 null\n2:0 null\n2:1 null\n2:2 \"KKk\"@0\n2:3 \"sſS\"@0\n2:4 \"éÉÿŸ\"@0\n2:5 \"µΜμ\"@0\n2:6 \"#\"@1\n2:7 \"x_9-Z\"@0\n2:8 \"😀z\"@0\n3:0 null\n3:1 null\n3:2 \"KKk\"@0\n3:3 null\n3:4 null\n3:5 null\n3:6 null\n3:7 null\n3:8 null\n4:0 null\n4:1 null\n4:2 \"K\"@0\n4:3 null\n4:4 null\n4:5 null\n4:6 null\n4:7 null\n4:8 null\n5:0 null\n5:1 null\n5:2 null\n5:3 \"sſS\"@0\n5:4 null\n5:5 null\n5:6 null\n5:7 null\n5:8 null\n6:0 null\n6:1 null\n6:2 null\n6:3 null\n6:4 \"éÉÿŸ\"@0\n6:5 null\n6:6 null\n6:7 null\n6:8 null\n7:0 null\n7:1 null\n7:2 null\n7:3 null\n7:4 null\n7:5 \"µ\"@0\n7:6 null\n7:7 null\n7:8 null\n8:0 null\n8:1 null\n8:2 null\n8:3 null\n8:4 null\n8:5 \"µ\"@0\n8:6 null\n8:7 null\n8:8 null\n9:0 \"abc\"@0\n9:1 \"ABC\"@0\n9:2 \"K\"@0\n9:3 \"s\"@0\n9:4 null\n9:5 null\n9:6 \"a#b#C\"@0\n9:7 \"x_9\"@0\n9:8 \"z\"@2\n10:0 null\n10:1 null\n10:2 null\n10:3 null\n10:4 null\n10:5 null\n10:6 \"#b\"@1\n10:7 null\n10:8 null\n11:0 \"abc\"@0\n11:1 \"ABC\"@0\n11:2 \"K\"@0\n11:3 \"s\"@0\n11:4 null\n11:5 null\n11:6 \"a\"@0\n11:7 \"x\"@0\n11:8 \"z\"@2\n12:0 \"abc\"@0\n12:1 \"ABC\"@0\n12:2 \"KKk\"@0\n12:3 \"sſS\"@0\n12:4 null\n12:5 null\n12:6 \"a\"@0\n12:7 \"x\"@0\n12:8 \"z\"@2\n13:0 null\n13:1 null\n13:2 null\n13:3 null\n13:4 null\n13:5 null\n13:6 null\n13:7 \"9-Z\"@undefined\n13:8 null\n14:0 null\n14:1 null\n14:2 null\n14:3 null\n14:4 \"é\"@0\n14:5 null\n14:6 null\n14:7 null\n14:8 null\n15:0 null\n15:1 null\n15:2 null\n15:3 null\n15:4 \"ÿ\"@2\n15:5 null\n15:6 null\n15:7 null\n15:8 null\n16:0 null\n16:1 null\n16:2 null\n16:3 null\n16:4 null\n16:5 null\n16:6 null\n16:7 null\n16:8 null\n17:0 \"a\"@0\n17:1 \"A\"@0\n17:2 \"K\"@0\n17:3 \"s\"@0\n17:4 \"é\"@0\n17:5 \"µ\"@0\n17:6 \"a\"@0\n17:7 \"_\"@1\n17:8 \"😀\"@0\n18:0 \"a\"@0\n18:1 \"A\"@0\n18:2 \"K\"@0\n18:3 \"s\"@0\n18:4 \"é\"@0\n18:5 \"µ\"@0\n18:6 \"a\"@0\n18:7 \"_\"@1\n18:8 \"\\ud83d\"@0\nxx!yy\na+b+\n0\n2100\n1500\nabXYZcdXYZabXYZcdXYZabXYZcdXYZabXYZcdXYZ\nabc\nabc\n\n+\n-a-b-c-\na-b\naĀc\naeb\n.😀.x.\na[b]c\nabbc\na$c\naBc\na-c-\n0\na-cb\n2\nabcb\n0\na-cb\n3\nown:abc-\nproto:abc-\na-c\nab/b/c\na-c\na-c-\n3\na-c-\na-c-\na[b]c[b]\n1x3\na7c\naundefinedc\nTypeError";
console.log(got === expected ? 'PASS regexp quick replace' : 'FAIL ' + JSON.stringify(got));
if (got !== expected) throw new Error('regexp quick replace regressions');
