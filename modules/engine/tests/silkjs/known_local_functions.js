// A variable only ever called, holding a function expression, runs that
// function from its bytecode (no closure object, no heap scope). Every way
// such a helper can be reached must behave as a closure would.
const r = [];
var G = 10;
// Captures, read after a later write.
function captures() { var x = 1, g; g = function (a) { return a + x + G; }; x = 5; return g(2); }
r.push(captures());
// Recursion through the variable itself.
function recursive(n) { var loop; loop = function (k, acc) { if (k == 0) return acc; return loop(k - 1, acc + k); }; return loop(n, 0); }
r.push(recursive(10));
// Deep enough that frames stop fitting inline and run as base frames.
r.push(recursive(2000));
// Nested helpers, each with its own scope.
function nested() {
  var a = 3, outer;
  outer = function (p) { var inner, q = p * 2; inner = function (s) { return s + q + a; }; return inner(1) + inner(2); };
  return outer(4) + outer(5);
}
r.push(nested());
// A closure created later moves the scope to the heap; helpers still see it.
function promoted() {
  var x = 7, g, h;
  g = function () { return x; };
  var first = g();
  h = function () { return g() + 1; };
  var keep = function () { return x * 100; };
  x = 8;
  return [first, g(), h(), keep()].join(',');
}
r.push(promoted());
// Called before it is assigned: the usual TypeError.
function early() { var g, caught = false; try { g(); } catch (e) { caught = e instanceof TypeError; } g = function () { return 'ok'; }; return caught + g(); }
r.push(early());
// arguments, spread, this.
function args() { var g; g = function () { return arguments.length; }; return g(1, 2, 3); }
r.push(args());
function spread() { var g; g = function (a, b) { return a + b; }; var list = [1, 2]; return g(...list) + g(3, 4); }
r.push(spread());
function receiver() { var g; g = function () { return typeof this; }; return g(); }
r.push(receiver());
// Called from a closure that outlives nothing and from a helper of a helper.
function fromClosure() { var g, x = 2; g = function (n) { return n <= 0 ? x : g(n - 1); }; var later = function () { return g(3); }; return later() + g(4); }
r.push(fromClosure());
// Created on each loop iteration.
function inLoop() { var total = 0; for (var i = 0; i < 100; i++) { var step; step = function (k) { return k + i; }; total += step(1); } return total; }
r.push(inLoop());
// Through a deeper call chain, and calling a hoisted declaration.
function chain() { var g, y = 4; g = function () { return y + helper(); }; function helper() { return 1; } function deep(n) { return n == 0 ? g() : deep(n - 1); } return deep(50); }
r.push(chain());
// Writes to captured variables.
function writes() { var x = 1, g; g = function () { x = x + 1; return x; }; g(); g(); return x; }
r.push(writes());
// Its own parameter object per call.
function perCall() { var g, s = 0; g = function (o) { var h; h = function () { return o.v; }; return h(); }; for (var i = 0; i < 5; i++) s += g({ v: i }); return s; }
r.push(perCall());
// Uses that read the value keep it a closure.
function asValue() { var g; g = function () { return 1; }; return typeof g + g.name + g(); }
r.push(asValue());
// Stack traces name the helper.
function traced() { var thrower; thrower = function () { throw new Error('boom'); }; try { thrower(); } catch (e) { return /at thrower/.test(e.stack); } }
r.push(traced());
// Exceptions unwind through helper frames.
function unwinds() { var g, h; g = function () { return h(); }; h = function () { throw 'x'; }; try { g(); } catch (e) { return 'caught ' + e; } }
r.push(unwinds());
const got = r.join('|');
const expected = '17|55|2001000|54|7,8,9,800|trueok|3|10|object|4|5050|5|3|10|function' + 'g1|true|caught x';
console.log(got === expected ? 'PASS known local functions' : 'FAIL ' + got);
if (got !== expected) throw new Error('known local function regressions');
