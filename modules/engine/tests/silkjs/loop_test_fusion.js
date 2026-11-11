// Loop tests fused with their step and their back edge: a loop's test is
// repeated at its bottom, a slot compared with a slot or a small constant
// answers in one instruction, and a stepped double that is an Int becomes one.
// Every shape must agree with the plain read, step, compare and branch.
const r = [];
function cmp(a, b, s) {
  var x = a, y = b, o = [];
  o.push(x < y, x <= y, x > y, x >= y, a < b, a <= b, a > b, a >= b, x < b, a > y, x < 3, x >= -2, a <= 100, a > 127, x < 1000, x >= -1000, a > 300, x <= 40000);
  if (x < y) o.push("lt"); else o.push("ge");
  var i = 0, n = 0; for (i = 0; i < b; i++) n += i; o.push(n);
  var j = b; do { n++; } while (--j > 0); o.push(n, j);
  j = b; while (j-- > 0) n += 2; o.push(n, j);
  j = 0; while (++j <= x) n += 3; o.push(n, j);
  j = 0; while (j++ < a) n += 5; o.push(n, j);
  while (--s >= 0) n++; o.push(n, s);
  while (s++ < 2) n++; o.push(n, s);
  for (j = y; j > 0; j--) n++; o.push(n, j);
  for (j = y; j >= x; j--) n++; o.push(n, j);
  for (j = 0; j <= 300; j++) n++; o.push(n, j);
  for (j = 400; j > 290; j--) n++; o.push(n, j);
  return o.join(",");
}
r.push(cmp(3, 5, 4), cmp(2.5, 7.5, 3.5), cmp("10", "9", "2"), cmp(NaN, 1, 2), cmp(-7, 3, 2));
r.push(cmp({ valueOf() { return 4; } }, 6, 3), cmp(5n, 3, 2n), cmp(undefined, null, 1), cmp(6 / 2, 2.5 * 2, 8 / 2));
function edge() { var m = 2147483646, c = 0; while (++m > 0 && c < 5) c++; var k = -2147483647; while (--k < 0 && c < 9) c++; var q = 2147483647; var t = q++ < q; return [m, k, c, q, t].join(","); }
r.push(edge());
function self(a) { var x = a; return [++x < x, x++ < x, --a > a, a-- > a, x, a].join(","); }
r.push(self(1));
function thrower(v) { var n = 0; try { while (v++ < 3) n++; } catch (e) { return e + ":" + n + ":" + typeof v; } return "none"; }
r.push(thrower({ valueOf() { throw "bad"; } }));
function many() { var a0 = 0, a1 = 0, a2 = 0, a3 = 0, a4 = 0, a5 = 0, a6 = 7, a7 = 9; var f = function () { return a2; }; var n = 0; while (a6 < a7) { a6++; n++; } return n + ":" + f(); }
r.push(many());
// Zeros keep their sign through a compacted bound or counter.
function zeros(z) { var j = z, n = 0; for (var i = 0; i < z; i++) n++; var d = -1.0 * 1; d++; var e = 1.5 - 0.5; e--; var f = -0.0; var g = 0; while (g < f) g++; return [1 / z, 1 / j, n, 1 / d, 1 / e, 1 / f, g].join(","); }
r.push(zeros(-0), zeros(0));
// Double counters and bounds: Ints in value step as Ints, others stay doubles.
function doubles(n) { var a = n * 2.5, c = 0, j; for (j = a; j > 0; j--) c++; var k = 0.5; while (k++ < a) c++; var big = 2147483646.0 + 0.5 - 0.5; big++; big++; var low = -2147483647.5 + 0.5; low--; low--; return [c, j, k, a, big, low, 1e300 > c, c < Infinity, c > -Infinity].join(","); }
r.push(doubles(4), doubles(3));
// continue, break, labels and closures over the loop variable.
function flow(n) {
  var o = [], i, j;
  for (i = 0; i < n; i++) { if (i == 2) continue; if (i == 5) break; o.push(i); }
  i = 0; while (i < n) { i++; if (i & 1) continue; o.push(-i); }
  outer: for (i = 0; i < 3; i++) for (j = 0; j < 3; j++) { if (j == 1) continue outer; if (i == 2) break outer; o.push(i * 10 + j); }
  var fs = []; for (let k = 0; k < 3; k++) fs.push(function () { return k; });
  for (let k = 3; k > 0; k--) fs.push(() => k);
  for (i = 0; i < fs.length; i++) o.push(fs[i]());
  for (i = 0; i < 0; i++) o.push("never"); while (n < 0) o.push("never");
  for (i = 0, j = 9; i < j; i++, j--) o.push(i + j);
  for (var p = 0; p < o.length && p < 3; p++) o[p]++;
  return o.join(",") + "|" + i + "," + j;
}
r.push(flow(8));
// A test with effects runs once per pass, in source order, and its exception
// keeps its line.
function effects() {
  var log = [], i = 0, lim = { get n() { log.push("g" + i); return 3; } };
  for (i = 0; i < lim.n; i++) log.push("b" + i);
  var a = [1, 2, 3], s = 0; for (i = 0; i < a.length; i++) { s += a[i]; if (i == 0) a.push(4); }
  var line = "";
  try {
    for (i = 0;
      i < undefinedName;
      i++) s++;
  } catch (e) { line = e.name; }
  return log.join("") + ":" + s + ":" + line;
}
r.push(effects());
function arguments_(n, m) { var c = 0; while (n-- > 0) c++; while (m < 3) { m++; c++; } arguments[1] = 0; while (m < 2) { m++; c += 10; } return c + "," + n + "," + m + "," + arguments[0]; }
r.push(arguments_(4, 1));
function generator() { function* g(n) { for (var i = 0; i < n; i++) yield i; var j = n; while (j-- > 0) yield -j; } return [...g(3)].join(","); }
r.push(generator());
const got = r.join(";");
const expected = "true,true,false,false,true,true,false,false,true,false,false,true,true,false,true,true,false,true,lt,10,15,0,25,-1,34,4,49,4,53,-1,56,3,61,0,64,2,365,301,475,290;true,true,false,false,true,true,false,false,true,false,true,true,true,false,true,true,false,true,lt,28,36,-0.5,52,-1.5,58,3,73,4,76,-0.5,79,3.5,87,-0.5,93,1.5,394,301,504,290;true,true,false,false,true,true,false,false,true,false,false,true,true,false,true,true,false,true,lt,36,45,0,63,-1,93,11,143,11,145,-1,148,3,157,0,158,8,459,301,569,290;false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,ge,0,1,0,3,-1,3,1,3,1,5,-1,8,3,9,0,9,1,310,301,420,290;true,true,false,false,true,true,false,false,true,false,true,false,true,false,true,true,false,true,lt,3,6,0,12,-1,12,1,12,1,14,-1,17,3,20,0,31,-8,332,301,442,290;true,true,false,false,true,true,false,false,true,false,false,true,true,false,true,true,false,true,lt,15,21,0,33,-1,45,5,65,5,68,-1,71,3,77,0,80,3,381,301,491,290;false,false,true,true,false,false,true,true,false,true,false,true,true,false,true,true,false,true,ge,3,6,0,12,-1,27,6,52,6,54,-1,57,3,60,0,60,3,361,301,471,290;false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,ge,0,1,-1,1,-1,1,1,1,1,2,-1,5,3,5,,5,,306,301,416,290;true,true,false,false,true,true,false,false,true,false,false,true,true,false,true,true,false,true,lt,10,15,0,25,-1,34,4,49,4,53,-1,56,3,61,0,64,2,365,301,475,290;2147483652,-2147483652,9,2147483648,true;false,true,false,true,3,-1;bad:0:object;2:0;-Infinity,-Infinity,0,Infinity,Infinity,-Infinity,0;Infinity,Infinity,0,Infinity,Infinity,-Infinity,0;20,0,11.5,10,2147483648,-2147483649,true,true,true;15,-0.5,8.5,7.5,2147483648,-2147483649,true,true,true;1,2,4,4,-2,-4,-6,-8,0,10,0,1,2,3,2,1,9,9,9,9,9|5,4;g0b0g1b1g2b2g3:10:ReferenceError;26,-1,2,-1;0,1,2,-2,-1,0";
console.log(got === expected ? 'PASS loop test fusion' : 'FAIL ' + got);
if (got !== expected) throw new Error('loop test fusion regressions');
