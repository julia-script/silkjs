// SilkJS regression test for this[symbol] = v adds in the symbol store fast
// path (js_vm_property_ops.storeSymbolOperand): verified memo adds, setters and
// read-only properties on the prototype, frozen and non-extensible receivers,
// proxies, arrays and repeated adds.
const out = [];
const a = Symbol('a'), b = Symbol('b'), c = Symbol('c');
class T { constructor(x) { this[a] = x; this[b] = x + 1 } }
let t; for (let i = 0; i < 6; i++) t = new T(i); out.push(t[a] + ',' + t[b] + ',' + Object.getOwnPropertySymbols(t).length);
class S { constructor() { this[c] = 1 } }
for (let i = 0; i < 4; i++) new S();
Object.defineProperty(S.prototype, c, { set(v) { out.push('setter ' + v) }, configurable: true });
const s = new S(); out.push(Object.getOwnPropertySymbols(s).length);
delete S.prototype[c]; Object.defineProperty(S.prototype, c, { value: 0, writable: false, configurable: true });
for (let i = 0; i < 2; i++) { try { new S() } catch (e) { out.push(e.constructor.name) } }
delete S.prototype[c]; const s2 = new S(); out.push(Object.getOwnPropertySymbols(s2).length, s2[c]);
function put(o, v) { 'use strict'; o[a] = v }
const objs = [{}, Object.freeze({}), Object.preventExtensions({}), [], new Proxy({}, { set(t, k, v) { out.push('trap'); t[k] = v; return true } })];
for (const o of objs) { try { put(o, 5); out.push(String(o[a])) } catch (e) { out.push(e.constructor.name) } }
const many = {}; for (let i = 0; i < 3; i++) { many[a] = i; many[b] = i } out.push(many[a] + many[b]);
const got = out.join('\n');
const expected = "5,6,2\nsetter 1\n0\nTypeError\nTypeError\n1\n1\n5\nTypeError\nTypeError\n5\ntrap\n5\n4";
console.log(got === expected ? 'PASS symbol store adds' : 'FAIL ' + JSON.stringify(got));
if (got !== expected) throw new Error('symbol store add regressions');
