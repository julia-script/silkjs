// SilkJS regression test for the property/collection fast paths: the natural
// merge sort behind the default string sort, `global = value;` statements
// compiled to a bare put_var, and object spread's block slot copy.
// Expected values come from V8.
var out = [];
function h(a) { var x = 0; for (var i = 0; i < a.length; i++) { var s = String(a[i]); for (var j = 0; j < s.length; j++) x = (x * 31 + s.charCodeAt(j) + i) | 0; } return x; }
var seed = 7; function rnd(n) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; }
var shapes = [function (i, n) { return rnd(n); }, function (i) { return i; }, function (i, n) { return n - i; },
  function () { return 0; }, function (i) { return (i & 1) * i; }, function (i) { return i ^ 1; },
  function (i, n) { return i % (n >> 4 || 1); }, function (i, n) { return i == n >> 2 ? n : i; }, function (i, n) { return rnd(3); }];
[0, 1, 2, 7, 31, 32, 33, 65, 300, 2000].forEach(function (n) {
  shapes.forEach(function (f, k) {
    var a = []; for (var i = 0; i < n; i++) a.push(String(f(i, n)) + (k == 8 ? 'aaaaaaaaaa' : ''));
    a.sort(); out.push(n + '/' + k + ':' + h(a));
  });
});
var dup = ['b', 'a', 'b' + '', 'a', 'c', 'abcdefghij', 'abcdefghi', 'abcdefghij' + 'k', 'abcdefgh\u0000'];
dup.sort(); out.push(JSON.stringify(dup));
var mixed = ['一', 'b', 'aé', 'é', 'a']; mixed.sort(); out.push(mixed.join(','));
var holes = ['b', , 'a', undefined, 'c']; holes.sort(); out.push(holes.length + ':' + holes.join(','), 1 in holes, 4 in holes);
var nums = [10, 9, 1, 100, 2]; nums.sort(); out.push(nums.join(','));
var g1, g2;
function writes() { for (var i = 0; i < 5; i++) { g1 = i; g2 = 'v' + i; g1 = g1 + 1; } return g1 + g2; }
out.push(writes(), g1, g2);
function strictWrite() { 'use strict'; try { undeclaredGlobal = 1; return 'no throw'; } catch (e) { return e.name; } }
out.push(strictWrite(), typeof undeclaredGlobal);
function sloppyWrite() { createdGlobal = 3; return createdGlobal; }
out.push(sloppyWrite(), globalThis.createdGlobal);
var src = { a: 1, b: 'two', c: { d: 4 }, e: [5], f: 6.5 };
var copies = []; for (var i = 0; i < 3; i++) copies.push({ ...src });
copies[0].a = 9; copies[1].c.d = 8; delete copies[2].b;
out.push(JSON.stringify(src), JSON.stringify(copies), copies[0].c === src.c, Object.keys(copies[2]).join());
var big = {}; for (var i = 0; i < 40; i++) big['k' + i] = 'v' + i; var bigCopy = { ...big }; out.push(Object.keys(bigCopy).length, bigCopy.k39, JSON.stringify(bigCopy) === JSON.stringify(big));
const got = out.join('|');
const expected = '0/0:0|0/1:0|0/2:0|0/3:0|0/4:0|0/5:0|0/6:0|0/7:0|0/8:0|1/0:48|1/1:48|1/2:49|1/3:48|1/4:48|1/5:49|1/6:48|1/7:49|1/8:-1153666864|2/0:1537|2/1:1538|2/2:1570|2/3:1537|2/4:1538|2/5:1538|2/6:1537|2/7:1570|2/8:-838689759|7/0:1130694453|7/1:1131648758|7/2:2048735895|7/3:1101079187|7/4:1101080246|7/5:1131648759|7/6:1101079187|7/7:1161232214|7/8:-961215533|31/0:-393570534|31/1:1343307643|31/2:-255197432|31/3:418006047|31/4:-1572467550|31/5:-2064155972|31/6:418006047|31/7:1954319039|31/8:-713188864|32/0:1708097013|32/1:454347161|32/2:-1518201561|32/3:73285648|32/4:685114981|32/5:454347161|32/6:-740597488|32/7:194976994|32/8:1414406289|33/0:1310781233|33/1:1749319576|33/2:1098078951|33/3:-2023112128|33/4:1144105366|33/5:-1658144039|33/6:1457972032|33/7:1713045347|33/8:853758722|65/0:1573172101|65/1:253004454|65/2:-1467120233|65/3:-674266032|65/4:-613908690|65/5:253034245|65/6:-415872432|65/7:-788440285|65/8:-1540224750|300/0:-776557470|300/1:158172401|300/2:773276643|300/3:1406902422|300/4:-1465634282|300/5:158172401|300/6:1352913081|300/7:-506776299|300/8:217363735|2000/0:1547548761|2000/1:483345793|2000/2:560174094|2000/3:-333831192|2000/4:2090816006|2000/5:483345793|2000/6:-520221368|2000/7:1205313021|2000/8:-804652342|["a","a","abcdefgh\\u0000","abcdefghi","abcdefghij","abcdefghijk","b","b","c"]|a,aé,b,é,一|5:a,b,c,,|true|false|1,10,100,2,9|5v4|5|v4|ReferenceError|undefined|3|3|{"a":1,"b":"two","c":{"d":8},"e":[5],"f":6.5}|[{"a":9,"b":"two","c":{"d":8},"e":[5],"f":6.5},{"a":1,"b":"two","c":{"d":8},"e":[5],"f":6.5},{"a":1,"c":{"d":8},"e":[5],"f":6.5}]|true|a,c,e,f|40|v39|true';
console.log(got === expected ? 'PASS property collection fast paths' : 'FAIL ' + got);
if (got !== expected) throw new Error('property collection fast path regressions');
