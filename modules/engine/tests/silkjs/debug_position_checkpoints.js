// Debug line/column positions stay exact when nested functions make the
// compiler's position cache jump back and forth over long stretches of source.
// The same probe is compiled alone and after (and before) large nested filler;
// its frames must move by exactly the filler's line count, columns unchanged.
function assert(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}
function filler(depth, width) {
  var s = "";
  for (var i = 0; i < width; i++) {
    s += "var f" + depth + "_" + i + " = function () { var pad = '" + "x".repeat(37 * (i + 1)) + "';\n";
    if (depth > 0) s += filler(depth - 1, width);
    s += "  return pad.length; };\n";
  }
  return s;
}
var probe = [
  "function probe() {",
  "  var frames = [];",
  "  function inner(k) { frames.push(new Error().stack.split('\\n')[1]);",
  "    if (k > 0) (function () { var long = '" + "y".repeat(600) + "'; frames.push(new Error().stack.split('\\n')[1]); })();",
  "    return k; }",
  "  inner(0); inner(1);",
  "  return frames;",
  "}"
].join("\n");
function positions(source) {
  return new Function(source + "\nreturn probe();")().map(function (frame) {
    var m = /:(\d+):(\d+)\)?$/.exec(frame);
    return [Number(m[1]), Number(m[2])];
  });
}
var alone = positions(probe);
var pad = filler(3, 3);
var padLines = pad.split("\n").length - 1;
var after = positions(pad + probe);
var before = positions(probe + "\n" + pad);
assert(alone.length, 3, "frame count");
for (var i = 0; i < alone.length; i++) {
  assert(after[i][0], alone[i][0] + padLines, "line after filler, frame " + i);
  assert(after[i][1], alone[i][1], "column after filler, frame " + i);
  assert(before[i][0], alone[i][0], "line before filler, frame " + i);
  assert(before[i][1], alone[i][1], "column before filler, frame " + i);
}
console.log("debug_position_checkpoints ok");
