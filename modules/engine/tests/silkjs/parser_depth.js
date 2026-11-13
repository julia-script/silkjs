// The parser checks the native stack where it recurses (parseStatement and the
// expression and pattern entry points), not on every token: nesting past the
// stack in any construct is a RangeError, not a crash. Deep binding patterns
// stop earlier, at the lookahead's own limit, with a SyntaxError.
var n = 100000, m = 20000;
var cases = [
  ["blocks", "{".repeat(n) + "}".repeat(n)],
  ["ifs", "if (1) ".repeat(n) + ";"],
  ["whiles", "while (0) ".repeat(n) + ";"],
  ["fors", "for (;0;) ".repeat(n) + ";"],
  ["labels", Array.from({ length: n }, function (_, i) { return "l" + i + ": "; }).join("") + ";"],
  ["trys", "try { ".repeat(m) + "} finally {}".repeat(m)],
  ["withs", "with (o) ".repeat(n) + ";"],
  ["funcs", "function g() { ".repeat(m) + "}".repeat(m)],
  ["arrows", "x = " + "a => ".repeat(n) + "1;"],
  ["arrowBlocks", "x = " + "() => { ".repeat(m) + "}".repeat(m) + ";"],
  ["classes", "x = " + "class { m() { return ".repeat(m) + "1" + "; } }".repeat(m) + ";"],
  ["templates", "x = " + "`${".repeat(n) + "1" + "}`".repeat(n) + ";"],
  ["parens", "x = " + "(".repeat(n) + "1" + ")".repeat(n) + ";"],
  ["arrays", "x = " + "[".repeat(n) + "]".repeat(n) + ";"],
  ["objects", "x = " + "{ a: ".repeat(n) + "1" + " }".repeat(n) + ";"],
  ["computed", "x = " + "{ [".repeat(n) + "1" + "]: 1 }".repeat(n) + ";"],
  ["spreads", "x = " + "[...".repeat(n) + "a" + "]".repeat(n) + ";"],
  ["calls", "x = " + "f(".repeat(n) + "1" + ")".repeat(n) + ";"],
  ["members", "x = a" + "[a".repeat(n) + "]".repeat(n) + ";"],
  ["news", "x = " + "new ".repeat(n) + "X;"],
  ["unary", "x = " + "!".repeat(n) + "1;"],
  ["typeofs", "x = " + "typeof ".repeat(n) + "1;"],
  ["assigns", "a = ".repeat(n) + "1;"],
  ["conds", "x = " + "a ? ".repeat(n) + "1" + " : 2".repeat(n) + ";"],
  ["letPattern", "let " + "[".repeat(n) + "a" + "]".repeat(n) + " = 1;"],
  ["letObjPattern", "let " + "{ a: ".repeat(n) + "b" + " }".repeat(n) + " = 1;"],
  ["paramPattern", "function g(" + "[".repeat(n) + "a" + "]".repeat(n) + ") {}"],
  ["arrowParams", "x = " + "(".repeat(n) + "a" + ")".repeat(n) + " => 1;"],
  ["defaults", "function g(a = " + "(b = ".repeat(n) + "1" + ")".repeat(n) + ") {}"],
  ["asyncAwait", "async function g() { " + "await ".repeat(n) + "1; }"],
  ["yields", "function* g() { " + "yield ".repeat(n) + "1; }"],
  ["optional", "x = a" + "?.[a".repeat(n) + "]".repeat(n) + ";"],
  ["exprStmtParens", "(".repeat(n) + "1" + ")".repeat(n) + ";"],
  ["assignPattern", "[".repeat(n) + "a" + "]".repeat(n) + " = 1;"],
  ["switches", "switch (1) { case 1: ".repeat(m) + "}".repeat(m)],
  ["doWhiles", "do ".repeat(n) + ";" + " while (0)".repeat(n)],
];
var patterns = { letPattern: 1, letObjPattern: 1, paramPattern: 1 };
var bad = [];
cases.forEach(function (c) {
  var r;
  try { new Function(c[1]); r = "ok"; } catch (e) { r = e instanceof RangeError ? "range" : e instanceof SyntaxError ? "syntax" : String(e); }
  if (r !== "range" && !(r === "syntax" && patterns[c[0]])) bad.push(c[0] + ":" + r);
});
console.log(bad.length ? "FAIL " + bad.join(" ") : "PASS parser depth");
if (bad.length) throw new Error("parser depth regressions");
