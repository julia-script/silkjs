// SilkJS regression test for the matcher's search skip past a pattern's leading
// zero-width steps (group starts, \b, \B) and on \s and \S. Expected values come from C QuickJS.
var r=[];
function m(re,s){ var x=re.exec(s); r.push(x===null?'null':x.index+':'+x.join('|')); }
m(/\bfoo/,'xfoo foo'); m(/\Bfoo/,'foo xfoo'); m(/(\d+)px/,'w: 12px'); m(/((a)b)c/,'aabc'); m(/\s+x/,'ab \tx'); m(/\S+/,'   ab');
m(/\b[A-Z]\w*/,'hello World'); m(/(?:x)y/,'axy'); m(/(^a)/,'ba'); m(/\b\s/,'ab c'); m(/\s/,'abc'); m(/\S/,'   ');
m(/ x/,'a x'); m(/\sx/,'a x'); m(/\sx/,'a　x'); m(/(\w+)\s(\w+)/,'  John Smith');
const got = r.join(';');
const expected = "5:foo;5:foo;3:12px|12;1:abc|ab|a;2: \tx;3:ab;6:World;1:xy;null;2: ;null;null;1: x;1: x;1:　x;2:John Smith|John|Smith";
console.log(got === expected ? 'PASS regexp zero-width skip' : 'FAIL ' + got);
if (got !== expected) throw new Error('regexp zero-width skip regressions');
