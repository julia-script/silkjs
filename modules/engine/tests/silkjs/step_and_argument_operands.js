// x++, ++x, x-- and --x with the value used, on locals and arguments; a[i] and
// + - * with argument operands; shifts by a constant. Every shape must agree
// with the plain get, operator and put sequence, off the Int fast path too.
const r = [];
function steps(a, n, s) {
  var i = 0, t = 0, x;
  while (--n >= 0) { t += a[i++] << 2; t = t + n; t = t - s; t = t * s; x = a[n] + a[i]; }
  var q = "5"; var p0 = q++; var p1 = ++q;
  var o = { valueOf() { return 41; } }; var p2 = o++;
  s++; --s; var z = s--;
  var big = 2147483647; var b0 = big++; var m = -2147483648; var m0 = --m;
  var fl = 1.5; var f1 = fl++; var f2 = --fl;
  var bi = 10n; var g1 = bi++; var g2 = ++bi;
  var und; var u1 = und++;
  return [t, x, p0, p1, q, p2, o, z, s, b0, big, m0, m, f1, f2, fl, String(g1), String(g2), String(bi), u1, und, n, i].join(",");
}
r.push(steps([1, 2, 3, 4, 5], 4, 1));
function operands(a, i, j) {
  var k = "x";
  return [a[i], a[j] + i, a[i] - j, a[i] * j, k + i, i + k, a[i++], i, a[--j], j, 1 << 31, (j << 3) + 1, "3" << 2, 1.5 << 1, k << 2].join(",");
}
r.push(operands([10, 20, 30, 40], 1, 3));
// Arguments stepped in place stay in step with a mapped arguments object.
function mapped(x) { arguments[0]++; x++; return x-- + "," + arguments[0] + "," + (++x) + "," + arguments[0]; }
r.push(mapped(5));
// A caller's values are not written through a callee's stepped arguments.
function callee(n, i) { while (n-- > 0) i++; return i + n; }
function caller() { var a = 3, b = 10; var got = callee(a, b); return [got, a, b].join(","); }
r.push(caller());
// Captured locals and arguments.
function captured(n) { var c = 0; var read = function () { return c + ":" + n; }; var got = [c++, ++c, n--, --n]; return got.join(",") + "|" + read(); }
r.push(captured(7));
// A step whose conversion throws leaves the slot as it was.
function throwing(v) {
  var seen = "";
  try { var w = v++; seen = "no"; } catch (e) { seen = String(e) + ":" + typeof v; }
  var local = v;
  try { local--; seen += "|no"; } catch (e) { seen += "|" + typeof local; }
  return seen;
}
r.push(throwing({ valueOf() { throw "bad"; } }));
// Symbols and strings as operands take the operators' own paths.
function texts(a, b) { return [a + b, "p" + b, a - b, a * b].join(","); }
r.push(texts("4", "2"), texts(4, 2.5), texts(2147483647, 2147483647), texts(-0, 0));
// Element reads through arguments: strings, holes, getters and typed arrays.
function element(a, i) { return a[i]; }
function scaled(a, i, k) { var t = a; return t[i] * 2 + k; }
var getter = { get 1() { return "g"; } };
r.push(element("abc", 1), element([1, , 3], 1), element(getter, 1), element(new Uint8Array([7, 8]), 1), element([5], "length"),
  scaled([1, 2, 3], 2, 10), scaled(new Float64Array([0.5]), 0, 1));
// Generators keep stepped locals and arguments across yields.
function* counting(n) { var i = 0; while (n-- > 0) yield i++ + ":" + n; }
r.push([...counting(3)].join(","));
// Zero products and the Int range's edges.
function products(a, b) { var x = a; return [x * b, x + b, x - b].map(function (v) { return Object.is(v, -0) ? "-0" : String(v); }).join(","); }
r.push(products(-1, 0), products(65536, 65536), products(-2147483648, 1), products(2147483647, 1));
const got = r.join(";");
const expected = '42,6,5,7,7,41,42,1,0,2147483647,2147483648,-2147483649,-2147483649,1.5,1.5,1.5,10,12,12,NaN,NaN,-1,4;20,41,17,60,x1,1x,20,2,30,2,-2147483648,17,12,2,0;7,6,7,7;12,3,10;0,2,7,5|2:5;bad:object|object;42,p2,2,8;6.5,p2.5,1.5,10;4294967294,p2147483647,0,4611686014132420600;0,p0,0,0;b;;g;8;1;16;2;0:2,1:1,2:0;-0,-1,-1;4294967296,131072,0;-2147483648,-2147483647,-2147483649;2147483647,2147483648,2147483646';
console.log(got === expected ? 'PASS step and argument operands' : 'FAIL ' + got);
if (got !== expected) throw new Error('step and argument operand regressions');
