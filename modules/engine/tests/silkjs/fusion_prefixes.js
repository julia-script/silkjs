// The fusion prefix: `heap[(x + k) >> s]` with x a local and string `switch`
// cases, on the values its fast paths take and on every value they must leave
// to the covered instructions. Also stores to arguments, wrapped int sums and
// element stores.
function assert(actual, expected, message) {
  if (actual !== expected && !(actual !== actual && expected !== expected)) {
    throw new Error(message + ': got ' + actual + ', expected ' + expected);
  }
}
var words = new Int32Array(16), bytes = new Uint8Array(words.buffer), halves = new Uint16Array(words.buffer);
for (var i = 0; i < 16; i++) { words[i] = i * 1000 + 7; }
// Locals 0-3 (short reads) and later ones (get_loc8).
function low(heap, x) { var a = heap[(x + 8) >> 2]; var b = heap[x >> 2]; var c = heap[x + 1]; var d = heap[(x + -4) >> 2]; return [a, b, c, d]; }
function high(heap, p) {
  var a0, a1, a2, a3, a4, x = p;
  a0 = heap[(x + 8) >> 2]; a1 = heap[x >> 2]; a2 = heap[x + 1]; a3 = heap[(x + -4) >> 2] | 0; a4 = heap[(x + 4) >> 2] | 0;
  return [a0, a1, a2, a3, a4];
}
function same(got, want, label) { assert(got.length, want.length, label + ' length'); for (var i = 0; i < want.length; i++) { assert(got[i], want[i], label + ' [' + i + ']'); } }
same(low(words, 8), [4007, 2007, 9007, 1007], 'low words');
same(high(words, 8), [4007, 2007, 9007, 1007, 3007], 'high words');
same(low(bytes, 8), [bytes[4], bytes[2], bytes[9], bytes[1]], 'low bytes');
same(high(halves, 8), [halves[4], halves[2], halves[9], halves[1], halves[3]], 'high halves');
var plain = []; for (var i = 0; i < 16; i++) { plain.push('e' + i); }
same(low(plain, 8), ['e4', 'e2', 'e9', 'e1'], 'low array');
same(high(plain, 8), ['e4', 'e2', 'e9', 0, 0], 'high array');
// Out of range, negative, fractional, string and missing indices.
same(low(words, 100), [undefined, undefined, undefined, undefined], 'past the end');
same(low(words, -40), [undefined, undefined, undefined, undefined], 'negative');
same(low(words, 8.5), [4007, 2007, undefined, 1007], 'fractional x');
same(low(words, '8'), [undefined, 2007, undefined, 7], 'string x');
assert(low(words, '8')[0], words[('8' + 8) >> 2], 'string x concatenates');
same(high(words, undefined), [words[0], words[0], undefined, 7, 7], 'undefined x');
// Sums that leave the Int range.
function edge(heap, x) { return [heap[(x + 4) >> 2], heap[x + 4], heap[(x + -4) >> 2], heap[x + -4]]; }
same(edge(words, 2147483647), [words[(2147483647 + 4) >> 2], undefined, undefined, undefined], 'overflow up');
same(edge(words, -2147483648), [undefined, undefined, words[(-2147483648 - 4) >> 2], undefined], 'overflow down');
assert((2147483647 + 4) >> 2, -536870912, 'wrapped shift');
// Objects that are not arrays, and a getter that changes the local's meaning.
var keyed = { 3: 'three', 12: 'twelve' };
function keyedRead(o, x) { return [o[(x + 4) >> 2], o[x + 4], o[x >> 2]]; }
same(keyedRead(keyed, 8), ['three', 'twelve', undefined], 'plain object');
same(keyedRead('abcdefghijklmnop', 8), ['d', 'm', 'c'], 'string object');
var threw = false; try { keyedRead(null, 8); } catch (e) { threw = e instanceof TypeError; } assert(threw, true, 'null object throws');
// arguments[i + k] keeps working, lazily or not.
function args(i) { return arguments[i + 1]; }
assert(args(0, 'a', 'b'), 'a', 'arguments[i + 1]');
assert(args(1, 'a', 'b'), 'b', 'arguments[i + 1] second');
assert(args(5, 'a', 'b'), undefined, 'arguments[i + 1] past the end');
function argsShift(i) { var a = arguments; return a[(i + 4) >> 2]; }
assert(argsShift(0, 'a'), 'a', 'arguments copy');
// A loop, so the same site sees many values.
function sum(heap, n) { var total = 0; for (var p = 0; p < n; p = p + 4) { total = (total + heap[(p + 4) >> 2]) | 0; } return total; }
assert(sum(words, 40), 1007 + 2007 + 3007 + 4007 + 5007 + 6007 + 7007 + 8007 + 9007 + 10007, 'loop sum');

