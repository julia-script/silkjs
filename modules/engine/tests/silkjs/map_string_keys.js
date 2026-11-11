// SilkJS regression test for Map and Set keyed by strings and numbers, and for
// `String(n)` on an Int answered at the call site: equal texts held in
// different string objects, keys that are looked up but never stored, strings
// that grow after being a key, tables that grow, shrink and are refilled, a
// shadowed or replaced String, and reads on a receiver that is no Map.
// Expected values come from V8.
var r=[];
for (var i=-25;i<1200;i+=37){ r.push(String(i), String(i*1000003), String(-i)); }
r.push(String(2147483647), String(-2147483648), String(1.5), String('x'), String(true), String(null), String(undefined), String(0), String(-0), typeof String(7), typeof new String(7), String(7).length);
(function(){ var String=function(v){ return 'L'+v }; r.push(String(5), String(300)); })();
var keep=String; String=function(v){ return 'G'+v }; r.push(String(6), String(4000)); String=keep; r.push(String(6));
var o={ String: function(v){ return 'M'+v } }; r.push(o.String(9));
function viaArg(f, v){ return f(v) } r.push(viaArg(String, 12), viaArg(Number, 12), viaArg(String, 123456), viaArg(function(v){ return v+1 }, 12));
// String keys met again as other objects with the same text.
var m=new Map(), n=0;
for (var i=0;i<3000;i++){ m.set('k'+i, i); }
for (var i=0;i<3000;i++){ if (m.get('k'+String(i)) !== i) n++; if (!m.has(`k${i}`)) n++; if (m.get(('xk'+i).slice(1)) !== i) n++; }
r.push(n, m.size);
for (var i=0;i<3000;i+=3){ if (!m.delete('k'+i)) n++; if (m.delete('k'+i)) n++; }
for (var i=0;i<3000;i++){ if (m.has('k'+i) !== (i%3 !== 0)) n++; }
r.push(n, m.size);
for (var i=0;i<3000;i+=3){ m.set('k'+i, -i); }
var order=0, at=0; m.forEach(function(v,k){ if (at < 2000 && k !== 'k'+(at + 1 + Math.floor(at/2))) order++; at++; });
r.push(order, at, m.size);
// The same key object looked up before and after other keys arrive, and a key
// that only ever looks up.
var probe='p'+41, hits=0; for (var i=0;i<50;i++){ if (m.has(probe)) hits++; m.set('p'+i, i); } r.push(hits);
var s=new Set(); for (var i=0;i<500;i++){ s.add(String(i%50)); s.add(i%50); } r.push(s.size, s.has('49'), s.has(49), s.has('50'));
// A string that grows after it was a key.
var g='a'; var gm=new Map(); for (var i=0;i<40;i++){ gm.set(g, i); g+='b'; if (gm.has(g)) n++; } r.push(gm.size, gm.get('abbb'), n);
// Number keys in a table that grows and shrinks.
var im=new Map(); for (var i=0;i<5000;i++){ im.set(i, i); im.set(i+0.5, i); } for (var i=0;i<5000;i+=2){ im.delete(i); } var sum=0; im.forEach(function(v){ sum+=v }); r.push(im.size, sum, im.get(4999), im.get(4998), im.get(0.5), im.has(-0), im.get(NaN));
im.set(NaN, 1); im.set(-0, 2); r.push(im.get(NaN), im.get(0));
// Reads and deletes on a receiver that is no Map still throw.
var errors=0; try { Map.prototype.get.call({}, 1) } catch (e) { if (e instanceof TypeError) errors++ } try { Map.prototype.delete.call(new Set(), 1) } catch (e) { if (e instanceof TypeError) errors++ } try { Map.prototype.has.call(1, 1) } catch (e) { if (e instanceof TypeError) errors++ } r.push(errors);
var wm=new WeakMap(), ks=[]; for (var i=0;i<300;i++){ ks.push({}); wm.set(ks[i], String(i)); } var w=0; for (var i=0;i<300;i++){ if (wm.get(ks[i]) === String(i)) w++; if (i%2) wm.delete(ks[i]); } for (var i=0;i<300;i++){ if (wm.has(ks[i])) w++; } r.push(w);
const got = r.join(',');
const expected = "-25,-25000075,25,12,12000036,-12,49,49000147,-49,86,86000258,-86,123,123000369,-123,160,160000480,-160,197,197000591,-197,234,234000702,-234,271,271000813,-271,308,308000924,-308,345,345001035,-345,382,382001146,-382,419,419001257,-419,456,456001368,-456,493,493001479,-493,530,530001590,-530,567,567001701,-567,604,604001812,-604,641,641001923,-641,678,678002034,-678,715,715002145,-715,752,752002256,-752,789,789002367,-789,826,826002478,-826,863,863002589,-863,900,900002700,-900,937,937002811,-937,974,974002922,-974,1011,1011003033,-1011,1048,1048003144,-1048,1085,1085003255,-1085,1122,1122003366,-1122,1159,1159003477,-1159,1196,1196003588,-1196,2147483647,-2147483648,1.5,x,true,null,undefined,0,0,string,object,1,L5,L300,G6,G4000,6,M9,12,12,123456,13,0,3000,0,2000,0,3000,3000,8,100,true,true,false,40,3,0,7500,18747500,4999,,0,false,,1,2,3,450";
console.log(got === expected ? 'PASS map string keys' : 'FAIL ' + got);
if (got !== expected) throw new Error('map string keys regressions');
