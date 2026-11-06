// SilkJS regression test: RegExp symbol methods remember the last builtin RegExp layout
// they proved (RuntimeState.regexpStandard); every later change to exec, the flag
// getters, lastIndex or the prototype chain must still be observed. Expected values come from V8.
var r = [];
function t() { return 'a b c'.replace(/b/g, 'X') + '|' + 'a1b2'.split(/\d/).join(',') + '|' + 'xbx'.replace(/b/, 'Y'); }
r.push(t(), t());
var re = /b/g; r.push('abc'.replace(re, '-'));
re.exec = function (s) { r.push('own exec'); return null; }; r.push('abc'.replace(re, '-'));
r.push(t());
var oldExec = RegExp.prototype.exec;
RegExp.prototype.exec = function (s) { r.push('proto exec'); return oldExec.call(this, s); };
r.push(t());
RegExp.prototype.exec = oldExec; r.push(t());
var d = Object.getOwnPropertyDescriptor(RegExp.prototype, 'global');
Object.defineProperty(RegExp.prototype, 'global', { get: function () { r.push('global getter'); return d.get.call(this); }, configurable: true });
r.push(t());
Object.defineProperty(RegExp.prototype, 'global', d); r.push(t());
var q = /b/g; q.lastIndex = {valueOf() { r.push('valueOf'); return 0; }}; r.push('abc'.replace(q, '-'));
var q2 = /b/g; r.push('abc'.replace(q2, '-')); q2.lastIndex = 'x'; r.push('abcb'.replace(q2, '-'));
class R extends RegExp { exec(s) { r.push('sub exec'); return super.exec(s); } }
r.push('abc'.replace(new R('b', 'g'), '-'));
var p = /b/g; Object.setPrototypeOf(p, { __proto__: RegExp.prototype, exec(s) { r.push('mid exec'); return RegExp.prototype.exec.call(this, s); } });
r.push('abc'.replace(p, '-'));
r.push(t());
const got = r.join('\n');
const expected = "a X c|a,b,|xYx\na X c|a,b,|xYx\na-c\nown exec\nabc\na X c|a,b,|xYx\nproto exec\nproto exec\nproto exec\nproto exec\nproto exec\nproto exec\nproto exec\na X c|a,b,|xYx\na X c|a,b,|xYx\nglobal getter\nglobal getter\nglobal getter\na X c|a,b,|xYx\na X c|a,b,|xYx\na-c\na-c\na-c-\nsub exec\nsub exec\na-c\nmid exec\nmid exec\na-c\na X c|a,b,|xYx";
console.log(got === expected ? 'PASS regexp standard cache' : 'FAIL ' + JSON.stringify(got));
if (got !== expected) throw new Error('regexp standard cache regressions');
