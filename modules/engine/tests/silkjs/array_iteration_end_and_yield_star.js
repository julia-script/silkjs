// Array destructuring and for-of step a fast Array by index (a stand-in
// record): the step past the end, growth and shrinkage during the loop, and
// yield* over an array, which needs the real iterator.
function chk(a,e,w){ if(a!==e) throw new Error(w+': '+a+' !== '+e) }
function J(x){ return JSON.stringify(x) }
var a=[1,2,3,4,5];
var [p,q,,r,...s]=a; chk(J([p,q,r,s]),'[1,2,4,[5]]','rest');
var [x,y,z]=[1,2]; chk(z,undefined,'short'); var [m,...n]=[]; chk(J([m===undefined,n]),'[true,[]]','empty');
var [u,v,w,t,o,extra,...more]=a; chk(extra,undefined,'past end'); chk(more.length,0,'empty rest');
var out=[]; for (var e of a) out.push(e); chk(out.join(),'1,2,3,4,5','for of');
// growing during iteration
var g=[1,2,3], seen=[]; for (var e of g){ seen.push(e); if (g.length<6) g.push(e*10) } chk(seen.join(),'1,2,3,10,20,30','grow');
// shrinking
var h=[1,2,3,4], seen2=[]; for (var e of h){ seen2.push(e); h.length=2 } chk(seen2.join(),'1,2','shrink');
// length greater than count (holey tail)
var k=[1,2]; k.length=4; var seen3=[]; for (var e of k) seen3.push(e); chk(J(seen3),'[1,2,null,null]','holes');
// spread and Array.from still work, array survives
var c=[...a,...a]; chk(c.length,10,'spread'); chk(a.length,5,'array alive');
// nested destructuring and defaults
var [[i1,i2=9],[j1]=[7]]=[[1]]; chk(J([i1,i2,j1]),'[1,9,7]','nested');
// done step drops last reference
function mk(){ return [{id:1},{id:2}] } var [d1,d2,d3]=mk(); chk(d1.id+d2.id,3,'temp array'); chk(d3,undefined,'temp past');
// patched iterator protocol
var saved=Array.prototype[Symbol.iterator]; var calls=0;
Array.prototype[Symbol.iterator]=function(){ calls++; return saved.call(this) }; var [aa,bb]=[1,2]; Array.prototype[Symbol.iterator]=saved; chk(calls,1,'patched'); chk(aa+bb,3,'patched values');
// arguments
(function(){ var [f1,f2,f3]=arguments; chk(J([f1,f2,f3===undefined]),'[1,2,true]','arguments') })(1,2);
// generator consumer
function* gen(){ yield* [1,2,3] } chk([...gen()].join(),'1,2,3','yield*');
for (var warm of [1]) {}
function* g2(){ var r = yield* [1,2,3]; return r } var it=g2(); chk(J([it.next(),it.next(),it.next(),it.next()]),'[{"value":1,"done":false},{"value":2,"done":false},{"value":3,"done":false},{"done":true}]','yield* steps');
function* g3(){ try { yield* [1,2,3] } finally { yield 9 } } var i3=g3(); i3.next(); chk(J(i3.return(5)),'{"value":9,"done":false}','yield* return'); chk(J(i3.next()),'{"value":5,"done":true}','after return');
function* g4(){ try { yield* [1,2] } catch (e) { yield 'c' + e } } var i4=g4(); i4.next(); chk(/^cTypeError/.test(i4.throw('x').value),true,'yield* throw');
function* g5(){ yield* []; yield* [7]; yield* 'ab' } chk([...g5()].join(),'7,a,b','yield* empty and string');
var grow=[1]; function* g6(){ yield* grow } var i6=g6(); chk(i6.next().value,1,'g6'); grow.push(2); chk(i6.next().value,2,'yield* sees growth');
console.log('ok')
