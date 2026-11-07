// SilkJS regression test for lazy function parsing: bodies the preparser skips
// and compiles on first call must keep closures, captures, hoisting, TDZ,
// strictness, toString, names, stack lines and early errors. Expected values
// come from the eager compiler (and match node). Lazy parsing only applies to
// sources of 64 KiB or more, so the body runs through a padded indirect eval.
var out = [];
function body() {
var g = 10;
function add(a, b) { return a + b + g; }
function outer(x) {
  var y = x * 2;
  function inner(z) { return y + z; }
  return inner(3) + (function(q){ return q + y; })(1);
}
var counter = (function() { var n = 0; return function() { n = n + 1; return n; }; })();
counter(); counter();
function rec(n) { return n <= 1 ? 1 : n * rec(n - 1); }
out.push([add(1, 2), outer(5), counter(), rec(5), add.toString().length, add.name, outer.length].join(" "));
function owner(a) {
  var x = a, y = 2;
  let z = 3;
  function f1() { return x + y + z; }
  var f2 = function named(n) { return n ? named(n - 1) + x : 0; };
  function setX(v) { x = v; }
  var fs = [];
  for (var i = 0; i < 3; i++) fs.push(function () { return x * 10 + y; });
  setX(5);
  return [f1(), f2(3), fs[0](), fs[2]()].join(',');
}
out.push(owner(1));
function deep() {
  var v = 1;
  return function a() { return function b() { return function c() { return function d() {
    return function e() { return function f() { return function g() { return function h() { return function i() { return v++; }; }; }; }; }; }; }; }; };
}
out.push(deep()()()()()()()()()(), deep()()()()()()()()()());
var mk = function () { var c = 0; return { inc: function () { return ++c; }, get: function () { return c; } }; };
var o1 = mk(), o2 = mk(); o1.inc(); o1.inc(); o2.inc();
out.push(o1.get() + ':' + o2.get());
(function () { 'use strict'; out.push(typeof this); })();
function strictInner() { 'use strict'; return function () { return typeof this; }(); }
out.push(strictInner());
function re(s) { return /a(b+)c/g.exec(s)[1].length; }
out.push(re('xabbbc'));
function labels(n) { var s = 0; outer: for (var i = 0; i < n; i++) { for (var j = 0; j < n; j++) { if (j > i) continue outer; if (i * j > 6) break outer; s += j; } } return s; }
out.push(labels(5));
function toS(a, b) { /* c */ return a; }
out.push(toS.toString(), toS.length, toS.name);
var g1 = 7; function useGlobal() { return g1 + (typeof undefinedThing); }
out.push(useGlobal());
function args() { return arguments.length + arguments[0]; }
out.push(args(5, 6));
function hoist() { return inner(); function inner() { return 'h' + typeof later; } var later = 1; }
out.push(hoist());
function tdz() { try { return q; } catch (e) { return e.constructor.name; } let q = 1; }
out.push(tdz());
function cnst() { const k = 1; try { k = 2; } catch (e) { return e.constructor.name; } }
out.push(cnst());
function shadow(x) { var x; { let x = 'block'; } return x; }
out.push(shadow('arg'));
var self = function me() { return typeof me; }; out.push(self());
function decl() { return typeof decl; } out.push(decl());
function outerEvalFree() { var hidden = 'h'; return function () { return hidden; }; }
out.push(outerEvalFree()());
function sw(v) { switch (v) { case 1: return 'one'; default: return 'd'; case 2: return 'two'; } }
out.push(sw(2), sw(9));
function thrower() { throw new Error('boom'); }
try { thrower(); } catch (e) { out.push(e.message, typeof e.stack); }
function objLit() { var a = 1; return { a, b: 2, get c() { return a + 1; }, set c(v) { a = v; } }; }
var ol = objLit(); ol.c = 10; out.push(ol.c);


function outerS() {
  var q = 2;
  function mid() {
    return function inner() {
        throw new Error('x' + q);
    };
  }
  return mid();
}
try { outerS()(); } catch (e) { out.push(e.stack.split('\n').length + ':' + e.stack.split('\n')[0].trim() + '@' + (e.stack.match(/:(\d+):\d+/)||[])[1]); }
(function () {
  function deepErr() { null.f(); }
  try { deepErr(); } catch (e) { out.push(e.stack.split('\n').length + ':' + e.stack.split('\n')[0].trim() + '@' + (e.stack.match(/:(\d+):\d+/)||[])[1]); }
})();
var escaped = ["({ \\u0067et foo() { return 0; } })", "({ g\\u0065t 'hi'() { return 0; } })", "function f() { return n\\u0065w.target }"];
for (var s of escaped) { try { Function(s); out.push('accepted'); } catch (e) { out.push(e.constructor.name); } }
function lazyLater() { return [1, 2, 3].map(function (v) { return v * g; }).join('+'); }
out.push(lazyLater());
}
(0, eval)('/*' + 'x'.repeat(70000) + '*/\n(' + body.toString() + ')()');
const got = out.join('|');
const expected = "13 24 3 120 40 add 1|10,15,52,52|1|1|2:1|undefined|undefined|3|7|function toS(a, b) { /* c */ return a; }|2|toS|7undefined|7|hundefined|ReferenceError|TypeError|arg|function|function|h|two|d|boom|string|11|6:at inner (<input>:72:24)@72|7:at deepErr (<input>:79:28)@79|SyntaxError|SyntaxError|SyntaxError|10+20+30";
console.log(got === expected ? 'PASS lazy parse' : 'FAIL ' + got);
if (got !== expected) throw new Error('lazy parse regressions');
