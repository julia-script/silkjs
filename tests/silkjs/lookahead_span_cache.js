// skipParens remembers every bracket span a lookahead scan closes; lookaheads
// that start inside an earlier scan reuse those results. These cover the parser
// decisions that read them: arrow heads, destructuring assignment targets,
// parameter expressions, and for-of heads, nested inside long spans.
function assert(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}
var pad = "c0, c1, c2, c3, c4, c5, c6, c7, c8, c9, d0, d1, d2, d3, d4, d5, d6, d7";
var a0 = 0, a1 = 1, a2 = 2, a3 = 3, a4 = 4, a5 = 5, a6 = 6, a7 = 7, a8 = 8, a9 = 9;
var b0 = 0, b1 = 1, b2 = 2, b3 = 3, b4 = 4, b5 = 5, b6 = 6, b7 = 7;

// Arrow functions nested in a long parenthesized argument list.
var sum = ((x, y) => x + y)(a0, a1) + ((f) => f(a2, a3, a4, a5, a6, a7, a8, a9, b0, b1, b2))((...r) => r.length);
assert(sum, 12, "nested arrows inside a long call");

// Object and array literals followed by `=` are destructuring targets; the same
// shapes followed by anything else stay literals.
var o = { p: { q: [1, 2, { r: 3 }] }, s: [4, [5, 6]], t: 7, u: 8, v: 9, w: 10 };
var q, r, s1, s2;
({ p: { q: [, , { r }] }, s: [s1, [, s2]] } = o);
assert(r, 3, "nested object destructuring assignment");
assert(s1 + s2, 10, "nested array destructuring assignment");
var lit = [{ p: { q: [1, 2, { r: 3 }] }, s: [4, [5, 6]] }, { x: [a0, a1, a2, a3, a4, a5, a6, a7] }];
assert(lit[1].x.length, 8, "literal in a long array stays a literal");
var x1, x2, rest;
[x1, [x2, ...rest]] = [1, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]];
assert(x1 + x2 + rest.length, 17, "array destructuring with rest");

// Parameter lists with defaults and rest, nested in long spans.
function outer(cb = (u = [1, 2, 3], { v } = { v: 4 }, ...w) => u.length + v + w.length, z = [a0, a1, a2, a3, a4, a5, a6, a7, a8]) {
  return cb(undefined, undefined, 1, 2) + z.length;
}
assert(outer(), 18, "default parameters containing arrows");

// for-of heads with destructuring inside an enclosing long expression.
var total = 0;
for (var [k, { m }] of [[1, { m: 2 }], [3, { m: 4 }], [5, { m: 6 }]]) total += k * m;
assert(total, 44, "for-of with destructuring");

// The same source scanned under different lexical contexts: `yield` is a plain
// identifier outside generators and an operator inside them.
var yieldSource = "(yield, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1, 2, 3, 4, 5)";
var sloppy = new Function("var yield = 5; return " + yieldSource + ";");
assert(sloppy(), 5, "yield as identifier in a long parenthesized list");
var gen = new Function("return function* () { var v = " + yieldSource.replace("yield", "yield 1") + "; return v; };")();
var it = gen(); it.next(); assert(it.next(9).value, 5, "yield expression in a long parenthesized list");

// Arrow heads separated from `=>` by a line break are not arrows.
var threw = false;
try { new Function("return (" + pad + ")\n=> 1"); } catch (e) { threw = e instanceof SyntaxError; }
assert(threw, true, "line break before => in a long head");

// Deep nesting compiles in linear time and keeps its value.
var deep = "1"; for (var i = 0; i < 120; i++) deep = "{ a: [" + deep + "] }";
var value = new Function("return " + deep + ";")();
for (var i = 0; i < 120; i++) value = value.a[0];
assert(value, 1, "deeply nested literal");

console.log("lookahead_span_cache ok");
