// SilkJS regression test for small BigInt products and sums (the paired
// 64-bit multiply and results written straight into the cell). Expected
// values come from C QuickJS.
var out = [];
var seed = 12345;
function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; }
function big(bits) {
  var v = 0n; for (var i = 0; i < bits; i += 16) v = (v << 16n) | BigInt(rnd() & 0xffff);
  v = v & ((1n << BigInt(bits)) - 1n); if (rnd() & 1) v = -v; return v;
}
var h = 0n;
for (var bits = 1; bits <= 600; bits += (bits < 140 ? 1 : 17)) {
  for (var k = 0; k < 4; k++) {
    var a = big(bits), b = big((bits * 7 + k * 13) % 520 + 1);
    var p = a * b, s = a + b, d = a - b;
    h = (h * 1000003n + p + 3n * s + 7n * d) % ((1n << 255n) - 19n);
    if (k == 0 && bits % 40 == 1) out.push(p.toString(16));
  }
}
var e = [0n, 1n, -1n, (1n << 31n), -(1n << 31n), (1n << 32n) - 1n, (1n << 63n), -(1n << 63n), (1n << 64n) - 1n, (1n << 127n) + 5n, -(1n << 128n), (1n << 319n), (1n << 320n) - 1n, -((1n << 320n) - 1n), (1n << 511n) - 3n];
for (var i = 0; i < e.length; i++) for (var j = 0; j < e.length; j++) { h = (h * 31n + e[i] * e[j] + e[i] + e[j] - e[i] - e[j] * 2n) % ((1n << 255n) - 19n); }
out.push(h.toString(36));
const got = out.join('|');
const expected = '0|3901d30ff1f4173788733eb6d9f7b23a09d79a2aad3928d78d256301300dcaefbb04e7052080000|28e53e17205d9f9135e9daf96f878000|29448d8c430c61f0fa7df56bb07a18d9d98ade9ed79eb1346b60bbe67194c98dd7554c2b92f2a904c401816789c6b1c01434290cbe8000|59951759bcccce2525dc3de9408483656245cca635060ae63cc63a3d8e1ad0b0ea082acfdd7ee2ce82104c4683f45b417ed62b993891045c5dc6e9b02a939d5a64b96bfef78b0afa8115b579bcdb23d7aa06df340b499efb306bc0273f1f50b81c3cc000|6lfna72gzv70d08cr8or56xdxjfrugwpcqceypcji95zj7sn8';
console.log(got === expected ? 'PASS bigint small arithmetic' : 'FAIL ' + got);
if (got !== expected) throw new Error('bigint small arithmetic regressions');
// x += y into a BigInt only the local holds must not change other holders.
var aliasOut = [];
var x = (1n << 100n) + 7n; var y = x; x += 1n; aliasOut.push(String(y - x));
var z = (1n << 100n); z += z; aliasOut.push(String(z));
var m = new Map(); var k = (1n << 90n); m.set('k', k); k += 5n; aliasOut.push(String(m.get('k')), String(k));
var arr = [(1n << 80n)]; var w = arr[0]; w += 3n; aliasOut.push(String(arr[0]), String(w));
function f() { var c = (1n << 70n); var g = function () { return c; }; c += 1n; return [g(), c]; } aliasOut.push(String(f()));
var s = (1n << 200n); for (var i = 0; i < 5; i++) s += -(1n << 199n); aliasOut.push(String(s));
var t = (1n << 100n) * 3n; var u = t; t += -t; aliasOut.push(String(t), String(u));
var big = (1n << 400n); var bb = big; big += 1n; aliasOut.push(String(bb === big), String(big - bb));
var q = (1n << 64n) + 1n; q += -(1n << 64n); aliasOut.push(String(q), typeof q);
const aliasGot = aliasOut.join('|');
const aliasExpected = '-1|2535301200456458802993406410752|1237940039285380274899124224|1237940039285380274899124229|1208925819614629174706176|1208925819614629174706179|1180591620717411303425,1180591620717411303425|-2410407066388485413312943138511743903783304490674189252952064|0|3802951800684688204490109616128|false|1|1|bigint';
console.log(aliasGot === aliasExpected ? 'PASS bigint in-place sums' : 'FAIL ' + aliasGot);
if (aliasGot !== aliasExpected) throw new Error('bigint in-place sum regressions');
