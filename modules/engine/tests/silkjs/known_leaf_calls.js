// Known local functions whose code is a leaf run frameless (js_vm.enterKnownCall,
// js_vm_leaf.attemptKnown), reading their captures from the caller's scope chain.
const r = [];
// A captured variable that changes between calls.
function counter(n) { var k = 1; function f(a) { return a + k; } var s = 0; for (var j = 0; j < n; j++) { s = f(s); k = j & 3; } return s; }
r.push(counter(1000));
// Two scope levels: a block's let and the function's var.
function levels() { var base = 100; var s = 0; for (let i = 0; i < 5; i++) { let step = i * 2; const g = (x) => x + step + base; s = g(s); } return s; }
r.push(levels());
// A nested closure calling its parent's helper.
function nested() { var w = 7; function h(x) { return x * w; } var outer = function (y) { return h(y) + h(y + 1); }; var t = 0; for (var i = 0; i < 50; i++) t += outer(i); return t; }
r.push(nested());
// Missing arguments read as undefined; extra ones are ignored.
function missing() { var d = 'd'; function m(a, b) { return '' + a + b + d; } return m(1) + m(1, 2) + m(1, 2, 3); }
r.push(missing());
// A captured let read before its initialization throws as a frame would.
function tdz() { function early() { return late; } var out; try { out = early(); } catch (e) { out = e instanceof ReferenceError; } let late = 3; return out + ':' + early(); }
r.push(tdz());
// A throw on a cold arm still throws from the call.
function cold() { var lim = 10; function check(x) { if (x > lim) throw new RangeError('big ' + x); return x; } var s = 0; for (var i = 0; i < 12; i++) { try { s += check(i); } catch (e) { s += 1000; } } return s; }
r.push(cold());
// Locals set on one arm only start undefined on every call.
function prefill() { var z = 2; function p(c) { var v; if (c) v = z; return v; } return [p(true), p(false), p(true), p(false)].join(','); }
r.push(prefill());
// Sloppy this in a plain call is the global object, strict this undefined.
function thisMode() { function sloppy() { return typeof this; } function strict() { 'use strict'; return typeof this; } return sloppy() + strict(); }
r.push(thisMode());
const got = r.join('|');
const expected = '1498|520|17500|1undefinedd12d12d|true:3|1055|2,,2,|objectundefined';
console.log(got === expected ? 'PASS known leaf calls' : 'FAIL ' + got);
if (got !== expected) throw new Error('known leaf call regressions');
