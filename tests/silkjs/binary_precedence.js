// Binary operator precedence and associativity across every level the parser climbs.
function assert(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}
assert(2 + 3 * 4, 14, "* over +");
assert(20 - 6 / 2 - 1, 16, "/ over -, left assoc");
assert(17 % 5 * 2, 4, "% and * left assoc");
assert(1 + 2 << 3, 24, "+ over <<");
assert(-16 >> 2 >>> 0, 4294967292, ">> then >>>");
assert(1 << 2 < 5, true, "<< over <");
assert(3 < 4 == true, true, "< over ==");
assert(1 == 1 & 1, 1, "== over &");
assert(6 & 3 ^ 5, 7, "& over ^");
assert(1 ^ 3 | 4, 6, "^ over |");
assert(1 | 2 && 0 | 0, 0, "| over &&");
assert(2 ** 3 ** 2, 512, "** right assoc");
assert(-(2 ** 2) * 3, -12, "** over *");
assert("a" in { a: 1 } === true, true, "in over ===");
assert([] instanceof Array && 1 <= 2 && 3 >= 3, true, "instanceof and <= >=");
assert(1 != 2 !== false, true, "!= then !==");

for (var i = ("y" in { y: 1 }) ? 5 : 0; i < 6; i++) assert(i, 5, "parenthesized in in for init");
class P { #f = 1; static has(o) { return #f in o && 1 + 1 === 2; } }
assert(P.has(new P()), true, "#f in o");
assert(P.has({}), false, "#f in plain object");
assert(eval("1 + 2 * 3 - 4 / 2 % 3 << 1 > 2 == 1 & 7 ^ 2 | 8"), 11, "all levels in one expression");
console.log("binary_precedence ok");
