// SilkJS regression test for object spread sharing the source's shape: the copy must
// see only enumerable own data properties, keep its own identity and prototype, and
// stay independent of the source. Expected values come from V8.
var r = [];
var p = {a:1, b:"s", c:{}}; var q = {...p}; q.a = 5; r.push(p.a, q.a, q.b, Object.keys(q).join(), q.c === p.c);
var o = Object.create({inh:1}); o.x = 1; r.push(JSON.stringify({...o}), 'inh' in {...o});
var d = {x:1, y:2}; delete d.x; r.push(JSON.stringify({...d}));
var g = {get z(){return 3}, w:1}; var cg = {...g}; r.push(JSON.stringify(cg), Object.getOwnPropertyDescriptor(cg,'z').value);
var ne = {a:1}; Object.defineProperty(ne,'h',{value:2,enumerable:false}); r.push(JSON.stringify({...ne}), Object.keys({...ne}).join());
var sy = Symbol('s'); var sv = {[sy]:1, 2:'two', k:'k', 1:'one'}; var c = {...sv}; r.push(c[sy], Object.keys(c).join());
var fr = Object.freeze({a:1}); var cf = {...fr}; cf.a=2; r.push(cf.a, Object.isFrozen(cf), Object.getOwnPropertyDescriptor(cf,'a').writable);
var n = Object.create(null); n.a=1; var cn = {...n}; r.push(Object.getPrototypeOf(cn) === Object.prototype, cn.a);
r.push(JSON.stringify({...[1,2]}));
var e = {}; var ce = {...e}; ce.x=1; r.push(JSON.stringify(e), JSON.stringify(ce));
var big = {}; for (var i=0;i<40;i++) big['k'+i]=i; var cb = {...big}; cb.k0 = 'z'; delete cb.k1; r.push(big.k0, big.k1, cb.k0, cb.k39, Object.keys(cb).length, Object.keys(big).length);
var t = {...p, d:4}; r.push(Object.keys(t).join(), p.d);
var u = {z:0, ...p}; r.push(Object.keys(u).join());
function P(){ this.m = 1; } P.prototype.pm = 2; var pi = new P(); var cpi = {...pi}; r.push(JSON.stringify(cpi), cpi.pm, cpi instanceof P);
var ns = Object.preventExtensions({a:1}); var cns = {...ns}; cns.b = 2; r.push(Object.isExtensible(cns), cns.b);
var x1 = {a:1}, x2 = {...x1}; x2.b = 2; var x3 = {...x1}; r.push(Object.keys(x3).join(), x1.b);
var obj = {a: 1}; obj.self = obj; var cs = {...obj}; r.push(cs.self === obj, cs.self.self === obj);
const got = r.join(';');
const expected = '"1;5;s;a,b,c;true;{\\"x\\":1};false;{\\"y\\":2};{\\"z\\":3,\\"w\\":1};3;{\\"a\\":1};a;1;1,2,k;2;false;true;true;1;{\\"0\\":1,\\"1\\":2};{};{\\"x\\":1};0;1;z;39;39;40;a,b,c,d;;z,a,b,c;{\\"m\\":1};;false;true;2;a;;true;true"';
console.log(JSON.stringify(got) === expected ? 'PASS object spread shape' : 'FAIL ' + got);
if (JSON.stringify(got) !== expected) throw new Error('object spread regressions');
