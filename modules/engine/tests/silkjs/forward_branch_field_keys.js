// SilkJS regression test for short forward branches over field reads and
// stores (js_compiler_label_support.forwardDistance): the inline field-cache
// keys make the final code between a branch and its label longer than the
// pre-label code that sizes the branch, so every body length near the one-byte
// limit must still compile and take both edges.
const o = {}; o.f = o;
const shapes = [
  (chain) => `if (a) { return o${chain} } return 1`,
  (chain) => `let v = 0; if (a) { v = o${chain} } else { v = o${chain}; v = 1 } return v`,
  (chain) => `return a ? o${chain} : 1`,
  (chain) => `return a && o${chain}`,
  (chain) => `switch (a) { case 1: return o${chain}; case 2: return o${chain} === o; default: return 0 }`,
  (chain, n) => `let x = o; if (a === 1) { ${'x = x.f; '.repeat(n)} } return a ? x : 1`,
  (chain, n) => `const t = {}; if (a < 3) { ${Array.from({ length: n }, (_, i) => `t.p${i} = a;`).join(' ')} return o } return t.p0 === undefined ? 1 : 2`,
];
let failures = 0;
for (let n = 1; n <= 40; n++) {
  const chain = '.f'.repeat(n);
  for (let s = 0; s < shapes.length; s++) {
    const f = new Function('a', 'o', shapes[s](chain, n));
    const taken = f(1, o), skipped = f(s === 4 ? 2 : s === 6 ? 5 : 0, o);
    const other = s === 3 ? 0 : s === 4 ? true : 1;
    if (taken !== o || skipped !== other) { failures++; console.log('FAIL shape ' + s + ' length ' + n); }
  }
}
console.log(failures === 0 ? 'PASS forward branches over field keys' : 'FAIL ' + failures);
if (failures !== 0) throw new Error('forward branch field key regressions');
