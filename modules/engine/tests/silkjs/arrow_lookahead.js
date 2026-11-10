// Arrow detection after `(` and function-variable lookup in large functions.
function check(name, got, want) { if (got !== want) throw new Error(name + ": got " + got + ", want " + want); }
check("empty", (() => 1)(), 1);
check("ident", ((a) => a + 1)(1), 2);
check("of", ((of) => of * 2)(3), 6);
check("rest", ((...r) => r.length)(1, 2, 3), 3);
check("object", (({ a }) => a)({ a: 4 }), 4);
check("array", (([a, b]) => a + b)([2, 3]), 5);
check("default", ((a = function () { return 7; }) => a())(), 7);
check("newline", ((
  a) => a)(8), 8);
check("async", typeof (async (x) => x), "function");
check("iife", (function () { return 9; })(), 9);
check("nested", ((function () { return 10; }))(), 10);
check("paren-number", (1 + 2) * 3, 9);
check("paren-string", ("a" + "b"), "ab");
var async = function (f) { return f(); };
check("async-call", async(function () { return 11; }), 11);
// More than 32 vars: lookups must still find the last declaration.
var src = "";
for (var i = 0; i < 80; i++) src += "var v" + i + " = " + i + ";\n";
src += "var v5 = 500; function w7() { return 700; }\nreturn v0 + v5 + v79 + w7() + v7;";
check("many vars", new Function(src)(), 0 + 500 + 79 + 700 + 7);
var fsrc = "";
for (var i = 0; i < 60; i++) fsrc += "function g" + i + "() { return " + i + "; }\n";
fsrc += "function g3() { return 33; }\nreturn g3() + g59();";
check("many functions", new Function(fsrc)(), 33 + 59);
console.log("ok");
// Redeclaration checks in scopes with more than 32 declarations.
function decls(prefix, n) { var s = ""; for (var i = 0; i < n; i++) s += prefix + " d" + i + " = " + i + ";\n"; return s; }
function throwsSyntax(src) { try { new Function(src); return false; } catch (e) { return e instanceof SyntaxError; } }
check("let dup", throwsSyntax(decls("let", 40) + "let d3 = 1;"), true);
check("let var clash", throwsSyntax(decls("let", 40) + "var d7 = 1;"), true);
check("var let clash", throwsSyntax(decls("var", 40) + "let d9 = 1;"), true);
check("block shadow", new Function(decls("let", 40) + "{ let d5 = 50; var e = d5; } return e + d5;")(), 55);
check("const read", new Function(decls("const", 40) + "return d39 + d0;")(), 39);
check("tdz", (function () { try { new Function(decls("let", 40) + "return z; let z = 1;")(); return "no"; } catch (e) { return e.constructor.name; } })(), "ReferenceError");
check("closure", new Function(decls("let", 40) + "return (function () { return d20 + d33; })();")(), 53);
check("with", new Function(decls("var", 40) + "var o = { d2: 200 }; with (o) { return d2 + d3; }")(), 203);
