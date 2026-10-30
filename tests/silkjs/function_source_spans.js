// Function.prototype.toString returns each function's own source text. A compile
// keeps one shared copy of its input and every function records its span, so nested
// functions, classes and their members, non-ASCII text and functions that outlive
// the rest of their compile must all still print exactly their own text.
function assert(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function outer(a) {
  function inner(b) { return b * 2; }
  const arrow = (c) => c + "é€😀";
  return [inner, arrow];
}
assert(outer.toString().slice(0, 16), "function outer(a", "outer head");
assert(outer.toString().slice(-1), "}", "outer tail");
var pair = outer();
assert(pair[0].toString(), "function inner(b) { return b * 2; }", "inner");
assert(pair[1].toString(), '(c) => c + "é€😀"', "arrow with non-ASCII");
class K extends Object { constructor() { super(); } get g() { return 1; } static async *s() {} m() { return "λ"; } }
assert(K.toString(), 'class K extends Object { constructor() { super(); } get g() { return 1; } static async *s() {} m() { return "λ"; } }', "class");
assert(Object.getOwnPropertyDescriptor(K.prototype, "g").get.toString(), "get g() { return 1; }", "getter");
assert(K.s.toString(), "async *s() {}", "static async generator");
assert(K.prototype.m.toString(), 'm() { return "λ"; }', "method");
class Empty {}
assert(Empty.toString(), "class Empty {}", "implicit constructor");
// Functions from separate compiles keep their own texts after the rest is gone.
var kept = [];
for (var i = 0; i < 50; i++) {
  var src = "var pad" + i + " = '" + "x".repeat(1000) + "'; return function k" + i + "() { return " + i + "; };";
  kept.push(new Function(src)());
}
src = null;
for (var i = 0; i < 50; i++) assert(kept[i].toString(), "function k" + i + "() { return " + i + "; }", "kept " + i);
assert(eval("(function e() { return 'ü'; })").toString(), "function e() { return 'ü'; }", "eval");
assert(new Function("a", "b", "return a + b").toString(), "function anonymous(a,b\n) {\nreturn a + b\n}", "Function constructor");
// An ASCII source string is compiled in place and its functions share the string.
var shortSource = "(function q() { return 7; })";
var q = eval(shortSource);
shortSource = null;
assert(q.toString(), "function q() { return 7; }", "short ASCII eval");
var longSource = "(function w() { return '" + "y".repeat(500) + "'; })";
longSource = longSource + "";
var w = eval(longSource);
longSource = null;
assert(w.toString(), "function w() { return '" + "y".repeat(500) + "'; }", "long ASCII eval");
function directEval() { var local = 3; return eval("(function d() { return local; })"); }
assert(directEval().toString(), "function d() { return local; }", "direct eval");
assert(directEval()(), 3, "direct eval closure");
assert(eval("(function z() { return '\\xff'; })").toString(), "function z() { return '\\xff'; }", "escaped non-ASCII");
assert(eval("(function y() { return '\xff'; })").toString(), "function y() { return '\xff'; }", "Latin-1 eval");
