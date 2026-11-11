// Write-only local detection in functions whose captured locals live in a scope
// (js_compiler_scopes): stores that only closures read must stay.
const r = [];
function scopedLet() { let s = 1; s = 2; const f = () => s; return f(); }
r.push(scopedLet());
function scopedConst() { const s = 'c'; return (() => s)(); }
r.push(scopedConst());
function hoisted() { function g() { return 'g'; } return (() => g())(); }
r.push(hoisted());
function parameter(a) { a = a + 1; return () => a; }
r.push(parameter(1)());
function mixed() { var dead, kept = 0; dead = 5; kept = 3; const read = () => kept; dead = 6; return read(); }
r.push(mixed());
function late() { let s; const f = () => s; s = 'late'; return f(); }
r.push(late());
function loop() { const out = []; for (let i = 0; i < 3; i++) { out.push(() => i); } return out.map((f) => f()).join(','); }
r.push(loop());
function nested() { let s = 'n'; return (() => (() => s)())(); }
r.push(nested());
const got = r.join('|');
const expected = '2|c|g|2|3|late|0,1,2|n';
console.log(got === expected ? 'PASS write only local scoped' : 'FAIL ' + got);
if (got !== expected) throw new Error('write-only local regressions in scoped functions');
