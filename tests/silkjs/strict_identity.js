// Strict equality on objects, symbols, booleans, null and undefined, and the
// ! / nullish tests, answered without the generic operator path.
function assert(actual, expected, message) {
  if (actual !== expected) throw new Error(message + ": expected " + String(expected) + ", got " + String(actual));
}
var o = {}, p = {}, s = Symbol("s"), t = Symbol("s");
assert(o === o, true, "same object");
assert(o === p, false, "different objects");
assert(o !== p, true, "different objects !==");
assert(s === s && s !== t, true, "symbols");
assert(true === true && true !== false, true, "booleans");
assert(null === null && undefined === undefined, true, "nullish identity");
assert(null === undefined, false, "null is not undefined");
assert(o === null || null === o, false, "object vs null");
assert(0 === false || "" === false || 1 === true, false, "booleans vs numbers and strings");
assert(undefined === void 0, true, "void");
assert(NaN === NaN, false, "NaN");
assert(0 === -0, true, "signed zero");
assert("ab" === "a" + "b", true, "strings by content");
assert(1.5 === 1.5 && 2 === 2.0, true, "numbers");
assert(!true, false, "! true");
assert(!0 && !null && !undefined && !"" && !NaN, true, "falsy");
assert(!1 || !{} || !"x" || ![] || !-1, false, "truthy");
var none = null, missing;
assert(none === null && missing === undefined && missing == null && none == undefined, true, "nullish tests");
assert(o === null || o === undefined || o == null, false, "object is not nullish");
var kept = [];
(function () { for (var i = 0; i < 3; i++) { var x = { i: i }; if (x !== null && !(x === kept[0])) kept.push(x); } })();
assert(kept.length, 3, "temporaries survive comparisons");
assert(kept[2].i, 2, "kept object intact");
