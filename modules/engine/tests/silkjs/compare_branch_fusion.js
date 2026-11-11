// SilkJS regression test for comparisons of locals, arguments and small
// constants that feed a branch (`i < n` as a loop or `if` test), which the
// interpreter answers in place without pushing the operands, and for element
// stores one past the end of an array: every comparison and operand kind,
// branches the compiler inverts (`if (j > i) break`), Int and Float64 operands,
// NaN, operands that are not numbers (strings, objects with valueOf, BigInt,
// undefined), locals past the short forms, long branches, and appends that
// grow, skip, or meet a frozen array; and a function whose locals are renumbered
// once the captured ones move to its scope.
// Expected values come from V8.
var r=[];
function count(n){ var j, c=0; for (j=0;j<n;j++) c+=j; return c }
function down(n){ var c=0; for (var i=n;i>=0;i--) c+=i; for (i=n;i>0;i--) c++; for (i=0;i<=n;i++) c++; return c }
function floats(n){ var c=0; for (var x=0.5;x<n;x+=1.25) c+=x; for (var y=n;y>=0.25;y-=0.75) c+=y; return c }
function four(a,b){ return (a<b?1:0)+(a<=b?2:0)+(a>b?4:0)+(a>=b?8:0) }
function consts(a){ var c=0; if (a<5) c+=1; if (a<=5) c+=2; if (a>5) c+=4; if (a>=5) c+=8; if (a>-3) c+=16; if (a<127) c+=32; if (a<128) c+=64; return c }
function inverted(n){ var c=0; for (var i=0;i<n;i++){ for (var j=0;j<n;j++){ if (j>i) break; c++ } } return c }
function labels(n){ var s=0; outer: for (var i=0;i<n;i++){ for (var j=0;j<n;j++){ if (j>i) continue outer; if (i*j>6) break outer; s+=j } } return s }
function skip(n){ var c=0; for (var i=0;i<n;i++){ if (i>2) continue; c++ } return c }
function many(a,b,c,d,e,f){ var l0=1,l1=2,l2=3,l3=4,l4=5,l5=6, t=0; if (e<f) t+=1; if (l4<l5) t+=2; if (l5>l0) t+=4; if (d<l4) t+=8; if (l3>=a) t+=16; if (f>e) t+=32; if (a<b) t+=64; return t }
function longBranch(a,b){ var s=0; if (a<b) { s+=a;s+=b;s+=a;s+=b;s+=a;s+=b;s+=a;s+=b;s+=a;s+=b;s+=a;s+=b;s+=a;s+=b;s+=a;s+=b;s+=a;s+=b;s+=a;s+=b;s+=a;s+=b;s+=a;s+=b;s+=a;s+=b;s+=a;s+=b;s+=a;s+=b;s+=a;s+=b;s+=a;s+=b;s+=a;s+=b;s+=a;s+=b;s+=a;s+=b;s+=a;s+=b;s+=a;s+=b;s+=a;s+=b;s+=a;s+=b;s+=a;s+=b;s+=a;s+=b;s+=a;s+=b;s+=a;s+=b;s+=a;s+=b;s+=a;s+=b;s+=a;s+=b;s+=a;s+=b } return s }
r.push(count(10), count(0), count(-1), count(100000), down(7), floats(7), inverted(4), labels(4), skip(6));
var pairs=[[1,2],[2,1],[2,2],[-1,0],[2147483647,-2147483648],[0.5,1],[1,0.5],[1.5,1.5],[1,1.0],[NaN,1],[1,NaN],[NaN,NaN],[-0,0],[Infinity,1e308],
  ['a','b'],['b','a'],['10','9'],['10',9],[null,0],[undefined,0],[0,undefined],[true,false],[10n,9],[9,10n],[2n,2.5],[{valueOf(){return 3}},2],[2,{valueOf(){return 3}}],[[5],[4]]];
