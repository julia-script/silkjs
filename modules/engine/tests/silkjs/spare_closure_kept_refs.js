// Recycled closures keep the cells they inherit from their creating closure
// (js_gc.parkClosure, js_closures.keptReferences): loop2 captures the globals G
// and H through loop1, and must see their current values after reuse.
// Expected values come from node.
var G = "g"; var H = [1, 2];
var make = function (tag, j, states) {
  var loop1 = function (l1, l2) {
    var total = 0; var l1; var l2;
    while (true) {
      if (l1 > 0) {
        var loop2 = function (k, l2) { var k; var l2; return tag + states[j] + k + l1 + l2 + G + H.length; };
        total += loop2(l1, l2).length; l1--;
      } else return total;
    }
  };
  return loop1(3, 'x') + ':' + loop1(2, 'yy');
};
var out = [];
for (var round = 0; round < 50; round++) { if (round == 25) { G = "gg"; H = [3]; } out.push(make('a', round % 3, ['p', 'qq', 'rrr'])); out.push(make('bb', 1, ['s', 't'])); }

var got = out.join();
var expected = '21:16,24:18,24:18,24:18,27:20,24:18,21:16,24:18,24:18,24:18,27:20,24:18,21:16,24:18,24:18,24:18,27:20,24:18,21:16,24:18,24:18,24:18,27:20,24:18,21:16,24:18,24:18,24:18,27:20,24:18,21:16,24:18,24:18,24:18,27:20,24:18,21:16,24:18,24:18,24:18,27:20,24:18,21:16,24:18,24:18,24:18,27:20,24:18,21:16,24:18,27:20,27:20,30:22,27:20,24:18,27:20,27:20,27:20,30:22,27:20,24:18,27:20,27:20,27:20,30:22,27:20,24:18,27:20,27:20,27:20,30:22,27:20,24:18,27:20,27:20,27:20,30:22,27:20,24:18,27:20,27:20,27:20,30:22,27:20,24:18,27:20,27:20,27:20,30:22,27:20,24:18,27:20,27:20,27:20,30:22,27:20,24:18,27:20,27:20,27:20';
console.log(got === expected ? 'PASS spare closure kept refs' : 'FAIL ' + got);
if (got !== expected) throw new Error('spare closure kept refs regressions');
