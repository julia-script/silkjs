// `else if` chains parse in a loop instead of one recursion per branch (#780): a long
// chain compiles in one frame, and each branch keeps its own scope and exit label.
function assert(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}
var chain = Array.from({ length: 5000 }, (_, i) => `${i ? "else " : ""}if (x === ${i}) return ${i};`).join("") + "else return -1;";
var pick = new Function("x", chain);
assert(pick(0), 0, "first branch");
assert(pick(2500), 2500, "middle branch");
assert(pick(4999), 4999, "last branch");
assert(pick(5000), -1, "final else");

// Each branch closes its own scope: closures see their branch's binding.
function scoped(x) {
  var fs = [];
  if (x === 0) { let v = "a"; fs.push(() => v); }
  else if (x === 1) { let v = "b"; fs.push(() => v); }
  else if (x === 2) { let v = "c"; fs.push(() => v); if (x) { let v = "inner"; fs.push(() => v); } }
  else { let v = "d"; fs.push(() => v); }
  return fs.map(f => f()).join(",");
}
assert(scoped(0), "a", "scope 0");
assert(scoped(1), "b", "scope 1");
assert(scoped(2), "c,inner", "scope 2 with nested if");
assert(scoped(9), "d", "final else scope");

// Chains without a final else, nested chains, and labels around and inside.
function nested(a, b) {
  var r = "";
  outer: if (a === 0) r = "a0";
  else if (a === 1) { if (b === 0) r = "a1b0"; else if (b === 1) break outer; else r = "a1b?"; }
  else if (a === 2) inner: { if (b) break inner; r = "a2"; }
  return r || "none";
}
assert(nested(0, 0), "a0", "first");
assert(nested(1, 0), "a1b0", "nested chain");
assert(nested(1, 1), "none", "break out of the labelled chain");
assert(nested(1, 5), "a1b?", "nested else");
assert(nested(2, 0), "a2", "labelled block in a branch");
assert(nested(2, 1), "none", "break out of the branch label");
assert(nested(3, 0), "none", "no branch taken");

// Sloppy-mode function declarations directly in a branch.
var sloppy = new Function("x", "if (x === 0) function f() { return 'zero'; } else if (x === 1) function g() { return 'one'; } return typeof f === 'function' ? f() : typeof g === 'function' ? g() : 'none';");
assert(sloppy(0), "zero", "function in first branch");
assert(sloppy(1), "one", "function in else-if branch");
assert(sloppy(2), "none", "no function declared");

// eval completion values come from the taken branch.
assert(eval("if (false) 1; else if (true) 2; else 3;"), 2, "completion of else-if");
assert(eval("7; if (false) 1; else if (false) 2;"), undefined, "completion with no branch taken");

// Nested statements are also cheaper per level now.
var deep = new Function("x", "{".repeat(300) + "x++;" + "}".repeat(300) + "return x;");
assert(deep(1), 2, "300 nested blocks");
var deepIf = new Function("x", "if (x) {".repeat(200) + "x++;" + "}".repeat(200) + "return x;");
assert(deepIf(1), 2, "200 nested ifs");
console.log("else_if_chain ok");
