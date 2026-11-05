// SilkJS regression test for the compiler's regexp search hints: a pattern that is a plain
// literal is found by substring search, and a pattern whose every match contains a run of
// literal characters is rejected early when the run is absent. Expected values come from V8.
var r=[];
function m(re,s,li){ if (li !== undefined) re.lastIndex = li; var x=re.exec(s); r.push(x===null?'null':x.index+':'+x.join('|')+':'+re.lastIndex); }
m(/abc/,'xxabcabc'); m(/abc/g,'xxabcabc',3); m(/abc/g,'abcab',1); m(/ab/,'a'); m(/ab/,''); m(/\//,'a/b'); m(/x/,'Āx');
m(/Āy/,'aaĀy'); m(/€/,'1€2'); m(/ab/u,'\u{1F600}ab'); m(/ab/m,'z\nab'); m(/ab/s,'zab'); m(/ab/y,'xab'); m(/ab/y,'ab');
m(/a(b)c/,'zabc'); m(/(x)?abc/,'zabc'); m(/q(a|b)cd/,'qbcd qacd'); m(/[0-9]+px/,'w: 12px'); m(/(\d+)\.(\d+)/,'v1.25'); m(/a+bc/,'aaabc');
m(/(?:ab)*cd/,'ababcd'); m(/(?:ab)+cd/,'ababcd'); m(/(?:ab){2}cd/,'ababcd abcd'); m(/x(?=yz)/,'xa xyz'); m(/x(?!yz)y/,'xyz xyq'); m(/(?<=ab)c/,'xc abc');
m(/(^|[^\\])"\\\/Date\((-?[0-9]+)\)\\\/"/g, 'a "\\/Date(12)\\/" b'); m(/(^|[^\\])"\\\/Date\((-?[0-9]+)\)\\\/"/g, 'no date here');
m(/\s?;\s?/,'a ; b'); m(/x;/,'aaa'); m(/ab|cd/,'zcd'); m(/a.c/,'abc'); m(/^ab/,'ab'); m(/^ab/,'cab'); m(/(?<n>ab)c/,'zabc');
m(/\bfoo\b/,'a foo b'); m(/foo\b/,'foobar foo'); m(/A/i,'xa'); m(/(a)\1bc/,'aabc');
r.push('xAbAbx'.replace(/Ab/g,'-'), 'a,b;c'.split(/;/).join('|'), 'abcabc'.split(/bc/).length, 'q1q2'.replace(/q/g, function(m,i){return '['+i+']'}));
r.push('aXbXc'.replace(/X/g,'$&$&'), 'aXb'.replace(/X/,"$'"), JSON.stringify('xyzxyz'.match(/yz/g)), 'hello'.search(/ll/), String(/ab/g.flags), String(/a\.b/.source), /zz/.test('azz'));
r.push(JSON.stringify([...'a1b1'.matchAll(/1/g)].map(x => x.index)), 'abc'.replaceAll(/b/g, 'B'));
// First-unit sets: the search skips to units a match can start with.
m(/\s?;\s?/,'a b ; c'); m(/[xy]?z/,'aaaz'); m(/(?:ab|cd)e/,'abcde'); m(/[^a]b/,'aab'); m(/k|Z/i,'aaZ'); m(/a*$/,'bcaa'); m(/\d+$/m,'x1\ny22'); m(/[a-c]?\u0100/,'zz\u0100'); m(/\Sx/,'  ax'); m(/ x/,'\u00a0 x');
r.push('a ; b;c'.split(/\s?;\s?/).join('|'), 'xx yy'.replace(/\s*y/g, '_'));
const got = JSON.stringify(r.join(';'));
const expected = "\"2:abc:0;5:abc:8;null;null;null;1:/:0;1:x:0;2:\u0100y:0;1:\u20ac:0;2:ab:0;2:ab:0;1:ab:0;null;0:ab:2;1:abc|b:0;1:abc|:0;0:qbcd|b:0;3:12px:0;1:1.25|1|25:0;0:aaabc:0;0:ababcd:0;0:ababcd:0;0:ababcd:0;3:x:0;4:xy:0;5:c:0;1: \\\"\\\\/Date(12)\\\\/\\\"| |12:16;null;1: ; :0;null;1:cd:0;0:abc:0;0:ab:0;null;1:abc|ab:0;2:foo:0;7:foo:0;1:a:0;0:aabc|a:0;x--x;a,b|c;3;[0]1[2]2;aXXbXXc;abb;[\\\"yz\\\",\\\"yz\\\"];2;g;a\\\\.b;true;[1,3];aBc;3: ; :0;3:z:0;2:cde:0;null;2:Z:0;2:aa:0;1:1:0;2:\u0100:0;2:ax:0;1: x:0;a|b|c;xx__\"";
console.log(got === expected ? 'PASS regexp search hints' : 'FAIL ' + got);
if (got !== expected) throw new Error('regexp search hint regressions');
// A branch starting with ^ adds nothing to the first-unit set: the search tries the start position before it skips.
var r2=[' a b '.replace(/^[\s\xa0]+|[\s\xa0]+$/g, ''), ' ab  '.replace(/^\s*|\s*$/g, '-'), 'ab'.replace(/^a|b/g, '_'), 'xab'.replace(/^a|b/g, '_'), 'zéĀ'.replace(/^q|[éĀ]/g, '.')];
if (r2.join(';') !== 'a b;-ab--;__;xa_;z..') throw new Error('anchored branch skip: ' + r2.join(';'));
// Over long inputs a required literal is found by its least common unit; the match must not move.
var r3 = [];
var pad = '"a":"b",'.repeat(20);
var w = '‰' + pad;
var cases = [pad + 'x\\/Qngr(12)', 'x\\/Qngr(' + pad, pad + '"\\/Qngr(5)\\/"' + pad, w + '"\\/Qngr(7)\\/"', pad + '\\/Qng\\/Qngr(\\/Qngr(9)', pad];
var res = [/\\\/Qngr\(/, /"\\\/Qngr\((-?[0-9]+)\)\\\/"/g, /(^|[^\\])"\\\/Qngr\((-?[0-9]+)\)\\\/"/g, /Qngr\(\d/, /aQ/, /\(9\)/];
for (var c of cases) for (var re of res) { re.lastIndex = 0; var m = re.exec(c); r3.push(m ? m.index + ':' + m[0] : 'null'); r3.push(c.replace(re, '#').length); }
for (var re of res) { var s = pad + 'Qngr(1' + pad + 'Qngr(2'; re.lastIndex = 0; r3.push(String(re.test(s))); }
if (JSON.stringify(r3) !== "[\"161:\\\\/Qngr(\",165,\"null\",171,\"null\",171,\"163:Qngr(1\",166,\"null\",171,\"null\",171,\"1:\\\\/Qngr(\",162,\"null\",168,\"null\",168,\"null\",168,\"null\",168,\"null\",168,\"161:\\\\/Qngr(\",327,\"160:\\\"\\\\/Qngr(5)\\\\/\\\"\",321,\"159:,\\\"\\\\/Qngr(5)\\\\/\\\"\",320,\"163:Qngr(5\",328,\"null\",333,\"null\",333,\"162:\\\\/Qngr(\",168,\"161:\\\"\\\\/Qngr(7)\\\\/\\\"\",162,\"160:,\\\"\\\\/Qngr(7)\\\\/\\\"\",161,\"164:Qngr(7\",169,\"null\",174,\"null\",174,\"165:\\\\/Qngr(\",175,\"null\",181,\"null\",181,\"174:Qngr(9\",176,\"null\",181,\"178:(9)\",179,\"null\",160,\"null\",160,\"null\",160,\"null\",160,\"null\",160,\"null\",160,\"false\",\"false\",\"false\",\"true\",\"false\",\"false\"]") throw new Error('literal pivot search: ' + JSON.stringify(r3));
// A literal longer than 255 units is hinted as required instead of literal.
var L = 'ab"c'.repeat(80) + 'Z', s4 = 'x'.repeat(50) + L + 'y' + L, reg4 = new RegExp(L, 'g');
var r4 = [new RegExp(L).exec(s4).index, new RegExp(L).test('q' + L.slice(1)), s4.replace(reg4, '-').length, (s4.match(reg4) || []).length, new RegExp(L + 'q').test(s4)];
if (JSON.stringify(r4) !== '[50,false,53,2,false]') throw new Error('long literal hint: ' + JSON.stringify(r4));
