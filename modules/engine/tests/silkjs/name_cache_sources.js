// The lexer's identifier cache outlives a parse: later sources, lazy compiles
// of earlier ones and different text at the same offsets must all still
// resolve each identifier by its own spelling.
var r = [];
var pad = '/*' + 'x'.repeat(2100) + '*/';
globalThis.a1 = 1; globalThis.b1 = 2; globalThis.abc = 3; globalThis.abd = 4;
globalThis.longIdentifierNameOne = 5; globalThis.longIdentifierNameTwo = 6;
r.push((0, eval)(pad + 'a1 + abc'));
r.push((0, eval)(pad + 'b1 + abd'));
r.push((0, eval)(pad + 'abd + a1'));
r.push((0, eval)(pad + 'longIdentifierNameOne'));
r.push((0, eval)(pad + 'longIdentifierNameTwo'));
r.push((0, eval)(pad + 'abc'));
// A lazily compiled body after other sources have filled the cache.
var f = (0, eval)(pad + '(function () { function g() { return abc + longIdentifierNameTwo } return g })()');
(0, eval)(pad + 'var zz9 = abd + b1');
r.push(f(), globalThis.zz9);
// The same identifier text at a shorter source's end.
r.push((0, eval)('a1'), (0, eval)('abc'));
var got = r.join();
var expected = '4,6,5,5,6,3,9,6,1,3';
console.log(got === expected ? 'PASS name cache sources' : 'FAIL ' + got);
if (got !== expected) throw new Error('name cache regressions');
