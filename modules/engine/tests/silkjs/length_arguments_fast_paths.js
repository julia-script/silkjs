// SilkJS regression test for get_length and arguments element reads taken
// without the generic property path: strings, ropes, String objects, arrays,
// arguments objects (strict, sloppy, mapped), patched or deleted length, holes,
// out-of-range and negative indexes, plain objects and prototype lengths.
// Expected values come from C QuickJS.
var r=[];
var s='hello'; var rope=s; for (var i=0;i<20;i++) rope+=String(i); r.push(s.length, rope.length, ''.length, 'é😀'.length);
r.push(new String('abc').length, [1,2,3].length, [].length, new Array(7).length);
var a=[1,2]; a.length=5; r.push(a.length); a.length=1; r.push(a.length, a[1]);
function sloppy(){ return [arguments.length, arguments[0], arguments[2], arguments[5], arguments[-1], arguments['1']]; }
r.push(sloppy(1,'two',3).join('|'), sloppy().join('|'));
function strict(){ 'use strict'; return [arguments.length, arguments[0], arguments[1]]; }
r.push(strict(4,5,6).join('|'));
function mapped(x,y){ x=10; return [arguments.length, arguments[0], arguments[1], arguments[2]]; }
r.push(mapped(1).join('|'), mapped(1,2,3).join('|'));
function patched(){ arguments.length=9; arguments[0]='p'; return [arguments.length, arguments[0], arguments[1]]; }
r.push(patched(1,2).join('|'));
function deleted(){ delete arguments.length; delete arguments[0]; return [arguments.length, arguments[0], arguments[1]]; }
r.push(deleted(1,2).join('|'));
function accessor(){ Object.defineProperty(arguments,'length',{get:function(){return 'g'}}); Object.defineProperty(arguments,'1',{get:function(){return 'e'}}); return [arguments.length, arguments[0], arguments[1]]; }
r.push(accessor(1,2).join('|'));
function sum(){ var t=0; for (var i=0;i<arguments.length;i++) t+=arguments[i]; return t; }
var tot=0; for (var k=0;k<2000;k++) tot+=sum(k,1,2,3); r.push(tot);
var o={length:42}; r.push(o.length, ({}).length, Object.create({length:'proto'}).length);
function f3(a,b,c){} r.push(f3.length, (function(){}).length);
var p=new Proxy([1,2,3],{get:function(t,k){ return k==='length'?'proxied':t[k]; }}); r.push(p.length);
var u8=new Uint8Array(6); r.push(u8.length);
try { null.length; } catch (e) { r.push(e.constructor.name); }
try { undefined.length; } catch (e) { r.push(e.constructor.name); }
r.push((5).length, true.length, Symbol('ab').description.length);
var got=r.join(',');
const expected = '5,35,0,3,3,3,0,7,5,1,,3|1|3|||two,0|||||,3|4|5,1|10||,3|10|2|3,9|p|2,||2,g|1|e,2011000,42,,proto,3,0,proxied,6,TypeError,TypeError,,,2';
console.log(got === expected ? 'PASS length and arguments fast paths' : 'FAIL ' + got);
if (got !== expected) throw new Error('length or arguments regressions');
