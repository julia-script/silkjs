// `a + b + 'literal'` builds its result in one string; the result must equal
// the two-step concatenation for every kind of piece.
var failures = 0;
function check(ok, what) { if (!ok) { failures++; if (failures < 10) console.log("bad", what); } }
function leaf(tag) { return "String for key " + tag + " in leaf node"; }
function wide(tag) { return "中" + tag + " end"; }
function mixed(a, b) { return a + b + "é!"; }
function numeric(a, b) { return a + b + "7"; }
var long = "x".repeat(5000);
for (var i = 0; i < 200; i++) {
  var tag = String(Math.random());
  var s = leaf(tag);
  check(s.length === 15 + tag.length + 13 && s.indexOf(tag) === 15 && s.slice(-13) === " in leaf node", "leaf " + i);
  check(wide(tag) === "中".concat(tag, " end"), "wide " + i);
  check(mixed("a" + i, "中") === "a" + i + "中é!", "mixed wide " + i);
  check(mixed(long, "y").length === 5003 && mixed(long, "y").slice(-3) === "yé!", "long " + i);
  check(numeric(i, 1) === (i + 1) + "7", "number sum " + i);
  check(numeric("n", i) === "n" + i + "7", "string number " + i);
  var rope = ("r" + i).repeat(40) + tag;
  check(leaf(rope) === "String for key ".concat(rope, " in leaf node"), "rope " + i);
}
// Repeated joins of the same pieces may share one result; appending to one
// copy must never show through the others.
var tagged = "k" + 7;
var first = leaf(tagged), second = leaf(tagged);
first += "!";
var third = leaf(tagged);
third += "?";
check(first === "String for key k7 in leaf node!" && second === "String for key k7 in leaf node", "shared append " + first + "|" + second);
check(third === "String for key k7 in leaf node?" && leaf(tagged) === second, "shared append again");
var built = [];
for (var i = 0; i < 50; i++) { var s = leaf(tagged); for (var j = 0; j < i % 5; j++) s += j; built.push(s); }
for (var i = 0; i < 50; i++) { var expected = "String for key k7 in leaf node"; for (var j = 0; j < i % 5; j++) expected += j; check(built[i] === expected, "built " + i); }
var o = { toString: function () { return "obj"; } };
check(leaf(o) === "String for key obj in leaf node", "object tag");
check(mixed("", "") === "é!", "empty");
console.log(failures == 0 ? "PASS string concat three" : "FAIL string concat three " + failures);
if (failures != 0) throw new Error("three-piece concat regressions");
