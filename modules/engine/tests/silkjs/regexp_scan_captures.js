// SilkJS regression test: literal and single-unit searches over long Latin-1 and UTF-16
// subjects (the vectorized scan with hits at every lane), and exec/replace results with 10 to
// 13 captures, around the inline capture limit. Expected values come from V8.
var r = [];
var out = [];
function h(s){ var x=0; for (var i=0;i<s.length;i++) x=(x*31+s.charCodeAt(i))|0; return x; }
for (var n = 0; n < 70; n++) {
  for (var pos = 0; pos < n; pos += 3) {
    var a = []; for (var i = 0; i < n; i++) a.push(String.fromCharCode(97 + (i * 7) % 5));
    a[pos] = 'Z'; if (pos + 1 < n) a[pos+1] = 'Q';
    var s = a.join('');
    var w = s + 'ā';
    out.push(s.search(/ZQ/), w.search(/ZQ/), s.replace(/Z/g, '-').length, w.replace(/ZQ/g, '').length,
      (/ZQ/.exec(s) || [-1]).index, s.indexOf('Z'), /a+ZQ/.test(s), /ZQ/i.exec(w) ? 1 : 0);
  }
}
r.push(h(out.join(',')), out.length);
var r12 = /(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)/, r13 = /(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)(l)/, r10 = /(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)/;
var t = 'xxabcdefghijklmn';
r.push(JSON.stringify(r12.exec(t)), JSON.stringify(r13.exec(t)), JSON.stringify(r10.exec(t)));
r.push(JSON.stringify(/(a)|(b)(c)?(d)?(e)?(f)?(g)?(h)?(i)?(j)?(k)?/.exec('b')), t.replace(r12, '$11$1'), t.replace(r13, '[$12]'));
const got = r.join('\n');
const expected = "1035013064\n6624\n[\"abcdefghijk\",\"a\",\"b\",\"c\",\"d\",\"e\",\"f\",\"g\",\"h\",\"i\",\"j\",\"k\"]\n[\"abcdefghijkl\",\"a\",\"b\",\"c\",\"d\",\"e\",\"f\",\"g\",\"h\",\"i\",\"j\",\"k\",\"l\"]\n[\"abcdefghij\",\"a\",\"b\",\"c\",\"d\",\"e\",\"f\",\"g\",\"h\",\"i\",\"j\"]\n[\"b\",null,\"b\",null,null,null,null,null,null,null,null,null]\nxxkalmn\nxx[l]mn";
console.log(got === expected ? 'PASS regexp scan and captures' : 'FAIL ' + JSON.stringify(got));
if (got !== expected) throw new Error('regexp scan and capture regressions');
