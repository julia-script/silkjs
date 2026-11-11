// Typed array element reads and writes answered in the interpreter loop, the
// `| 0` skipped after an Int element, `>>>` on Ints and `===` on strings.
function assert(actual, expected, message) {
  if (actual !== expected && !(actual !== actual && expected !== expected)) {
    throw new Error(message + ': got ' + actual + ', expected ' + expected);
  }
}
var buffer = new ArrayBuffer(64);
var kinds = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array];
var written = [-1, 255, 300, -32768, 65535, -2147483648, 4294967295 | 0, 3, -7];
var read = [-1, 255, 255, -32768, 65535, -2147483648, 4294967295, 3, -7];
for (var k = 0; k < kinds.length; k++) {
  var view = new kinds[k](buffer);
  for (var i = 0; i < 4; i++) { view[i] = written[k]; }
  for (var i = 0; i < 4; i++) { assert(view[i], read[k], kinds[k].name + ' element ' + i); }
  assert(view[view.length], undefined, kinds[k].name + ' past the end');
  view[view.length] = 1;
  assert(view.length, 64 / kinds[k].BYTES_PER_ELEMENT, kinds[k].name + ' length');
  assert(view[-1], undefined, kinds[k].name + ' negative index');
}
var bytes = new Uint8Array(4), words = new Int32Array(4), unsigned = new Uint32Array(1), floats = new Float64Array(1);
bytes[0] = 257; words[1] = 1.9; words[2] = -1; unsigned[0] = -1; floats[0] = 1.5;
assert(bytes[0], 1, 'byte wraps');
assert(words[1], 1, 'float truncates');
// `| 0` right after the read: an Int element stays itself, others still coerce.
assert(words[2] | 0, -1, 'int element coerced');
assert(unsigned[0] | 0, -1, 'uint32 element coerced');
assert(floats[0] | 0, 1, 'float element coerced');
assert([7][0] | 0, 7, 'array element coerced');
assert(['8'][0] | 0, 8, 'string element coerced');
assert(new BigInt64Array(1)[0], 0n, 'bigint element');
var big = new BigInt64Array(1); big[0] = 5n; assert(big[0], 5n, 'bigint store');
var caught = false; try { big[0] = 1; } catch (e) { caught = e instanceof TypeError; } assert(caught, true, 'number into a bigint view');
// >>> on Ints
function shift(x, y) { return x >>> y; }
assert(shift(-1, 0), 4294967295, '-1 >>> 0');
assert(shift(-1, 1), 2147483647, '-1 >>> 1');
assert(shift(5, 0), 5, '5 >>> 0');
assert(shift(-8, 33), 2147483644, 'count masked');
assert(shift(1, -1), 0, 'negative count');
assert(shift(2.5, 0), 2, 'float operand');
assert(shift('16', 2), 4, 'string operand');
// === and !== on strings
function same(a, b) { return a === b; }
function differ(a, b) { return a !== b; }
var built = 'B' + String.fromCharCode(84);
assert(same(built, 'BT'), true, 'built string equals a literal');
assert(same(built, 'ET'), false, 'different text');
assert(same(built, 'BTX'), false, 'different length');
assert(differ(built, 'BT'), false, 'built string differs');
assert(differ(built, 'ET'), true, 'different text differs');
assert(same('1', 1), false, 'string and number');
assert(same(1, '1'), false, 'number and string');
assert(same('a' + 'b' + built, 'abBT'), true, 'rope equals a literal');
function pick(name) { switch (name) { case 'BT': return 1; case 'ET': return 2; default: return 0; } }
assert(pick(built), 1, 'switch on a built string');
assert(pick('E' + 'T'), 2, 'switch second case');
assert(pick(3), 0, 'switch default');
