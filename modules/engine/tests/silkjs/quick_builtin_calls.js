// SilkJS regression test for builtins answered inside the VM call opcodes:
// Math, Map and Set, String methods and Date.now in loops, the fallback to the
// full native call when a quick path declines, thrown errors with their
// position, own properties deep in a hash bucket, and replaced builtins.
// Expected values come from C QuickJS.
var out=[];
var r=0; for (var i=0;i<50;i++) r+=Math.min(i,25)+Math.max(i,3)+Math.abs(-i); out.push(r);
var m=new Map(); for (var i=0;i<20;i++) m.set(i, i*i); var t=0; for (var i=0;i<20;i++) t+=m.get(i); out.push(t, m.has(3), m.has(99), m.size);
var st=new Set(); for (var i=0;i<10;i++) st.add(i%4); out.push(st.size, st.has(2));
var s='hello world'; var codes=0; for (var i=0;i<s.length;i++) codes+=s.charCodeAt(i); out.push(codes, s.indexOf('o'), s.slice(2,5), s.replace('o','0'), s.split(' ').length);
out.push(typeof Date.now(), Date.now() > 0);
try { Map.prototype.get.call({}, 1); out.push('nothrow'); } catch(e) { out.push(e instanceof TypeError); }
try { new Map().set.call(null); out.push('nothrow'); } catch(e) { out.push(e instanceof TypeError); }
function thrower(){ return 'x'.repeat(-1); }
try { thrower(); } catch(e) { out.push(e instanceof RangeError, String(e.stack).indexOf('thrower') >= 0); }
var saved=Math.min; Math.min=function(a,b){ return 'patched'; }; out.push(Math.min(1,2)); Math.min=saved; out.push(Math.min(1,2));
var dict={}; for (var i=0;i<64;i++) dict['k'+i]=i; var sum=0; for (var j=0;j<3;j++) for (var i=0;i<64;i++) sum+=dict['k'+i]; out.push(sum);
var o={}; for (var i=0;i<40;i++) o['p'+i]=i; function rd(x){ return x.p37+x.p1+x.p20; } out.push(rd(o), rd(o)); o.p37=0; out.push(rd(o)); delete o.p1; out.push(rd(o));
var nul=Object.create(null); for (var i=0;i<30;i++) nul['n'+i]=i; function rn(x){ return x.n29; } out.push(rn(nul), rn(nul));
out.push(String(42), String(-7), Number('12'), parseInt('0x1f'));
const got = out.join(',');
const expected = "3381,2470,true,false,20,4,true,1116,4,llo,hell0 world,2,number,true,true,true,true,true,patched,1,6048,58,58,21,NaN,29,29,42,-7,12,31";
console.log(got === expected ? 'PASS quick builtin calls' : 'FAIL ' + got);
if (got !== expected) throw new Error('quick builtin call regressions');
