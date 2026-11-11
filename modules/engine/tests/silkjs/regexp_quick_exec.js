// SilkJS regression test for the VM's quick RegExp.prototype.exec path
// (js_regexp_intrinsics_exec.quickExec) and the cases it leaves to the full
// call. Expected values come from C QuickJS.
var out = [];
function r(m) { return m === null ? 'null' : JSON.stringify([m.slice(), m.index, m.input.length, m.groups, m.length]); }
var a = /b(c)?/; out.push(r(a.exec('abcab')), a.lastIndex, r(a.exec('xyz')));
var g = /a./g; var s = 'a1a2a3'; for (var i = 0; i < 5; i++) out.push(r(g.exec(s)), g.lastIndex);
var y = /a/y; out.push(r(y.exec('aab')), y.lastIndex, r(y.exec('aab')), y.lastIndex, r(y.exec('aab')), y.lastIndex);
g.lastIndex = 100; out.push(r(g.exec(s)), g.lastIndex);
g.lastIndex = -3; out.push(r(g.exec(s)), g.lastIndex);
g.lastIndex = 2.5; out.push(r(g.exec(s)), g.lastIndex);
g.lastIndex = { valueOf: function () { out.push('valueOf'); return 4; } }; out.push(r(g.exec(s)), g.lastIndex);
var f = /a/g; Object.defineProperty(f, 'lastIndex', { writable: false, value: 0 });
try { f.exec('aa'); out.push('no throw'); } catch (e) { out.push(e.constructor.name); } out.push(f.lastIndex);
try { f.exec('bb'); out.push('no throw'); } catch (e) { out.push(e.constructor.name); }
var n = /a/; Object.defineProperty(n, 'lastIndex', { writable: false, value: 7 }); out.push(r(n.exec('ba')), n.lastIndex);
out.push(r(/(?<x>q)/.exec('aq')), r(/q/d.exec('aq')) , JSON.stringify(/q/d.exec('aq').indices));
var rope = 'x'.repeat(20); rope = rope + 'yz' + rope; out.push(r(/yz/.exec(rope)));
out.push(r(/ᵃ(b)/.exec('ᵃbᵃ')), r(/\d+/.exec(12345)), r(/u/.exec({ toString: function () { return 'au'; } })), r(/x/.exec()));
try { RegExp.prototype.exec.call({}, 'a'); } catch (e) { out.push(e.constructor.name); }
var cls = /a(b)/; out.push(r(cls.exec('ab')), r(cls.exec('ab', 'extra')));
var u = /(a)|(b)/g; out.push(r(u.exec('b')), u.lastIndex);
var big = /./g; var t = ''; for (var i = 0; i < 300; i++) t += String.fromCharCode(65 + i % 26); var c = 0; while (big.exec(t)) c++; out.push(c, big.lastIndex);
const got = out.join('|');
const expected = '[["bc","c"],1,5,null,2]|0|null|[["a1"],0,6,null,1]|2|[["a2"],2,6,null,1]|4|[["a3"],4,6,null,1]|6|null|0|[["a1"],0,6,null,1]|2|[["a"],0,3,null,1]|1|[["a"],1,3,null,1]|2|null|0|null|0|[["a1"],0,6,null,1]|2|[["a2"],2,6,null,1]|4|valueOf|[["a3"],4,6,null,1]|6|TypeError|0|TypeError|[["a"],1,2,null,1]|7|[["q","q"],1,2,{"x":"q"},2]|[["q"],1,2,null,1]|[[1,2]]|[["yz"],20,42,null,1]|[["ᵃb","b"],0,3,null,2]|[["12345"],0,5,null,1]|[["u"],1,2,null,1]|null|TypeError|[["ab","b"],0,2,null,2]|[["ab","b"],0,2,null,2]|[["b",null,"b"],0,1,null,3]|1|300|0';
console.log(got === expected ? 'PASS regexp quick exec' : 'FAIL ' + got);
if (got !== expected) throw new Error('regexp quick exec regressions');
