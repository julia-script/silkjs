// Stack positions decode with a per-table resume point (js_backtrace.framePositions):
// captures that go backwards, forwards and repeat in the same function must all
// report the same line:column a fresh decode would.
"use strict";
function where(e, depth) {
  const line = e.stack.split("\n").filter((l) => /^\s+at /.test(l))[depth];
  const m = /:(\d+):(\d+)\)?$/.exec(line);
  return m[1] + ":" + m[2];
}
function pick(k) {
  if (k === 0) return new Error("zero");
  if (k === 1) return new Error("one");
  if (k === 2) return new Error("two");
  return new Error("three");
}
function outer(k) {
  const a = pick(k);
  return a;
}
const expected = [];
for (let k = 0; k < 4; k++) expected.push(where(pick(k), 0) + " " + where(outer(k), 1));
const order = [3, 0, 2, 2, 1, 3, 0, 1, 1, 3, 2, 0];
for (let round = 0; round < 3; round++) {
  for (const k of order) {
    const got = where(pick(k), 0) + " " + where(outer(k), 1);
    if (got !== expected[k]) throw new Error("case " + k + ": " + got + " != " + expected[k]);
  }
}
// The engine's own positions (QuickJS columns), as main decoded them from the start.
const want = ["11:32 17:17", "12:32 17:17", "13:32 17:17", "14:19 17:17"];
for (let k = 0; k < 4; k++) if (expected[k] !== want[k]) throw new Error("fresh " + k + ": " + expected[k] + " != " + want[k]);
console.log("PASS error positions resume");
