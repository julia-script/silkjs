// lt/lte/gt/gte on two Ints followed by a forward if_false8/if_true8 take the
// branch in the comparison's arm; every other case keeps the Bool.
const pairs = [[1, 2], [2, 1], [3, 3], [-5, 0], [2147483647, -2147483648], [1.5, 2], [2, NaN], ["a", "b"], ["10", 9], [null, 0]];
const out = [];
for (const [a, b] of pairs) {
  let r = "";
  if (a < b) r += "L"; else r += "l";
  if (a <= b) r += "E"; else r += "e";
  if (a > b) r += "G"; else r += "g";
  if (a >= b) r += "F"; else r += "f";
  if (!(a < b)) r += "!";
  r += (a < b) ? "?" : ".";
  r += (a > b || a === b) ? "|" : "_";
  r += (a <= b && b >= a) ? "&" : "^";
  out.push(r + " " + (a < b) + " " + (a >= b));
}
// Loop conditions: the backward branch keeps polling interrupts.
let n = 0;
for (let i = 0; i < 1000; i++) { if (i >= 500) n++; }
let j = 0;
do { j++; } while (j < 7);
let k = 10, w = 0;
while (k > 0) { k--; w += k <= 4 ? 1 : 0; }
// A leaf function runs the same comparison in the leaf interpreter.
function leafLess(x, y) { if (x < y) return 1; return 0; }
function leafMore(x, y) { return x >= y ? "y" : "n"; }
let leaf = "";
for (let i = 0; i < 4; i++) leaf += leafLess(i, 2) + leafMore(i, 2);
out.push([n, j, w, leaf].join(" "));
const got = out.join("\n");
const expected = "LEgf?_& true false\nleGF!.|^ false true\nlEgF!.|& false true\nLEgf?_& true false\nleGF!.|^ false true\nLEgf?_& true false\nlegf!._^ false false\nLEgf?_& true false\nleGF!.|^ false true\nlEgF!._& false true\n500 7 5 1n1n0y0y";
if (got !== expected) throw new Error("got:\n" + got);
print("ok");
