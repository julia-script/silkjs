// Stores to a local that is never read are dropped; everything else must stay.
const r = [];
var calls = 0;
function bump() { calls++; return calls; }
function writeOnly(n) {
  var i, s, t, r2 = '';
  for (i = 0; i < n; i++) { s = r2; t = bump(); r2 += 'x'; }
  return r2;
}
r.push(writeOnly(5), calls);
// Read by a nested function: the stores stay.
function captured() { var s = 1; s = 2; return function () { return s; }; }
r.push(captured()());
// Read by direct eval: the stores stay.
function viaEval() { var s; s = 'e'; return eval('s'); }
r.push(viaEval());
// Read after a try/finally.
function tryFinally() { var s; try { s = 'a'; } finally { s = s + 'b'; } return s; }
r.push(tryFinally());
// Store whose value is an expression with side effects.
function sideEffects() { var s, o = { n: 0 }; s = (o.n++, o.n++); s = o.n++; return o.n; }
r.push(sideEffects());
// Chained assignment through a write-only local.
function chained() { var a, b; b = a = 7; return b; }
r.push(chained());
// Many locals: a write-only one past index 64 keeps working.
var src = 'var ' + Array.from({ length: 70 }, (_, k) => 'v' + k).join(',') + ';';
src += 'for (var k = 0; k < 3; k++) { v69 = k; v1 = k; } return v1;';
r.push(new Function(src)());
// with: name lookup in a with body reaches the local.
function withBody(o) { var s = 'local'; with (o) { s = 'w'; } return s; }
r.push(withBody({}), withBody({ s: 1 }));
// Generators keep locals across yields.
function* gen() { var s, k = 0; while (k < 3) { s = k; yield k++; } }
r.push([...gen()].join(','));
const got = r.join('|');
const expected = 'xxxxx|5|2|e|ab|3|7|2|w|local|0,1,2';
console.log(got === expected ? 'PASS write only local' : 'FAIL ' + got);
if (got !== expected) throw new Error('write-only local regressions');
