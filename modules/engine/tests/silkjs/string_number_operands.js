// SilkJS regression test for the numeric-operator shortcut that converts a flat
// ASCII string operand in place ("12345" | 0), and for parseNumber's plain digit
// fast path. Every operator and comparison runs against ropes, wide, non-ASCII,
// signed, prefixed and malformed strings. Expected values come from C QuickJS.
function show(v){ return Object.is(v,-0) ? '-0' : typeof v === 'bigint' ? v+'n' : String(v); }
var out=[];
var strs=["12345","007","","  12 ","-5","1e3","0x1f","12a","é","٣","1.5","-0","Infinity","9007199254740993", "4294967296"];
var rope = "12" + String(Math.floor(3.5)) + "45"; strs.push(rope);
var nums=[3, -2, 0.5, -0];
for (var s of strs) for (var n of nums) {
  out.push(show(s|n), show(n|s), show(s-n), show(n-s), show(s*n), show(s/n), show(s%n), show(n**s===n**s), show(s&n), show(s^n), show(s<<n), show(s>>n), show(s>>>n),
           show(s<n), show(n<s), show(s<=n), show(s>n), show(s>=n), show(s==n), show(n!=s), show(s===n));
}
out.push(show("5"+3), show(3+"5"), show("3"<"10"), show({valueOf(){out.push('vo');return 2}} * "3"), show("2" * {valueOf(){out.push('v2');return 4}}));
try { out.push(show("1" - 1n)); } catch(e) { out.push(e.name); }
out.push(show("10" == 10n), show(Symbol.iterator ? 1 : 0));
try { out.push(show(Symbol() * "1")); } catch(e) { out.push(e.name); }
const got = out.join();
let hash = 0; for (let i = 0; i < got.length; i++) hash = (hash * 31 + got.charCodeAt(i)) | 0;
const summary = out.length + ':' + hash + ':' + got.slice(0, 60);
const expected = '1355:886493422:12347,12347,12342,-12342,37035,4115,0,true,1,12346,98760,154';
console.log(summary === expected ? 'PASS string number operands' : 'FAIL ' + summary);
if (summary !== expected) throw new Error('string number operand regressions');
