// UTF-8 conversions on wide (UTF-16) strings: the Function constructor encodes
// its source to UTF-8 and the parser decodes it again, so non-ASCII text in
// every position must survive the round trip, including long ASCII runs
// between wide characters and astral or lone-surrogate units.
function assert(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function codes(s) {
  var out = [];
  for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i).toString(16));
  return out.join(",");
}
var pad = "x".repeat(3000);
var samples = ["é", "€", "😀", "aé€😀z", "ÿĀ", "\ud800", "\udc00", "\ud800x", "􏿿", pad + "€" + pad];
for (var i = 0; i < samples.length; i++) {
  var text = samples[i];
  var f = new Function("var pad = '" + pad + "';\nreturn ['" + text + "', '" + text + "'.length, pad.length];");
  var got = f();
  assert(codes(got[0]), codes(text), "string literal " + i);
  assert(got[1], text.length, "literal length " + i);
  assert(got[2], 3000, "ascii run " + i);
}
// Wide identifiers and comments around long ASCII runs.
var src = "// " + pad + " ☃ comment\nvar ünï = '" + pad + "', λ = 'λ€😀';\nreturn ünï.length + ':' + λ;";
assert(new Function(src)(), "3000:λ€😀", "identifiers");
// Concatenating wide and Latin-1 pieces and flattening them keeps every unit.
var parts = [];
for (var i = 0; i < 200; i++) parts.push(i % 3 === 0 ? "é" + i : i % 3 === 1 ? "€" + i : "a" + i);
var joined = "";
for (var i = 0; i < parts.length; i++) joined += parts[i];
assert(joined, parts.join(""), "rope flatten");
assert(joined.slice(5, 400), parts.join("").slice(5, 400), "rope slice");
assert(("é".repeat(500) + "€".repeat(500)).indexOf("€"), 500, "mixed width search");
