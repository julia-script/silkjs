// Captured variables in per-activation scopes: parent and child writes,
// parameters, lexicals and TDZ, nesting depth, loops, recursion, arguments,
// this/new.target in arrows, classes, and the cell fallbacks around them.
var out = [];

function counter(start) {
  var n = start;
  return { inc: function () { return ++n; }, get: function () { return n; }, set: function (v) { n = v; } };
}
var c = counter(5); c.inc(); c.inc(); c.set(c.get() * 2);
out.push(c.get());

function shared() {
  var x = 1;
  function read() { return x; }
  x = 2;
  var r1 = read();
  x += 3;
  return r1 + ':' + read();
}
out.push(shared());

function param(a, b) {
  var f = function () { return a + b; };
  a = a * 10;
  return f() + ',' + arguments[0];
}
out.push(param(1, 2));

function sloppyMapped(a) {
  var f = function () { return a; };
  arguments[0] = 9;
  return f();
}
out.push(sloppyMapped(1));

function strictParam(a) {
  'use strict';
  var f = function () { return a; };
  arguments[0] = 9;
  return f() + '/' + arguments[0];
}
out.push(strictParam(1));

function tdz() {
  var early;
  try { early = (function () { return later; })(); } catch (e) { early = e.constructor.name; }
  let later = 'ok';
  return early + ',' + (function () { return later; })();
}
out.push(tdz());

function deep() {
  var a = 'a';
  return function () {
    var b = 'b';
    return function () {
      var c = 'c';
      return function () {
        return function () { return a + b + c; }
          ;
      };
    };
  };
}
out.push(deep()()()()());

function depthMix() {
  var v = 1;
  function mid() {
    var w = 2;
    function leaf() { v += w; return v; }
    return leaf;
  }
  var l = mid();
  l(); l();
  return v;
}
out.push(depthMix());

function loops() {
  var fs = [];
  for (let i = 0; i < 3; i++) fs.push(function () { return i; });
  var gs = [];
  for (var j = 0; j < 3; j++) gs.push(function () { return j; });
  return fs.map(function (f) { return f(); }).join('') + '|' + gs.map(function (g) { return g(); }).join('');
}
out.push(loops());

function fib(n) {
  function go(k) { return k < 2 ? k : go(k - 1) + go(k - 2); }
  return go(n);
}
out.push(fib(15));

function selfName() {
  var f = function inner(k) { return k ? inner(k - 1) + 1 : 0; };
  return f(4);
}
out.push(selfName());

function arrows() {
  var self = this;
  var get = () => this === self;
  var nt = () => typeof new.target;
  return get() + ',' + nt();
}
out.push(arrows.call({}));
out.push(new arrows() instanceof arrows);

class Base { constructor(v) { this.v = v; } }
class Derived extends Base {
  constructor(v) {
    var early = () => this;
    var threw = false;
    try { early(); } catch (e) { threw = true; }
    super(v);
    this.ok = early() === this && threw;
  }
}
var d = new Derived(3);
out.push(d.v + ':' + d.ok);

function withEval() {
  var hidden = 4;
  return function () { return eval('hidden * 2'); }();
}
out.push(withEval());

function withStatement() {
  var p = 1;
  var o = { q: 2 };
  with (o) { return (function () { return p + q; })(); }
}
out.push(withStatement());

function generatorOuter() {
  var base = 10;
  function* gen() { yield base; base++; yield base; }
  var it = gen();
  return it.next().value + it.next().value + base;
}
out.push(generatorOuter());

function argumentsCaptured() {
  var args = arguments;
  return function () { return args.length + ':' + args[1]; };
}
out.push(argumentsCaptured(7, 8, 9)());

function manyClosures() {
  var total = 0;
  for (var k = 0; k < 2000; k++) {
    var make = (function (m) { return function () { return m; }; })(k);
    total += make();
  }
  return total;
}
out.push(manyClosures());

function destructure() {
  var a, b;
  var swap = function () { [a, b] = [b, a]; };
  a = 1; b = 2; swap();
  return a + '' + b;
}
out.push(destructure());

function compound() {
  var s = 'x';
  var add = function (t) { s += t; return s; };
  add('y');
  s = s + 'z';
  return add('!');
}
out.push(compound());

function constCapture() {
  const k = 3;
  var f = function () { return k * 2; };
  var threw = false;
  try { (function () { k = 4; })(); } catch (e) { threw = e instanceof TypeError; }
  return f() + ',' + threw;
}
out.push(constCapture());

var result = out.join('|');
var expected = '14|2:5|12,10|9|1/9|ReferenceError,ok|abc|5|012|333|610|4|true,undefined|true|3:true|8|3|32|3:8|1999000|21|xyz!|6,true';
console.log(result === expected ? 'PASS scope contexts' : 'FAIL ' + result);
if (result !== expected) throw new Error('scope context regressions');
