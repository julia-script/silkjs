// Dead zone checks the compiler proves unneeded go (js_compiler_tdz): every
// read before initialization must still throw, through every control flow
// shape that runs code in another order than it is written.
const r = [];
function tdz(f) { try { return String(f()); } catch (e) { return e.name; } }
// Straight line, nested blocks, loops: reads after the store.
r.push(tdz(() => { let a = 1; { a = a + 1; } for (let i = 0; i < 3; i++) { a += i; } return a; }));
// Read before the declaration in the same block.
r.push(tdz(() => { a; let a = 1; return a; }));
r.push(tdz(() => { a = 2; let a = 1; return a; }));
r.push(tdz(() => { let a = a; return a; }));
r.push(tdz(() => { let [a, b] = [b, 1]; return a; }));
r.push(tdz(() => { let { a = 1, b = a } = {}; return a + b; }));
// switch: a later case reached without the earlier case's declaration.
function sw(n) {
  switch (n) {
    case 0: let x = 5; return x;
    case 1: return x;
    case 2: x = 3; return 'set';
    default: return typeof x;
  }
}
r.push(tdz(() => sw(0)), tdz(() => sw(1)), tdz(() => sw(2)), tdz(() => sw(3)));
function swFall(n) { switch (n) { case 0: let y = 1; case 1: return y; } }
r.push(tdz(() => swFall(0)), tdz(() => swFall(1)));
// for-in/of: the head expression runs after the binding code is written.
r.push(tdz(() => { for (let k of k) {} return 'no'; }));
r.push(tdz(() => { for (let k in k) {} return 'no'; }));
r.push(tdz(() => { let s = 0; for (const v of [1, 2, 3]) { s += v; } for (const k in { p: 1, q: 2 }) { s += k.length; } return s; }));
// Loops: the store happens later in the body on a previous iteration only.
r.push(tdz(() => { let out = 0; for (let i = 0; i < 2; i++) { if (i == 1) { out = z; } let z = i; } return out; }));
r.push(tdz(() => { let n = 0; while (n < 3) { let w = n; n = w + 1; } return n; }));
// Conditional stores.
function cond(c) { let q; if (c) { q = 1; } return q; }
r.push(cond(true), cond(false));
function late(c) { if (c) { return v; } let v = 2; return v; }
r.push(tdz(() => late(false)), tdz(() => late(true)));
// try/catch/finally: handlers start with nothing known.
function tc(c) {
  try { if (c) throw 1; let t = 1; return t; }
  catch (e) { let u = e + 1; return u; }
  finally { let f = 3; f++; }
}
r.push(tc(false), tc(true));
function tf() { let a; try { a = 1; throw 0; } catch (e) { a = a + 1; } finally { a = a * 10; } return a; }
r.push(tf());
function inner() { try { return g; } finally { } let g = 1; }
r.push(tdz(inner));
// Labeled breaks and continue.
r.push(tdz(() => { let s = 0; outer: for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) { if (j == 1) continue outer; let k = i + j; s += k; } } return s; }));
r.push(tdz(() => { b: { break b; } let m = 4; return m; }));
// Closures keep their checks: called before and after initialization.
r.push(tdz(() => { const f = () => c; let r1 = tdz(f); let c = 7; return r1 + '/' + f(); }));
// typeof in the dead zone throws too.
r.push(tdz(() => { typeof d; let d = 1; return 'no'; }));
// Compound assignment and update on locals.
r.push(tdz(() => { let e = 1; e += 2; e++; ++e; return e; }));
r.push(tdz(() => { e++; let e = 1; }));
// Classes: the binding inside its own heritage.
r.push(tdz(() => { class C extends (C, Object) {} return 'no'; }));
// Generators resume after the store.
function* gen() { let x = 1; yield x; x++; yield x; }
r.push([...gen()].join(','));
// async: await between store and read.
let asyncResult = '';
(async () => { let a = 1; await null; a++; asyncResult = String(a); })();
const got = r.join(';');
const expected = "5;ReferenceError;ReferenceError;ReferenceError;ReferenceError;2;5;ReferenceError;ReferenceError;ReferenceError;1;ReferenceError;ReferenceError;ReferenceError;8;ReferenceError;3;1;;2;ReferenceError;1;2;20;ReferenceError;3;4;ReferenceError/7;ReferenceError;5;ReferenceError;ReferenceError;1,2";
Promise.resolve().then(() => {
  const all = got + '|' + asyncResult;
  console.log(all === expected + '|2' ? 'PASS tdz check elision' : 'FAIL ' + all);
  if (all !== expected + '|2') throw new Error('tdz check elision regressions');
});
