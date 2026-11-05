// SilkJS regression test for string constants, add_loc and string equality kept
// in the dispatch loop: local += on Ints, Float64s, strings and mixed operands,
// and ===, !==, ==, != across interned, built and non-string values.
// Expected values come from C QuickJS.
var r=[];
function f(n){ var s=''; for (var i=0;i<n;i++){ s += String.fromCharCode(97+i%26); } var t=s; s += 'x'; return [s, t, s.length]; }
r.push(f(30).join('/'));
function g(){ var a=1, b=1.5, c=2147483647, d='a', e=0.5; a+=2; b+=0.25; c+=1; d+=1; e+=1; var o={toString:function(){return 'O'}}; var p='p'; p+=o; var q=1; q+='z'; var n=null; n+=1; return [a,b,c,d,e,p,q,n].join(); }
r.push(g());
var w=['BT','ET','Tf','BT'+'', 'B'+'T', 'b'.toUpperCase()+'T', 1, '1', null, undefined, NaN];
for (var i=0;i<w.length;i++) for (var j=0;j<w.length;j++) r.push((w[i]===w[j])?1:0,(w[i]!==w[j])?1:0,(w[i]==w[j])?1:0,(w[i]!=w[j])?1:0);
var k='key'; r.push(k==='key', 'key'===k, 'aé'==='aé', 'aé'==='aè', '\u{1F600}x'==='\u{1F600}'+'x');
var big=''; for (var i=0;i<2000;i++) big+='ab'; r.push(big.length, big===('ab'.repeat(2000)));
const got = r.join(',');
const expected = 'abcdefghijklmnopqrstuvwxyzabcdx/abcdefghijklmnopqrstuvwxyzabcd/31,3,1.75,2147483648,a1,1.5,pO,1z,1,1,0,1,0,0,1,0,1,0,1,0,1,1,0,1,0,1,0,1,0,1,0,1,0,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,1,0,1,0,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,1,0,1,0,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,1,0,1,0,0,1,0,1,0,1,0,1,1,0,1,0,1,0,1,0,1,0,1,0,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,1,0,1,0,0,1,0,1,0,1,0,1,1,0,1,0,1,0,1,0,1,0,1,0,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,1,0,1,0,0,1,0,1,0,1,0,1,1,0,1,0,1,0,1,0,1,0,1,0,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,1,0,1,0,0,1,1,0,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,1,0,1,0,1,0,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,1,0,1,0,0,1,1,0,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,1,0,1,0,1,0,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,true,true,true,false,true,4000,true';
console.log(got === expected ? 'PASS string operator fast paths' : 'FAIL ' + got);
if (got !== expected) throw new Error('string operator regressions');
