// RegExp result filling: each capture owns one initialized element, including
// absent captures. Expected values and descriptors are verified with Node.
function same(actual, expected) {
  if (!Object.is(actual, expected)) throw new Error(String(actual) + ' !== ' + String(expected));
}
function captureShape(m, text, index, captures) {
  same(Array.isArray(m), true);
  same(Object.getPrototypeOf(m), Array.prototype);
  same(m.input, text);
  same(m.index, index);
  same(m.length, captures.length);
  for (var i = 0; i < captures.length; i++) {
    same(m[i], captures[i]);
    var d = Object.getOwnPropertyDescriptor(m, String(i));
    same(d.writable && d.enumerable && d.configurable, true);
  }
  same(Object.getOwnPropertyDescriptor(m, 'length').enumerable, false);
  for (var key of ['index', 'input', 'groups']) {
    var d = Object.getOwnPropertyDescriptor(m, key);
    same(d.writable && d.enumerable && d.configurable, true);
  }
}

var text = 'xxabbb!';
var m = /((a)(b+))(q)?()/.exec(text);
captureShape(m, text, 2, ['abbb', 'abbb', 'a', 'bbb', undefined, '']);
same(m.groups, undefined);
same(Object.keys(m).join(','), '0,1,2,3,4,5,index,input,groups');
// Growing, shrinking and retaining a result must preserve independently owned
// strings even after later executions replace substring-table entries.
var saved = m.slice();
m.push('tail'); m.length = 3; m.extra = 42;
same(m[2], 'a'); same(m.extra, 42);
for (var i = 0; i < 600; i++) /(.{2})(.*)/.exec('prefix-' + i + '-suffix');
same(saved.join('|'), 'abbb|abbb|a|bbb||');

captureShape(/(a)?(b)?/.exec(''), '', 0, ['', undefined, undefined]);
captureShape(/(\x00)(bc)/.exec('a\x00bcd'), 'a\x00bcd', 1, ['\x00bc', '\x00', 'bc']);
captureShape(/(a+)(b+)/.exec('aaaaabbbbb'), 'aaaaabbbbb', 0, ['aaaaabbbbb', 'aaaaa', 'bbbbb']);
captureShape(/(a+)(b+)/.exec('a'.repeat(70) + 'b'.repeat(80)),
  'a'.repeat(70) + 'b'.repeat(80), 0, ['a'.repeat(70) + 'b'.repeat(80), 'a'.repeat(70), 'b'.repeat(80)]);
captureShape(/(a)(\u0100)(.)/u.exec('xa\u0100😀'), 'xa\u0100😀', 1, ['a\u0100😀', 'a', '\u0100', '😀']);
captureShape(/(a)(bc)/.exec('\u0100abc\u0100'), '\u0100abc\u0100', 1, ['abc', 'a', 'bc']);
// Both sides of the 16-value inline-storage limit, with absent captures too.
for (var count of [15, 16, 20]) {
  var re = new RegExp('(a)'.repeat(count) + '(z)?');
  var input = 'a'.repeat(count);
  var expected = [input];
  for (var i = 0; i < count; i++) expected.push('a');
  expected.push(undefined);
  captureShape(re.exec(input), input, 0, expected);
}

var global = /(a)(b)?/g;
captureShape(global.exec('aba'), 'aba', 0, ['ab', 'a', 'b']); same(global.lastIndex, 2);
captureShape(global.exec('aba'), 'aba', 2, ['a', 'a', undefined]); same(global.lastIndex, 3);
same(global.exec('aba'), null); same(global.lastIndex, 0);
global.lastIndex = 99; same(global.exec('aba'), null); same(global.lastIndex, 0);
var sticky = /(a)(b)?/y;
sticky.lastIndex = 1;
captureShape(sticky.exec('xaba'), 'xaba', 1, ['ab', 'a', 'b']); same(sticky.lastIndex, 3);
captureShape(sticky.exec('xaba'), 'xaba', 3, ['a', 'a', undefined]); same(sticky.lastIndex, 4);
same(sticky.exec('xaba'), null); same(sticky.lastIndex, 0);
Object.defineProperty(global, 'lastIndex', {writable: false});
var threw = false;
try { global.exec('aba'); } catch (e) { threw = e instanceof TypeError; }
same(threw, true);

var named = /(?<first>a)(?<missing>b)?/d.exec('xa');
captureShape(named, 'xa', 1, ['a', 'a', undefined]);
same(Object.getPrototypeOf(named.groups), null);
same(named.groups.first, 'a'); same(named.groups.missing, undefined);
same(JSON.stringify(named.indices), '[[1,2],[1,2],null]');
same(named.indices.groups.first, named.indices[1]);
same(Object.getPrototypeOf(named.indices.groups), null);
same(Object.prototype.hasOwnProperty.call(named.indices.groups, 'missing'), true);
same(named.indices.groups.missing, undefined);
console.log('PASS regexp capture fill');
