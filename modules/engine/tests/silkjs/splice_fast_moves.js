// SilkJS regression test for splice on fast Arrays, whose tail moves in bulk:
// shrinking and growing splices, edges, object identity and a long run of
// mixed splices. Expected values come from C QuickJS.
var r=[];
var a=[1,2,3,4,5,6,7,8]; r.push(a.splice(2,3).join('/'), a.join('/'));
a=[1,2,3,4,5]; r.push(a.splice(1,1,'x','y','z').join('/'), a.join('/'));
a=[{},{},{}]; var o=a[1]; a.splice(0,1); r.push(a[0]===o, a.length);
a=[1,2,3]; a.splice(1,0,9); r.push(a.join('/'));
a=[1,2,3]; a.splice(3,0,4,5); r.push(a.join('/'));
a=['a','b','c','d']; a.splice(0,4); r.push(a.length);
a=['a','b','c','d']; a.splice(-1,1,'p','q'); r.push(a.join('/'));
a=[1,2,3]; a.unshift(0); a.shift(); r.push(a.join('/'));
var big=[]; for (var i=0;i<1000;i++) big.push('s'+i); for (var i=0;i<500;i++) big.splice(i%7, 1, 'n'+i, 'm'+i); r.push(big.length, big[3], big[999], big[1499]);
for (var i=0;i<700;i++) big.splice(i%11, 2); r.push(big.length, big[0], big[99]);
const got = r.join();
const expected = '3/4/5,1/2/6/7/8,2,1/x/y/z/3/4/5,true,2,1/9/2/3,1/2/3/4/5,0,a/b/c/p/q,1/2/3,1500,m499,s499,s999,100,s868,s999';
if (got !== expected) throw new Error('splice: got ' + got);
print('ok');
