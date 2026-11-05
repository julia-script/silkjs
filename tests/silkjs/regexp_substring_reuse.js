// SilkJS regression test: exec, match and split pieces of 2 to 32 Latin-1 units come
// from a table of recent substrings; reused pieces must stay correct strings that
// later appends and colliding contents never disturb. Expected values come from V8.
var r = [];
var re = /(\w+):\/\/([^\/]*)(\/.*)?/;
var inputs = ['http://example.com/a', 'http://example.org/b', 'ftp://example.com/', 'http://example.com/a'];
for (var i = 0; i < inputs.length; i++) { var m = re.exec(inputs[i]); r.push(m[1] + '|' + m[2] + '|' + m[3]); }
var a = re.exec(inputs[0])[1]; var b = re.exec(inputs[1])[1];
a += 'S'; r.push(a, b, re.exec(inputs[3])[1]);
var p = 'xy'; for (var k = 0; k < 3; k++) { var q = /(..)/.exec('xyz')[1]; q += k; r.push(q); }
var words = [];
for (var n = 0; n < 2000; n++) words.push('k' + n + 'v');
var sum = 0, last = '';
for (var n = 0; n < 2000; n++) { var w = /k(\d+)v/.exec(words[n])[1]; if (w !== String(n)) last = 'bad ' + n; sum += w.length; }
r.push(sum, last);
var lengths = [];
for (var len = 2; len <= 34; len++) { var s = 'ab'.repeat(20).slice(0, len); lengths.push(/(.*)/.exec(s + '!')[1].length); }
r.push(lengths.join(','));
r.push('a1b2c3'.match(/[a-z]\d/g).join('-'), 'one, two, one'.split(/, /).join('/'));
r.push(/(é\w)/.exec('xéab')[1], /(ab)/.exec('āab')[1]);
var got = r.join('\n');
const expected = "http|example.com|/a\nhttp|example.org|/b\nftp|example.com|/\nhttp|example.com|/a\nhttpS\nhttp\nhttp\nxy0\nxy1\nxy2\n6890\n\n3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35\na1-b2-c3\none/two/one\néa\nab";
console.log(got === expected ? 'PASS regexp substring reuse' : 'FAIL ' + JSON.stringify(got));
if (got !== expected) throw new Error('regexp substring reuse regressions');
