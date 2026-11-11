// Call-only function declarations and arrows run without a closure (js_compiler_known).
const r = [];
// A declaration called before its text, capturing a local.
function declared(n) { var k = 3; var s = 0; for (var i = 0; i < n; i++) s += add(i); return s; function add(x) { return x * k; } }
r.push(declared(10));
// Recursion through the declaration's own name.
function recurse() { return fact(10) + depth(2000); function fact(n) { return n <= 1 ? 1 : n * fact(n - 1); } function depth(n) { return n === 0 ? 0 : 1 + depth(n - 1); } }
r.push(recurse());
// A nested closure calling a declaration of its parent.
function nested() { var base = 5; function helper(x) { return x + base; } var outer = function (y) { return helper(y) * 2; }; return outer(1) + outer(2); }
r.push(nested());
// Reassigned or read as a value: stays a closure.
function reassigned() { function f() { return 1; } var a = f(); f = function () { return 2; }; return a + f(); }
r.push(reassigned());
function asValue() { function f() { return 7; } return typeof f + f.name + [1, 2].map(f).join(','); }
r.push(asValue());
// Declarations in blocks, strict and sloppy.
function blockStrict() { 'use strict'; var s = 0; { let w = 4; function g() { return w; } s += g(); } return s; }
r.push(blockStrict());
function blockSloppy() { var s = 0; { function g() { return 6; } s += g(); } return s + g(); }
r.push(blockSloppy());
// Arrows: lexical this and arguments, captures, recursion through a var.
function arrowThis() { var a = (x) => this.v + x; return a(1) + a(2); }
r.push(arrowThis.call({ v: 10 }));
function arrowArguments() { var count = () => arguments.length; return count(); }
r.push(arrowArguments(1, 2, 3));
function arrowCapture() { let total = 0; const add = (x) => { total += x; }; for (let i = 1; i <= 4; i++) add(i); return total; }
r.push(arrowCapture());
function arrowRecursion() { var fib; fib = (n) => n < 2 ? n : fib(n - 1) + fib(n - 2); return fib(15); }
r.push(arrowRecursion());
// Variable initializers: `var v = function` and `const v = () =>`.
function varInit() { var k = 2; var sq = function (x) { return x * k; }; const inc = (x) => x + k; return sq(3) + sq(4) + inc(1); }
r.push(varInit());
// Stack traces name declarations and arrows.
function traced() { function boom() { throw new Error('b'); } const zap = () => boom(); try { zap(); } catch (e) { return /at boom/.test(e.stack) && /at zap/.test(e.stack); } }
r.push(traced());
const got = r.join('|');
const expected = '135|3630800|26|3|functionf7,7|4|12|23|3|10|610|17|true';
console.log(got === expected ? 'PASS known local declarations' : 'FAIL ' + got);
if (got !== expected) throw new Error('known local declaration regressions');
