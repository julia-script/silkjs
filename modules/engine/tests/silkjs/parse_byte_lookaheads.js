// SilkJS regression test for the parser's byte-level lookaheads (plain
// parameter lists, classic for heads, literal object starts, `let`
// declarations) against comments, escapes, keywords and line breaks, which send
// them back to the token-level checks. Expected values come from node.
var r = [];
function q1(a /* c */, b) { return a + b; }
function q2(a, b) { return a - b; }
function q3(a, b // c
) { return a * b; }
function q4(a, b = 2) { return a + b; }
function q5(
  a,
  b) { return a + b; }
r.push(q1(1, 2), q2(5, 1), q3(2, 3), q4(1), q5(3, 4), q4.length, q5.length);
var s = 0;
for (let i = 0; i < 3; i++) s += i;
for (const k = 5; s < 10;) s += k;
for (/* c */ let j = 0; j < 2; j++) s += 1;
for (let m = 1; m < 3; m++) s += m;
for (let [x, y] = [1, 2]; x < 2; x++) s += y;
for (let w in { a: 1 }) s += w.length;
for (const v of [1, 2]) s += v;
for (;;) { s += 100; break; }
r.push(s);
var o1 = { k: 1, n: 0, z: 10 };
var o2 = { k: 'a\'b', s: "x" };
var o3 = { k: 1.5, e: 1e3, h: 0x10 };
var o4 = { k: true, f: false, u: null };
var o5 = { k /* c */: 2 };
var o6 = { if: 'kw', a: 3 };
var p, q;
({ k: p } = { k: 4 });
({ k: q = 6 } = {});
r.push(o1.z, o2.k, o2.s, o3.e, o3.h, o4.u, o5.k, o6.if, o6.a, p, q);
try { eval("({ k: 007 } = o1)"); r.push('none'); } catch (e) { r.push(e.constructor.name); }
try { eval("({ k: 'v } = o1)"); r.push('none'); } catch (e) { r.push(e.constructor.name); }
var let1 = (function () { var let_ = 1; let x = 2; let [y] = [3]; let { z } = { z: 4 }; return let_ + x + y + z; })();
var let2 = new Function("var let = 5; let\nx = 6; return let + x;")();
var let3 = new Function("let\nyield = 7; return yield;")();
var let4 = 8;
var let5 = new Function("let x/*c*/ = 9; return x;")();
var let6 = new Function("var let = 3; let = let + 1; return let;")();
r.push(let1, let2, let3, let4, let5, let6);
try { new Function("let let = 1;"); r.push('none'); } catch (e) { r.push(e.constructor.name); }
try { new Function("'use strict'; let yield = 1;"); r.push('none'); } catch (e) { r.push(e.constructor.name); }
try { new Function("function f(if) {}"); r.push('none'); } catch (e) { r.push(e.constructor.name); }
const got = r.join();
const expected = '3,4,6,3,7,1,2,124,10,a\'b,x,1000,16,,2,kw,3,4,6,SyntaxError,SyntaxError,10,11,7,8,9,4,SyntaxError,SyntaxError,SyntaxError';
if (got !== expected) throw new Error('byte lookaheads: got ' + got);
console.log('ok');
