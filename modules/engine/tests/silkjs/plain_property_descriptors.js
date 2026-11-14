// SilkJS regression test for property descriptors read straight from plain
// objects (Object.defineProperty/defineProperties) and promise resolving
// functions made with the pinned closure shape: prototype keys, accessors on
// descriptors and sources, null-prototype descriptors, proxies, key order.
// Expected values from Node.
var out = [];
var o = {}; Object.defineProperties(o, { a: { value: 1, writable: true }, b: { get: function () { return 2; }, enumerable: true }, c: { value: 3 } });
out.push(JSON.stringify(Object.getOwnPropertyDescriptors(o), function (k, v) { return typeof v === 'function' ? 'fn' : v; }));
try { Object.defineProperty({}, 'x', { get: 1 }); } catch (e) { out.push(e.constructor.name); }
try { Object.defineProperty({}, 'x', { get: function () {}, value: 1 }); } catch (e) { out.push(e.constructor.name); }
Object.prototype.enumerable = true;
var p = {}; Object.defineProperty(p, 'y', { value: 1 }); out.push(Object.getOwnPropertyDescriptor(p, 'y').enumerable);
delete Object.prototype.enumerable;
var q = {}; Object.defineProperty(q, 'y', { value: 1 }); out.push(Object.getOwnPropertyDescriptor(q, 'y').enumerable);
Object.defineProperty(Object.prototype, 'value', { get: function () { return 'proto'; }, configurable: true });
var r2 = {}; Object.defineProperty(r2, 'z', {}); out.push(r2.z);
delete Object.prototype.value;
var d = { value: 5, get writable() { out.push('getter ran'); return true; } }; var s = {}; Object.defineProperty(s, 'w', d); out.push(Object.getOwnPropertyDescriptor(s, 'w').writable);
var n = Object.create(null); n.value = 7; var t = {}; Object.defineProperty(t, 'v', n); out.push(t.v);
var props = { a: { value: 1 }, b: { value: 2, enumerable: true } };
Object.defineProperty(props, 'hidden', { value: { value: 9 }, enumerable: false });
Object.defineProperty(props, 'acc', { get: function () { out.push('acc read'); return { value: 3 }; }, enumerable: true });
props[Symbol.for('s')] = { value: 4 };
props[2] = { value: 5 }; props[1] = { value: 6 };
var o2 = {}; Object.defineProperties(o2, props);
out.push(Reflect.ownKeys(o2).map(String).join(' '), o2.hidden, o2.acc, o2[Symbol.for('s')], o2[1], o2[2]);
var arr = [{ value: 'x' }]; var t2 = {}; Object.defineProperties(t2, arr); out.push(t2[0]);
var pr = new Proxy({ k: { value: 1 } }, { getOwnPropertyDescriptor: function (tg, k) { out.push('gopd ' + String(k)); return Reflect.getOwnPropertyDescriptor(tg, k); } }); var u = {}; Object.defineProperties(u, pr); out.push(u.k);
try { Object.defineProperties({}, { a: { value: 1 }, b: 5 }); } catch (e) { out.push(e.constructor.name); }
new Promise(function (res, rej) { out.push(res.length, JSON.stringify(res.name), Object.getOwnPropertyNames(rej).join(' '), Object.getPrototypeOf(res) === Function.prototype, res === rej, delete res.name, res.name === undefined ? 'gone' : 'kept'); });
var got = out.join('|');
var expected = "{\"a\":{\"value\":1,\"writable\":true,\"enumerable\":false,\"configurable\":false},\"b\":{\"get\":\"fn\",\"enumerable\":true,\"configurable\":false},\"c\":{\"value\":3,\"writable\":false,\"enumerable\":false,\"configurable\":false}}|TypeError|TypeError|true|false|proto|getter ran|true|7|acc read|1 2 a b acc Symbol(s)||3|4|6|5|x|gopd k|1|TypeError|1|\"\"|length name|true|false|true|kept";
console.log(got === expected ? 'PASS plain property descriptors' : 'FAIL ' + got);
if (got !== expected) throw new Error('plain property descriptor regressions');
