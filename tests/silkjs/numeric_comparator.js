// SilkJS regression test: sort computes `(a, b) => a - b` and `(a, b) => b - a`
// itself for number pairs. Results must match calling the comparator, and any
// other operand (strings, objects with valueOf, BigInt) must still call it.
const out = [];
const nums = [5, -0, 3.5, NaN, 0, -7, Infinity, 2, -Infinity, 3.5, 1e300, -1e-300];
out.push(nums.slice().sort((a, b) => a - b).map(String).join());
out.push(nums.slice().sort((a, b) => b - a).map(String).join());
out.push(nums.slice().sort(function (x, y) { return x - y; }).map(String).join());
out.push([2147483647, -2147483648, 0, 1].sort((a, b) => a - b).join());
out.push(["10", "9", 1, "2"].sort((a, b) => a - b).join());
let calls = 0;
const boxed = [3, 1, 2].map((v) => ({ valueOf() { calls++; return v; } }));
out.push(boxed.sort((a, b) => a - b).map(Number).join(), calls > 0);
const stable = [[1, "a"], [0, "b"], [1, "c"], [0, "d"]];
out.push(stable.map((p) => p[0]).sort((a, b) => a - b).join());
const keyed = stable.slice().sort((p, q) => p[0] - q[0]);
out.push(keyed.map((p) => p[1]).join());
try { [1n, 2].sort((a, b) => a - b); out.push("no throw"); } catch (e) { out.push(e instanceof TypeError); }
try { [3n, 1n, 2n].sort((a, b) => a - b); out.push("no throw"); } catch (e) { out.push(e.name); }
const typed = new Float64Array([3, NaN, -1, 2]);
out.push(Array.prototype.slice.call(typed).sort((a, b) => b - a).map(String).join());
const got = JSON.stringify(out);
const expected = '["-7,-1e-300,0,NaN,-Infinity,0,2,3.5,3.5,5,1e+300,Infinity","NaN,Infinity,1e+300,5,3.5,3.5,2,0,0,-1e-300,-7,-Infinity","-7,-1e-300,0,NaN,-Infinity,0,2,3.5,3.5,5,1e+300,Infinity","-2147483648,0,1,2147483647","1,2,9,10","1,2,3",true,"0,0,1,1","b,d,a,c",true,"TypeError","3,NaN,2,-1"]';
console.log(got === expected ? 'PASS numeric comparator' : 'FAIL ' + got);
if (got !== expected) throw new Error('numeric comparator regressions');
