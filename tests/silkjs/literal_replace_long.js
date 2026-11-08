// A global literal pattern replaced across a long Latin-1 string gives the same
// result whatever the match count and placement, sets lastIndex to 0, and
// returns the string itself when nothing matches.
function assert(actual, expected, message) {
  if (actual !== expected) throw new Error(message + ': expected ' + JSON.stringify(expected).slice(0, 80) + ', got ' + JSON.stringify(actual).slice(0, 80));
}
function reference(text, word, insert) {
  var out = '', from = 0, at;
  while ((at = text.indexOf(word, from)) >= 0) { out += text.slice(from, at) + insert; from = at + word.length; }
  return out + text.slice(from);
}
var count = 0;
var fillers = ['x', 'go', 'gooog', 'g', ' é ', 'oog'];
var words = ['goog', 'g', 'ab', 'jQuery'];
var inserts = ['', 'X', 'goog12abc', 'éé', 'a much longer replacement text'];
for (var w = 0; w < words.length; w++) {
  for (var f = 0; f < fillers.length; f++) {
    for (var n = 0; n < 6; n++) {
      for (var k = 0; k < inserts.length; k++) {
        var word = words[w], insert = inserts[k];
        var parts = [];
        var gap = fillers[f].repeat(1 + ((n * 37) % 23));
        for (var i = 0; i < 40 * n; i++) parts.push(i % 7 === 0 ? '' : gap);
        var text = (n % 2 ? word : '') + parts.join(word) + 'y'.repeat(1100) + (n % 3 ? word + word : '');
        var re = new RegExp(word, 'g');
        re.lastIndex = 5;
        var got = text.replace(re, insert);
        assert(got, reference(text, word, insert), 'replace ' + word + ' ' + f + ' ' + n + ' ' + k);
        assert(re.lastIndex, 0, 'lastIndex');
        count++;
      }
    }
  }
}
var plain = 'z'.repeat(5000);
assert(plain.replace(/goog/g, 'x'), plain, 'no match');
assert('q'.repeat(2000).replace(/q/g, 'goog').length, 8000, 'every byte');
console.log('PASS literal replace long ' + count);
