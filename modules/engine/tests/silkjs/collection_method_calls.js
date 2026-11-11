// SilkJS regression test for Map, Set, WeakMap and WeakSet methods called as
// methods (get, has, delete, set, add), which the interpreter answers on the
// receiver's hash state without a native frame: answers and chaining, argument
// counts the fast call leaves to the general one, keys of every kind, weak
// collections and primitive keys, methods on the wrong receiver, replaced and
// own methods, subclasses, temporaries freed by the call, and growth.
// Expected values come from V8.
var r=[];
function kind(f){ try { return String(f()) } catch (e) { return e instanceof TypeError ? 'TypeError' : 'other:' + e } }
var m=new Map(), s=new Set(), wm=new WeakMap(), ws=new WeakSet(), k1={}, k2={};
// Answers and chaining: set and add answer the receiver.
r.push(m.set(1, 'a') === m, m.set(1, 'b').set(2, 'c').get(1), m.size, s.add(5) === s, s.add(5).add(6).has(6), s.size);
r.push(new Map().set('x', 7).get('x'), new Set().add(3).has(3), new Map().get(1), new Map().has(1), new Map().delete(1), new Set().delete(9));
r.push(m.get(2), m.get(3), m.has(2), m.has(3), m.delete(2), m.delete(2), m.size, s.delete(5), s.has(5), s.size);
// Argument counts the fast call does not take.
r.push(m.set(4) === m, m.has(4), m.get(4), m.get(), m.has(), m.get(1, 2, 3), m.set(5, 6, 7).get(5), s.add() === s, s.has(undefined), s.has(), s.add(8, 9).has(9));
// Keys of every kind, and number keys that are one key.
var keys=[0, -0, 1.5, NaN, 'k', '', true, null, undefined, 10n, k1, Symbol.iterator, 2147483648, -1];
for (var i=0;i<keys.length;i++){ m.set(keys[i], i); s.add(keys[i]); }
var seen=0; for (var i=0;i<keys.length;i++){ if (m.get(keys[i]) === (i === 0 ? 1 : i) && m.has(keys[i]) && s.has(keys[i])) seen++; }
r.push(seen, m.get(0.0), m.get(1.5), m.get(0/0), m.get(10n), m.get(2**31), m.has(1.0), m.get(1.0));
for (var i=0;i<keys.length;i++){ if (m.delete(keys[i])) seen++; if (s.delete(keys[i])) seen++; } r.push(seen, m.size, s.size);
// Weak collections: object keys only.
r.push(wm.set(k1, 1) === wm, wm.get(k1), wm.has(k1), wm.has(k2), wm.get(k2), wm.delete(k1), wm.delete(k1), wm.has(k1), ws.add(k2) === ws, ws.has(k2), ws.has(k1), ws.delete(k2), ws.has(k2));
r.push(kind(function(){ return wm.set(1, 2) }), kind(function(){ return ws.add('x') }), kind(function(){ return wm.set(null, 2) }), wm.get(1), wm.has('x'), wm.delete(1), ws.has(1), ws.delete(null));
// A method of one collection on another receiver throws; so does a plain object.
var o={ get: Map.prototype.get, set: Map.prototype.set, has: Set.prototype.has, add: Set.prototype.add, delete: WeakMap.prototype.delete };
r.push(kind(function(){ return o.get(1) }), kind(function(){ return o.set(1, 2) }), kind(function(){ return o.has(1) }), kind(function(){ return o.add(1) }), kind(function(){ return o.delete(k1) }));
s.get=Map.prototype.get; m.add=Set.prototype.add; wm.has2=Map.prototype.has; m.wdel=WeakMap.prototype.delete;
r.push(kind(function(){ return s.get(1) }), kind(function(){ return m.add(1) }), kind(function(){ return wm.has2(k1) }), kind(function(){ return m.wdel(k1) }));
// Replaced and own methods are called as written.
var m2=new Map(); m2.get=function(k){ return 'own' + k }; r.push(m2.get(1));
var keepHas=Map.prototype.has; Map.prototype.has=function(k){ return 'proto' + k }; r.push(new Map().has(2)); Map.prototype.has=keepHas; r.push(new Map().has(2));
// Subclasses, and a receiver that frees with the call.
class M extends Map { get(k){ return super.get(k) + 1 } } var sub=new M(); sub.set(1, 10); r.push(sub.get(1), sub.has(1), sub.delete(1), sub.size);
function fresh(n){ var t=new Map(); for (var i=0;i<n;i++) t.set(i, {v:i}); return t }
var total=0; for (var i=0;i<200;i++){ total += fresh(20).get(7).v; if (fresh(3).has(2)) total++; if (fresh(3).delete(1)) total++; } r.push(total);
// Tables that grow while values are replaced, with object values released.
var g=new Map(); for (var i=0;i<4000;i++){ g.set(i, {v:i}); if (i % 3 === 0) g.set(i >> 1, {v:-i}); } var sum=0; for (var i=0;i<4000;i++){ sum += g.get(i).v } r.push(g.size, sum);
var gs=new Set(); for (var i=0;i<4000;i++){ gs.add(i % 1000); gs.add('s' + (i % 700)); } r.push(gs.size);
// A failed weak insertion reports the line of the call: the first position in
// its stack is the one a throw on the same line reports.
function firstLine(f){ try { f() } catch (e) { var hit=/:(\d+):\d+/.exec(String(e.stack)); return hit ? +hit[1] : -1 } return -2 }
var weakLine=firstLine(function(){ wm.set(1, 2) }), throwLine=firstLine(function(){ throw new Error('x') }); r.push(weakLine === throwLine, weakLine > 0);
var addLine=firstLine(function(){ ws.add(1) }), againLine=firstLine(function(){ throw new Error('x') }); r.push(addLine === againLine, addLine === weakLine + 1);
const got = r.join(',');
const expected = "true,b,2,true,true,2,7,true,,false,false,false,c,,true,false,true,false,1,true,false,1,true,true,,,false,b,6,true,true,true,false,14,1,2,3,9,12,true,b,40,3,2,true,1,true,false,,true,false,false,true,true,false,true,false,TypeError,TypeError,TypeError,,false,false,false,false,TypeError,TypeError,TypeError,TypeError,TypeError,TypeError,TypeError,TypeError,TypeError,own1,proto2,false,11,true,true,0,1800,4000,3997334,1700,true,true,true,true";
console.log(got === expected ? 'PASS collection method calls' : 'FAIL ' + got);
if (got !== expected) throw new Error('collection method calls regressions');
