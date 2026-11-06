function a(x) { if (x === null) return 1; return 2 }
function b(x) { if (x !== null) return 1; return 2 }
function c(x) { return x === null ? 'n' : x === undefined ? 'u' : 'v' }
function d(x) { let n = 0; while (x !== null) { n++; x = x.next } return n }
function e(x) { let n = 0; do { n++; x = x.next } while (x !== null); return n }
function f(o) { return !(o instanceof P) ? 'no' : 'yes' }
function g(x) { if (!x) return 'f'; return 't' }
function h(x, y) { while (!(x > y)) x++; return x }
function k(x) { return (x !== null && !x.z) ? 1 : 2 }
function l(a0, a1, a2, a3) { a0 = 1; a1 = 2; a2 = 3; a3 = 4; return a0 + a1 + a2 + a3 + arguments[2] + arguments[3] }
function m(a0, a1, a2, a3) { var s = a2 = a3 = 7; return s + a2 + a3 + arguments.length }
function n(x) { try { if (x === null) throw 'null'; return !x } catch (e) { return e } }
function P() {}
const list = { next: { next: { next: null } } }
const results = [a(null), a(undefined), a(0), b(null), b(undefined), b(''), c(null), c(undefined), c(0),
  d(list), d(null), e(list), f(new P()), f({}), f(null), g(0), g(''), g('x'), g(null), h(1, 5), h(9, 5),
  k(null), k({}), k({ z: 1 }), l(9, 9, 9, 9), m(1, 2, 3, 4), n(null), n(0), n({})]
let loops = 0
for (let i = 0; i < 20000; i++) { loops += a(i & 1 ? null : i) + b(i & 2 ? null : i) + (g(i & 4) === 't' ? 1 : 0) }
results.push(loops)
const expected = '[1,2,2,2,1,1,"n","u","v",3,0,3,"yes","no","no","f","f","t","f",6,9,2,1,2,17,25,"null",true,false,70000]'
const got = JSON.stringify(results)
console.log(got == expected ? "PASS null branches" : "FAIL null branches " + got)
if (got != expected) throw new Error("null branch regressions")
