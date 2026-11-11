// Primitive native string calls and their coercing fallbacks. Expected results
// are verified with Node 22 --jitless.
function same(actual, expected) {
    if (!Object.is(actual, expected)) throw new Error(String(actual) + ' !== ' + String(expected));
}
var text = 'ab中😀cdab';
for (var repeat = 0; repeat < 30; repeat++) {
    same(text.indexOf('ab'), 0);
    same(text.indexOf('ab', 1), 7);
    same(text.indexOf('', 100), 9);
    same(text.indexOf('missing', -5), -1);
    same(text.lastIndexOf('ab'), 7);
    same(text.lastIndexOf('ab', undefined), 7);
    same(text.lastIndexOf('ab', 6), 0);
    same(text.includes('😀', 3), true);
    same(text.includes('中', 3), false);
    same(text.startsWith('ab', -1), true);
    same(text.endsWith('ab'), true);
    same(text.endsWith('ab', 2), true);
    same(text.endsWith('', 0), true);
    same(text.slice(-2), 'ab');
    same(text.slice(7, 2), '');
    same(text.slice(-100, 100), text);
    same(text.slice(undefined, 2), 'ab');
    same(text.substring(7, 2), '中😀cd');
    same(text.substring(-3, 2), 'ab');
    same(text.substr(-2, 1), 'a');
    same(text.substr(2, -1), '');
    same(text.at(-2), 'a');
    same(text.at(-100), undefined);
    same(text.charAt(100), '');
    same(text.charCodeAt(100), NaN);
    same(text.codePointAt(3), 0x1f600);
    same(text.codePointAt(4), 0xde00);
    same(text.codePointAt(100), undefined);
    same(text.charAt(), 'a');
    same(text.slice(), text);
    same(text.substring(), text);
    same(text.substr(), text);
    same(''.slice(0, 2), '');
    same(('temporary' + repeat).slice(0, 4), 'temp');
}
var order = [];
var start = { valueOf: function () { order.push('start'); return 1; } };
var end = { valueOf: function () { order.push('end'); return 3; } };
same('abcd'.slice(start, end), 'bc');
same(order.join(','), 'start,end');
var receiver = { slice: String.prototype.slice, toString: function () { order.push('this'); return 'abcd'; } };
order = [];
same(receiver.slice(start, end), 'bc');
same(order.join(','), 'this,start,end');
var search = { toString: function () { order.push('search'); return 'b'; } };
order = [];
same('abcd'.indexOf(search, start), 1);
same(order.join(','), 'search,start');
var marker = {};
try { text.substring({ valueOf: function () { throw marker; } }, end); throw new Error('did not throw'); }
catch (error) { same(error, marker); }
var poisoned = { valueOf: function () { throw marker; }, toString: function () { throw marker; } };
same('abcd'.slice(1, 3, poisoned), 'bc');
same('abcd'.indexOf('b', 0, poisoned), 1);
same('abcd'.slice(1.9, Infinity), 'bcd');
same('abcd'.substring(NaN, '2'), 'ab');
same(new String('abcd').slice(1, 3), 'bc');
try { text.includes(/ab/); throw new Error('did not throw'); }
catch (error) { same(error instanceof TypeError, true); }
var saved = String.prototype.slice;
String.prototype.slice = function () { return 'replaced'; };
same(text.slice(1, 2), 'replaced');
String.prototype.slice = saved;
same(text.slice(0, 2), 'ab');
console.log('PASS primitive native string calls');
