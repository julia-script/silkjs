// add_imm, sar_imm, shl_imm, and_imm, or_imm and lt_imm: an Int right operand
// fused into the operator must keep every operator's semantics.
function show(v) { return Object.is(v, -0) ? "-0" : typeof v === "bigint" ? v + "n" : String(v); }
const values = [5, -7, 2147483647, -2147483648, 1.5, -0, NaN, "12", "a", null, undefined, true, {}, [3], { valueOf() { return 9; } }];
const out = [];
for (const v of values) {
  out.push([v + 1, v + -1, v + 300, v >> 2, v >> 33, v << 3, v << 31, v & 255, v & 0x7fff, v | 0, v | 4, v < 16, v < -1].map(show).join(" "));
}
// Non-numeric operands reach the generic paths; a leaf function too.
function leafAdd(x) { return x + 1; }
function leafMix(x) { return ((x >> 1) | 0) < 3; }
for (let i = 0; i < 5; i++) out.push([leafAdd(i), leafAdd("s"), leafMix(i), leafMix(1.5)].map(show).join(" "));
let threw = "";
try { 1n + 1; } catch (e) { threw = e.constructor.name; }
out.push(threw);
let s = 0;
for (let i = 0; i < 100; i++) s = (s + ((i << 2) >> 1 & 0xff | 1)) | 0;
out.push(String(s));
const got = out.join("\n");
const expected = "6 4 305 1 2 40 -2147483648 5 5 5 5 true false\n-6 -8 293 -2 -4 -56 -2147483648 249 32761 -7 -3 true true\n2147483648 2147483646 2147483947 536870911 1073741823 -8 -2147483648 255 32767 2147483647 2147483647 false false\n-2147483647 -2147483649 -2147483348 -536870912 -1073741824 0 0 0 0 -2147483648 -2147483644 true true\n2.5 0.5 301.5 0 0 8 -2147483648 1 1 1 5 true false\n1 -1 300 0 0 0 0 0 0 0 4 true false\nNaN NaN NaN 0 0 0 0 0 0 0 4 false false\n121 12-1 12300 3 6 96 0 12 12 12 12 true false\na1 a-1 a300 0 0 0 0 0 0 0 4 false false\n1 -1 300 0 0 0 0 0 0 0 4 true false\nNaN NaN NaN 0 0 0 0 0 0 0 4 false false\n2 0 301 0 0 8 -2147483648 1 1 1 5 true false\n[object Object]1 [object Object]-1 [object Object]300 0 0 0 0 0 0 0 4 false false\n31 3-1 3300 0 1 24 -2147483648 3 3 3 7 true false\n10 8 309 2 4 72 -2147483648 9 9 9 13 true false\n1 s1 true true\n2 s1 true true\n3 s1 true true\n4 s1 true true\n5 s1 true true\nTypeError\n10000";
if (got !== expected) throw new Error("got\n" + got + "\nexpected\n" + expected);
console.log("ok");
