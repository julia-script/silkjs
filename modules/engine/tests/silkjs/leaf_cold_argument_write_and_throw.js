// SilkJS regression test for frameless leaf calls (js_vm_leaf) of helpers whose
// cold arms write an argument, throw, or push a string: js_bytecode.leafOpcode
// admits them and a run that reaches one is declined and repeated in a frame.
// Every helper is called often enough to run inline, to hit the declined arm
// many times, and to use up its declined-run credits. Expected values come from V8.
function clamp(p, lo, hi) { if (p === undefined) p = 0; if (lo === undefined) lo = 0; if (hi === undefined) hi = 0; return p < lo ? lo : p > hi ? hi : p; }
function check(a) { if (!a) throw "Assertion Failed"; }
function bump(a) { a = a + 1; return a; }
function swap(a, b) { var t = a; a = b; b = t; return a - b; }
function both(a, b) { if (b > 2) a = b = b * 2; return a + b; }
function name(a) { if (a > 3) return "big"; return a; }
function Box(v) { this.v = v; this.n = 0; }
Box.prototype.put = function (v) { if (v < 0) v = -v; this.v = v; };
Box.prototype.clamped = function (lo, hi) { return clamp(this.v, lo, hi); };
Box.prototype.checked = function (v) { check(v < 5); return this.v; };
function run() {
  const out = [];
  const box = new Box(1);
  let sum = 0, thrown = 0;
  for (let i = 0; i < 300; i++) {
    sum += clamp(i % 7, 2, 4) + bump(i) + swap(i, 1) + both(i % 5, i % 4);
    box.put(i % 3 === 0 ? -i : i);
    sum += box.v + box.clamped(10, 20);
    try { check(i % 4 !== 3); sum += box.checked(i % 9); } catch (e) { thrown++; if (i < 8) out.push(e); }
    if (i % 60 === 0) out.push(clamp(undefined, 1, 3), clamp(5, 6), clamp(-2), name(i % 7), name(i % 3), typeof name(9));
  }
  out.push(sum, thrown);
  return out.join(',');
}
const got = run() + '|' + run();
const expected = '1,6,0,0,0,string,Assertion Failed,Assertion Failed,Assertion Failed,Assertion Failed,1,6,0,big,0,string,1,6,0,1,0,string,1,6,0,big,0,string,1,6,0,2,0,string,72395,174|1,6,0,0,0,string,Assertion Failed,Assertion Failed,Assertion Failed,Assertion Failed,1,6,0,big,0,string,1,6,0,1,0,string,1,6,0,big,0,string,1,6,0,2,0,string,72395,174';
console.log(got === expected ? 'PASS leaf cold argument write and throw' : 'FAIL ' + got);
if (got !== expected) throw new Error('leaf cold argument write and throw regressions');
