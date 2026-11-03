// SilkJS regression test for obj[i] = v adding an integer key to an ordinary
// object without the generic set: key order, setters and read-only keys up the
// prototype chain, frozen and non-extensible objects, proxies as prototypes,
// strict mode and large keys. Expected values come from C QuickJS.
var out=[];
var o={b:1}; for (var i=9;i>=0;i--) o[i]=i*2; o.a=2; out.push(Object.keys(o).join(), JSON.stringify(o));
var proto={}; Object.defineProperty(proto,'3',{set(v){ out.push('setter:'+v); }, get(){ return 'g'; }});
Object.defineProperty(proto,'4',{value:'ro', writable:false});
var c=Object.create(proto); for (var i=2;i<6;i++) c[i]='v'+i; out.push(Object.keys(c).join(), c[3], c[4], c[5]);
(function(){ "use strict"; var d=Object.create(proto); try { d[4]=1; out.push('nothrow'); } catch(e) { out.push(e instanceof TypeError); } })();
var fz=Object.freeze({}); fz[0]=1; out.push(0 in fz);
var ne=Object.preventExtensions({}); ne[1]=1; out.push(1 in ne);
(function(){ "use strict"; try { Object.freeze({})[0]=1; out.push('nothrow'); } catch(e) { out.push(e instanceof TypeError); } })();
var px=Object.create(new Proxy({}, {set(t,k,v,r){ out.push('trap:'+k); return Reflect.set(t,k,v,r); }})); px[7]=1; out.push(Object.keys(px).join());
var big={}; big[2147483647]=1; big[4294967295]=2; big[0]=0; out.push(Object.keys(big).join());
var shared=[]; for (var j=0;j<3;j++) { var n={}; for (var i=0;i<4;i++) n[i]=i+j; shared.push(n[3]); } out.push(shared.join());
var inherited=Object.create({0:'p'}); inherited[0]='own'; out.push(inherited[0], Object.getPrototypeOf(inherited)[0]);
var fn=function(){}; fn[0]='f'; out.push(fn[0]);
const got = out.join(',');
const expected = "0,1,2,3,4,5,6,7,8,9,b,a,{\"0\":0,\"1\":2,\"2\":4,\"3\":6,\"4\":8,\"5\":10,\"6\":12,\"7\":14,\"8\":16,\"9\":18,\"b\":1,\"a\":2},setter:v3,2,5,g,ro,v5,true,false,false,true,trap:7,7,0,2147483647,4294967295,3,4,5,own,p,f";
console.log(got === expected ? 'PASS object index add' : 'FAIL ' + got);
if (got !== expected) throw new Error('object index add regressions');
