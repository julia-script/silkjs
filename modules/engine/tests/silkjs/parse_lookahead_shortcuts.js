// SilkJS regression test for the parser's short lookaheads in front of the full
// bracket scan: plain parameter lists against defaults, patterns, rest and
// trailing commas, and object literals with a literal first value against
// assignment patterns. Expected values come from node.
var r = [];
function p0() { return arguments.length; }
function p1(a, b) { return a + b; }
function p2(a, b,) { return [a, b].join(); }
function p3(a, b = a + 1) { return a * b; }
function p4(a, { b }) { return a + b; }
function p5(a, ...rest) { return rest.length; }
function p6(a, [b]) { return a - b; }
var d = 7;
function p7(a, b = (function () { return d; })()) { return b; }
r.push(p0(1, 2), p1(1, 2), p2(1, 2), p3(3), p4(1, { b: 2 }), p5(1, 2, 3), p6(5, [2]), p7(1), p1.length, p3.length, p5.length);
var o1 = { k: 'v', x: 2 };
var o2 = { k: 1, x: o1.x };
var o3 = { 'k': null, n: true };
var a, b;
({ k: a, x: b } = o1);
r.push(o1.k, o2.x, o3.n, a, b);
({ k: a } = { k: 9 });
r.push(a);
var c = [];
c[0] = { k: `t${a}` };
r.push(c[0].k);
try { eval("({ k: 1 } = o1)"); r.push('none'); } catch (e) { r.push(e.constructor.name); }
try { eval("({ k: 'v' } = o1)"); r.push('none'); } catch (e) { r.push(e.constructor.name); }
const got = r.join();
const expected = '2,3,1,2,12,3,2,3,7,2,1,1,v,2,true,v,2,9,t9,SyntaxError,SyntaxError';
if (got !== expected) throw new Error('parse lookahead: got ' + got);
console.log('ok');
