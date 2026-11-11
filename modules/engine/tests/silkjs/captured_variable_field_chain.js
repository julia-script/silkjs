// SilkJS regression test for js_vm_property_ops.pushChained: a captured or
// scope variable directly followed by field reads (`Namespace.Enum.Member`) is
// read in one step without pushing the variable's object. Covers shape changes
// under a warm site, non-object links, missing fields, getters, a throwing
// link, and enough calls for the functions to run inline. Expected values
// come from V8.
var NS = { K: { A: 1, B: 2, o: { v: 2.5 } }, s: "str", n: null, get g() { return { z: 4 }; } };
function make() {
  var L = { K: { A: 7, B: 8 }, t: "text" };
  L.f = function (x) { return x == L.K.A || x === NS.K.B; };
  L.g = function () { return NS.K.o.v * 2 + L.K.B; };
  L.h = function () { return NS.s.length + L.t.length + (NS.n == null ? 1 : 0); };
  L.u = function () { return NS.q === undefined && NS.K.zz === undefined; };
  L.w = function () { return NS.g.z + (typeof NS.K.o); };
  L.e = function () { try { return NS.n.x.y; } catch (e) { return e instanceof TypeError; } };
  return L;
}
function run() {
  var L = make(), out = [];
  for (var i = 0; i < 6; i++) {
    out.push(L.f(i + 5), L.f(2), L.g(), L.h(), L.u(), L.w(), L.e());
    if (i == 2) NS.K = { B: 2, A: 1, o: { v: 1.5 } };
    if (i == 3) { NS.K.o = { w: 1, v: 9 }; L.K = { B: 1, A: 9 }; }
    if (i == 4) { NS.K.o = 5; NS.s = { length: 10 }; }
  }
  NS.K = { A: 1, B: 2, o: { v: 2.5 } }; NS.s = "str";
  return out.join(',');
}
const got = run() + '|' + run();
const expected = 'false,true,13,8,true,4object,true,false,true,13,8,true,4object,true,true,true,13,8,true,4object,true,false,true,11,8,true,4object,true,true,true,19,8,true,4object,true,false,true,NaN,15,true,4number,true|false,true,13,8,true,4object,true,false,true,13,8,true,4object,true,true,true,13,8,true,4object,true,false,true,11,8,true,4object,true,true,true,19,8,true,4object,true,false,true,NaN,15,true,4number,true';
console.log(got === expected ? 'PASS captured variable field chain' : 'FAIL ' + got);
if (got !== expected) throw new Error('captured variable field chain regressions');
