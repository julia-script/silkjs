// SilkJS regression test for the dispatch loop's quick Array.prototype.splice
// (js_array_intrinsics_mutation.quickSplicePlan): clamped and negative starts,
// absent and out-of-range delete counts, inserts and removals, holes, species,
// frozen arrays and a non-writable length must all match the full splice.
const out = [];
var a=[1,2,3,4,5,6]; out.push([JSON.stringify(a.splice(1,2)), JSON.stringify(a)].join(' '));
a=[1,2,3]; out.push([JSON.stringify(a.splice(0,1,9,8,7)), JSON.stringify(a), a.length].join(' '));
a=[1,2,3,4]; out.push([JSON.stringify(a.splice(-2)), JSON.stringify(a)].join(' '));
a=[1,2,3,4]; out.push([JSON.stringify(a.splice(10,1,'x')), JSON.stringify(a)].join(' '));
a=[1,2,3,4]; out.push([JSON.stringify(a.splice(1,-5,'y')), JSON.stringify(a)].join(' '));
a=[1,2,3,4]; out.push([JSON.stringify(a.splice(1,100)), JSON.stringify(a)].join(' '));
a=[1,2,3,4]; out.push([JSON.stringify(a.splice(-10,1)), JSON.stringify(a)].join(' '));
a=[1,2,3]; out.push([JSON.stringify(a.splice(1.5,1)), JSON.stringify(a)].join(' '));
class MyA extends Array {}; var m=MyA.from([1,2,3]); var r=m.splice(0,1); out.push([r instanceof MyA, JSON.stringify(m)].join(' '));
a=[1,2,3]; a.constructor=function(){}; try { a.splice(0,1); out.push('ctor ok') } catch(e) { out.push(['ctor', e.constructor.name].join(' ')) }
a=[1,2,3]; Object.freeze(a); try { a.splice(0,1); out.push('frozen no throw') } catch(e) { out.push(['frozen', e.constructor.name].join(' ')) }
a=[1,,3]; out.push([JSON.stringify(a.splice(0,2)), JSON.stringify(a)].join(' '));
a=[1,2,3]; Object.defineProperty(a,'length',{writable:false}); try { a.splice(0,1) } catch(e) { out.push(['nw', e.constructor.name, JSON.stringify(a)].join(' ')) }
var cs=[]; for (var i=0;i<20;i++) cs.push(i); for (var i=0;i<cs.length;i++) if (cs[i]%3==0 && cs[i]>2) { cs.splice(i,1,28,cs[i]>>8,cs[i]&255); i+=2 }; out.push([cs.length, cs.join()].join(' '));
a=[1,2,3]; out.push([JSON.stringify(a.splice()), JSON.stringify(a)].join(' '));
const got = out.join('\n');
const expected = "[2,3] [1,4,5,6]\n[1] [9,8,7,2,3] 5\n[3,4] [1,2]\n[] [1,2,3,4,\"x\"]\n[] [1,\"y\",2,3,4]\n[2,3,4] [1]\n[1] [2,3,4]\n[2] [1,3]\ntrue [2,3]\nctor ok\nfrozen TypeError\n[1,null] [3]\nnw TypeError [2,3,null]\n32 0,1,2,28,0,3,4,5,28,0,6,7,8,28,0,9,10,11,28,0,12,13,14,28,0,15,16,17,28,0,18,19\n[] [1,2,3]";
console.log(got === expected ? 'PASS quick splice' : 'FAIL ' + got);
if (got !== expected) throw new Error('quick splice regressions');
