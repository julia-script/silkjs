// SilkJS regression test for nested functions whose compile finishes on their first
// call: closures over outer and sibling bindings, recursion, constructors, methods,
// never-called functions, their position and source before and after the first call,
// stack trace lines from inside them, and many closures of one function. Expected
// values come from node, and the lineNumber and columnNumber ones from QuickJS.
var r = [];
function outer(k) {
  var hidden = k * 2;
  function add(a, b) { return a + b + hidden; }
  function fact(n) { return n <= 1 ? 1 : n * fact(n - 1); }
  function Point(x, y) { this.x = x; this.y = y; }
  Point.prototype.sum = function () { return this.x + this.y; };
  function never(a, b, c) { return a; }
  var arrow = (s) => s + hidden;
  return { add: add, fact: fact, Point: Point, never: never, arrow: arrow, bump: function () { return ++hidden; } };
}
var o = outer(3);
r.push(o.never.length, o.never.name, String(o.never).length, typeof o.never);
r.push(o.add(1, 2), o.fact(6), new o.Point(2, 5).sum(), o.arrow(10), o.bump(), o.add(0, 0));
r.push(o.never(9), String(o.never).length);
var made = [];
for (var i = 0; i < 5; i++) made.push(function (v) { return function () { return v * i; }; }(i));
r.push(made.map(function (f) { return f(); }).join('/'));
var e = eval('\n  (function () {\n    return function inner() { return 1; };\n  })()');
r.push(e.lineNumber, e.columnNumber, e(), e.lineNumber, e.columnNumber);
function thrower() {
  function deep() {
    throw new Error('x');
  }
  return deep();
}
try { thrower(); } catch (err) { r.push(/deferred_function_finish\.js:28:20/.test(err.stack)); }
var src = '';
for (var j = 0; j < 50; j++) src += 'function g' + j + '(a) { let t = a + ' + j + '; for (let q = 0; q < 2; q++) t += q; return t; }\n';
var built = new Function(src + 'return [g0(1), g7(1), g49(1)];');
r.push(built().join('/'));
const got = r.join();
const expected = '3,never,37,function,9,720,7,16,7,7,9,37,0/5/10/15/20,3,12,1,3,12,true,2/9/51';
if (got !== expected) throw new Error('deferred finish: got ' + got);
console.log("ok");
