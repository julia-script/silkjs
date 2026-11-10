// SilkJS regression test for three call_method/operator shortcuts: Number
// methods on number receivers answered before quickInline, BigInt + BigInt
// answered without the operator family step, and a[a.length] = x appends with
// the extensibility, length and prototype checks folded together.
// Expected values come from V8.
var r = [];
var s = '';
for (var j = 0; j < 20; j++) s += (j + 0.1).toFixed(j % 4) + ',' + (-j - 0.25).toFixed(1) + ';';
r.push(s);
r.push((12.5).toPrecision(3), (0.000123).toExponential(2), (255).toString(16), (3.75).toString(2), (7).toString(), (1e21).toFixed(2));
try { (1.5).toFixed(101); } catch (e) { r.push(e.constructor.name); }
r.push((5).toFixed(), (5).valueOf(), (5).toLocaleString === Number.prototype.toLocaleString);
var saved = Number.prototype.toFixed; Number.prototype.toFixed = function (d) { return 'own' + d; }; r.push((1.5).toFixed(2)); Number.prototype.toFixed = saved;
r.push((1.5).toFixed.call(2.25, 1), Number.prototype.toString.call(10, 3));
var a = 1n, sum = 0n; for (var i = 0; i < 300; i++) { sum = sum + a * a; a = a + 12345678901n; } r.push(String(sum));
var big = 2n ** 70n; r.push(String(big + big), String(big + -big), String(-5n + 3n), String(9007199254740993n + 1n));
try { 1n + 1; } catch (e) { r.push(e.constructor.name); }
r.push(1n + '2', '3' + 4n, typeof (1n + 2n));
var t = []; for (var k = 0; k < 50; k++) t[t.length] = k * 2; r.push(t.length, t[49]);
var f = [1, 2]; Object.freeze(f); try { (function () { 'use strict'; f[f.length] = 3; })(); } catch (e) { r.push(e.constructor.name); } r.push(f.length);
var n = [1]; Object.preventExtensions(n); n[1] = 5; r.push(n.length, n[1]);
var w = [1, 2]; Object.defineProperty(w, 'length', { writable: false }); w[2] = 9; r.push(w.length, w[2]);
var hits = 0; var proto = Object.create(Array.prototype); Object.defineProperty(proto, '1', { set: function (v) { hits++; }, configurable: true });
var p = [0]; Object.setPrototypeOf(p, proto); p[1] = 7; r.push(hits, p.length);
const got = r.join('|');
const expected = '0,-0.3;1.1,-1.3;2.10,-2.3;3.100,-3.3;4,-4.3;5.1,-5.3;6.10,-6.3;7.100,-7.3;8,-8.3;9.1,-9.3;10.10,-10.3;11.100,-11.3;12,-12.3;13.1,-13.3;14.10,-14.3;15.100,-15.3;16,-16.3;17.1,-17.3;18.10,-18.3;19.100,-19.3;|12.5|1.23e-4|ff|11.11|7|1e+21|RangeError|5|5|true|own2|2.3|101|1364890998091156001883765050|2361183241434822606848|0|-2|9007199254740994|TypeError|12|34|bigint|50|98|TypeError|2|1||2||1|1';
console.log(got === expected ? 'PASS number methods, BigInt add, array append' : 'FAIL ' + got);
if (got !== expected) throw new Error('call_method/operator shortcut regressions');
