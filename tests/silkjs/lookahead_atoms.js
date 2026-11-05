// SilkJS regression test for the parser's parenthesis lookahead, whose probe
// lexer borrows existing atoms and never interns: identifiers seen for the
// first time inside the lookahead must still classify arrows, for-of/in,
// keywords and yield/await exactly as the real parse does.
const out = [];
const src = [
  "(zqFreshA, zqFreshB) => zqFreshA + zqFreshB",
  "(zqFreshC = 1, ...zqRest) => zqFreshC + zqRest.length",
  "(function () { let r = 0; for (const zqItem of [1, 2, 3]) r += zqItem; return r; })()",
  "(function () { let r = ''; for (const zqKey in { p: 1, q: 2 }) r += zqKey; return r; })()",
  "(function* () { yield (zqY) => zqY * 2; })().next().value(21)",
  "(async (zqAw) => zqAw)(5) instanceof Promise",
  "(zqParen)",
  "((zqA, zqB) => { return typeof zqA + typeof zqB; })(1)",
  "(\\u0061bc = 3) => abc",
];
for (const s of src) {
  try { const v = eval("var zqParen = 9; " + s); out.push(typeof v === "function" ? v(2, 3) : v); }
  catch (e) { out.push(e.constructor.name); }
}
const got = JSON.stringify(out);
const expected = '[5,3,6,"pq",42,true,9,"numberundefined",2]';
console.log(got === expected ? 'PASS lookahead atoms' : 'FAIL ' + got);
if (got !== expected) throw new Error('lookahead regressions');
