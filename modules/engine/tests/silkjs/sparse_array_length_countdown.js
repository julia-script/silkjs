// arr.length = n counting down over a sparse Array: the last index is usually
// absent and only the length moves; present, non-configurable and read-only
// cases keep the full path's results.
function chk(a,e,w){ if(a!==e) throw new Error(w+': '+a+' !== '+e) }
function down(tab){ for (var i = tab.length; i --> 0;) tab.length = i; return tab }
var ref=[]; for (var i=0;i<100;i++) if (i%10==9) ref[i]=i;
var t=ref.slice(); for (var i=100;i-->0;){ t.length=i; chk(t.length,i,'len'); chk(i>0?t[i-1]:undefined, (i>0&&(i-1)%10==9)?i-1:undefined,'el'); chk(Object.keys(t).length, Math.floor(i/10), 'keys') }
var s=ref.slice(); Object.defineProperty(s, 50, {value:1, configurable:false}); s[49]=1; down(s); chk(s.length,51,'nonconfigurable stops'); chk(s[49],1,'below stays');
var fz=ref.slice(); Object.freeze(fz); down(fz); chk(fz.length,100,'frozen');
var st=ref.slice(); Object.defineProperty(st,'length',{writable:false}); down(st); chk(st.length,100,'readonly length');
(function(){ 'use strict'; var r=ref.slice(); Object.defineProperty(r,'length',{writable:false}); var threw=false; try { r.length = 99 } catch(e){ threw = e instanceof TypeError } chk(threw,true,'strict readonly') })();
var big=[]; big[4000000000]=1; big.length=3999999999; chk(big.length,3999999999,'big'); big.length = 3999999998; chk(big.length,3999999998,'big2');
var f=[1,2,3]; down(f); chk(f.length,0,'fast');
var o={length:5}; (function(x){ x.length = 4 })(o); chk(o.length,4,'plain object');
var p=[]; p[9]=1; p.x=1; (function(x){ x.length = 9 })(p); chk(p.length,9,'named prop'); chk(9 in p,false,'dropped'); chk(p.x,1,'x');
console.log("ok")
// Date.now() answered in the call site: same clock, any arguments, any receiver.
var before = Date.now(), now = Date.now(1, 2), other = Date.now.call(null), held = { now: Date.now }
chk(typeof now, 'number', 'Date.now type'); chk(now >= before && other >= now && held.now() >= other, true, 'Date.now order')
chk(Math.abs(new Date().getTime() - Date.now()) < 1000, true, 'Date.now clock')
var saved = Date.now; Date.now = function () { return 7 }; chk(Date.now(), 7, 'Date.now replaced'); Date.now = saved
console.log('ok2')
