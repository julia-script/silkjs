// Answered charCodeAt / fromCharCode / push calls release their operands, including
// last references (temporary receivers), and handle rope, wide and compact strings.
function check(actual, expected, what) {
  if (actual !== expected) throw new Error(what + ": got " + JSON.stringify(actual) + ", want " + JSON.stringify(expected));
}
let sum = 0;
for (let i = 0; i < 300; i++) {
  // A temporary receiver: its last reference goes with the call.
  sum += ("ab" + i).charCodeAt(2);
  sum += ("ā" + i).charCodeAt(0);
}
let want = 0;
for (let i = 0; i < 300; i++) want += String(i).charCodeAt(0) + 0x101;
check(sum, want, "temporary receivers");
let rope = "x".repeat(40);
for (let i = 0; i < 20; i++) rope = rope + "yz".repeat(30);
check(rope.charCodeAt(0), 120, "rope head");
check(rope.charCodeAt(rope.length - 1), 122, "rope tail");
check(Number.isNaN(rope.charCodeAt(rope.length)), true, "rope past end");
check("€".charCodeAt(0), 0x20ac, "wide");
check("q".charCodeAt(0), 113, "compact");
check("abc".charCodeAt(7) !== "abc".charCodeAt(7), true, "past end is NaN");
const arrays = [];
for (let i = 0; i < 100; i++) {
  const a = [];
  for (let j = 0; j < 5; j++) a.push({ j: j });
  check(a.push([i].concat([])), 6, "push length");
  arrays.push(a);
}
check(arrays[99][5][0], 99, "pushed temporary array");
let text = "";
for (let i = 0; i < 200; i++) text += String.fromCharCode(65 + (i % 26));
check(text.charCodeAt(199), 65 + (199 % 26), "fromCharCode build");
