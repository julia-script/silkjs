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
