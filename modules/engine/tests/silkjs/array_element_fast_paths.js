// Indexed reads and writes on fast arrays take an inline path in the interpreter loop;
// everything outside it (holes, out of range, frozen, getters, non-arrays) must not.
function assert(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}
var a = [1.5, 2, "three", { four: 4 }];
assert(a[0], 1.5, "read float");
assert(a[2], "three", "read string");
assert(a[3].four, 4, "read object");
assert(a[4], undefined, "read past the end");
assert(a[-1], undefined, "negative index");
a[1] = { replaced: true };
a[1] = "again";
assert(a[1], "again", "overwrite releases the old element");
a[4] = 5;
assert(a.length, 5, "append extends");
var frozen = Object.freeze([1, 2, 3]);
frozen[0] = 9;
assert(frozen[0], 1, "frozen array ignores sloppy writes");
assert((function () { "use strict"; try { frozen[1] = 9; return "no"; } catch (e) { return e instanceof TypeError; } })(), true, "frozen array throws in strict mode");
var getter = [0, 1];
Object.defineProperty(getter, 0, { get() { return "got"; } });
assert(getter[0], "got", "accessor element");
var proto = [7];
var sub = Object.create(proto);
assert(sub[0], 7, "inherited element on a non-array");
var arr = new Array(3);
assert(arr[1], undefined, "hole");
arr[1] = 4;
assert(arr[1], 4, "fill hole");
var sum = 0, grid = [];
for (var i = 0; i < 100; i++) grid.push(i * 0.5);
for (var r = 0; r < 10; r++) for (var i = 1; i < 99; i++) { grid[i] = (grid[i - 1] + grid[i + 1]) / 2; }
for (var i = 0; i < 100; i++) sum += grid[i];
assert(sum.toFixed(6), "2475.000000", "relaxation sum");
var keep = [];
(function () { var t = [{ v: 1 }]; keep.push(t[0]); t[0] = null; })();
assert(keep[0].v, 1, "element outlives its array slot");
assert([10, 20, 30][1], 20, "temporary array read");
