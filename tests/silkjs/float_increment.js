// SilkJS regression test for the Float64 fast paths of inc, dec, post_inc,
// post_dec, inc_loc and dec_loc: results stay Float64 and match the generic
// path. Expected values come from C QuickJS.
function show(v){ return Object.is(v,-0) ? '-0' : String(v); }
var out=[];
var n = 2; n = n*2.5;
var j = n; out.push(show(j--), show(j), typeof j);
j = n; out.push(show(--j), show(++j), show(j++), show(j));
var z = -0.5; out.push(show(++z), show(--z), show(z));
var w = 0.5; out.push(show(--w)); var q=-0.5; q++; out.push(show(q));
var nan = NaN; nan++; out.push(show(nan)); var inf = -Infinity; inf--; out.push(show(inf));
var big = 9007199254740992; big++; out.push(show(big)); var big2 = 2147483647.0*1.5; big2--; out.push(show(big2));
var fl = 1.25; for (var k = 0; k < 5; k++) fl++; out.push(show(fl));
var cnt=0; for (var d = 5.5; d --> 0;) cnt++; out.push(cnt, show(d));
var e = 3.5; do { cnt++ } while (--e > 0); out.push(cnt, show(e));
var o = {v: 1.5}; o.v++; ++o.v; out.push(show(o.v));
var arr=[0.5]; arr[0]--; out.push(show(arr[0]));
const got = out.join();
const expected = '5,4,number,4,5,5,6,0.5,-0.5,-0.5,-0.5,0.5,NaN,-Infinity,9007199254740992,3221225469.5,6.25,6,-1.5,10,-0.5,3.5,-0.5';
console.log(got === expected ? 'PASS float increment' : 'FAIL ' + got);
if (got !== expected) throw new Error('float increment regressions');
