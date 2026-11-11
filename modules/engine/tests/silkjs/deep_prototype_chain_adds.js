// SilkJS regression test for put_field adds on objects whose prototype chain is
// four to six links deep (classes three to five levels down): the add memo
// verifies the whole chain, so a setter or read-only property added later to a
// deep prototype must still be honoured, and fresh objects stepping along a
// chain no other object holds take the same shapes. Expected values come from C QuickJS.
var r = [];
var __extends = function (d, b) { function __() { this.constructor = d; } __.prototype = b.prototype; d.prototype = new __(); };
function A0() { this.a = 0; }
function A1() { A0.call(this); this.b = 1; }
__extends(A1, A0);
function A2() { A1.call(this); this.c = 2; }
__extends(A2, A1);
function A3() { A2.call(this); this.d = 3; this.e = 4; }
__extends(A3, A2);
function A4() { A3.call(this); this.f = 5; }
__extends(A4, A3);
function build(C, n) { var last; for (var i = 0; i < n; i++) last = new C(); return last; }
var o = build(A4, 50); r.push(Object.keys(o).join(''), o.f);
// A setter on the deepest user prototype, after the adds were memoized.
var seen = [];
Object.defineProperty(A0.prototype, 'e', { set: function (v) { seen.push(v); }, get: function () { return 'getter'; }, configurable: true });
o = build(A4, 3); r.push(Object.keys(o).join(''), o.e, seen.join('/'));
delete A0.prototype.e;
o = build(A4, 3); r.push(Object.keys(o).join(''), o.e);
// Read-only on Object.prototype, five links up from an A4 instance.
Object.defineProperty(Object.prototype, 'f', { value: 'ro', writable: false, configurable: true });
o = build(A4, 3); r.push(Object.keys(o).join(''), o.f);
delete Object.prototype.f;
o = build(A4, 3); r.push(Object.keys(o).join(''), o.f);
// Many distinct classes with long constructors: shapes nothing else holds.
var classes = [];
for (var k = 0; k < 40; k++) {
  classes.push(new Function('base', 'k', 'function C() { base.call(this); this.p' + k + 'a = 1; this.p' + k + 'b = 2; this.p' + k + 'c = 3; this.p' + k + 'd = 4; this.p' + k + 'e = 5; this.p' + k + 'f = 6; this.p' + k + 'g = 7; this.p' + k + 'h = 8; this.p' + k + 'i = 9; } return C;')(A3, k));
}
var total = 0;
for (var round = 0; round < 3; round++) for (var k = 0; k < 40; k++) { var x = new classes[k](); total += Object.keys(x).length + x['p' + k + 'i']; }
r.push(total);
const got = r.join();
const expected = 'abcdef,5,abcdf,getter,4/4/4,abcdef,4,abcde,ro,abcdef,5,2760';
console.log(got === expected ? 'PASS deep prototype chain adds' : 'FAIL ' + got);
if (got !== expected) throw new Error('deep prototype chain add regressions');