for (var i=0;i<pairs.length;i++) r.push(four(pairs[i][0], pairs[i][1]));
var values=[4,5,6,-3,-4,127,128,4.5,5.0,NaN,'5','x',null,undefined,6n,{valueOf(){return 5}}];
for (var i=0;i<values.length;i++) r.push(consts(values[i]));
r.push(many(1,2,3,4,5,6), many(6,5,4,3,2,1), many(1.5,'x',null,4,NaN,7), longBranch(1,2), longBranch(2,1), longBranch(0.5,'1'));
var order=[]; function tag(n,v){ return { valueOf(){ order.push(n); return v } } }
function sides(a,b){ var c=0; if (a<b) c+=1; if (a>b) c+=2; if (a<=b) c+=4; if (a>=b) c+=8; return c }
r.push(sides(tag('l',1), tag('r',2)), order.join(''));
function thrower(a,b){ try { if (a<b) return 1; return 0 } catch (e) { return e.constructor.name } }
r.push(thrower(Symbol(),1), thrower(1,{valueOf(){ throw new RangeError('v') }}), thrower(1n,Symbol()));
// Element stores at and past the end.
function fill(n){ var t=[], i; for (i=0;i<n;i++) t[i]=i; return t }
var t=fill(1000); r.push(t.length, t[0], t[999], t[1000], fill(0).length, fill(1).join());
function at(a,i,v){ a[i]=v; return a.length }
var a=[]; r.push(at(a,0,'x'), at(a,1,'y'), at(a,1,'z'), at(a,5,'q'), a.join(), at(a,6,'w'), 3 in a, a.length);
var frozen=Object.freeze([1,2]); r.push(at(frozen,2,3), frozen.length, 2 in frozen);
var fixed=[1,2]; Object.defineProperty(fixed,'length',{writable:false}); r.push(at(fixed,2,3), at(fixed,0,7), fixed.join());
var closed=Object.preventExtensions([1]); r.push(at(closed,1,2), closed.length);
function strictAt(a,i,v){ 'use strict'; try { a[i]=v; return a.length } catch (e) { return e.constructor.name } }
r.push(strictAt(frozen,2,3), strictAt(fixed,2,3), strictAt(closed,1,2), strictAt([],0,1));
var setter=0; Object.defineProperty(Array.prototype,'3',{ set(v){ setter+=v }, configurable:true });
var viaProto=[1,2,3]; r.push(at(viaProto,3,40), setter, viaProto.length); delete Array.prototype[3];
var holder=[]; var objects=[]; for (var i=0;i<50;i++){ var o={n:i}; objects[i]=o; holder[i]=o } r.push(holder[49].n, objects[49]===holder[49], holder.length);
var typed=new Uint8Array(2); r.push(at(typed,2,5), typed.length, at(typed,1,300), typed[1]);
var args=(function(){ arguments[arguments.length]=9; return arguments.length })(1,2); r.push(args);
// Locals renumbered after the captured ones (i, j, prev) leave the frame.
function scoped(head, base){
  var out=[];
  var loop=function(){
    var f, prev, j, i, x, conf=5;
    x=head;
    while (x>=0) {
      i=x; j=base; prev=conf-1;
      if (conf>=3 && j>=0) { f=function(l){ var k; k=l; while (k>=0) { if (k>=i) out.push(k+':'+i+':'+j+':'+prev); k=k-1 } return 1 }; f(2); }
      x=x-1;
    }
    return out.join(' ');
  };
  return loop();
}
r.push(scoped(2,7));
const got = r.join('|');
const expected = "45|0|0|4999950000|43|58|10|7|3|3|12|10|3|12|3|12|10|10|0|0|0|10|12|3|12|3|12|10|0|0|12|12|3|3|12|3|12|115|122|124|99|99|92|28|115|122|0|122|0|115|0|124|122|127|14|30|96|0|0.510.510.510.510.510.510.510.510.510.510.510.510.510.510.510.510.510.510.510.510.510.510.510.510.510.510.510.510.510.510.510.51|5|lrlrlrlr|TypeError|RangeError|TypeError|1000|0|999||0|0|1|2|2|6|x,z,,,,q|7|false|7|2|2|false|2|2|7,2|1|1|TypeError|TypeError|TypeError|1|3|40|3|49|true|50|2|2|2|44|2|2:2:7:4 2:1:7:4 1:1:7:4 2:0:7:4 1:0:7:4 0:0:7:4";
console.log(got === expected ? 'PASS compare branch fusion' : 'FAIL ' + got);
if (got !== expected) throw new Error('compare branch fusion regressions');
