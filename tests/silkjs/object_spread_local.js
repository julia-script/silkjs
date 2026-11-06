// SilkJS regression test for {...source} of a local or argument, which the VM
// builds straight from the source's shape (objects.cloneSpread): the copy must
// match a generic spread for every source kind and stay independent of it.
// Expected values come from V8.
var r = [];
function locals(a, b, c, d, e) {
  var o = { x: 1, y: "s", z: [1, 2] };
  var c1 = { ...o };
  var c2 = { ...a };
  var c3 = { ...e };
  let l = { p: { q: 3 } };
  var c4 = { ...l };
  c1.z.push(3); c1.x = 9;
  return [JSON.stringify([c1, c2, c3, c4]), o.x, c1.z === o.z, Object.keys(c1).join()];
}
r.push(locals({ m: 1, n: 2 }, 0, 0, 0, { k: "v" }).join("|"));
function h(s) { return { ...s }; }
r.push(JSON.stringify(h({ get a() { return 7; }, b: 2 })), JSON.stringify(h(null)), JSON.stringify(h(undefined)), JSON.stringify(h("ab")), JSON.stringify(h([5, 6])));
var child = Object.create({ inh: 1 }); child.own = 2;
r.push(JSON.stringify(h(child)), Object.getPrototypeOf(h(child)) === Object.prototype);
var nf = { a: 1 }; Object.defineProperty(nf, "hid", { value: 9, enumerable: false });
r.push(JSON.stringify(h(nf)), Object.getOwnPropertyNames(h(nf)).join());
var big = {}; for (var i = 0; i < 40; i++) big["k" + i] = i; big[3] = "three";
var cb = h(big); r.push(Object.keys(cb).length, cb.k39, cb[3], Object.keys(cb)[0]);
var del = { a: 1, b: 2 }; delete del.a; r.push(JSON.stringify(h(del)));
var sym = Symbol("s"); var ws = { a: 1, [sym]: 2 }; r.push(h(ws)[sym], JSON.stringify(h(ws)));
var grown = h({ a: 1 }); grown.b = 2; for (var g = 0; g < 20; g++) grown["g" + g] = g;
r.push(Object.keys(grown).length, JSON.stringify(h({ a: 1 })));
function tdz() { try { var t = { ...q }; let q = 1; return "no error"; } catch (e) { return e.constructor.name; } }
r.push(tdz());
for (var j = 0; j < 3; j++) { (function () { var src = { v: j, w: { j: j } }; var cc = { ...src }; r.push(cc.v, cc.w.j, cc.w === src.w); })(); }
var cf = h(Object.freeze({ a: 1 })); cf.a = 5; r.push(cf.a, Object.isFrozen(cf));
function many() { var src = { a: 1, b: { c: 2 } }; var out = []; for (var k = 0; k < 200; k++) out.push({ ...src }); return out; }
var m = many(); r.push(m.length, m[199].b === m[0].b, JSON.stringify(m[50]));
const got = r.join(";");
const expected = "[{\"x\":9,\"y\":\"s\",\"z\":[1,2,3]},{\"m\":1,\"n\":2},{\"k\":\"v\"},{\"p\":{\"q\":3}}]|1|true|x,y,z;{\"a\":7,\"b\":2};{};{};{\"0\":\"a\",\"1\":\"b\"};{\"0\":5,\"1\":6};{\"own\":2};true;{\"a\":1};a;41;39;three;3;{\"b\":2};2;{\"a\":1};22;{\"a\":1};ReferenceError;0;0;true;1;1;true;2;2;true;5;false;200;true;{\"a\":1,\"b\":{\"c\":2}}";
console.log(got === expected ? "PASS object spread local" : "FAIL " + got);
if (got !== expected) throw new Error("object spread local regressions");
