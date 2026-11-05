var out2 = [];
var arr = [10, 20, 30, 40, 50]; var seen = [];
for (var k in arr) { seen.push(k + ':' + typeof k + ':' + arr[k]); if (k == '1') arr.pop(); }
out2.push(seen.join(','));
var big = []; for (var i = 0; i < 300; i++) big.push(i); var sum = 0, keys = 0;
for (var k in big) { sum += big[k]; keys++; } out2.push(sum, keys);
var grown = [1, 2]; var gk = []; for (var k in grown) { gk.push(k); if (gk.length < 3) grown.push(9); } out2.push(gk.join());
var holey = [1, , 3]; var hk = []; for (var k in holey) hk.push(k); out2.push(hk.join());
var withProp = [1, 2]; withProp.extra = 'e'; var wk = []; for (var k in withProp) wk.push(k + '=' + withProp[k]); out2.push(wk.join());
Array.prototype.inherited = 'i'; var ik = []; for (var k in [7, 8]) ik.push(k); delete Array.prototype.inherited; out2.push(ik.join());
var a2 = ['x', 'y', 'z']; out2.push(a2['0'], a2['2'], a2['3'], a2['01'], a2['-0'], a2['1e0'], a2['00'], a2['4294967295']);
var ta = new Int16Array([5, 6, 7]); out2.push(ta['1'], ta['3'], ta['-1'], ta['1.5']);
(function () { out2.push(arguments['1'], arguments['5']); })('p', 'q');
var str = 'hello'; out2.push(str['1']);
var o = {}; for (var i = 0; i < 6; i++) o[i] = i * i; out2.push(JSON.stringify(o), Object.keys(o).join());
var setterHits = []; Object.defineProperty(Object.prototype, '4', { set: function (v) { setterHits.push(v); }, configurable: true });
var o2 = {}; for (var i = 0; i < 6; i++) o2[i] = 'v' + i; delete Object.prototype[4];
out2.push(JSON.stringify(o2), setterHits.join());
var frozen = Object.freeze({ 0: 'f' }); frozen[1] = 'no'; frozen[0] = 'no'; out2.push(JSON.stringify(frozen));
var sealed = Object.preventExtensions({ 0: 'a' }); sealed[0] = 'b'; sealed[1] = 'c'; out2.push(JSON.stringify(sealed));
var ro = {}; Object.defineProperty(ro, 2, { value: 'r', writable: false, enumerable: true }); ro[2] = 'w'; ro[3] = 'x'; out2.push(JSON.stringify(ro));
var mixed = [1, 'two', { three: 3 }, [4], 5.5, null, undefined, true, 10n];
var sl = mixed.slice(); var sl2 = mixed.slice(1, 4); mixed.length = 0;
out2.push(sl.length, String(sl[1]), sl[2].three, sl[3][0], typeof sl[8], sl2.length, sl2[1].three);
var nums = []; for (var i = 0; i < 1001; i++) nums.push(i % 7 ? i : i + 0.5); var ns = nums.slice(3); out2.push(ns.length, ns[0], ns[4], ns[997]);
var objs = []; for (var i = 0; i < 37; i++) objs.push({ i: i }); var copy = objs.slice(); objs = null; var t = 0; for (var i = 0; i < copy.length; i++) t += copy[i].i; out2.push(t);
var src = { a: 1, b: 2 }; var c1 = { ...src }; Object.defineProperty(src, 'a', { enumerable: false }); var c2 = { ...src };
Object.defineProperty(src, 'b', { get: function () { return 'g'; }, enumerable: true }); var c3 = { ...src };
out2.push(JSON.stringify(c1), JSON.stringify(c2), JSON.stringify(c3), Object.getOwnPropertyDescriptor(c3, 'b').value);
var got2 = out2.join('|');
const expected2 = "0:string:10,1:string:20,2:string:30,3:string:40|44850|300|0,1|0,2|0=1,1=2,extra=e|0,1,inherited|x|z|||||||6||||q||e|{\"0\":0,\"1\":1,\"2\":4,\"3\":9,\"4\":16,\"5\":25}|0,1,2,3,4,5|{\"0\":\"v0\",\"1\":\"v1\",\"2\":\"v2\",\"3\":\"v3\",\"5\":\"v5\"}|v4|{\"0\":\"f\"}|{\"0\":\"b\"}|{\"2\":\"r\",\"3\":\"x\"}|9|two|3|4|bigint|3|3|998|3|7.5|1000|666|{\"a\":1,\"b\":2}|{\"b\":2}|{\"b\":\"g\"}|g";
console.log(got2 === expected2 ? 'PASS property collection edge cases' : 'FAIL ' + got2);
if (got2 !== expected2) throw new Error('property collection edge case regressions');
var out3 = [];
for (var n = 0; n < 11; n++) {
  for (var at = -1; at < n; at++) {
    var a = []; for (var i = 0; i < n; i++) a.push(i === at ? 's' + i : i * 1.5);
    var b = a.slice(); a.length = 0; a = null;
    out3.push(b.join(':'));
  }
}
var objs = [];
for (var k = 0; k < 6; k++) {
  var o = { p: 1, q: 2, r: 3, s: 4, t: 5 }; if (k & 1) o.r = 'str' + k; if (k & 2) o.t = { deep: k };
  objs.push({ ...o }); o = null;
}
out3.push(JSON.stringify(objs)); objs = null;
var base = { x: 1, y: 2 }; var copies = []; for (var i = 0; i < 3; i++) copies.push({ ...base }); copies = null;
var acc = { x: 1, y: 2 }; var hit = 0;
Object.defineProperty(acc, 'y', { get: function () { hit++; return 'gy'; }, enumerable: true, configurable: true });
var accCopy = { ...acc }; out3.push(accCopy.y, hit); acc = null;
var withFn = { x: 1, y: 2 }; withFn.y = function () { return 'fn'; }; var fnCopy = { ...withFn }; withFn = null; out3.push(fnCopy.y());
var sym = Symbol('k'); var withSym = { x: 1, y: 2 }; withSym[sym] = 'sv'; var symCopy = { ...withSym }; withSym = null; out3.push(symCopy[sym]);
var del = { x: 1, y: 'two', z: 3 }; delete del.y; var delCopy = { ...del }; del = null; out3.push(JSON.stringify(delCopy));
function Make() { this.a = 1; this.b = 2; } var made = []; for (var i = 0; i < 4; i++) made.push(new Make()); made[2].b = 'str'; Object.defineProperty(made[3], 'a', { get: function () { return 'ga'; } });
out3.push(made.map(function (m) { return m.a + ',' + m.b; }).join(';')); made = null;
var got3 = out3.join('|');
const expected3 = "|0|s0|0:1.5|s0:1.5|0:s1|0:1.5:3|s0:1.5:3|0:s1:3|0:1.5:s2|0:1.5:3:4.5|s0:1.5:3:4.5|0:s1:3:4.5|0:1.5:s2:4.5|0:1.5:3:s3|0:1.5:3:4.5:6|s0:1.5:3:4.5:6|0:s1:3:4.5:6|0:1.5:s2:4.5:6|0:1.5:3:s3:6|0:1.5:3:4.5:s4|0:1.5:3:4.5:6:7.5|s0:1.5:3:4.5:6:7.5|0:s1:3:4.5:6:7.5|0:1.5:s2:4.5:6:7.5|0:1.5:3:s3:6:7.5|0:1.5:3:4.5:s4:7.5|0:1.5:3:4.5:6:s5|0:1.5:3:4.5:6:7.5:9|s0:1.5:3:4.5:6:7.5:9|0:s1:3:4.5:6:7.5:9|0:1.5:s2:4.5:6:7.5:9|0:1.5:3:s3:6:7.5:9|0:1.5:3:4.5:s4:7.5:9|0:1.5:3:4.5:6:s5:9|0:1.5:3:4.5:6:7.5:s6|0:1.5:3:4.5:6:7.5:9:10.5|s0:1.5:3:4.5:6:7.5:9:10.5|0:s1:3:4.5:6:7.5:9:10.5|0:1.5:s2:4.5:6:7.5:9:10.5|0:1.5:3:s3:6:7.5:9:10.5|0:1.5:3:4.5:s4:7.5:9:10.5|0:1.5:3:4.5:6:s5:9:10.5|0:1.5:3:4.5:6:7.5:s6:10.5|0:1.5:3:4.5:6:7.5:9:s7|0:1.5:3:4.5:6:7.5:9:10.5:12|s0:1.5:3:4.5:6:7.5:9:10.5:12|0:s1:3:4.5:6:7.5:9:10.5:12|0:1.5:s2:4.5:6:7.5:9:10.5:12|0:1.5:3:s3:6:7.5:9:10.5:12|0:1.5:3:4.5:s4:7.5:9:10.5:12|0:1.5:3:4.5:6:s5:9:10.5:12|0:1.5:3:4.5:6:7.5:s6:10.5:12|0:1.5:3:4.5:6:7.5:9:s7:12|0:1.5:3:4.5:6:7.5:9:10.5:s8|0:1.5:3:4.5:6:7.5:9:10.5:12:13.5|s0:1.5:3:4.5:6:7.5:9:10.5:12:13.5|0:s1:3:4.5:6:7.5:9:10.5:12:13.5|0:1.5:s2:4.5:6:7.5:9:10.5:12:13.5|0:1.5:3:s3:6:7.5:9:10.5:12:13.5|0:1.5:3:4.5:s4:7.5:9:10.5:12:13.5|0:1.5:3:4.5:6:s5:9:10.5:12:13.5|0:1.5:3:4.5:6:7.5:s6:10.5:12:13.5|0:1.5:3:4.5:6:7.5:9:s7:12:13.5|0:1.5:3:4.5:6:7.5:9:10.5:s8:13.5|0:1.5:3:4.5:6:7.5:9:10.5:12:s9|[{\"p\":1,\"q\":2,\"r\":3,\"s\":4,\"t\":5},{\"p\":1,\"q\":2,\"r\":\"str1\",\"s\":4,\"t\":5},{\"p\":1,\"q\":2,\"r\":3,\"s\":4,\"t\":{\"deep\":2}},{\"p\":1,\"q\":2,\"r\":\"str3\",\"s\":4,\"t\":{\"deep\":3}},{\"p\":1,\"q\":2,\"r\":3,\"s\":4,\"t\":5},{\"p\":1,\"q\":2,\"r\":\"str5\",\"s\":4,\"t\":5}]|gy|1|fn|sv|{\"x\":1,\"z\":3}|1,2;1,2;1,str;ga,2";
console.log(got3 === expected3 ? 'PASS number-only copies and plain shapes' : 'FAIL ' + got3);
if (got3 !== expected3) throw new Error('number-only copy regressions');
var out5 = [];
function S(x) { return JSON.stringify(x); }
var base = { a: 1, b: 'two', c: { d: 3 } };
for (var i = 0; i < 3; i++) { var cl = { ...base }; out5.push(S(cl)); }
var ext = { ...base, a: 9, z: 1 }; out5.push(S(ext), S(base));
var pre = { z: 0, ...base }; out5.push(S(pre));
var arrSrc = { ...[5, 6] }; out5.push(S(arrSrc));
var strSrc = { ...'hi' }; out5.push(S(strSrc)); var { 0: s0, ...rs } = 'abc'; out5.push(s0, S(rs), S({ ...'' }), S({ x: 1, ...'q' }));
var nul = { ...null, ...undefined, ...7 }; out5.push(S(nul));
var proto = Object.create({ inh: 1 }); proto.own = 2; out5.push(S({ ...proto }));
var sym = Symbol('s'); var withSym = { [sym]: 4, k: 5 }; var ws = { ...withSym }; out5.push(ws[sym], ws.k);
var getterSrc = { get g() { return 'gv'; } }; var gs = { ...getterSrc }; out5.push(S(Object.getOwnPropertyDescriptor(gs, 'g')));
var prox = new Proxy({ p: 1 }, {}); out5.push(S({ ...prox }));
var m = new Map([[1, 'a']]); out5.push(S({ ...m }));
var nested = { o: { x: 1 } }; var nc = { ...nested }; nc.o.x = 2; out5.push(nested.o.x);
var { a: ra, ...rest } = base; out5.push(ra, S(rest));
var srt = [3, 1, 2, 10, 1, 20, 5]; out5.push(srt.slice().sort().join());
var hol = [3, , 1, undefined, 2]; hol.sort(); out5.push(hol.length, S(hol), 1 in hol, 3 in hol, 4 in hol);
var dups = ['b', 'a', 'b', 'a', 'c', 'a']; out5.push(dups.sort().join());
var mixedSort = [10, '9', 'a', 1, true, null, 'B']; out5.push(mixedSort.sort().join());
var big = []; for (var i = 0; i < 200; i++) big.push((i * 37) % 101); big.sort(); out5.push(big.slice(0, 8).join(), big.slice(-4).join());
var stable = []; for (var i = 0; i < 40; i++) stable.push({ k: i % 3, i: i }); stable.sort(function (x, y) { return x.k - y.k; });
out5.push(stable.map(function (e) { return e.i; }).join());
var objSort = { 0: 'c', 1: 'a', 2: 'b', length: 3 }; Array.prototype.sort.call(objSort); out5.push(S(objSort));
var protoHole = [3, , 1]; Array.prototype[1] = 0; protoHole.sort(); delete Array.prototype[1]; out5.push(S(protoHole));
var p1 = [1, 2, 3]; out5.push(p1.pop(), p1.pop(), p1.length, S(p1));
var p0 = []; out5.push(p0.pop(), p0.length);
var ph = [1, , 3]; out5.push(ph.pop(), ph.pop(), ph.length);
var pobj = { 0: 'x', 1: 'y', length: 2 }; out5.push(Array.prototype.pop.call(pobj), pobj.length, 1 in pobj);
var pfrozen = Object.freeze([1]); try { pfrozen.pop(); out5.push('nothrow'); } catch (e) { out5.push(e.constructor.name); }
var pheap = [{ v: 1 }, 'str', 2n]; out5.push(typeof pheap.pop(), pheap.pop(), pheap.pop().v);
var mp = new Map(); for (var i = 0; i < 20; i++) mp.set('k' + i, i); out5.push(mp.get('k7'), mp.has('k19'), mp.has('k20'), mp.delete('k3'), mp.delete('k3'), mp.size);
out5.push(mp.set('n', 1) === mp, mp.get(undefined), mp.get());
var nanMap = new Map(); nanMap.set(NaN, 'nan').set(-0, 'zero'); out5.push(nanMap.get(NaN), nanMap.get(0), nanMap.has(+0));
var st = new Set(); out5.push(st.add(1) === st, st.has(1), st.has('1'), st.delete(1), st.size);
var wm = new WeakMap(); var key = {}; out5.push(wm.set(key, 'w') === wm, wm.get(key), wm.has(key), wm.has({}), wm.delete(key), wm.has(key));
try { wm.set(1, 2); out5.push('nothrow'); } catch (e) { out5.push(e.constructor.name); }
out5.push(wm.get(1), wm.has('x'), wm.delete(3));
var wsx = new WeakSet(); var wk = {}; out5.push(wsx.add(wk) === wsx, wsx.has(wk), wsx.delete(wk), wsx.has(wk));
try { wsx.add(1); out5.push('nothrow'); } catch (e) { out5.push(e.constructor.name); }
try { Map.prototype.get.call(new Set(), 1); out5.push('nothrow'); } catch (e) { out5.push(e.constructor.name); }
try { Map.prototype.set.call({}, 1, 2); out5.push('nothrow'); } catch (e) { out5.push(e.constructor.name); }
class MyMap extends Map { set(k, v) { return super.set(k, v * 2); } }
var mm = new MyMap(); mm.set('a', 2); out5.push(mm.get('a'), mm.has('a'));
var shadow = new Map(); shadow.get = function () { return 'own'; }; out5.push(shadow.get(1));
var callGet = new Map([[1, 2]]); var g = callGet.get; out5.push(g.call(callGet, 1));
var wSym = new WeakMap(); try { wSym.set(Symbol('ok'), 1); out5.push(wSym.has(Symbol.for('reg'))); } catch (e) { out5.push(e.constructor.name); }
var got5 = out5.join('|');
const expected5 = "{\"a\":1,\"b\":\"two\",\"c\":{\"d\":3}}|{\"a\":1,\"b\":\"two\",\"c\":{\"d\":3}}|{\"a\":1,\"b\":\"two\",\"c\":{\"d\":3}}|{\"a\":9,\"b\":\"two\",\"c\":{\"d\":3},\"z\":1}|{\"a\":1,\"b\":\"two\",\"c\":{\"d\":3}}|{\"z\":0,\"a\":1,\"b\":\"two\",\"c\":{\"d\":3}}|{\"0\":5,\"1\":6}|{\"0\":\"h\",\"1\":\"i\"}|a|{\"1\":\"b\",\"2\":\"c\"}|{}|{\"0\":\"q\",\"x\":1}|{}|{\"own\":2}|4|5|{\"value\":\"gv\",\"writable\":true,\"enumerable\":true,\"configurable\":true}|{\"p\":1}|{}|2|1|{\"b\":\"two\",\"c\":{\"d\":3}}|1,1,10,2,20,3,5|5|[1,2,3,null,null]|true|true|false|a,a,a,b,b,c|1,10,9,B,a,,true|0,0,1,1,10,10,100,100|98,98,99,99|0,3,6,9,12,15,18,21,24,27,30,33,36,39,1,4,7,10,13,16,19,22,25,28,31,34,37,2,5,8,11,14,17,20,23,26,29,32,35,38|{\"0\":\"a\",\"1\":\"b\",\"2\":\"c\",\"length\":3}|[0,1,3]|3|2|1|[1]||0|3||1|y|1|false|TypeError|bigint|str|1|7|true|false|true|false|19|true|||nan|zero|true|true|true|false|true|0|true|w|true|false|true|false|TypeError||false|false|true|true|true|false|TypeError|TypeError|TypeError|4|true|own|2|false";
console.log(got5 === expected5 ? 'PASS spread, sort, pop and collection methods' : 'FAIL ' + got5);
if (got5 !== expected5) throw new Error('spread, sort, pop or collection regressions');
var out7 = [];
var d = { '': 1, '1a': 2, '01': 3, '1': 4, 'a1': 5, 'é1': 6, '中': 7, '-1': 8, x: { y: 1 } };
var dc = { ...d }; out7.push(JSON.stringify(dc), dc.x === d.x);
out7.push(delete d[''], delete d['1a'], delete d['01'], delete d['1'], delete d['a1'], delete d['é1'], delete d['中'], delete d['-1'], delete d['nope']);
out7.push(JSON.stringify(d), Object.keys(dc).length);
var got7 = out7.join('|');
const expected7 = "{\"1\":4,\"\":1,\"1a\":2,\"01\":3,\"a1\":5,\"é1\":6,\"中\":7,\"-1\":8,\"x\":{\"y\":1}}|true|true|true|true|true|true|true|true|true|true|{\"x\":{\"y\":1}}|9";
console.log(got7 === expected7 ? 'PASS clone copies and named deletes' : 'FAIL ' + got7);
if (got7 !== expected7) throw new Error('clone or delete regressions');
