// Anonymous functions named by their binding at creation (OP_set_name folded in).
const r = [];
var f = function () {}; r.push(f.name);
let g = () => 1; r.push(g.name);
const h = function named() {}; r.push(h.name);
var o = { m: function () {}, n: () => 0, ['c' + 1]: function () {} }; r.push(o.m.name, o.n.name, o.c1.name);
function withDefault(x = function () {}) { return x.name; } r.push(withDefault());
var a; a = function () {}; r.push(a.name);
var gen = function* () {}; r.push(gen.name);
var asy = async function () {}; r.push(asy.name);
class K { static s = function () {}; } r.push(K.s.name);
r.push(Object.getOwnPropertyNames(f).join(','));
var d = Object.getOwnPropertyDescriptor(f, 'name'); r.push(d.writable, d.enumerable, d.configurable);
var list = []; for (var i = 0; i < 3; i++) { var q = function () { return i; }; list.push(q.name); } r.push(list.join(','));
var [dz = function () {}] = []; r.push(dz.name);
const got = r.join('|');
const expected = 'f|g|named|m|n|c1|x|a|gen|asy|s|length,name,prototype|false|false|true|q,q,q|dz';
console.log(got === expected ? 'PASS function name inference' : 'FAIL ' + got);
if (got !== expected) throw new Error('function name inference regressions');
