// `x += global` folded into add_loc, and `s | 0` style bitwise ops on numeric text.
var gnum = 3, gtext = "ab", gfloat = 0.5;
let failures = 0;
function check(got, want, label) { if (got !== want) { failures++; console.log("FAIL", label, got, want); } }

function sums(n) { var s = 0; for (var i = 0; i < n; i++) { s += gnum; s += gfloat; } return s; }
function texts() { var s = "x"; s += gtext; s += gnum; return s; }
function missing() { var s = 1; try { s += notDeclaredAnywhere; } catch (e) { return s + ":" + e.name; } return "no throw"; }
// A getter that writes a captured x: x is read before the getter runs.
function captured() {
  var x = 1;
  Object.defineProperty(globalThis, "writesX", { get() { x = 100; return 1; }, configurable: true });
  x += writesX;
  return x;
}
var calls = 0;
Object.defineProperty(globalThis, "counted", { get() { calls++; return 2; }, configurable: true });
function getterSum() { var s = 0; s += counted; s += counted; return s; }

for (let k = 0; k < 200; k++) {
  check(sums(4), 14, "sums");
  check(texts(), "xab3", "texts");
}
check(missing(), "1:ReferenceError", "missing");
check(captured(), 2, "captured");
check(getterSum(), 4, "getter sum");
check(calls, 2, "getter calls");

function bitwise(s, n) { return [s | 0, s & n, n ^ s, s | n, n | s, s << 1, s >> 1, s >>> 0]; }
for (let k = 0; k < 200; k++) {
  check(JSON.stringify(bitwise("12345", 6)), JSON.stringify([12345, 0, 12351, 12351, 12351, 24690, 6172, 12345]), "int text");
  check(JSON.stringify(bitwise("7.9", 3)), JSON.stringify([7, 3, 4, 7, 7, 14, 3, 7]), "float text");
  check(JSON.stringify(bitwise("-1", 1)), JSON.stringify([-1, 1, -2, -1, -1, -2, -1, 4294967295]), "negative text");
  check(JSON.stringify(bitwise("x", 5)), JSON.stringify([0, 0, 5, 5, 5, 0, 0, 0]), "nan text");
  check(JSON.stringify(bitwise(" 42 ", 1)), JSON.stringify([42, 0, 43, 43, 43, 84, 21, 42]), "spaced text");
  check("3" | "4", 7, "two texts");
  check(("12" | 0) + ("12" | 0), 24, "repeat cache");
}
console.log(failures == 0 ? "PASS global add and text bitwise" : "FAIL global add and text bitwise " + failures);
if (failures != 0) throw new Error("global add / text bitwise regressions");
