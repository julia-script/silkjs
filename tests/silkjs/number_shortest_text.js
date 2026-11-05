// SilkJS regression test for shortest number-to-string (dtoa_shortest, the
// Schubfach path) and the number + string join in the VM. Covers random bit
// patterns, short decimals, powers of two and ten, binade edges and both
// layout switches (1e21, 1e-7). Expected values come from V8.
var view = new DataView(new ArrayBuffer(8));
var seed = 12345;
function next() { seed = (Math.imul(seed, 1103515245) + 12345) | 0; return seed >>> 0; }
function fromBits(hi, lo) { view.setUint32(0, hi); view.setUint32(4, lo); return view.getFloat64(0); }
var hash = 0x811c9dc5, count = 0;
function mix(s) { for (var i = 0; i < s.length; i++) hash = Math.imul(hash ^ s.charCodeAt(i), 16777619); hash = Math.imul(hash ^ 124, 16777619); count++; }
function check(x) { var a = String(x); var b = x + ''; var c = '' + x; var d = x.toString(); if (a !== b || a !== c || a !== d) throw new Error('paths differ ' + a + ' ' + b + ' ' + c + ' ' + d); mix(a); if (Number(a) !== x && x === x) throw new Error('no round trip ' + a); }
for (var i = 0; i < 20000; i++) { var x = fromBits(next(), next()); check(x); check(-x); }
for (var e = -1074; e <= 1023; e++) { var p = Math.pow(2, e); check(p); check(p * 1.5); check(fromBits(((e + 1023) << 20) >>> 0 | 0xfffff, 0xffffffff)); }
for (var e = -330; e <= 310; e++) { check(Number('1e' + e)); check(Number('9.999999999999999e' + e)); check(Number('5e' + e)); }
for (var j = 0; j < 3000; j++) { check(j + 0.1); check(j % 10 + 0.1); check(j * 12345678 + 0.1); check(j / 7); check(j * 1e-9); }
var fixed = [0, -0, 0.1, 0.2, 0.3, 1/3, 2/3, 1e21, 1e-7, 1.5e-7, 123e-20, 999999999999999900000, 1e20, 123456789012345680000, 0.000001, 0.0000012345, 5e-324, 2.2250738585072014e-308, 2.225073858507201e-308, 1.7976931348623157e308, 9007199254740993, 4.35, 1.005, 100, 1e100, -1.25e-5, NaN, Infinity, -Infinity, 2**53, 2**64, 2**-1074, 0.1 + 0.2];
var out = [];
for (var k = 0; k < fixed.length; k++) { out.push(String(fixed[k]) + '/' + fixed[k].toExponential() + '/' + ('<' + fixed[k])); check(fixed[k]); }
var got = out.join(' ') + ' #' + count + ':' + (hash >>> 0).toString(16);
var expected = "0/0e+0/<0 0/0e+0/<0 0.1/1e-1/<0.1 0.2/2e-1/<0.2 0.3/3e-1/<0.3 0.3333333333333333/3.333333333333333e-1/<0.3333333333333333 0.6666666666666666/6.666666666666666e-1/<0.6666666666666666 1e+21/1e+21/<1e+21 1e-7/1e-7/<1e-7 1.5e-7/1.5e-7/<1.5e-7 1.23e-18/1.23e-18/<1.23e-18 999999999999999900000/9.999999999999999e+20/<999999999999999900000 100000000000000000000/1e+20/<100000000000000000000 123456789012345680000/1.2345678901234568e+20/<123456789012345680000 0.000001/1e-6/<0.000001 0.0000012345/1.2345e-6/<0.0000012345 5e-324/5e-324/<5e-324 2.2250738585072014e-308/2.2250738585072014e-308/<2.2250738585072014e-308 2.225073858507201e-308/2.225073858507201e-308/<2.225073858507201e-308 1.7976931348623157e+308/1.7976931348623157e+308/<1.7976931348623157e+308 9007199254740992/9.007199254740992e+15/<9007199254740992 4.35/4.35e+0/<4.35 1.005/1.005e+0/<1.005 100/1e+2/<100 1e+100/1e+100/<1e+100 -0.0000125/-1.25e-5/<-0.0000125 NaN/NaN/<NaN Infinity/Infinity/<Infinity -Infinity/-Infinity/<-Infinity 9007199254740992/9.007199254740992e+15/<9007199254740992 18446744073709552000/1.8446744073709552e+19/<18446744073709552000 5e-324/5e-324/<5e-324 0.30000000000000004/3.0000000000000004e-1/<0.30000000000000004 #63250:5e61af0e";
console.log(got === expected ? 'PASS shortest number text' : 'FAIL ' + got);
if (got !== expected) throw new Error('number text regressions');
