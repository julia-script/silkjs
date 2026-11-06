// SilkJS regression test for `obj.f = v;` statements on locals and arguments. With
// a local object and a local or argument value the compiler fuses them into
// put_loc_field_loc8 or put_loc_field_arg8 (both read in place): every store
// path (own field, add, setter, proxy, frozen, primitive, throwing setter) and the
// arguments object as a value must behave as put_field. Expected values come from V8.
var r = [];
function a(o, v) { o.x = v; o.y = 3; o.z = null; o.w = true; o.u = undefined; o.big = 123456; return o; }
r.push(JSON.stringify(a({}, 1)), JSON.stringify(a({x: 0, y: 0}, "s")));
function loc() { var o = {a: 1}; var j = 7; o.a = j; o.b = j; o.c = -1; return JSON.stringify(o); }
r.push(loc());
function setter() { var log = []; var o = { set p(v) { log.push(v); } }; var k = 5; o.p = k; o.p = 9; return log.join(); }
r.push(setter());
function ro() { "use strict"; var o = Object.freeze({q: 1}); var v = 2; try { o.q = v; return "no"; } catch (e) { return e.constructor.name; } }
r.push(ro());
function sloppyRo() { var o = Object.freeze({q: 1}); var v = 2; o.q = v; return o.q; }
r.push(sloppyRo());
function bad(o) { var v = 1; try { o.x = v; } catch (e) { return e.constructor.name; } return "ok"; }
r.push(bad(undefined), bad(null), bad(5), bad("s"));
function arr() { var a = [1, 2]; var n = 0; a.length = n; return a.length; }
r.push(arr());
function proto() { var p = {}; var o = Object.create(p); var v = 4; o.k = v; return Object.keys(o).join() + Object.keys(p).length; }
r.push(proto());
function loop() { var o = {a: 0, b: 0}; for (var j = 0; j < 1000; j++) { o.a = j; o.b = j; } return o.a + o.b; }
r.push(loop());
function self() { var o = {}; o.me = o; return o.me === o; }
r.push(self());
function args() { var o = {}; o.n = arguments.length; return o.n; }
r.push(args(1, 2, 3));
function alias() { var a = arguments; a.extra = 1; return a.extra + arguments.length; }
r.push(alias(1, 2));
function getsetargs(o) { o.v = o; return o.v === o; }
r.push(getsetargs({}));
var g = { n: 0 }; function leafSet(o, v) { o.n = v; } for (var i = 0; i < 100; i++) leafSet(g, i); r.push(g.n);
function C(x) { this.x = x; var t = this; t.y = x; } var c = new C(3); r.push(c.x, c.y);
function tdz() { var o = {}; try { o.v = q; let q = 1; } catch (e) { return e.constructor.name; } }
r.push(tdz());
function prox() { var log = []; var o = new Proxy({}, { set(t, k, v) { log.push(k + "=" + v); t[k] = v; return true; } }); var v = 8; o.pk = v; return log.join(); }
r.push(prox());
function al() { var a = arguments; var o = {}; o.x = a; return o.x.length + ":" + o.x[1]; }
r.push(al(1, 2, 3));
function al2() { var o = {}; o.x = arguments; return o.x.length; }
r.push(al2(4, 5));
function al3() { var o = {}; var a = arguments; o.y = a; return Array.prototype.join.call(o.y); }
r.push(al3(6, 7));
function ap(f) { var a = arguments; var o = {}; o.k = a; return f.apply(null, a); }
r.push(ap(function () { return arguments.length; }, 1, 2));
function prefill(c) { var o = {}; var v; if (c) v = 1; o.p = v; return o.p; }
r.push(prefill(false), prefill(true));
function loops() { var o = {}; for (let i = 0; i < 3; i++) { let w = i * 2; o["k"] = w; o.last = w; } return o.last; }
r.push(loops());
function arg2(o, v) { o.q = v; return o; }
for (var i = 0; i < 50; i++) arg2({}, i);
r.push(JSON.stringify(arg2({}, "z")), JSON.stringify(arg2({ q: 1 }, [1])));
function leafy(o, v) { o.s = v; }
var t = {}; for (var i = 0; i < 100; i++) leafy(t, { n: i }); r.push(t.s.n);
function strictSet() { "use strict"; var o = Object.preventExtensions({}); var v = 1; try { o.n = v; } catch (e) { return e.constructor.name; } return "ok"; }
r.push(strictSet());
function refc() { var o = {}; var big = { a: [1, 2, 3] }; for (var i = 0; i < 10; i++) { o.b = big; o.b = big; } big = null; return o.b.a.length; }
r.push(refc());
function setterThrows() { var o = { set z(v) { throw new Error("no " + v); } }; var v = 3; try { o.z = v; } catch (e) { return e.message; } }
r.push(setterThrows());
function overwriteHeap() { var o = { s: "a" + Math.random() }; var v = "b"; for (var i = 0; i < 5; i++) o.s = v; return o.s; }
r.push(overwriteHeap());
const got = r.join(";");
const expected = "{\"x\":1,\"y\":3,\"z\":null,\"w\":true,\"big\":123456};{\"x\":\"s\",\"y\":3,\"z\":null,\"w\":true,\"big\":123456};{\"a\":7,\"b\":7,\"c\":-1};5,9;TypeError;1;TypeError;TypeError;ok;ok;0;k0;1998;true;3;3;true;99;3;3;ReferenceError;pk=8;3:2;2;6,7;3;;1;4;{\"q\":\"z\"};{\"q\":[1]};99;TypeError;3;no 3;b";
console.log(got === expected ? "PASS fused field stores" : "FAIL " + got);
if (got !== expected) throw new Error("fused field store regressions");
