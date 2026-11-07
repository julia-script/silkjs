// SilkJS regression test: functions that own captured locals also wait for their
// first call to finish compiling (js_compiler_finish.defer keeps their scope plan).
// Their closures, captured arguments and the owner's own captures must behave as
// when compiled eagerly. Expected values come from V8.
var r = [];
var shared = 10;
function counter(start, step) {
  var count = start, label = 'c';
  function bump() { count += step; return count; }
  function read() { return label + count + shared; }
  return { bump: bump, read: read, set: function (v) { count = v; } };
}
function outer(a) {
  var x = a * 2;
  function mid(b) {
    var y = b + x;
    return function inner(c) { return [a, b, c, x, y, shared].join(':'); };
  }
  return mid;
}
function loops(n) {
  var fns = [];
  for (var i = 0; i < n; i++) { let j = i; var k = i; fns.push(function () { return j + '/' + k; }); }
  return fns.map(function (f) { return f(); }).join(',');
}
function argumentsOwner(p, q) {
  var get = function () { return p + q + arguments.length; };
  p = p + 1;
  return get(1, 2, 3) + '|' + arguments[0];
}
function strictOwner() { 'use strict'; var v = 1; return function () { return v++; }; }
var c = counter(1, 3);
r.push(c.bump(), c.bump(), c.read());
c.set(100); r.push(c.bump(), c.read());
shared = 20;
r.push(outer(3)(4)(5), outer(1)(2)(3));
r.push(loops(4));
r.push(argumentsOwner(1, 2));
var s = strictOwner(); r.push(s(), s(), s());
var c2 = counter(0, 1); r.push(c2.bump(), c.bump());
const got = r.join(';');
const expected = '4;7;c710;103;c10310;3:4:5:6:10:20;1:2:3:2:4:20;0/3,1/3,2/3,3/3;7|2;1;2;3;1;106';
console.log(got === expected ? 'PASS deferred scope owners' : 'FAIL ' + JSON.stringify(got));
if (got !== expected) throw new Error('deferred scope owners regressions');
