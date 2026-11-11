// obj[symbol] reads, overwrites and adds take field fast paths; each case
// checks they keep [[Get]]/[[Set]] semantics.
'use strict';
const r = [];
const k = Symbol('k'), g = Symbol('g'), ro = Symbol('ro'), s = Symbol('s');
class T { constructor(v) { this[k] = v; } }
const t = new T(1); t[k] = t[k] + 1; r.push(t[k]);
// Inherited data property: read finds it, write adds an own property.
const proto = { [k]: 10 }; const child = Object.create(proto);
r.push(child[k]); child[k] = 11; r.push(child[k], proto[k], Object.getOwnPropertySymbols(child).length);
// Accessors on the object and on the prototype.
let seen = 0;
const acc = { get [g]() { return 7; }, set [g](v) { seen = v; } };
r.push(acc[g]); acc[g] = 5; r.push(seen);
const viaProto = Object.create(acc); viaProto[g] = 9; r.push(seen, Object.getOwnPropertySymbols(viaProto).length);
// Non-writable, frozen and non-extensible objects throw in strict code.
const frozen = Object.defineProperty({}, ro, { value: 1, writable: false });
try { frozen[ro] = 2; r.push('no'); } catch (e) { r.push(e instanceof TypeError, frozen[ro]); }
const sealed = Object.preventExtensions({});
try { sealed[s] = 1; r.push('no'); } catch (e) { r.push(e instanceof TypeError, sealed[s]); }
const ice = Object.freeze({ [k]: 3 });
try { ice[k] = 4; r.push('no'); } catch (e) { r.push(ice[k]); }
// Proxy traps, arrays, functions and a missing key.
const log = [];
const p = new Proxy({}, { get(o, key) { log.push('get'); return 42; }, set(o, key, v) { log.push('set'); o[key] = v; return true; } });
p[k] = 1; r.push(p[k], log.join(''));
const a = [1, 2]; a[k] = 'x'; a[k] = 'y'; r.push(a[k], a.length);
function f() {} f[k] = 'fn'; f[k] += '!'; r.push(f[k]);
r.push(({})[Symbol('missing')] === undefined);
// Well-known symbols through the prototype chain.
r.push(typeof [][Symbol.iterator], typeof Map.prototype[Symbol.toStringTag]);
// Many symbol fields on one object, rewritten in a loop.
const keys = []; for (let i = 0; i < 20; i++) keys.push(Symbol(i));
const many = {}; for (let n = 0; n < 3; n++) for (let i = 0; i < keys.length; i++) many[keys[i]] = (many[keys[i]] | 0) + i;
let sum = 0; for (const key of keys) sum += many[key]; r.push(sum);
// Symbol keys of exotic objects keep their own [[Set]].
const ta = new Uint8Array(2); ta[k] = 5; r.push(ta[k]);
const str = new String('ab'); str[k] = 6; r.push(str[k]);
const got = r.join('|');
const expected = '2|10|11|10|1|7|5|9|0|true|1|true||3|42|setget|y|2|fn!|true|function|string|570|5|6';
console.log(got === expected ? 'PASS symbol element keys' : 'FAIL ' + got);
if (got !== expected) throw new Error('symbol element key regressions');
