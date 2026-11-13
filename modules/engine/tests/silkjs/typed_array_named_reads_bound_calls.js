// SilkJS regression test for named reads on typed arrays (methods and the
// length, byteLength, byteOffset and buffer getters take the ordinary paths,
// while canonical numeric keys such as NaN and Infinity stay the typed
// array's own), bound calls with no bound arguments (primordials'
// uncurryThis), and integer ** integer literals folded at compile time.
// Expected values come from Node.
var r = [];
// Named reads and getters, own and inherited, on typed arrays and subclasses.
class Fast extends Uint8Array { tag() { return 'fast' + this.length; } }
var b = new Fast(16), u = new Uint8Array(8), sub = b.subarray(4, 12);
var lens = 0;
for (var i = 0; i < 50; i++) { lens += b.byteLength + sub.byteOffset + sub.length + u.byteLength; }
r.push(lens, b.tag(), typeof b.subarray, sub.buffer === b.buffer, b.buffer.byteLength);
b.own = 7; r.push(b.own, u.own);
// Canonical numeric names are the typed array's: never read from prototypes.
Uint8Array.prototype.NaN = 'p'; Uint8Array.prototype.Infinity = 'q'; Uint8Array.prototype.extra = 'x';
var fake = Object.create(Uint8Array.prototype);
function readNaN(o) { return o.NaN; }
function readExtra(o) { return o.extra; }
var seen = [];
for (var j = 0; j < 4; j++) { seen.push(readNaN(fake), readNaN(u), readExtra(u), readExtra(fake)); }
r.push(seen.join('/'), u.Infinity, fake.Infinity, u['-0'], u['1.5'], u['1e+21']);
delete Uint8Array.prototype.NaN; delete Uint8Array.prototype.Infinity; delete Uint8Array.prototype.extra;
// Getters on resized, detached and foreign receivers.
var rab = new ArrayBuffer(8, { maxByteLength: 16 }), tracking = new Uint8Array(rab), fixed = new Uint8Array(rab, 4, 4);
rab.resize(12); r.push(tracking.length, tracking.byteLength, fixed.byteLength);
rab.resize(2); r.push(fixed.byteLength, fixed.byteOffset, fixed.length);
var moved = new Uint8Array(4); moved.buffer.transfer(); r.push(moved.byteLength, moved.length);
var byteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;
try { byteLength.call({}); } catch (e) { r.push(e.constructor.name); }
r.push(byteLength.call(new Float64Array(3)), Reflect.apply(byteLength, new Int16Array(5), []));
// Bound calls with no bound arguments, as primordials make them.
var uncurryThis = Function.prototype.bind.bind(Function.prototype.call);
var slice = uncurryThis(Array.prototype.slice), getLength = uncurryThis(byteLength);
r.push(slice([1, 2, 3], 1).join(), getLength(new Uint32Array(2)), slice([4, 5])[1]);
function who() { 'use strict'; return this === undefined ? 'undef' : typeof this; }
var callWho = Function.prototype.call.bind(who);
r.push(callWho(), callWho(5), callWho(undefined, 1));
try { Function.prototype.call.bind({})(1); } catch (e) { r.push(e.constructor.name); }
function add(a, b) { return this.base + a + b; }
var boundAdd = add.bind({ base: 10 }), partial = add.bind({ base: 1 }, 2);
r.push(boundAdd(1, 2), partial(3), boundAdd.bind(null)(3, 4));
function Point(x) { this.x = x; } var P = Point.bind(null); r.push(new P(3).x, new P(4) instanceof Point);
var nested = uncurryThis(uncurryThis(Array.prototype.join)); r.push(nested(Array.prototype.join, ['a', 'b'], '-'));
// Integer powers fold exactly; others keep their runtime value.
r.push(2 ** 24, 2 ** 53, 2 ** 54, (-2) ** 3, 0 ** 0, 3 ** -1, 2 ** 31, 10 ** 15, 10 ** 21, 2 ** 3 ** 2, -(2 ** 4), (1, 2) ** 3, 1 ** 1000000, (-1) ** 65);
var two = 2; r.push(two ** 10, 2 ** two);
const got = r.join();
const expected = '1800,fast16,function,true,16,7,,p//x/x/p//x/x/p//x/x/p//x/x,,q,,,,12,12,4,0,0,0,0,0,TypeError,24,10,2,3,8,5,undef,number,undef,TypeError,13,6,17,3,true,a-b,16777216,9007199254740992,18014398509481984,-8,1,0.3333333333333333,2147483648,1000000000000000,1e+21,512,-16,8,1,-1,1024,4';
console.log(got === expected ? 'PASS typed array named reads, bound calls, folded powers' : 'FAIL ' + got);
if (got !== expected) throw new Error('typed array, bound call or power regressions');
