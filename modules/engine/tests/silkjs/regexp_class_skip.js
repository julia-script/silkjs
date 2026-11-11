// SilkJS regression test for the matcher's search skip on patterns that start
// with a case-insensitive literal, a class or `^`. Expected values come from C QuickJS.
var r=[];
function m(re,s){ var x=re.exec(s); r.push(x===null?'null':x.index+':'+x.join('|')); }
m(/[0-9]+/,'abc123d'); m(/[0-9]/,'abc'); m(/[^a]/,'aab'); m(/[a-c]x/i,'zzBx'); m(/B/i,'aab'); m(/é/i,'xxÉ'); m(/k/i,'K'); m(/[k]/i,'aK');
m(/^a/,'ba'); m(/^a/,'ab'); m(/^/,''); m(/^b/m,'a\nb'); m(/[Ā-Ȁ]/,'abŐ'); r.push(/[\ud800-\udbff]/.exec('a\ud83d\ude00').index);
m(/[😀]/u,'ab😀'); m(/\w+/,'  hi'); m(/[a-z]/i,'12Q'); m(/s/i,'ſ'); m(/[s]/iu,'aſ');
var g=/^x/g; r.push(g.test('xx'), g.lastIndex, g.test('xx'));
r.push('a1b22c333'.replace(/[0-9]+/g,'#'), 'Hello World'.replace(/o/gi,'0'));
const got = r.join(';');
const expected = "3:123;null;2:b;2:Bx;2:b;2:É;null;null;null;0:a;0:;2:b;2:Ő;1;2:😀;2:hi;2:Q;null;1:ſ;true;1;false;a#b#c#;Hell0 W0rld";
console.log(got === expected ? 'PASS regexp class skip' : 'FAIL ' + got);
if (got !== expected) throw new Error('regexp class skip regressions');
