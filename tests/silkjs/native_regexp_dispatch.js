// Native RegExp dispatch must preserve method identity, coercion and fallback.
function same(actual, expected) {
    if (!Object.is(actual, expected)) throw new Error(String(actual) + ' !== ' + String(expected));
}
var nativeExec = RegExp.prototype.exec;
var nativeTest = RegExp.prototype.test;
var pattern = new RegExp('(a)', 'g');
var poisoned = { toString: function () { throw new Error('unused argument'); } };
for (var i = 0; i < 40; i++) {
    pattern.lastIndex = 0;
    var first = pattern.exec('baab', poisoned);
    same(first[0], 'a');
    same(first[1], 'a');
    same(first.index, 1);
    same(first.input, 'baab');
    same(pattern.lastIndex, 2);
    same(pattern.exec('baab').index, 2);
    same(pattern.exec('baab'), null);
    same(pattern.lastIndex, 0);
    same(pattern.test('x'), false);
    same(pattern.test('a'), true);
    same(pattern.lastIndex, 1);
    same('baab'.replace(pattern, '<$1>'), 'b<a><a>b');
}
var missing = new RegExp('undefined');
same(missing.exec()[0], 'undefined');
same(missing.test(), true);
pattern.lastIndex = 0;
pattern.other = nativeExec;
same(pattern.other('ba').index, 1);

var coercions = 0;
pattern.lastIndex = 0;
var input = { toString: function () {
    coercions++;
    pattern.exec = function () { return 'replacement'; };
    return 'ba';
} };
same(pattern.exec(input).index, 1);
same(coercions, 1);
same(pattern.exec('ba'), 'replacement');
pattern.exec = nativeExec;

var marker = {};
try { pattern.exec({ toString: function () { throw marker; } }); throw new Error('did not throw'); }
catch (error) { same(error, marker); }
var invalid = { exec: nativeExec };
try { invalid.exec('a'); throw new Error('did not throw'); }
catch (error) { same(error instanceof TypeError, true); }

var calls = 0;
var tester = { test: nativeTest, exec: function (text) { calls++; same(text, 'value'); return {}; } };
same(tester.test('value'), true);
same(calls, 1);
Object.defineProperty(tester, 'exec', { get: function () { calls++; throw marker; } });
try { tester.test('value'); throw new Error('did not throw'); }
catch (error) { same(error, marker); }
same(calls, 2);

var replacementPattern = new RegExp('a', 'g');
replacementPattern.exec = function () { calls++; return null; };
same('baab'.replace(replacementPattern, 'x'), 'baab');
same(calls, 3);
var positions = [];
same('aba'.replace(new RegExp('a', 'g'), function (match, position) {
    positions.push(position);
    return position;
}), '0b2');
same(positions.join(','), '0,2');
console.log('PASS native regexp dispatch');
