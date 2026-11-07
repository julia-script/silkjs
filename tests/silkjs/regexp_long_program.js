// A program past 65,535 bytecode bytes outgrows the search hint's u16 offsets and searches without one.
function same(actual, expected) {
    if (!Object.is(actual, expected)) throw new Error(String(actual) + ' !== ' + String(expected));
}
var digits = new RegExp('\\d'.repeat(2000) + 'ab');
same(digits.test('7'.repeat(2000) + 'ab'), true);
same(digits.test('x' + '7'.repeat(2000) + 'ab'), true);
same(digits.exec('x' + '7'.repeat(2000) + 'ab').index, 1);
same(digits.test('77ab'), false);
same(digits.test('7'.repeat(1999) + 'ab'), false);
var wide = new RegExp('\\d'.repeat(2000) + 'é');
same(wide.test('Ā' + '7'.repeat(2000) + 'é'), true);
