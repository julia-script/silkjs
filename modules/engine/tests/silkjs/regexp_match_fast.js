// SilkJS regression test: String.prototype.match on a standard RegExp searches with the
// bytecode directly (optimizedMatch), and its ways out. Expected values come from V8.
var r = [];
var str0 = 'Zbmvyyn/5.0 (Jvaqbjf; H; Jvaqbjf AG 5.1; ra-HF) zfvr ZFVR';
r.push(JSON.stringify(str0.match(/zfvr/gi)), JSON.stringify(str0.match(/bcren/gi)), JSON.stringify(str0.match(/jvaqbjf/i)));
r.push(JSON.stringify('aaa'.match(/a*?/g)), JSON.stringify('abc'.match(/(?:)/g)), JSON.stringify(''.match(/x*/g)), JSON.stringify(''.match(/x/g)));
r.push(JSON.stringify('😀x'.match(/(?:)/gu)), JSON.stringify('😀x'.match(/(?:)/g)), JSON.stringify('ā-b-ā'.match(/ā/g)));
var g = /b/g; g.lastIndex = 5; r.push(JSON.stringify('abcb'.match(g)), g.lastIndex);
var s = /b/gy; r.push(JSON.stringify('bbab'.match(s)), s.lastIndex);
var y = /b/y; y.lastIndex = 1; r.push(JSON.stringify('abab'.match(y)), y.lastIndex);
var n = /(b)(c)?/; n.lastIndex = 3; r.push(JSON.stringify('abcb'.match(n)), n.lastIndex);
var h = /b/g; Object.defineProperty(h, 'lastIndex', { writable: false, value: 0 });
try { 'abc'.match(h); r.push('no throw'); } catch (e) { r.push(e.constructor.name); }
var old = RegExp.prototype.exec; var seen = 0;
RegExp.prototype.exec = function (t) { seen++; return old.call(this, t); };
r.push(JSON.stringify('abab'.match(/b/g)), seen);
RegExp.prototype.exec = old; r.push(JSON.stringify('abab'.match(/b/g)));
var gd = Object.getOwnPropertyDescriptor(RegExp.prototype, 'global');
Object.defineProperty(RegExp.prototype, 'global', { get: function () { return false; }, configurable: true });
r.push(JSON.stringify('abab'.match(/b/g)));
Object.defineProperty(RegExp.prototype, 'global', gd);
r.push(JSON.stringify('abab'.match(/b/g)), JSON.stringify('x1y22z333'.match(/\d+/g)), JSON.stringify(/b/g[Symbol.match]('abcb')));
const got = r.join('\n');
const expected = "[\"zfvr\",\"ZFVR\"]\nnull\n[\"Jvaqbjf\"]\n[\"\",\"\",\"\",\"\"]\n[\"\",\"\",\"\",\"\"]\n[\"\"]\nnull\n[\"\",\"\",\"\"]\n[\"\",\"\",\"\",\"\"]\n[\"\u0101\",\"\u0101\"]\n[\"b\",\"b\"]\n0\n[\"b\",\"b\"]\n0\n[\"b\"]\n2\n[\"bc\",\"b\",\"c\"]\n3\nTypeError\n[\"b\",\"b\"]\n3\n[\"b\",\"b\"]\n[\"b\"]\n[\"b\",\"b\"]\n[\"1\",\"22\",\"333\"]\n[\"b\",\"b\"]";
console.log(got === expected ? 'PASS regexp match fast path' : 'FAIL ' + JSON.stringify(got));
if (got !== expected) throw new Error('regexp match fast path regressions');