// String switch cases.
function pick(name) {
  switch (name) {
    case 'BT': return 1;
    case 'ET': return 2;
    case 'Tj': return 3;
    case '': return 4;
    case 'a rather long operator name': return 5;
    default: return 0;
  }
}
var built = 'B' + String.fromCharCode(84);
assert(pick('BT'), 1, 'literal'); assert(pick(built), 1, 'built'); assert(pick('E' + 'T'), 2, 'second');
assert(pick(['T', 'j'].join('')), 3, 'joined'); assert(pick(''), 4, 'empty'); assert(pick('x'.slice(1)), 4, 'empty slice');
assert(pick('a rather long ' + 'operator name'), 5, 'rope'); assert(pick('a rather long operator namf'), 0, 'same length');
assert(pick('BU'), 0, 'near miss'); assert(pick(1), 0, 'number'); assert(pick(null), 0, 'null'); assert(pick(undefined), 0, 'undefined');
assert(pick(new String('BT')), 0, 'String object'); assert(pick({ toString: function () { return 'BT'; } }), 0, 'object');
assert(pick('ł'), 0, 'wide'); assert(pick(Symbol.iterator), 0, 'symbol');
function mixed(v) { switch (v) { case 1: return 'one'; case 'two': return 2; case 3.5: return 'f'; case 'four': return 4; } return 'none'; }
assert(mixed(1), 'one', 'mixed number'); assert(mixed('two'), 2, 'mixed string'); assert(mixed('fo' + 'ur'), 4, 'mixed built');
assert(mixed(3.5), 'f', 'mixed float'); assert(mixed('1'), 'none', 'mixed numeric text');
// Enough cases that the branches are long.
var source = 'switch (v) {';
for (var i = 0; i < 300; i++) { source += 'case "k' + i + '": r = ' + i + '; break;'; }
source += 'default: r = -1; } return r;';
var wide = new Function('v', 'var r;' + source);
assert(wide('k0'), 0, 'long first'); assert(wide('k' + 299), 299, 'long last'); assert(wide('k300'), -1, 'long default');
// A case whose value is kept: the dup's copy must stay balanced.
function fall(v) { var out = ''; switch (v) { case 'a': out += 'a'; case 'b': out += 'b'; break; case 'c': out += 'c'; } return out; }
assert(fall('a'), 'ab', 'fall through'); assert(fall('b'), 'b', 'fall b'); assert(fall('c'), 'c', 'fall c'); assert(fall('d'), '', 'fall none');

// Stores to arguments.
function store(a, b, c, d, e, f) { a = a + 1; b = b + 'x'; c = d; d = e; e = f; f = a; return [a, b, c, d, e, f, arguments.length]; }
same(store(1, 'b', 3, 4, 5, 6), [2, 'bx', 4, 5, 6, 2, 6], 'argument stores');
function appendArg(s, t) { s = s + t; s = s + 'tail'; t = 'head' + t; return s + '|' + t; }
assert(appendArg('ab', 'cd'), 'abcdtail|headcd', 'string argument stores');
function Point(x, y) { if (x === undefined) x = 0; if (y === undefined) y = 0; this.x = x; this.y = y; }
var p = new Point(), q = new Point(3), r = new Point(4, 5);
assert(p.x + ',' + p.y + ',' + q.x + ',' + q.y + ',' + r.x + ',' + r.y, '0,0,3,0,4,5', 'constructor defaults');
function sloppy(a) { a = 9; return arguments[0]; }
assert(sloppy(1), 9, 'mapped arguments see the store');

