// SilkJS regression test for the decimal texts of integers that the runtime
// remembers (String(i), i.toString()): a remembered string whose only holder is
// the table takes the next number's text in place. Strings held elsewhere keep
// their text, a rewritten string hashes as its new text (Map and Set keys, own
// property names), lengths that differ and negative numbers allocate anew, and
// get, has and delete answer for every receiver and key kind.
// Expected values come from V8.
var r=[];
function digits(s){ var t=0; for (var i=0;i<s.length;i++) t=t*31+s.charCodeAt(i)|0; return t }
// Held strings survive any number of later conversions.
var held=[], want=[]; for (var i=300;i<3000;i+=7){ held.push(i.toString()); want.push(i) }
var sum=0; for (var i=0;i<20000;i++){ sum+=(i).toString().length; sum+=String(i+1024).length }
var same=0; for (var k=0;k<held.length;k++){ if (held[k] === '' + want[k] && Number(held[k]) === want[k]) same++ }
r.push(sum, same === held.length);
// Transient lookups: each String(i) is hashed, dropped, and its cell reused.
var m=new Map(); for (var i=1000;i<3000;i++) m.set(String(i), i);
var bad=0; for (var round=0;round<3;round++){ for (var i=1000;i<5000;i++){ if (m.has(String(i)) !== (i<3000)) bad++; if (m.get(i.toString()) !== (i<3000 ? i : undefined)) bad++ } }
r.push(bad, m.size);
var s=new Set(); for (var i=0;i<4000;i+=3) s.add((i).toString());
var hits=0; for (var i=0;i<4000;i++){ if (s.has(String(i))) hits++ } r.push(hits, s.delete(String(3)), s.delete((3).toString()), s.has('3'), s.size);
var o={}; for (var i=2000;i<2600;i++) o[String(i)]=i; var keyed=0; for (var i=1900;i<2700;i++){ if (o[(i).toString()] === i) keyed++ } r.push(keyed, Object.keys(o).length);
// Lengths that change, signs, and the table's index wrapping (1024 apart).
var edge=[9,10,99,100,255,256,999,1000,1023,1024,1280,2047,2048,9999,10000,99999,100000,1048576,2147483647,-1,-9,-10,-255,-256,-1024,-1280,-2147483648,0];
var acc=0; for (var round=0;round<4;round++){ for (var i=0;i<edge.length;i++){ acc=acc*7+digits(String(edge[i]))|0; acc=acc*7+digits((edge[i]+1024).toString())|0; acc=acc*7+digits((edge[i]-1024|0).toString())|0 } }
r.push(acc, String(1280), (2304).toString(), String(-1280), (256).toString(), String(1280) === '1280', (1280).toString(16), (1280).toString(10), String(1280.5), String(-0));
var a=String(7000), b=String(8024), c=String(7000); r.push(a, b, c, a === c, a + b);
var concat=''; for (var i=5000;i<5010;i++) concat+=String(i); r.push(concat, concat.length);
// Reads through every collection kind and odd receivers.
function kind(f){ try { return String(f()) } catch (e) { return e instanceof TypeError ? 'TypeError' : 'other:' + e } }
var k1={}, k2={}, wm=new WeakMap([[k1,1]]), ws=new WeakSet([k1]), mm=new Map([[1,'a'],['1','b'],[k1,'c'],[NaN,'n'],[0,'z']]), ss=new Set([1,'1',k1]);
r.push(mm.get(1), mm.get('1'), mm.get(String(1)), mm.get(k1), mm.get(k2), mm.get(NaN), mm.get(-0), mm.has(1), mm.has(2), mm.delete(1), mm.delete(1), mm.has(1), mm.size);
r.push(ss.has(1), ss.has('1'), ss.has(k2), ss.delete(k1), ss.delete(k1), ss.size, wm.get(k1), wm.get(k2), wm.has(k1), wm.has(1), wm.get('x'), wm.delete(k1), wm.delete(k1), wm.delete(1), ws.has(k1), ws.has(k2), ws.delete(k1), ws.has(k1));
r.push(kind(function(){ return mm.get.call(ss, 1) }), kind(function(){ return ss.has.call(mm, 1) }), kind(function(){ return wm.get.call(mm, k1) }), kind(function(){ return mm.delete.call({}, 1) }), kind(function(){ return mm.has.call(1, 1) }));
var temp=0; for (var i=0;i<200;i++){ if (new Map([[i,i]]).get(i) === i) temp++; if (new Set([String(i)]).has(String(i))) temp++; if (new Map([[i,i]]).delete(i)) temp++ } r.push(temp);
class M2 extends Map { get(k){ return 'sub:' + super.get(k) } } var m2=new M2([[1,2]]); r.push(m2.get(1), m2.has(1), m2.delete(1), m2.size);
var own=new Map([[1,2]]); own.has=function(){ return 'own' }; r.push(own.has(1), own.get(1));
// Weak tables: sets with object keys, and keys released afterwards.
var tab=[]; for (var i=0;i<500;i++) tab.push({ key:i }); var w=new WeakMap(); for (var i=0;i<500;i++) w.set(tab[i], i);
var live=0; for (var i=0;i<500;i++){ if (w.get(tab[i]) === i && w.has(tab[i])) live++ } for (var i=0;i<500;i+=2) tab[i]=null;
var left=0; for (var i=1;i<500;i+=2){ if (w.get(tab[i]) === i) left++ } r.push(live, left, kind(function(){ return w.set(1, 2) }), kind(function(){ return new WeakSet().add('x') }), w.set(tab[1], 'again').get(tab[1]));
const got = r.join('|');
const expected = "179914|true|0|2000|1334|true|false|false|1333|600|600|1198375816|1280|2304|-1280|256|true|500|1280|1280.5|0|7000|8024|7000|true|70008024|5000500150025003500450055006500750085009|40|a|b|b|c||n|z|true|false|true|false|false|4|true|true|false|true|false|2|1||true|false||true|false|false|true|false|true|false|TypeError|TypeError|TypeError|TypeError|TypeError|600|sub:2|true|true|0|own|2|500|250|TypeError|TypeError|again";
console.log(got === expected ? 'PASS number text reuse' : 'FAIL ' + got);
if (got !== expected) throw new Error('number text reuse regressions');
