// SilkJS regression test for String.fromCharCode(code) answered in the
// dispatch loop from the one-unit string cache: cached and wide codes, wrap
// at 65536, non-integer and missing arguments, a replaced method and a bound
// receiver. Expected values come from C QuickJS.
var r = [];
var s = '';
for (var i = 60; i < 70; i++) s += String.fromCharCode(i);
r.push(s, String.fromCharCode(255).length, String.fromCharCode(256).charCodeAt(0), String.fromCharCode(0x4e2d));
r.push(String.fromCharCode(65536 + 66), String.fromCharCode(-1).charCodeAt(0), String.fromCharCode(65.7), String.fromCharCode('67'));
r.push(String.fromCharCode().length, String.fromCharCode(72, 105));
var f = { fromCharCode: String.fromCharCode }; r.push(f.fromCharCode(74));
var saved = String.fromCharCode;
String.fromCharCode = function (c) { return 'own' + c };
r.push(String.fromCharCode(75));
String.fromCharCode = saved;
r.push(String.fromCharCode(76) === 'L', typeof String.fromCharCode(77));
const got = r.join();
const expected = '<=>?@ABCDE,1,256,中,B,65535,A,C,0,Hi,J,own75,true,string';
if (got !== expected) throw new Error('fromCharCode: got ' + got);
print('ok');
