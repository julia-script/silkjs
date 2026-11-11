function a(x) { if (x == null) return 1; return 2 }
function b(x) { if (x != null) return 1; return 2 }
function c(x) { return x?.y }
function d(x, y) { let n = 0; while (x != null) { n++; x = x.next } return n }
function e(o) { o.v ??= 5; return o.v }
function f(x) { var r = 0; for (var i = 0; i < 3; i++) { if (x == undefined) r += i; else r -= i } return r }
function g(a0, a1, a2, a3) { a0 = 1; a1 = 2; a2 = 3; a3 = 4; return a0 + a1 + a2 + a3 + arguments[0] }
function h(x) { try { if (x == null) throw 1; return 0 } catch (e) { return e } }
const list = { next: { next: { next: null } } }
const results = [a(null), a(undefined), a(0), a(''), b(null), b(false), c(null), c({ y: 3 }), c(undefined),
  d(list, 0), e({}), e({ v: 0 }), f(null), f(1), g(9, 9, 9, 9), h(null), h(2)]
// Backward fused branch (loop condition) and a branch that is a jump target.
function k(x) { let n = 0; do { n++ } while (n < 5 && x != null); return n }
function m(x, y) { return (y || x == null) ? 1 : 2 }
let loops = 0
for (let i = 0; i < 20000; i++) { loops += a(i & 1 ? null : i) + b(i) }
results.push(k(null), k(1), m(null, false), m(1, false), m(1, true), loops)
const expected = "[1,1,2,2,2,1,null,3,null,3,5,0,3,-3,11,1,0,1,5,1,2,1,50000]"
const got = JSON.stringify(results)
console.log(got == expected ? "PASS nullish branches" : "FAIL nullish branches " + got)
if (got != expected) throw new Error("nullish branch regressions")
