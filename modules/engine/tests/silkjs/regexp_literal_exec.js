// SilkJS regression test: `/re/.exec(x)` on a local or argument is answered without creating
// the literal's object when exec is the builtin; every other case takes the full call. Expected values come from V8.
var r = [];
function show(m) { return m === null ? 'null' : JSON.stringify(Array.prototype.slice.call(m)) + '@' + m.index + ':' + m.input + ':' + JSON.stringify(m.groups); }
function local(s) { var t = s; var a = /b+(c)?/.exec(t); var b = /z/.exec(t); var c = /a/g.exec(t); return [show(a), show(b), show(c)].join(' '); }
function argument(s) { return show(/(?<x>b)/.exec(s)) + ' ' + show(/b/.exec(s)) + ' ' + show(/d|é/.exec(s)); }
function loop(s) { var last = null; for (var i = 0; i < 3; i++) last = /b./y.exec(s); return show(last); }
function nonString(n) { return show(/1/.exec(n)) + ' ' + show(/l/.exec({ toString: function () { return 'xl'; } })); }
r.push(local('abbc'), argument('abé'), loop('ab'), loop('bx'), nonString(212));
var original = RegExp.prototype.exec;
RegExp.prototype.exec = function (s) { return ['patched', String(this.source), s]; };
r.push(JSON.stringify(local('abbc')), JSON.stringify(argument('xb')));
RegExp.prototype.exec = original;
Object.defineProperty(RegExp.prototype, 'exec', { get: function () { return function () { return 'getter'; }; }, configurable: true });
r.push(String(argument('b')));
Object.defineProperty(RegExp.prototype, 'exec', { value: original, writable: true, configurable: true });
r.push(argument('bb'));
var got = r.join('\n');
const expected = "[\"bbc\",\"c\"]@1:abbc:undefined null [\"a\"]@0:abbc:undefined\n[\"b\",\"b\"]@1:abé:{\"x\":\"b\"} [\"b\"]@1:abé:undefined [\"é\"]@2:abé:undefined\nnull\n[\"bx\"]@0:bx:undefined\n[\"1\"]@1:212:undefined [\"l\"]@1:xl:undefined\n\"[\\\"patched\\\",\\\"b+(c)?\\\",\\\"abbc\\\"]@undefined:undefined:undefined [\\\"patched\\\",\\\"z\\\",\\\"abbc\\\"]@undefined:undefined:undefined [\\\"patched\\\",\\\"a\\\",\\\"abbc\\\"]@undefined:undefined:undefined\"\n\"[\\\"patched\\\",\\\"(?<x>b)\\\",\\\"xb\\\"]@undefined:undefined:undefined [\\\"patched\\\",\\\"b\\\",\\\"xb\\\"]@undefined:undefined:undefined [\\\"patched\\\",\\\"d|é\\\",\\\"xb\\\"]@undefined:undefined:undefined\"\n[\"g\",\"e\",\"t\",\"t\",\"e\",\"r\"]@undefined:undefined:undefined [\"g\",\"e\",\"t\",\"t\",\"e\",\"r\"]@undefined:undefined:undefined [\"g\",\"e\",\"t\",\"t\",\"e\",\"r\"]@undefined:undefined:undefined\n[\"b\",\"b\"]@0:bb:{\"x\":\"b\"} [\"b\"]@0:bb:undefined null";
console.log(got === expected ? 'PASS regexp literal exec' : 'FAIL ' + JSON.stringify(got));
if (got !== expected) throw new Error('regexp literal exec regressions');
