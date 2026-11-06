// Stack positions of lazily finished nested functions and their call sites
// when their source follows lines with astral and non-ASCII characters. A
// finish counts positions from the function's own start, so the frames must
// move by exactly the prefix's line count with columns unchanged.
function assert(actual, expected, message) {
  if (actual !== expected) throw new Error(message + ": expected " + expected + ", got " + actual);
}
var probe = [
  "function probe() {",
  "  var frames = [];",
  "  function inner(k) { var s = '\\u{1F600}\\u00e9'; frames.push(new Error().stack.split('\\n')[1]);",
  "    if (k > 0) (function () { var t = '\\u{1F600}'; frames.push(new Error().stack.split('\\n')[1]);",
  "      frames.push(new Error().stack.split('\\n')[2]); })();",
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
var prefix = "var a = '\u{1F600}\u{1F600}';\nvar b = 1; var c = 'é';\n" +
  "var e = function () { return '\u{1F600}'; };\n";
var prefixLines = 3;
var alone = positions(probe);
var after = positions(prefix + probe);
assert(alone.length, 4, "frame count");
for (var i = 0; i < alone.length; i++) {
  assert(after[i][0], alone[i][0] + prefixLines, "line after prefix, frame " + i);
  assert(after[i][1], alone[i][1], "column after prefix, frame " + i);
}
console.log("ok");
