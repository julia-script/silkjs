// arguments[i] reads on a function that never names its formals (lazy arguments).
function pick() { return arguments[0] + arguments[1] + arguments[2]; }
function strictPick() { "use strict"; return arguments[0] + arguments[1] + arguments[2]; }
function outOfRange() { return [arguments[3], arguments[-1], arguments["1"], arguments.length]; }
function keyed(k) { return arguments[k]; }
function mutate() { arguments[0] = 9; return arguments[0]; }
let failures = 0;
function check(got, want, label) { if (got !== want) { failures++; console.log("FAIL", label, got, want); } }
for (let i = 0; i < 2000; i++) {
  check(pick(i, 1, 2), i + 3, "pick");
  check(strictPick("a", i, "c"), "a" + i + "c", "strict");
}
check(JSON.stringify(outOfRange(1, 2, 3)), JSON.stringify([undefined, undefined, 2, 3]), "range");
check(keyed(0, 5), 0, "keyed");
check(mutate(1), 9, "mutate");
check(Number.isNaN(pick(1.5, 2)), true, "missing argument");
console.log(failures == 0 ? "PASS lazy arguments elements" : "FAIL lazy arguments elements " + failures);
if (failures != 0) throw new Error("lazy arguments regressions");
