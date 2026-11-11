// SilkJS regression test for immediately invoked function expressions in run-time
// code, which parse in full at once while their children stay lazy. A direct eval
// or a with statement in the body makes the parse start over the usual way, so
// names the eval declares still reach children defined before it.
const out = [];
const pad = '/*' + 'x'.repeat(3000) + '*/\n';
const run = (body) => (0, eval)(pad + body);
out.push(run('(function(){ var a = 5; function g(){ return a * 2; } return g(); })()'));
out.push(run('(function(){ function g(){ return c + 1; } eval("var c = 40"); function h(){ return c + 2; } return g() + h(); })()'));
out.push(run('(function(){ var o = {x: 7}; function g(){ return typeof x; } with (o) { return x + g(); } })()'));
out.push(run('(function(){ var n = 1; return (function(){ function k(){ return n + 2; } return k(); })(); })()'));
out.push(run('(function(){ function inner(){ return (function(){ eval("var z = 3"); return z; })(); } return inner(); })()'));
out.push(run('[1, 2].map(function(v){ return v * 3; }).join(",") + (function(n){ function k(){ return n + 1; } return k(); })(9)'));
out.push(run('(function(){\n  function f(a) {\n    return a.b.c;\n  }\n  try { f({}); } catch (e) { return e.stack.split("\\n")[0].trim(); }\n})()'));
out.push(run('(function(){ var s = 0; function add(v){ s += v; return add; } add(1)(2)(3); return s + ":" + add.toString().length; })()'));
// Parameterless function expressions after `=` or `,` inside a parsed-in-full
// function parse in full too, whether or not a call follows the body.
out.push(run('(function(){ var n = 4, f = function(){ function k(){ return n * 10; } return k(); }(); return f; })()'));
out.push(run('(function(){ var r = [], g; g = 1, function(){ r.push(/[}(]/.source, `${"}"}`, "}(".length); }(); return r.join(","); })()'));
out.push(run('(function(){ var f = function(){ return function(){ eval("var q = 6"); return q; }(); }(); return f; })()'));
out.push(run('(function(){ var f = function(){ return 2; }; var t = f == function(){ return 1; }; return f() + ":" + t; })()'));
out.push(run('(function(){ var o = {}, log = []; o.m = function(){ log.push("m"); return function(){ return 5; }; }\n(function(){ log.push("arg"); })(); return log.join(",") + ":" + o.m; })()'));
out.push(run('(function(){ var f = function(){ var s = "a"; return function(){ return s + "b"; }; }(); return f() + f.toString().length; })()'));
out.push(run('(function(){ var w = 9, g = function(){ eval("var w = 1"); return w; }; return typeof g + g() + w; })()'));
const got = out.join('|');
const expected = "10|83|7undefined|3|3|3,610|at f (<input>:4:15)|6:38|40|[}(],},2|6|2:false|m:5|ab29|function19";
console.log(got === expected ? 'PASS eager iife' : 'FAIL ' + got);
if (got !== expected) throw new Error('eager iife regressions');
