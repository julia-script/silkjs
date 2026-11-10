// SilkJS regression test: the RegExp layout cache's cheap path (standard() reading the proven
// slots raw) and its ways out, plus exec results whose one-unit captures come from the unit
// string table. Expected values come from V8.
var r = [];
// One-unit captures, Latin-1 and wide, matched and unmatched.
r.push(JSON.stringify(/(=)(x)?(.)/.exec('a=bc')), JSON.stringify(/(.)(ā)/.exec('zā')), JSON.stringify('k=v;q=w'.match(/(.)=(.)/)));
// Symbol.replace as an accessor on the prototype, then restored as data.
var desc = Object.getOwnPropertyDescriptor(RegExp.prototype, Symbol.replace);
r.push('abc'.replace(/b/g, '-'));
Object.defineProperty(RegExp.prototype, Symbol.replace, { get: function () { return function (s, t) { return 'getter:' + s + t; }; }, configurable: true });
r.push('abc'.replace(/b/g, '-'));
Object.defineProperty(RegExp.prototype, Symbol.replace, desc);
r.push('abc'.replace(/b/g, '-'));
// Replacing the flags getter keeps the layout but changes the value.
var flagsDesc = Object.getOwnPropertyDescriptor(RegExp.prototype, 'flags');
r.push('aXbXc'.replace(/x/gi, '_'));
Object.defineProperty(RegExp.prototype, 'flags', { get: function () { return 'i'; }, configurable: true });
r.push('a,b'.split(/,/).length);
Object.defineProperty(RegExp.prototype, 'flags', flagsDesc);
r.push('aXbXc'.replace(/x/gi, '_'));
// A non-number lastIndex.
var g = /b/g; g.lastIndex = 'x'; r.push('abcb'.replace(g, '+'), g.lastIndex);
var old = RegExp.prototype.exec; var seen = 0;
RegExp.prototype.exec = function (s) { seen++; return old.call(this, s); };
r.push('abab'.replace(/b/g, '.'), seen);
RegExp.prototype.exec = old; r.push('abab'.replace(/b/g, '.'));
const got = r.join('\n');
const expected = "[\"=b\",\"=\",null,\"b\"]\n[\"zā\",\"z\",\"ā\"]\n[\"k=v\",\"k\",\"v\"]\na-c\ngetter:abc-\na-c\na_b_c\n2\na_b_c\na+c+\n0\na.a.\n3\na.a.";
console.log(got === expected ? 'PASS regexp standard fast path' : 'FAIL ' + JSON.stringify(got));
if (got !== expected) throw new Error('regexp standard fast path regressions');
