// Predefined string and symbol keys must retain their identities and descriptors.
const out = [];
out.push(Array.prototype[Symbol.iterator] === Array.prototype.values);
out.push(Object.getOwnPropertyDescriptor(Array, Symbol.species).get.name);
out.push(RegExp.prototype[Symbol.match].name);
out.push(Object.getOwnPropertyDescriptor(Object.prototype, '__proto__').get.name);
out.push(Reflect.get.name, Promise.prototype.catch.name, Date.prototype.toISOString.name);
out.push(Object.prototype.hasOwnProperty.call(Array.prototype, 'Symbol.iterator'));
out.push(Object.getOwnPropertyDescriptor(globalThis, 'Infinity').writable);
out.push(Object.getOwnPropertyDescriptor(Promise, Symbol.species).get.call(Promise) === Promise);
const inherited = Object.create(Math);
function readLate() { return inherited.__intrinsicProbe; }
out.push(readLate() === undefined);
Object.defineProperty(Math, '__intrinsicProbe', { value: 7, writable: true, configurable: true });
out.push(readLate());
Math.__intrinsicProbe = 9;
out.push(readLate());
delete Math.__intrinsicProbe;
out.push(readLate() === undefined);
const got = out.join('\n');
const expected = 'true\nget [Symbol.species]\n[Symbol.match]\nget __proto__\nget\ncatch\ntoISOString\nfalse\nfalse\ntrue\ntrue\n7\n9\ntrue';
if (got !== expected) throw new Error(got);
console.log('PASS predefined intrinsic atoms');
