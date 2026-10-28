// SilkJS regression test: native callers (sort, map, forEach, reduce, call)
// lend their argument cells to callees that never write a parameter. Callees
// that do write, alias or capture parameters must still get private copies.
const out = [];
const base = [5, 3, 9, 1, 7];
const sortWrites = base.slice().sort((a, b) => { a = a - b; b = 0; return a; });
out.push(sortWrites.join());
const sortArguments = base.slice().sort(function (a, b) { arguments[0] = 100; return a - b; });
out.push(sortArguments.join());
const sortEval = base.slice().sort(function (a, b) { eval("a = 0"); return a - b; });
out.push(sortEval.length);
const kept = [];
base.forEach((x, i, arr) => { kept.push(() => x + i); x = -1; i = -1; arr = null; });
out.push(kept.map((f) => f()).join());
const objects = [{ v: 2 }, { v: 1 }];
objects.sort((p, q) => p.v - q.v);
out.push(objects.map((o) => o.v).join());
out.push(base.map((x) => { x = x * 2; return x; }).join(), base.join());
out.push(base.reduce((acc, x) => { acc += x; return acc; }, 0));
function plain(a, b) { return a + b; }
out.push(plain.call(null, 1, 2), plain.apply(null, [3]), plain.call(null, "x", "y", "z"));
function rest(a, ...more) { return a + more.length; }
out.push([1].map(rest).join(), rest.call(null, 1, 2, 3));
const strings = ["b", "a", "c"].map((s) => s + "!");
out.push(strings.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)).join());
const got = JSON.stringify(out);
const expected = '["1,3,5,7,9","7,1,9,3,5",5,"-2,-2,-2,-2,-2","1,2","10,6,18,2,14","5,3,9,1,7",25,3,null,"xy","3",3,"a!,b!,c!"]';
console.log(got === expected ? 'PASS borrowed arguments' : 'FAIL ' + got);
if (got !== expected) throw new Error('borrowed argument regressions');
