// SilkJS regression test: alternatives compile to a flat chain of splits (one frame per
// choice); order, captures and lookbehind alternatives stay as before. Expected values come from V8.
var r = [];
function show(m) { return m === null ? 'null' : JSON.stringify(Array.prototype.slice.call(m)) + '@' + m.index; }
r.push(show(/a|ab/.exec('ab')), show(/ab|a/.exec('ab')), show(/(a|ab)(c|bcd)(d*)/.exec('abcd')));
r.push(show(/x|y|z|(w)/.exec('..w')), show(/(?:q|qq|qqq)+$/.exec('qqqqq')), show(/((a)|(b)|(c))+/.exec('abc')));
r.push(show(/(?<=ab|b)c/.exec('abc')), show(/(?<=(a|xa)|(b))c/.exec('xac')), show(/(?<!a|b)c/.exec('bcxc')));
r.push(show(/qqqq|qqq|qq|q|ZZZZ|ZZZ|ZZ|Z|llll|ll|l/g.exec('xx ZZZ q')), 'a|b||c'.split(/(\|)/).length);
r.push(show(/^(?:a|b|)$/.exec('')), show(/(a|)+b/.exec('aab')), show(/(?:(x)|y|z)*/.exec('xyzx')));
r.push('ab-cd'.replace(/a|c/g, '[$&]'), 'aaa'.match(/a|aa/g).join(','), show(/[a-c]|d|(e)/i.exec('E')));
var got = r.join('\n');
const expected = "[\"a\"]@0\n[\"ab\"]@0\n[\"abcd\",\"a\",\"bcd\",\"\"]@0\n[\"w\",\"w\"]@2\n[\"qqqqq\"]@0\n[\"abc\",\"c\",null,null,\"c\"]@0\n[\"c\"]@2\n[\"c\",\"a\",null]@2\n[\"c\"]@3\n[\"ZZZ\"]@3\n7\n[\"\"]@0\n[\"aab\",\"a\"]@0\n[\"xyzx\",\"x\"]@0\n[a]b-[c]d\na,a,a\n[\"E\",\"E\"]@0";
console.log(got === expected ? 'PASS regexp flat alternation' : 'FAIL ' + JSON.stringify(got));
if (got !== expected) throw new Error('regexp flat alternation regressions');
