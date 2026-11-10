// SilkJS regression test for arr.length = n stores from put_field: fast and
// sparse arrays, heap elements, a read-only length, a non-configurable element
// that stops truncation, growth, and plain objects with a length field.
// Expected values come from C QuickJS.
var out=[];
var a=[1,2,3,4,5]; for (var i=5;i-->0;) a.length=i; out.push(a.length, JSON.stringify(a));
var b=[{x:1},{x:2},'s'+1,4]; b.length=2; out.push(b.length, b[1].x, b[2]);
var h=[]; h[9]=1; h[3]=2; h.length=5; out.push(h.length, h[3], h[9], 9 in h);
var f=[1,2,3]; Object.defineProperty(f,'length',{writable:false}); try { (function(){'use strict'; f.length=1;})(); out.push('nothrow'); } catch(e) { out.push(e instanceof TypeError); } f.length=0; out.push(f.length);
var c=[1,2,3]; Object.defineProperty(c,1,{configurable:false,value:9}); c.length=0; out.push(c.length, c[1]);
var o={length:3}; o.length=1; out.push(o.length);
var g=[1,2,3]; g.length=10; out.push(g.length, 5 in g);
var t=[1,2,3]; t.length=1.0; out.push(t.length); try { t.length=-1; } catch(e) { out.push(e instanceof RangeError); }
const got = out.join(',');
const expected = '0,[],2,2,,5,2,,false,true,3,2,9,1,10,false,1,true';
console.log(got === expected ? 'PASS array length stores' : 'FAIL ' + got);
if (got !== expected) throw new Error('array length store regressions');
