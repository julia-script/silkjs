// SilkJS regression test for other native builtins called straight from the VM
// call opcodes (nativeInline): regexp exec, JSON, Object and Array methods,
// thrown errors caught in loops, and calls from deep frames.
// Expected values come from C QuickJS.
var out=[];
var re=/b(c+)/; var hits=0; for (var i=0;i<30;i++) { var m=re.exec('abccd'+i); if (m) hits+=m[1].length; } out.push(hits);
var parts=[]; for (var i=0;i<5;i++) parts.push(JSON.stringify({a:i})); out.push(parts.join('|'));
var bad=0; for (var i=0;i<5;i++) { try { JSON.parse('{'+i); } catch(e) { if (e instanceof SyntaxError) bad++; } } out.push(bad);
function deep(n){ return n ? deep(n-1) : Object.keys({x:1,y:2}).join(''); } out.push(deep(20));
var f=String.prototype.toUpperCase; out.push(f.call('ab'));
var a=[3,1,2]; out.push(a.join('-'), a.concat([4]).length, Array.isArray(a));
function thrower(){ return null.toString(); }
try { thrower(); } catch(e) { out.push(e instanceof TypeError); }
try { Object.defineProperty(1,'x',{}); } catch(e) { out.push(e instanceof TypeError, String(e.stack).length > 0); }
var t=0; for (var i=0;i<100;i++) t+=parseFloat('1.5')+Number.isInteger(i); out.push(t);
const got = out.join(',');
const expected = '60,{"a":0}|{"a":1}|{"a":2}|{"a":3}|{"a":4},5,xy,AB,3-1-2,4,true,true,true,true,250';
console.log(got === expected ? 'PASS native inline calls' : 'FAIL ' + got);
if (got !== expected) throw new Error('native inline call regressions');
