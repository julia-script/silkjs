// SilkJS regression test for js_vm.writeSetter (a put_field of an accessor
// with a bytecode setter runs the setter in an inline frame whose result is
// dropped) and js_native_functions.quickParseInt (parseInt of a number
// without the text round trip). Expected values come from V8.
var out = [];
function A() { this._k = 0; this.n = 0; }
Object.defineProperty(A.prototype, 'key', { configurable: true,
  set: function (b) { if (b === undefined) b = 0; this._k = b; this.n++; return 'ignored'; },
  get: function () { return this._k; } });
Object.defineProperty(A.prototype, 'leaf', { set: function (b) { this._k = b; } });
Object.defineProperty(A.prototype, 'ro', { get: function () { return 1; } });
Object.defineProperty(A.prototype, 'bomb', { set: function (b) { throw new Error('boom ' + b); } });
Object.defineProperty(A.prototype, 'deep', { set: function (b) { this.key = b * 2; this.leaf = this._k + 1; } });
Object.defineProperty(A.prototype, 'strictThis', { set: function (b) { 'use strict'; this.t = typeof this + b; } });
var a = new A();
// Top level (the loop's base frame), then from inline frames with the least operand stack.
a.key = 5; out.push(a._k);
function direct(o, v) { o.key = v; return o._k; }
function local(o, v) { var t = v; o.key = t; var u = o._k + 1; return u; }
function chain(o, v) { return o.key = v; }
function leaf(o, v) { o.leaf = v; return o._k; }
function deep(o, v) { o.deep = v; return o._k + ':' + o.n; }
for (var i = 0; i < 4; i++) out.push(direct(a, i + 10), local(a, i + 20), chain(a, 'c' + i), a._k, leaf(a, i + 30), deep(a, i));
out.push(direct(a), a.n);
// A missing setter, a throwing setter, an inherited one, and one replaced after the site ran.
function readOnly(o) { 'use strict'; try { o.ro = 2; return 'no throw'; } catch (e) { return e instanceof TypeError; } }
function sloppyReadOnly(o) { o.ro = 2; return o.ro; }
function bomb(o, v) { try { o.bomb = v; return 'no throw'; } catch (e) { return e.message; } }
for (var i = 0; i < 3; i++) out.push(readOnly(a), sloppyReadOnly(a), bomb(a, i));
var child = Object.create(a); child._k = 'own';
for (var i = 0; i < 3; i++) out.push(direct(child, 'ch' + i), a._k);
Object.defineProperty(A.prototype, 'key', { set: function (b) { this._k = 'second ' + b; }, configurable: true });
out.push(direct(a, 1), direct(a, 2));
Object.defineProperty(a, 'key', { value: 'data', writable: true, configurable: true });
out.push(direct(a, 3), a.key);
function onPrimitive(v) { v.strictThis = 1; return typeof v; }
Object.defineProperty(Number.prototype, 'strictThis', { set: function (b) { 'use strict'; out.push(typeof this + b); }, configurable: true });
for (var i = 0; i < 3; i++) out.push(onPrimitive(7));
delete Number.prototype.strictThis;
// Generators and arguments objects keep working across a setter frame.
function* gen(o) { o.key = yield 1; o.key = yield o._k; return o._k; }
var g = gen(new A()); out.push(g.next().value, g.next('x').value, g.next('y').value);
function viaArguments(o) { o.key = arguments; return o._k.length + ':' + o._k[1]; }
for (var i = 0; i < 3; i++) out.push(viaArguments(new A(), 'arg' + i));
// parseInt of numbers.
function p(v) { return parseInt(v); }
var inputs = [0, -0, 5, -7, 5.7, -5.7, 0.5, -0.5, 1e-6, 1e-7, -1e-7, 123456789012, 1e20, 1e21, -1e21, 4294967296.5, NaN, Infinity, -Infinity, 2147483647, -2147483648, 2147483648.9];
for (var i = 0; i < inputs.length; i++) { var r = p(inputs[i]); out.push(Object.is(r, -0) ? '-0' : String(r)); }
out.push(parseInt(11, 2), parseInt(11.9, 16), parseInt(11, 10), parseInt(11, undefined), parseInt(11, 0), parseInt('12px'), parseInt(), Number.parseInt(9.99));
const got = out.join('|');
const expected = '5|10|21|c0|c0|30|1:5|11|22|c1|c1|31|3:9|12|23|c2|c2|32|5:13|13|24|c3|c3|33|7:17|0|18|true|1|boom 0|true|1|boom 1|true|1|boom 2|ch0|0|ch1|0|ch2|0|second 1|second 2|second 2|3|number1|number|number1|number|number1|number|1|second x|second y|25:e|25:e|25:e|0|0|5|-7|5|-5|0|-0|0|1|-1|123456789012|100000000000000000000|1|-1|4294967296|NaN|NaN|NaN|2147483647|-2147483648|2147483648|3|17|11|11|11|12|NaN|9';
console.log(got === expected ? 'PASS setter inline and parseInt' : 'FAIL ' + got);
if (got !== expected) throw new Error('setter inline and parseInt regressions');
