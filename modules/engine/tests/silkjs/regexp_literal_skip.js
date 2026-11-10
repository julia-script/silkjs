// SilkJS regression test for the matcher's search skip: a non-sticky pattern that
// starts with a literal jumps to the next position holding it. Expected values
// come from C QuickJS.
var r=[];
function m(re,s){ var x=re.exec(s); r.push(x===null?'null':x.index+':'+x.join('|')); }
m(/b/,'aaab'); m(/b/,'aaaa'); m(/b/,''); m(/bc/,'abbbc'); m(/b(c)?d/,'abdxbcd'); m(/x/,'x');
m(/é/,'abcé'); m(/Ā/,'abcĀd'); m(/Ā/,'abcd'); m(/a/u,'bba'); m(/a/u,'😀a');
m(/z/,'ああz'); m(/あ/,'abあ');
var g=/o/g, s='foo boo', out=[]; var t; while((t=g.exec(s))) out.push(t.index+'/'+g.lastIndex); r.push(out.join(','));
r.push('xaxbxc'.replace(/x/g,'-'), 'aXbX'.split(/X/).join('+'), 'hello'.search(/l/), 'abc'.search(/d/));
var st=/b/y; st.lastIndex=1; r.push(st.test('abc'), st.lastIndex); st.lastIndex=0; r.push(st.test('abc'));
var g2=/b/g; g2.lastIndex=3; r.push(g2.test('abcab'), g2.lastIndex);
r.push(/a|b/.exec('ccb').index, /ab*/.exec('cab').index, /a?b/.exec('ccb').index, /\nb/m.exec('a\nb').index);
r.push(JSON.stringify('aaa'.match(/a/g)), JSON.stringify('xyz'.match(/q/g)));
const got=r.join(';');
const expected='3:b;null;null;3:bc;1:bd|;0:x;3:é;3:Ā;null;2:a;2:a;2:z;2:あ;1/2,2/3,5/6,6/7;-a-b-c;a+b+;2;-1;true;2;false;true;5;2;1;2;1;["a","a","a"];null';
console.log(got===expected?'PASS regexp literal skip':'FAIL '+got);
if(got!==expected) throw new Error('regexp literal skip regressions');
