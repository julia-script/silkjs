// SilkJS regression test for x = x op y on a heap BigInt local written into
// x's own cell: aliases of the old value keep it, x * x and shared values are
// not overwritten, and both sum, difference and product forms. Expected
// values come from node.
function run() {
  var r = [];
  var a = 2n ** 100n, keep = a;
  a = a + 7n;
  r.push(a - keep, keep === 2n ** 100n);
  var s = 2n ** 200n;
  for (var i = 0; i < 4; i++) { s = s + (2n ** 70n) * 3n; }
  r.push(s.toString(16));
  var d = 2n ** 150n;
  for (var j = 0; j < 3; j++) { d = d - 2n ** 90n; }
  r.push(d.toString(36));
  var m = 2n ** 64n + 5n;
  m = m * 3n; r.push(m);
  var q = 2n ** 80n + 1n; q = q * q; r.push(q.toString(16));
  var arr = [2n ** 96n]; var v = arr[0]; v = v + 1n; r.push(arr[0] === 2n ** 96n, v - arr[0]);
  var n = -(2n ** 100n); n = n - 1n; r.push(n);
  return r.join();
}
const got = run();
const expected = '7,true,100000000000000000000000000000003000000000000000000,11uhgyodt997jftbxd23cb28h8jrwg,55340232221128654863,10000000000000000000200000000000000000001,true,1,-1267650600228229401496703205377';
if (got !== expected) throw new Error('bigint store back: got ' + got);
console.log('ok');
