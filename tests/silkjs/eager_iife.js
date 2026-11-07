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
const got = out.join('|');
const expected = "10|83|7undefined|3|3|3,610|at f (<input>:4:15)|6:38";
console.log(got === expected ? 'PASS eager iife' : 'FAIL ' + got);
if (got !== expected) throw new Error('eager iife regressions');
