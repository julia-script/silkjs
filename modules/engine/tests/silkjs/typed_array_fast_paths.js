// SilkJS regression test for typed array element reads, writes and length taken
// without the generic property path: every element type against edge numbers,
// out-of-range and negative keys, objects and strings stored, a patched or
// shadowed length getter, a detached buffer and a Proxy prototype.
// Expected values come from C QuickJS.
var r=[];
var kinds=[Int8Array,Uint8Array,Uint8ClampedArray,Int16Array,Uint16Array,Int32Array,Uint32Array,Float32Array,Float64Array];
if (typeof Float16Array === 'function') kinds.push(Float16Array);
var vals=[0,1,-1,127,128,255,256,-129,300,65535,65536,-32769,2147483647,-2147483648,4294967295,4294967296,1.5,2.5,-0.5,254.5,255.5,1e20,-1e20,NaN,Infinity,-Infinity,-0,0.1];
for (var k=0;k<kinds.length;k++){ var a=new kinds[k](vals.length+1); for (var i=0;i<vals.length;i++){ a[i]=vals[i]; } var s=[]; for (var i=0;i<a.length;i++){ s.push(Object.is(a[i],-0)?'-0':String(a[i])); } r.push(kinds[k].name+':'+s.join('|')+':'+a.length); }
var b=new Uint8Array(4); b[10]=5; b[-1]=3; b[1.5]=2; r.push(b[10], b[-1], b[1.5], b.length, Object.keys(b).length);
var c=new Int32Array(2); c[0]={valueOf:function(){return 41}}; c[1]='7'; r.push(c[0], c[1]);
var d=new BigInt64Array(2); d[0]=5n; r.push(String(d[0]), d.length);
var e=new Uint8Array(8); Object.defineProperty(Uint8Array.prototype,'length',{get:function(){return 99},configurable:true}); r.push(e.length); delete Uint8Array.prototype.length; r.push(e.length);
var f=new Uint16Array(3); Object.defineProperty(f,'length',{value:'own'}) ; r.push(f.length);
var ab=new ArrayBuffer(8); var g=new Uint8Array(ab); g[0]=9; r.push(g[0], g.length);
if (typeof ab.transfer === 'function') { ab.transfer(); r.push(g.length, g[0]); g[0]=4; r.push(g[0]); }
var proto=Object.getPrototypeOf(Int8Array.prototype); var desc=Object.getOwnPropertyDescriptor(proto,'length'); Object.defineProperty(proto,'length',{get:function(){return 'patched'},configurable:true}); r.push(new Int8Array(3).length); Object.defineProperty(proto,'length',desc); r.push(new Int8Array(3).length);
var h=new Float64Array(2); var x=new Proxy({}, {}); Object.setPrototypeOf(h, x); r.push(h.length); 
var sum=0; var big=new Uint8Array(1000); for (var j=0;j<1000;j++){ big[j]=j; } for (var j=0;j<big.length;j++){ sum+=big[j]; } r.push(sum);
const got = r.join(',');
const expected = 'Int8Array:0|1|-1|127|-128|-1|0|127|44|-1|0|-1|-1|0|-1|0|1|2|0|-2|-1|0|0|0|0|0|0|0|0:29,Uint8Array:0|1|255|127|128|255|0|127|44|255|0|255|255|0|255|0|1|2|0|254|255|0|0|0|0|0|0|0|0:29,Uint8ClampedArray:0|1|0|127|128|255|255|0|255|255|255|0|255|0|255|255|2|2|0|254|255|255|0|0|255|0|0|0|0:29,Int16Array:0|1|-1|127|128|255|256|-129|300|-1|0|32767|-1|0|-1|0|1|2|0|254|255|0|0|0|0|0|0|0|0:29,Uint16Array:0|1|65535|127|128|255|256|65407|300|65535|0|32767|65535|0|65535|0|1|2|0|254|255|0|0|0|0|0|0|0|0:29,Int32Array:0|1|-1|127|128|255|256|-129|300|65535|65536|-32769|2147483647|-2147483648|-1|0|1|2|0|254|255|1661992960|-1661992960|0|0|0|0|0|0:29,Uint32Array:0|1|4294967295|127|128|255|256|4294967167|300|65535|65536|4294934527|2147483647|2147483648|4294967295|0|1|2|0|254|255|1661992960|2632974336|0|0|0|0|0|0:29,Float32Array:0|1|-1|127|128|255|256|-129|300|65535|65536|-32769|2147483648|-2147483648|4294967296|4294967296|1.5|2.5|-0.5|254.5|255.5|100000002004087730000|-100000002004087730000|NaN|Infinity|-Infinity|-0|0.10000000149011612|0:29,Float64Array:0|1|-1|127|128|255|256|-129|300|65535|65536|-32769|2147483647|-2147483648|4294967295|4294967296|1.5|2.5|-0.5|254.5|255.5|100000000000000000000|-100000000000000000000|NaN|Infinity|-Infinity|-0|0.1|0:29,Float16Array:0|1|-1|127|128|255|256|-129|300|Infinity|Infinity|-32768|Infinity|-Infinity|Infinity|Infinity|1.5|2.5|-0.5|254.5|255.5|Infinity|-Infinity|NaN|Infinity|-Infinity|-0|0.0999755859375|0:29,,,,4,4,41,7,5,2,99,8,own,9,8,0,,,patched,3,,124716';
console.log(got === expected ? 'PASS typed array fast paths' : 'FAIL ' + got);
if (got !== expected) throw new Error('typed array regressions');
