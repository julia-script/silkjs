// `s.replace(/re/, text)` with a RegExp literal is answered without creating
// the RegExp object when every builtin involved is the intrinsic. The answer
// must match the generic path in every shape, and the shortcut must stand down
// as soon as anything observable is overridden.
function assert(value, message) { if (!value) throw new Error(message); }
function same(actual, expected, message) {
    assert(actual === expected, message + ': got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected));
}

function plain(s) { return s.replace(/b+/, 'X'); }
function global(s) { return s.replace(/b+/g, 'X'); }
function sticky(s) { return s.replace(/b+/y, 'X'); }
function literal(s) { return s.replace(/needle/g, '-'); }
function empty(s) { return s.replace(/x*/g, '.'); }
function local(s, r) { return s.replace(/(\d+)-(\d+)/, r); }
function dollar(s) { return s.replace(/(\d+)-(\d+)/, '$2-$1'); }
function named(s) { return s.replace(/(?<a>\d+)/, '[$<a>]'); }
function ignore(s) { return s.replace(/ABC/gi, '_'); }
function unicode(s) { return s.replace(/./gu, '*'); }

var long = '';
for (var i = 0; i < 400; i++) long += 'ab' + i + 'needle';

for (var round = 0; round < 40; round++) {
    same(plain('aabbbcbb'), 'aaXcbb', 'non-global');
    same(plain('none'), 'none', 'non-global miss');
    same(global('aabbbcbb'), 'aaXcX', 'global');
    same(global(''), '', 'global empty input');
    same(sticky('bbabb'), 'Xabb', 'sticky hit');
    same(sticky('abb'), 'abb', 'sticky miss');
    same(literal('a needle b needle'), 'a - b -', 'literal global');
    same(literal(long).length, long.length - 400 * 5, 'long literal global');
    same(empty('ab'), '.a.b.', 'empty matches');
    same(local('10-20', 'R'), 'R', 'local replacement');
    same(local('10-20', '$2'), '20', 'local replacement with $');
    same(local('10-20', 7), '7', 'non-string replacement');
    same(local('10-20', function(m, a, b) { return b + a; }), '2010', 'callback replacement');
    same(dollar('10-20'), '20-10', 'dollar replacement');
    same(named('x12'), 'x[12]', 'named groups');
    same(ignore('xAbCabc'), 'x__', 'ignore case');
    same(unicode('a\u{1F600}b'), '***', 'unicode on wide input');
    same(global('Ābbā'), 'ĀXā', 'wide input');
    same(local('1-2', 'Ā'), 'Ā', 'wide replacement');
    same(global(new String('abb')), 'aX', 'String object receiver');
    same(String.prototype.replace.call(5, /5/, 'five'), 'five', 'number receiver');
}

// Results stay distinct strings and the input is never changed.
var input = 'abba';
var first = global(input), second = global(input);
same(first, 'aXa', 'first result'); same(second, 'aXa', 'second result'); same(input, 'abba', 'input intact');

// lastIndex of a literal created elsewhere is still honoured and written.
var kept = /b/y;
kept.lastIndex = 2;
same('abba'.replace(kept, 'X'), 'abXa', 'sticky lastIndex honoured');
same(kept.lastIndex, 3, 'sticky lastIndex written');

// An own property on the receiver's wrapper does not matter, but an override
// on the prototypes does. Each is installed, observed, then removed.
var calls = 0;
var originalExec = RegExp.prototype.exec;
RegExp.prototype.exec = function(s) { calls++; return originalExec.call(this, s); };
same(plain('abc'), 'aXc', 'exec override result');
assert(calls === 1, 'exec override observed');
RegExp.prototype.exec = originalExec;
same(plain('abc'), 'aXc', 'exec restored');
assert(calls === 1, 'exec restored is not called through the override');

var originalReplace = RegExp.prototype[Symbol.replace];
RegExp.prototype[Symbol.replace] = function(s, r) { return 'symbol:' + s + ':' + r; };
same(plain('abc'), 'symbol:abc:X', 'Symbol.replace override');
RegExp.prototype[Symbol.replace] = originalReplace;
same(plain('abc'), 'aXc', 'Symbol.replace restored');

// A flags getter that hides the g of a global literal. Engines differ on
// whether replace reads flags or global, so the literal site is held to
// whatever a RegExp created elsewhere does under the same override.
var flags = Object.getOwnPropertyDescriptor(RegExp.prototype, 'flags');
var reads = 0;
Object.defineProperty(RegExp.prototype, 'flags', {get: function() { reads++; return ''; }, configurable: true});
var reference = new RegExp('b+', 'g');
var expected = 'abcb'.replace(reference, 'X');
var referenceReads = reads;
reads = 0;
same(global('abcb'), expected, 'flags override matches a materialized RegExp');
assert(reads === referenceReads, 'flags override observed as often as for a materialized RegExp');
Object.defineProperty(RegExp.prototype, 'flags', flags);
same(global('abcb'), 'aXcX', 'flags restored');

var originalStringReplace = String.prototype.replace;
String.prototype.replace = function(re, r) { return 'string:' + (re instanceof RegExp) + ':' + r; };
same(plain('abc'), 'string:true:X', 'String.prototype.replace override');
String.prototype.replace = originalStringReplace;
same(plain('abc'), 'aXc', 'String.prototype.replace restored');

// A receiver that is not a string takes the generic path with the literal.
var holder = {replace: function(re, r) { return re.source + '|' + re.lastIndex + '|' + r; }};
function onObject(o) { return o.replace(/b+/, 'X'); }
same(onObject(holder), 'b+|0|X', 'object receiver sees a real RegExp');
same(onObject('abb'), 'aX', 'same site with a string');
same(onObject(holder), 'b+|0|X', 'object receiver again');

console.log('PASS regexp site replace');
