// ||, && and ?? chains: short-circuit order, precedence and the mixing rule.
const r = [];
const log = [];
function t(v) { log.push(v); return v; }
r.push(t(0) || t(1) && t(2));
r.push(t(1) && t(0) || t(3));
r.push(t(0) && t(1) && t(2) || t(4) && t(5));
r.push(t(null) ?? t(6) ?? t(7));
r.push((t(0) || t(null)) ?? t(8));
r.push(t(0) ? t(1) || t(2) : t(3) && t(4));
r.push(1 | 2 && 3 | 4 || 5);
r.push(log.join(''));
for (const src of ['a ?? b || c', 'a || b ?? c', 'a && b ?? c', 'a ?? b && c', 'a || b && c ?? d']) {
  try { new Function(src); r.push('none'); } catch (e) { r.push(e.constructor.name); }
}
const got = r.join();
const expected = '2,3,5,6,8,4,7,012103045608034,SyntaxError,SyntaxError,SyntaxError,SyntaxError,SyntaxError';
if (got !== expected) throw new Error('logical chains: got ' + got);
console.log('ok');
