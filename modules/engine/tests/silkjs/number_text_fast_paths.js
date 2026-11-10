// SilkJS regression test for n.toString() on an Int answered without the
// call (also with the method replaced or turned into a getter), in-place
// appends that keep a flat string growing past 8 KB, and string literals
// used over and over in arithmetic. Expected values
// come from V8.
var out = [];
function h(s) { var x = 0; for (var i = 0; i < s.length; i++) x = (Math.imul(x, 31) + s.charCodeAt(i)) | 0; return s.length + ':' + x; }
var acc = ''; var vals = [0, 1, 9, 10, 99, 100, 255, 256, 1000, -1, -255, -256, 2147483647, -2147483648, 65536];
for (var k = 0; k < vals.length; k++) { var v = vals[k]; acc += v.toString() + ',' + (v).toString(10) + ',' + v.toString(16) + ';'; }
out.push(acc);
var t = ''; for (var i = -300; i < 3000; i += 7) t += (i % 300).toString(); out.push(h(t));
out.push((5).toString(), (5).toString() === '5', typeof (300).toString());
var saved = Number.prototype.toString;
var seen = [];
for (var i = 0; i < 10; i++) {
  if (i == 4) Number.prototype.toString = function () { 'use strict'; return 'n' + typeof this; };
  if (i == 7) Number.prototype.toString = saved;
  seen.push(i.toString());
}
out.push(seen.join());
Object.defineProperty(Number.prototype, 'toString', { get: function () { return function () { return 'got'; }; }, configurable: true });
out.push((3).toString(), (300).toString());
Object.defineProperty(Number.prototype, 'toString', { value: saved, writable: true, configurable: true });
out.push((3).toString(), (300).toString(), 2.5.toString());
var k2 = 7; var o = { toString: function () { return 'obj'; } }; out.push(o.toString(), k2.toString(), String(k2));
var r = ''; var mid; for (var i = 0; i < 25000; i++) { r += 'abcdef'; if (i == 2000) mid = r; } out.push(h(r), h(mid), r.slice(149990));
var w = ''; for (var i = 0; i < 3000; i++) { w += 'xy'; if (i == 1500) w += 'é'; } out.push(h(w));
var u = ''; for (var i = 0; i < 2000; i++) { u += 'pq'; if (i == 1800) u += '一'; } out.push(h(u));
var lits = ['12345', '0012', '999999999', '1000000000', '7', '0', '12.5', '-3', ' 4', 'x1', ''];
var sums = []; for (var k = 0; k < lits.length; k++) { var s = lits[k], r = 0; for (var i = 0; i < 50; i++) r += (s | 0) + (s * 1) + (s < 100 ? 1 : 0); sums.push(r); }
out.push(sums.join());
var built = {}; for (var i = 0; i < 20; i++) { var key = 'k' + (i % 5); built[key] = (built[key] | 0) + 1; } out.push(JSON.stringify(built));
var dyn = ['1', '2', '3'].join('') ; var o2 = {}; o2[dyn] = 1; var acc2 = 0; for (var i = 0; i < 30; i++) acc2 += dyn | 0; out.push(acc2, Object.keys(o2)[0] - 0);
var got = out.join('|');
var expected = "0,0,0;1,1,1;9,9,9;10,10,a;99,99,63;100,100,64;255,255,ff;256,256,100;1000,1000,3e8;-1,-1,-1;-255,-255,-ff;-256,-256,-100;2147483647,2147483647,7fffffff;-2147483648,-2147483648,-80000000;65536,65536,10000;|1283:556016651|5|true|string|0,1,2,3,nnumber,nnumber,nnumber,7,8,9|got|got|3|300|2.5|obj|7|7|150000:-162010888|12006:1990890451|cdefabcdef|6001:-678971577|4001:-655587234|1234500,1250,99999999900,100000000000,750,50,1275,-250,450,NaN,50|{\"k0\":4,\"k1\":4,\"k2\":4,\"k3\":4,\"k4\":4}|3690|123";
console.log(got === expected ? 'PASS int toString and large appends' : 'FAIL ' + got);
if (got !== expected) throw new Error('int toString regressions');

