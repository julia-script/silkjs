// `heap[(x + k) >> s]` with heap a captured variable or a global and x a local
// or an argument: the fusion prefix reads the array where it is held. Every
// kind of array and of x its fast path takes, and every value it must leave to
// the covered instructions.
function assert(actual, expected, message) {
  if (actual !== expected && !(actual !== actual && expected !== expected)) {
    throw new Error(message + ': got ' + actual + ', expected ' + expected);
  }
}
var buffer = new ArrayBuffer(64);
var HEAP32 = new Int32Array(buffer), HEAPU8 = new Uint8Array(buffer), HEAP16 = new Int16Array(buffer), HEAPU16 = new Uint16Array(buffer);
var HEAP8 = new Int8Array(buffer), HEAPU32 = new Uint32Array(buffer), HEAPF32 = new Float32Array(buffer), HEAPF64 = new Float64Array(buffer);
var CLAMPED = new Uint8ClampedArray(buffer), PLAIN = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];
for (var fill = 0; fill < 16; fill++) { HEAP32[fill] = fill * 0x01010101 - 0x7f000000 + fill; }
var holder = HEAP32, missing;
// Globals, x in arguments 0-3 and a later one, and in locals 0-3 and later ones.
function globalArgs(a, b, c, d, e) {
  return [HEAP32[a >> 2], HEAP32[(b + 4) >> 2], HEAPU8[c + 1], HEAP16[(d + -2) >> 1], HEAPU16[e >> 1], HEAP32[(e + 8) >> 2] | 0];
}
function globalLocals(p) {
  var x0 = p, x1 = p + 4, x2 = p + 8, x3 = p + 12, x4 = p + 16, x5 = p + 20;
  return [HEAP32[x0 >> 2], HEAP32[(x1 + 4) >> 2] | 0, HEAPU8[x2 + 3], HEAP8[x3 + 3], HEAPU32[x4 >> 2], HEAPU32[(x5 + -4) >> 2] | 0,
    HEAPF32[x4 >> 2], HEAPF64[(x5 + 4) >> 3], CLAMPED[x5 + 1], PLAIN[x1 >> 2], PLAIN[(x2 + 4) >> 1], PLAIN[x0 + 1]];
}
function expectArgs(a, b, c, d, e) {
  var h32 = HEAP32, u8 = HEAPU8, h16 = HEAP16, u16 = HEAPU16;
  var i = a >> 2, j = (b + 4) >> 2, k = c + 1, l = (d - 2) >> 1, m = e >> 1, n = (e + 8) >> 2;
  return [h32[i], h32[j], u8[k], h16[l], u16[m], h32[n] | 0];
}
function expectLocals(p) {
  var h32 = HEAP32, u8 = HEAPU8, h8 = HEAP8, u32 = HEAPU32, f32 = HEAPF32, f64 = HEAPF64, cl = CLAMPED, pl = PLAIN;
  var i0 = p >> 2, i1 = (p + 8) >> 2, i2 = p + 11, i3 = p + 15, i4 = (p + 16) >> 2, i5 = (p + 16) >> 2, i6 = (p + 24) >> 3, i7 = p + 21;
  var i8 = (p + 4) >> 2, i9 = (p + 12) >> 1, i10 = p + 1;
  return [h32[i0], h32[i1] | 0, u8[i2], h8[i3], u32[i4], u32[i5] | 0, f32[i4], f64[i6], cl[i7], pl[i8], pl[i9], pl[i10]];
}
function same(left, right, message) {
  assert(left.length, right.length, message + ' length');
  for (var at = 0; at < left.length; at++) { assert(left[at], right[at], message + ' [' + at + ']'); }
}
for (var p = 0; p <= 32; p += 4) {
  same(globalArgs(p, p + 4, p + 8, p + 12, p + 16), expectArgs(p, p + 4, p + 8, p + 12, p + 16), 'global heaps, arguments at ' + p);
  same(globalLocals(p), expectLocals(p), 'global heaps, locals at ' + p);
}
// Captured heaps: the same reads from a module-like function's own variables.
var captured = (function () {
  var H32 = new Int32Array(buffer), HU8 = new Uint8Array(buffer), H16 = new Int16Array(buffer), HF64 = new Float64Array(buffer);
  var list = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21], swapped = H32;
  function args(a, b, c, d, e) { return [H32[a >> 2], H32[(b + 4) >> 2], HU8[c + 1], H16[(d + -2) >> 1], list[e >> 2], H32[(e + 8) >> 2] | 0]; }
  function locals(p) {
    var x0 = p, x1 = p + 4, x2 = p + 8, x3 = p + 12, x4 = p + 16, x5 = p + 20;
    return [H32[x0 >> 2], H32[(x1 + 4) >> 2] | 0, HU8[x2 + 3], H16[(x3 + -4) >> 1], HF64[x4 >> 3], list[(x5 + -4) >> 2], list[x0 + 1]];
  }
  function expectA(a, b, c, d, e) {
    var h = H32, u = HU8, s = H16, l = list, i = a >> 2, j = (b + 4) >> 2, k = c + 1, m = (d - 2) >> 1, n = e >> 2, o = (e + 8) >> 2;
    return [h[i], h[j], u[k], s[m], l[n], h[o] | 0];
  }
  function expectL(p) {
    var h = H32, u = HU8, s = H16, f = HF64, l = list, i = p >> 2, j = (p + 8) >> 2, k = p + 11, m = (p + 8) >> 1, n = (p + 16) >> 3, o = (p + 16) >> 2, q = p + 1;
    return [h[i], h[j] | 0, u[k], s[m], f[n], l[o], l[q]];
  }
  // A capture two functions up, and one that changes between reads.
  function deep() { return function (x) { return H32[(x + 4) >> 2] + HU8[x >> 0]; }; }
  function swap(to) { swapped = to; }
  function readSwapped(x) { return swapped[(x + 4) >> 2]; }
  return { args: args, locals: locals, expectA: expectA, expectL: expectL, deep: deep(), swap: swap, readSwapped: readSwapped };
})();
for (var q = 0; q <= 32; q += 4) {
  same(captured.args(q, q + 4, q + 8, q + 12, q + 16), captured.expectA(q, q + 4, q + 8, q + 12, q + 16), 'captured heaps, arguments at ' + q);
  same(captured.locals(q), captured.expectL(q), 'captured heaps, locals at ' + q);
  assert(captured.deep(q), HEAP32[(q >> 2) + 1] + HEAPU8[q], 'a capture two functions up at ' + q);
}
assert(captured.readSwapped(4), HEAP32[2], 'a captured Int32Array');
captured.swap([1, 2, 3, 4]); assert(captured.readSwapped(4), 3, 'then an Array');
captured.swap('abcdef'); assert(captured.readSwapped(4), 'c', 'then a string');
captured.swap({ 2: 'two' }); assert(captured.readSwapped(4), 'two', 'then a plain object');
captured.swap(7); assert(captured.readSwapped(4), undefined, 'then a number');
captured.swap(null);
var threw = false; try { captured.readSwapped(4); } catch (error) { threw = error instanceof TypeError; }
assert(threw, true, 'then null throws');
// What the prefix leaves to the instructions it covers.
function at(x) { return holder[(x + 4) >> 2]; }
function plainAt(x) { return holder[x + 1]; }
function wide(x) { return HEAP32[(x + 32767) >> 2]; }
function shifted(x) { return HEAPU8[x >> 31]; }
assert(at(4), HEAP32[2], 'int x');
assert(at(4.5), HEAP32[2], 'double x'); assert(at('4'), HEAP32[11], 'string x concatenates');
assert(at(-4), HEAP32[0], 'index 0'); assert(at(-8), undefined, 'negative index'); assert(at(64), undefined, 'index past the end');
assert(at(2147483647), undefined, 'a sum past the int range'); assert(at(2147483644), undefined, 'a sum that wraps');
assert(at({ valueOf: function () { return 8; } }), HEAP32[3], 'object x');
assert(at(undefined), HEAP32[0], 'undefined x'); assert(at(true), HEAP32[1], 'boolean x');
assert(wide(2147483647 - 32767), undefined, 'the largest int sum'); assert(wide(1), undefined, 'far past the end');
assert(wide(-32767), HEAP32[0], 'k of 32767'); assert(shifted(5), HEAPU8[0], 'shift of 31'); assert(shifted(-5), undefined, 'shift of 31 of a negative');
assert(plainAt('x'), undefined, 'string index');
holder = PLAIN; assert(at(4), 12, 'an Array global'); assert(plainAt(10), 21, 'last element'); assert(plainAt(11), undefined, 'past the Array');
holder = [1, , 3]; assert(plainAt(0), undefined, 'a hole'); Array.prototype[1] = 'proto'; assert(plainAt(0), 'proto', 'a hole reads the prototype'); delete Array.prototype[1];
holder = 'string'; assert(plainAt(1), 'r', 'a string global');
holder = { 1: 'one', get 2() { return 'getter'; } }; assert(plainAt(0), 'one', 'a plain object global'); assert(plainAt(1), 'getter', 'a getter');
holder = new Proxy({}, { get: function (target, key) { return 'p' + key; } }); assert(at(4), 'p2', 'a proxy global');
holder = undefined; threw = false; try { at(4); } catch (error) { threw = error instanceof TypeError; } assert(threw, true, 'an undefined global throws');
function undeclared(x) { return notDeclaredAnywhere[x >> 2]; }
threw = false; try { undeclared(4); } catch (error) { threw = error instanceof ReferenceError; } assert(threw, true, 'an undeclared global throws');
function early(x) { return later[x >> 2]; }
threw = false; try { early(4); } catch (error) { threw = error instanceof ReferenceError; } assert(threw, true, 'a let global before its declaration throws');
let later = new Int32Array([5, 6, 7]); assert(early(4), 6, 'a let global');
const fixed = new Uint8Array([9, 8, 7]); function constant(x) { return fixed[x + 1] | 0; } assert(constant(1), 7, 'a const global');
// A global defined as an accessor, and one replaced while a function reads it.
Object.defineProperty(globalThis, 'accessed', { get: function () { return HEAP16; }, configurable: true });
function viaGetter(x) { return accessed[x >> 1]; } assert(viaGetter(4), HEAP16[2], 'an accessor global');
globalThis.late = HEAPU8; function lateRead(x) { return late[x + 2]; } assert(lateRead(1), HEAPU8[3], 'a global object property');
globalThis.late = PLAIN; assert(lateRead(1), 13, 'replaced'); delete globalThis.late;
threw = false; try { lateRead(1); } catch (error) { threw = error instanceof ReferenceError; } assert(threw, true, 'deleted');
// A detached or shrunk buffer, and `| 0` after elements that are not ints.
var small = new ArrayBuffer(16), view = new Int32Array(small), floats = new Float64Array([1.5, -0, 4294967296.5]);
function viewAt(x) { return view[x >> 2] | 0; } function floatAt(x) { return floats[x >> 3] | 0; }
view[1] = -5; assert(viewAt(4), -5, 'before the transfer'); assert(floatAt(0), 1, 'double | 0'); assert(floatAt(16), 0, 'large double | 0');
if (small.transfer) { small.transfer(); assert(viewAt(4), 0, 'a detached view reads undefined'); }
var big = new Uint32Array([4294967295, 2147483648]); function bigAt(x) { return big[x >> 2]; } function bigOr(x) { return big[x >> 2] | 0; }
assert(bigAt(0), 4294967295, 'Uint32 above the int range'); assert(bigOr(0), -1, 'and | 0'); assert(bigOr(4), -2147483648, 'the sign bit | 0');
// Loops over a global heap, as compiled C makes them.
function checksum(from, to) { var total = 0; for (var x = from; x < to; x = x + 4) { total = (total + HEAP32[x >> 2] | 0) ^ HEAPU8[x + 1]; } return total; }
function reference(from, to) { var total = 0, h = HEAP32, u = HEAPU8; for (var x = from; x < to; x = x + 4) { var i = x >> 2, j = x + 1; total = (total + h[i] | 0) ^ u[j]; } return total; }
for (var round = 0; round < 200; round++) { assert(checksum(0, 64), reference(0, 64), 'checksum round ' + round); }
// Many reads between a short forward branch and its target: the prefixes may
// not push the target out of the branch's reach.
function count() { return arguments.length; }
for (var reads = 1; reads <= 14; reads++) {
  var list = [];
  for (var n = 0; n < reads; n++) { list.push(n % 3 === 0 ? 'HEAP32[q >> 2]' : n % 3 === 1 ? 'h[q + 1]' : 'HEAPU8[r >> 1]'); }
  var body = 'var a0 = 1, a1 = 2, a2 = 3, a3 = 4, q = 4, r = 6, total = 0;';
  var shapes = [
    body + 'return c && count(' + list.join(', ') + ');',
    body + 'return c ? [' + list.join(', ') + '].length : -1;',
    body + 'if (c) total = ' + list.join(' + ') + '; return total;',
    body + 'while (c) { total = ' + list.join(' ^ ') + '; break; } return total;',
    body + 'return (c || [' + list.join(', ') + '].length) && (c ? ' + list.join(' - ') + ' : 0);'
  ];
  for (var shape = 0; shape < shapes.length; shape++) {
    var made = new Function('c', 'h', shapes[shape]);
    var taken = made(1, HEAPU8), skipped = made(0, HEAPU8);
    var sum = 0, xor = 0, difference = 0;
    for (n = 0; n < reads; n++) {
      var term = n % 3 === 0 ? HEAP32[1] : n % 3 === 1 ? HEAPU8[5] : HEAPU8[3];
      sum += term; xor ^= term; difference = n === 0 ? term : difference - term;
    }
    var expected = [reads, reads, sum, xor, difference][shape], other = [0, -1, 0, 0, 0][shape];
    assert(taken, expected, reads + ' reads, shape ' + shape + ', taken');
    assert(skipped, other, reads + ' reads, shape ' + shape + ', skipped');
  }
}
