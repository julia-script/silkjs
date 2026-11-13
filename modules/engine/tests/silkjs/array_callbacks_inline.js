// SilkJS regression test for Array callback methods run in the caller's dispatch
// loop (js_vm_iteration) and bound functions entered inline or made by the quick
// bind path: this values, holes, mutation during the loop, species, proxies,
// throws, reduce edge cases, bound chains, bind's length and name. Expected
// values come from Node.
var r = [];
function show(name, f) { try { r.push(name + '=' + JSON.stringify(f())); } catch (e) { r.push(name + '!' + e.constructor.name); } }
show('forEach', () => { var s = 0; a.forEach(function (x, i, o) { s += x * i + o.length; }); return s; });
show('forEach this', () => { var r = []; a.forEach(function (x) { r.push(this.k + x); }, { k: 10 }); return r; });
show('forEach sloppy this', () => { var r; [1].forEach(function () { r = typeof this; }); return r; });
show('forEach strict this', () => { var r; [1].forEach(function () { 'use strict'; r = typeof this; }); return r; });
show('map', () => a.map((x) => x * 2));
show('map String', () => ['a', 1, null].map(String));
show('map holes', () => [1, , 3].map((x) => x + 1));
show('map holes len', () => { var m = [1, , 3].map((x) => x); return [m.length, 1 in m]; });
show('filter', () => a.filter((x) => x & 1));
show('some', () => [a.some((x) => x > 3), a.some((x) => x > 9)]);
show('every', () => [a.every((x) => x > 0), a.every((x) => x < 3)]);
show('reduce', () => a.reduce((s, x) => s + x));
show('reduce init', () => a.reduce((s, x, i, o) => s + x * i + o.length, 100));
show('reduceRight', () => ['a', 'b', 'c'].reduceRight((s, x) => s + x));
show('reduce empty', () => [].reduce((s, x) => s + x));
show('reduce empty init', () => [].reduce((s, x) => s + x, 7));
show('reduce holes', () => [, , 3, , 5].reduce((s, x) => s + x));
show('not callable', () => a.forEach(5));
show('no args', () => a.map());
show('mutate push', () => { var b = [1, 2]; var n = 0; b.forEach((x) => { n++; if (b.length < 6) b.push(x); }); return [n, b]; });
show('mutate shrink', () => { var b = [1, 2, 3, 4]; var seen = []; b.forEach((x) => { seen.push(x); b.length = 2; }); return seen; });
show('array-like', () => Array.prototype.map.call({ length: 3, 0: 'a', 2: 'c' }, (x) => x + '!'));
show('string', () => Array.prototype.map.call('abc', (x) => x.toUpperCase()));
show('throws in cb', () => a.forEach((x) => { if (x == 3) throw new RangeError('boom ' + x); }));
show('call', () => Array.prototype.forEach.call(a, function () {}) === undefined);
show('apply', () => Array.prototype.map.apply(a, [(x) => -x]));
show('uncurry', () => { var call = Function.prototype.call; var m = call.bind(Array.prototype.map); return m(a, (x) => x + 100); });
show('bound cb', () => a.map(function (x) { return this.k + x; }.bind({ k: 1 })));
show('bound args', () => { function f(p, q, x) { return p + q + x; } var g = f.bind(null, 1, 2); return a.map((x) => g(x)); });
show('bound new', () => { function P(x, y) { this.v = x + y; } var B = P.bind(null, 1); return new B(2).v; });
show('bound chain', () => { function f(a, b, c) { return [this && this.n, a, b, c]; } var g = f.bind({ n: 1 }, 'a').bind({ n: 2 }, 'b'); return g('c'); });
show('species', () => { class M extends Array {} var m = new M(1, 2, 3); var r = m.map((x) => x); return [r instanceof M, r.length]; });
show('proxy', () => { var p = new Proxy([1, 2], {}); return p.map((x) => x * 3); });
show('nested', () => [[1, 2], [3]].map((r) => r.map((x) => x * 10)));
show('deep recursion', () => { function d(n) { return n == 0 ? 0 : [n].map((x) => d(x - 1) + 1)[0]; } return d(500); });
show('closure counter', () => { let n = 0; for (let i = 0; i < 1000; i++) a.forEach((x) => { n += x; }); return n; });
show('return early every', () => { var c = 0; a.every((x) => { c++; return x < 2; }); return c; });
show('generator cb', () => a.map(function* () {}).length);
show('async cb', () => a.map(async (x) => x).length);
show('class cb', () => { class C {} return a.map(C); });
show('forEach len getter', () => { var o = { get length() { return 2; }, 0: 'x', 1: 'y' }; var r = []; Array.prototype.forEach.call(o, (v) => r.push(v)); return r; });
show('filter species 0', () => [1,2,3].filter(x => x > 1).length);
show('thisArg prim', () => { var t; [1].forEach(function () { 'use strict'; t = this; }, 5); return t; });
function bf(a, b, c) { return [this && this.x, a, b, c].join(); }
var bg = bf.bind({ x: 1 }, 2);
show('bind props', () => [bg.name, bg.length, bg(3, 4), Object.getOwnPropertyNames(bg).join(), JSON.stringify(Object.getOwnPropertyDescriptor(bg, 'name')), JSON.stringify(Object.getOwnPropertyDescriptor(bg, 'length'))]);
show('bind twice', () => { var h = bg.bind(null, 5); return [h.name, h.length, h(6)]; });
show('bind class', () => { class C { constructor(x) { this.x = x; } } var B = C.bind(null, 7); return [new B().x, B.name, B.length, new B() instanceof C]; });
show('bind arrow', () => { var k = (() => {}).bind(); return [k.name, k.length]; });
show('bind name getter', () => { function m() {} Object.defineProperty(m, 'name', { get() { return 'getter'; } }); return m.bind().name; });
show('bind float length', () => { function n() {} Object.defineProperty(n, 'length', { value: 2.7 }); return [n.bind().length, n.bind(1, 2, 3, 4).length]; });
show('bind no name', () => { function o() {} delete o.name; return o.bind().name; });
show('bind no length', () => { function p() {} delete p.length; return p.bind().length; });
show('bind null proto', () => { function q() {} Object.setPrototypeOf(q, null); return Object.getPrototypeOf(Function.prototype.bind.call(q)); });
show('bind native', () => { var b = Math.max.bind(null, 1); return [b.name, b.length, b(5)]; });
show('bind add prop', () => { var b = bf.bind(); b.extra = 1; return [b.extra, Object.keys(b).join(), b.name]; });
show('bind symbol name', () => { function u() {} Object.defineProperty(u, 'name', { value: Symbol('x') }); return u.bind().name; });
show('bind loop names', () => { var out = []; [function a() {}, function b() {}, function a() {}].forEach((f) => out.push(f.bind().name)); return out; });
show('bound leaf this', () => { var g = function () { return this.v; }.bind({ v: 9 }); var s = 0; for (var i = 0; i < 50; i++) s += g(); return s; });
show('missing method arg', () => { var seven = 7; var o = []; for (var i = 0; i < 3; i++) { try { seven.at(i); } catch (e) { o.push(e.constructor.name); } } return o; });
show('missing method args', () => { var o = []; for (var i = 0; i < 3; i++) { try { (void 0, {}).nope(1, 2, 3); } catch (e) { o.push(e.constructor.name); } } return o; });
const got = r.join('|');
const expected = "forEach!ReferenceError|forEach this!ReferenceError|forEach sloppy this=\"object\"|forEach strict this=\"undefined\"|map!ReferenceError|map String=[\"a\",\"1\",\"null\"]|map holes=[2,null,4]|map holes len=[3,false]|filter!ReferenceError|some!ReferenceError|every!ReferenceError|reduce!ReferenceError|reduce init!ReferenceError|reduceRight=\"cba\"|reduce empty!TypeError|reduce empty init=7|reduce holes=8|not callable!ReferenceError|no args!ReferenceError|mutate push=[2,[1,2,1,2]]|mutate shrink=[1,2]|array-like=[\"a!\",null,\"c!\"]|string=[\"A\",\"B\",\"C\"]|throws in cb!ReferenceError|call!ReferenceError|apply!ReferenceError|uncurry!ReferenceError|bound cb!ReferenceError|bound args!ReferenceError|bound new=3|bound chain=[1,\"a\",\"b\",\"c\"]|species=[true,3]|proxy=[3,6]|nested=[[10,20],[30]]|deep recursion=500|closure counter!ReferenceError|return early every!ReferenceError|generator cb!ReferenceError|async cb!ReferenceError|class cb!ReferenceError|forEach len getter=[\"x\",\"y\"]|filter species 0=2|thisArg prim=5|bind props=[\"bound bf\",2,\"1,2,3,4\",\"length,name\",\"{\\\"value\\\":\\\"bound bf\\\",\\\"writable\\\":false,\\\"enumerable\\\":false,\\\"configurable\\\":true}\",\"{\\\"value\\\":2,\\\"writable\\\":false,\\\"enumerable\\\":false,\\\"configurable\\\":true}\"]|bind twice=[\"bound bound bf\",1,\"1,2,5,6\"]|bind class=[7,\"bound C\",0,true]|bind arrow=[\"bound \",0]|bind name getter=\"bound getter\"|bind float length=[2,0]|bind no name=\"bound \"|bind no length=0|bind null proto=null|bind native=[\"bound max\",1,5]|bind add prop=[1,\"extra\",\"bound bf\"]|bind symbol name=\"bound \"|bind loop names=[\"bound a\",\"bound b\",\"bound a\"]|bound leaf this=450|missing method arg=[\"TypeError\",\"TypeError\",\"TypeError\"]|missing method args=[\"TypeError\",\"TypeError\",\"TypeError\"]";
console.log(got === expected ? 'PASS array callbacks inline' : 'FAIL ' + got);
if (got !== expected) throw new Error('array callback regressions');
