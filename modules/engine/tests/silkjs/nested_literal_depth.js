// A literal that starts an expression is parsed directly and whatever follows
// it (member access, call, operators, `? :`) afterwards, so each nesting level
// of object and array literals costs a small native frame. These cover the
// depth that buys and every continuation a literal can have.
function assert(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}
function syntaxError(source) {
  try { new Function(source); } catch (e) { return e instanceof SyntaxError; }
  return false;
}

// Nesting well past what the default 1 MB stack held before (about 200 levels).
function nest(open, close, levels, path) {
  var source = "1";
  for (var i = 0; i < levels; i++) source = open + source + close;
  var value = new Function("return " + source + ";")();
  for (var i = 0; i < levels; i++) value = path(value);
  return value;
}
assert(nest("{ a: [", "] }", 250, (v) => v.a[0]), 1, "object and array pairs");
assert(nest("[", "]", 500, (v) => v[0]), 1, "arrays");
assert(nest("{ a: ", " }", 500, (v) => v.a), 1, "objects");
assert(nest("[0, ", "].slice(1)", 250, (v) => v[0]), 1, "arrays with a member call");
assert(nest("Object({ a: [", "] })", 60, (v) => v.a[0]), 1, "literals as call arguments");

// Nesting past the limit is an error, not a crash.
var threw = false;
try { new Function("return " + "[".repeat(200000) + "1" + "]".repeat(200000) + ";"); } catch (e) { threw = e instanceof Error; }
assert(threw, true, "runaway nesting is reported");

// Continuations of a literal.
var one = 1, two = 2, o, x, y;
assert([1, 2, 3].length, 3, "member");
assert([one, two][1], 2, "index");
assert([4, 5, 6].map((v) => v * 2).join(), "8,10,12", "method call");
assert([(v) => v + 1][0](1), 2, "call");
assert([(s) => s[0]][0]`tag`, "tag", "tagged template");
assert([7]?.[0], 7, "optional index");
assert([7]?.length, 1, "optional member");
assert({ a: 1 }.a, 1, "object member");
assert({ a: { b: [5] } }.a.b[0], 5, "object member chain");
assert([3] ** 2, 9, "power");
assert([3] * [2], 6, "multiply");
assert([1] + [2], "12", "add");
assert([1] - 1, 0, "subtract");
assert([1] << 2, 4, "shift");
assert([2] > 1, true, "relational");
assert([] instanceof Array, true, "instanceof");
assert([0] in [9], true, "in");
assert([1] == 1, true, "equality");
assert([1] === 1, false, "strict equality");
assert([5] & 4, 4, "bitwise and");
assert([5] ^ 4, 1, "bitwise xor");
assert([5] | 2, 7, "bitwise or");
assert([1] + 2 * 3, "16", "precedence after a literal");
assert(([] && 1), 1, "logical and");
assert(([0] || 1)[0], 0, "logical or");
assert(([0] ?? 1)[0], 0, "coalesce");
assert([] ? 1 : 2, 1, "conditional");
assert({} ? [1].length : [1, 2].length, 1, "conditional with literal arms");
assert(([1], [2])[0], 2, "comma");
assert(typeof [1].x, "undefined", "member under typeof");
for (var k of [1, 2].concat([3])) x = k;
assert(x, 3, "for-of over a literal expression");
for (var i = [0].length in { a: 1 }) y = i;
assert(y, "a", "for-in initializer without in");

// Literals that turn out to be patterns.
[x, y] = [y, x];
assert(x + y, "a3", "swap");
[{ a: x = 5 }, [y]] = [{}, [6]];
assert(x + y, 11, "nested pattern with default");
({ o } = { o: 1 });
assert(o, 1, "object pattern");
[x = [1, 2].length, y = { a: [3] }.a[0]] = [];
assert(x + y, 5, "defaults that are literal expressions");
var g = ([a, { b }] = [1, { b: 2 }]) => a + b;
assert(g(), 3, "arrow parameters");

// Errors only a pattern excuses.
assert(syntaxError("return [{ a = 1 }];"), true, "shorthand default in a literal");
assert(syntaxError("return [{ a = 1 }].length;"), true, "shorthand default before a member");
assert(syntaxError("return { a = 1 } + 1;"), true, "shorthand default before an operator");
assert(syntaxError("var a; [{ a = 1 }] = [{}]; return a;"), false, "shorthand default in a pattern");
assert(syntaxError("return [{ __proto__: null, __proto__: null }];"), true, "duplicate __proto__");
assert(syntaxError("[1]++;"), true, "update of a literal");
assert(syntaxError("[1] = 2, [a + 1] = 3;"), true, "invalid pattern element");
assert(syntaxError("return -[1] ** 2;"), true, "unary operand of **");
assert(syntaxError("return [1] ?? 2 || 3;"), true, "mixing ?? and ||");

console.log("nested_literal_depth ok");
