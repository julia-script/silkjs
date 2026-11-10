// SilkJS regression test for in-place prepends (s = piece + s growing a flat
// buffer at its front, and a rope's left leaf), the short decimal string parse
// ("12345.6" in arithmetic and Number()), and number + string joins. Expected
// values come from V8.
var out = [];
function h(s) { var x = 0; for (var i = 0; i < s.length; i++) x = (Math.imul(x, 31) + s.charCodeAt(i)) | 0; return s.length + ':' + x; }
var r = ''; for (var i = 0; i < 3000; i++) r = (i % 10) + r; out.push(h(r), r.slice(0, 12), r.charAt(2999));
var a = ''; var keep = []; for (var i = 0; i < 600; i++) { if (i % 97 == 0) keep.push(a); a = 'ab' + a; } out.push(h(a), keep.map(h).join());
var w = 'x'; for (var i = 0; i < 50; i++) w = (i == 25 ? 'é一' : 'y') + w; out.push(h(w), w.length, w.indexOf('一'));
var big = ''; for (var i = 0; i < 20000; i++) big = 'abcdef' + big; out.push(h(big), big.substr(119990));
var t = ''; for (var i = 0; i < 12000; i++) { t = String.fromCharCode(97 + i % 26) + t; if (i == 9000) out.push(h(t)); } out.push(h(t), t[0], t[11999]);
var p = 'tail'; for (var i = 0; i < 100; i++) { var q = p; p = '<' + p; if (q === p) out.push('alias'); } out.push(p.length, h(p));
function arg(s) { for (var i = 0; i < 400; i++) s = '-' + s; return s; } out.push(h(arg('end')));
var nums = ['12345', '12345.6', '.5', '5.', '.', '1.2.3', '0012.50', '123456789012345', '1234567890123456', '12345678901234567', '-1.5', '1e3', ' 7', '7 ', '0x1f', '', '00', '999999999', '9999999999', '0.000000000000001', '123456789.12345', '1.000000000000005'];
for (var k = 0; k < nums.length; k++) { var s = nums[k]; out.push((s | 0) + '/' + (s - 0) + '/' + (s * 2) + '/' + Number(s) + '/' + (s < 10) + '/' + (3 - s)); }
var f = [0.1, -2.5, 1e21, 1.5e-7, -0, NaN, Infinity, 123.456, 2**53 + 2];
for (var k = 0; k < f.length; k++) { var v = f[k]; out.push(v + 'u', 'u' + v, v + '', '' + v, (v + 'tail').length); }
var long = 'q'.repeat(700); out.push(h(0.25 + long), h(long + 1.75));
var got = out.join('|');
var expected = "3000:-1942750684|987654321098|0|1200:-910843816|0:0,194:102648961,388:-1158421310,582:-207431485,776:-611764092,970:-1254026235,1164:1537243974|52:-468697706|52|25|120000:-1867785632|cdefabcdef|9001:-2135437935|12000:2090064208|n|a|104|104:120146768|403:-1055038501|12345/12345/24690/12345/false/-12342|12345/12345.6/24691.2/12345.6/false/-12342.6|0/0.5/1/0.5/true/2.5|5/5/10/5/true/-2|0/NaN/NaN/NaN/false/NaN|0/NaN/NaN/NaN/false/NaN|12/12.5/25/12.5/false/-9.5|-2045911175/123456789012345/246913578024690/123456789012345/false/-123456789012342|1015724736/1234567890123456/2469135780246912/1234567890123456/false/-1234567890123453|1567312776/12345678901234568/24691357802469136/12345678901234568/false/-12345678901234564|-1/-1.5/-3/-1.5/true/4.5|1000/1000/2000/1000/false/-997|7/7/14/7/true/-4|7/7/14/7/true/-4|31/31/62/31/false/-28|0/0/0/0/true/3|0/0/0/0/true/3|999999999/999999999/1999999998/999999999/false/-999999996|1410065407/9999999999/19999999998/9999999999/false/-9999999996|0/1e-15/2e-15/1e-15/true/2.999999999999999|123456789/123456789.12345/246913578.2469/123456789.12345/false/-123456786.12345|1/1.000000000000005/2.00000000000001/1.000000000000005/true/1.999999999999995|0.1u|u0.1|0.1|0.1|7|-2.5u|u-2.5|-2.5|-2.5|8|1e+21u|u1e+21|1e+21|1e+21|9|1.5e-7u|u1.5e-7|1.5e-7|1.5e-7|10|0u|u0|0|0|5|NaNu|uNaN|NaN|NaN|7|Infinityu|uInfinity|Infinity|Infinity|12|123.456u|u123.456|123.456|123.456|11|9007199254740994u|u9007199254740994|9007199254740994|9007199254740994|20|704:1520626945|704:1077596539";
console.log(got === expected ? 'PASS string prepends and short decimals' : 'FAIL ' + got);
if (got !== expected) throw new Error('string prepend regressions');
