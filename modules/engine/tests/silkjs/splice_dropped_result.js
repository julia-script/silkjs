// arr.splice(...) as a statement skips building the Array of removed elements;
// the same calls with the result used must still return it, and the receiver
// must end up the same either way. Also methods read from string primitives.
function assert(actual, expected, message) {
  if (actual !== expected && !(actual !== actual && expected !== expected)) {
    throw new Error(message + ': got ' + actual + ', expected ' + expected);
  }
}
function fresh() { return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]; }
var cases = [[0, 1], [0, 3], [2, 0, 'a'], [2, 1, 'a', 'b'], [3, 3, 28, 1, 2], [9, 1], [10, 0, 'end'], [-2, 1], [4], [0, 100], [5, -1, 'x']];
for (var c = 0; c < cases.length; c++) {
  var args = cases[c], dropped = fresh(), kept = fresh(), removed;
  if (args.length === 1) { dropped.splice(args[0]); removed = kept.splice(args[0]); }
  else if (args.length === 2) { dropped.splice(args[0], args[1]); removed = kept.splice(args[0], args[1]); }
  else if (args.length === 3) { dropped.splice(args[0], args[1], args[2]); removed = kept.splice(args[0], args[1], args[2]); }
  else if (args.length === 4) { dropped.splice(args[0], args[1], args[2], args[3]); removed = kept.splice(args[0], args[1], args[2], args[3]); }
  else { dropped.splice(args[0], args[1], args[2], args[3], args[4]); removed = kept.splice(args[0], args[1], args[2], args[3], args[4]); }
  assert(dropped.join(), kept.join(), 'receiver after splice(' + args.join() + ')');
  assert(dropped.length, kept.length, 'length after splice(' + args.join() + ')');
  assert(Array.isArray(removed), true, 'a used result is an Array');
  assert(removed.join(), fresh().splice.apply(fresh(), args).join(), 'removed elements of splice(' + args.join() + ')');
}
// Removed objects are released, not leaked into a hidden Array: the receiver is all that changes.
var objects = [{ id: 1 }, { id: 2 }, { id: 3 }];
var second = objects[1];
objects.splice(1, 1);
assert(objects.length, 2, 'object removed'); assert(objects[1].id, 3, 'tail moved down'); assert(second.id, 2, 'a removed object another holder keeps');
// The comma operator and an expression statement in a loop both drop the result.
var list = fresh();
for (var i = 0; i < 3; i++) { list.splice(0, 1); }
assert(list.join(), '3,4,5,6,7,8,9', 'splice in a loop');
var value = (list.splice(0, 2), list.length);
assert(value, 5, 'splice before a comma');
// A subclass and a replaced splice keep their own behaviour.
class Tracked extends Array {}
var tracked = Tracked.from([1, 2, 3]);
tracked.splice(0, 1);
assert(tracked.length, 2, 'subclass receiver'); assert(tracked.splice(0, 1) instanceof Tracked, true, 'species result');
var calls = 0, patched = [1, 2, 3];
patched.splice = function () { calls++; return 'mine'; };
patched.splice(0, 1);
assert(calls, 1, 'an own splice is called'); assert(patched.length, 3, 'an own splice leaves the array');

// Methods read from a string primitive, a rope and a String object.
var text = 'hello world', rope = text + ', ' + text + '!';
assert(text.charCodeAt(4), 111, 'charCodeAt'); assert(text.substring(6), 'world', 'substring'); assert(rope.indexOf('!'), 24, 'rope method');
assert(text.constructor, String, 'constructor through the prototype'); assert(text.missing, undefined, 'missing name'); assert(text.length, 11, 'length');
String.prototype.shout = function () { return this.toUpperCase() + '!'; };
assert(text.shout(), 'HELLO WORLD!', 'a method added to String.prototype');
function reader(s) { return s.shout(); }
for (var r = 0; r < 4; r++) { assert(reader(r % 2 ? text : rope), (r % 2 ? text : rope).toUpperCase() + '!', 'cached lookup ' + r); }
String.prototype.shout = function () { return 'quiet'; };
assert(reader(text), 'quiet', 'a replaced prototype method is seen at a cached site');
delete String.prototype.shout;
var threw = false; try { reader(text); } catch (error) { threw = error instanceof TypeError; }
assert(threw, true, 'a deleted prototype method is seen at a cached site');
assert((5).toString(), '5', 'number method'); assert(true.toString(), 'true', 'boolean method');
