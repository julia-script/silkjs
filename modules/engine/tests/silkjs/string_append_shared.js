// `s = s + piece` appends in place only when the local is the sole holder.
function check(actual, expected, what) {
  if (actual !== expected) throw new Error(what + ": got " + JSON.stringify(actual) + ", want " + JSON.stringify(expected));
}
function build(n) {
  let s = "ab".repeat(3).slice(1);
  for (let i = 0; i < n; i++) s = s + String.fromCharCode(97 + (i % 26));
  return s;
}
let want = "babab";
for (let i = 0; i < 200; i++) want += String.fromCharCode(97 + (i % 26));
check(build(200), want, "plain build");
// Another holder keeps its old value.
function aliased() {
  let s = "x".repeat(2) + "y";
  const kept = [];
  for (let i = 0; i < 40; i++) { kept.push(s); s = s + "z"; }
  for (let i = 0; i < 40; i++) check(kept[i], "xxy" + "z".repeat(i), "alias " + i);
  return s;
}
check(aliased(), "xxy" + "z".repeat(40), "aliased result");
// Multi-byte short pieces and an argument slot.
function arg(s) {
  for (let i = 0; i < 30; i++) s = s + "pq" + i;
  return s;
}
let w = "go";
for (let i = 0; i < 30; i++) w = w + "pq" + i;
check(arg("g" + "o"), w, "argument slot");
