// The preparser (js_preparse) skips function bodies of large sources. Its token
// step checks no stack; statement, assignment and newExpression do, so nesting
// past the native stack in a skipped body is a RangeError, not a crash.
// Lazy parsing only applies to sources of 64 KiB or more: pad the source.
var pad = "/*" + "x".repeat(70000) + "*/\n";
function deep(inner) {
  var source = pad + "function outer() { function deep() { " + inner + " } return deep; }\nouter;";
  try { (0, eval)(source); return "ok"; } catch (e) { return e instanceof RangeError ? "range" : String(e); }
}
var n = 300000;
var cases = [
  ["parens", "return " + "(".repeat(n) + "1" + ")".repeat(n) + ";"],
  ["new", "return " + "new ".repeat(n) + "X;"],
  ["blocks", "{".repeat(n) + "}".repeat(n)],
  ["ifs", "if (1) ".repeat(n) + ";"],
  ["assign", "a = ".repeat(n) + "1;"],
  ["cond", "a ? ".repeat(n) + "1" + " : 2".repeat(n) + ";"],
  ["funcs", "function g() { ".repeat(30000) + "}".repeat(30000)],
  ["calls", "return " + "f(".repeat(n) + "1" + ")".repeat(n) + ";"],
  ["members", "return a" + "[a".repeat(n) + "]".repeat(n) + ";"],
];
var got = cases.map(function (c) { return c[0] + ":" + deep(c[1]); }).join(" ");
var expected = cases.map(function (c) { return c[0] + ":range"; }).join(" ");
// Moderate nesting still preparses and runs.
var ok = (0, eval)(pad + "function outer() { function inner() { return " + "(".repeat(200) + "7" + ")".repeat(200) + "; } return inner(); }\nouter();");
got += " small:" + ok;
expected += " small:7";
console.log(got === expected ? "PASS preparse depth" : "FAIL " + got);
if (got !== expected) throw new Error("preparse depth regressions");