// `(x + y) | 0` and `(x - y) | 0`: the wrapped Int, whatever the exact sum is.
function addInt(a, b) { return (a + b) | 0; }
function subInt(a, b) { return (a - b) | 0; }
function addConst(a) { return (a + 1000) | 0; }
function subConst(a) { return (a - 1000) | 0; }
assert(addInt(2147483647, 1), -2147483648, 'add wraps'); assert(addInt(-2147483648, -1), 2147483647, 'add wraps down');
assert(addInt(1, 2), 3, 'add small'); assert(addInt(1.5, 2), 3, 'add float'); assert(addInt('1', 2), 12, 'add text');
assert(addInt(2147483647, 2147483647), -2, 'add wraps far'); assert(addInt(4294967296.5, 1), 1, 'add wide float');
assert(subInt(-2147483648, 1), 2147483647, 'sub wraps'); assert(subInt(2147483647, -1), -2147483648, 'sub wraps up');
assert(subInt(5, 7), -2, 'sub small'); assert(subInt('9', 2), 7, 'sub text'); assert(subInt(0.5, 2), -1, 'sub float');
assert(addConst(2147483647), -2147482649, 'add_imm wraps'); assert(addConst(1), 1001, 'add_imm small'); assert(addConst('1'), 11000, 'add_imm text');
assert(subConst(-2147483648), 2147482648, 'sub_imm wraps'); assert(addConst(0.25), 1000, 'add_imm float');
// The exact sum is kept when no coercion follows.
function addPlain(a, b) { var s = a + b; return s; }
assert(addPlain(2147483647, 1), 2147483648, 'add exact'); assert(2147483647 + 1 | 1, -2147483647, 'or with a nonzero constant');
// A branch that lands on the coercion itself.
function landing(a, b, c) { return (c ? a + b : a) | 0; }
assert(landing(2147483647, 1, true), -2147483648, 'coercion as a branch target'); assert(landing(7.9, 1, false), 7, 'coercion reached by the branch');

// Element stores answered before the frame is published.
var bytes = new Uint8Array(4), words = new Int32Array(4), shorts = new Int16Array(4), floats = new Float64Array(2), list = [1, 'two', {}, 4];
function put(t, i, v) { t[i] = v; return t[i]; }
assert(put(bytes, 1, 300), 44, 'Uint8 wraps'); assert(put(words, 2, -5), -5, 'Int32'); assert(put(shorts, 3, 70000), 4464, 'Int16 wraps');
assert(put(floats, 1, 3), 3, 'Float64 from Int'); assert(put(floats, 0, 1.5), 1.5, 'Float64'); assert(put(bytes, 9, 1), undefined, 'typed out of range');
assert(put(bytes, -1, 1), undefined, 'typed negative'); assert(put(words, 0, 2.9), 2, 'Int32 from float'); assert(put(words, 1, '7'), 7, 'Int32 from text');
assert(put(list, 1, 'x'), 'x', 'array overwrite'); assert(put(list, 2, 5), 5, 'array overwrite of an object'); assert(put(list, 4, 'new'), 'new', 'array append');
assert(put(list, 9, 'gap'), 'gap', 'array gap'); assert(list.length, 10, 'array length after gap'); assert(put(list, '0', 'zero'), 'zero', 'text index');
var frozen = Object.freeze([1, 2]); assert(put(frozen, 0, 9), 1, 'frozen array keeps its element');
var clamped = new Uint8ClampedArray(2); assert(put(clamped, 0, 300), 255, 'clamped high'); assert(put(clamped, 1, -3), 0, 'clamped low');
