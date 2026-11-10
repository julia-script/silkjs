// SilkJS regression test: RegExp.prototype.test on the VM's quick path (no result array)
// and its ways out. Expected values come from V8.
var r = [];
var re = /b(c)?/; r.push(re.test('abc'), re.test('xyz'), re.lastIndex);
var g = /b/g; r.push(g.test('abab'), g.lastIndex, g.test('abab'), g.lastIndex, g.test('abab'), g.lastIndex);
g.lastIndex = 9; r.push(g.test('abab'), g.lastIndex);
var y = /b/y; y.lastIndex = 1; r.push(y.test('abab'), y.lastIndex, y.test('abab'), y.lastIndex);
var n = /(?<x>b)/g; r.push(n.test('ab'), n.lastIndex);
var d = /b/d; r.push(d.test('ab'));
var w = /ā+/; r.push(w.test('xāā'), w.test('xa'));
var u = /^.$/u; r.push(u.test('\ud83d\ude00'), /^.$/.test('\ud83d\ude00'));
var ro = /b/g; Object.defineProperty(ro, 'lastIndex', { writable: false, value: 0 });
try { r.push(ro.test('ab')); } catch (e) { r.push(e.constructor.name); }
var own = /b/; own.exec = function () { return null; }; r.push(own.test('b'));
var old = RegExp.prototype.exec; var seen = 0;
RegExp.prototype.exec = function (s) { seen++; return old.call(this, s); };
r.push(/b/.test('ab'), seen);
RegExp.prototype.exec = function () { return {}; }; r.push(/b/.test('zz'));
RegExp.prototype.exec = old; r.push(/b/.test('ab'), /b/.test(123), /1/.test(123), /b/.test({ toString: function () { return 'b'; } }));
var s = /b/g; s.lastIndex = '1'; r.push(s.test('ab'), s.lastIndex);
var sum = 0; var hot = /q/; for (var i = 0; i < 100; i++) if (hot.test(i % 3 ? 'aq' : 'aa')) sum++; r.push(sum);
const got = r.join('\n');
const expected = "true\nfalse\n0\ntrue\n2\ntrue\n4\nfalse\n0\nfalse\n0\ntrue\n2\nfalse\n0\ntrue\n2\ntrue\ntrue\nfalse\ntrue\nfalse\nTypeError\nfalse\ntrue\n1\ntrue\ntrue\nfalse\ntrue\ntrue\ntrue\n2\n66";
console.log(got === expected ? 'PASS regexp test quick path' : 'FAIL ' + JSON.stringify(got));
if (got !== expected) throw new Error('regexp test quick path regressions');
