// SilkJS regression test for the native call kinds (NativeFunctionData.callKind):
// frameless predicate answers (Array.isArray, ArrayBuffer.isView, Number.is*,
// Object.is), string methods' primitive entries called without a frame, and
// lean calls of other builtins: answers, declines, errors and their stacks
// must match the full native call. Expected values come from node.
var r = [];
var p = new Proxy([], {}), rev = Proxy.revocable([], {});
r.push(Array.isArray([]), Array.isArray({}), Array.isArray(p), Array.isArray(), Array.isArray('x'), Array.isArray(new Proxy({}, {})));
rev.revoke();
try { Array.isArray(rev.proxy); r.push('no throw'); } catch (e) { r.push(e.constructor.name); }
r.push(ArrayBuffer.isView(new Uint8Array(2)), ArrayBuffer.isView(new DataView(new ArrayBuffer(2))), ArrayBuffer.isView(new ArrayBuffer(2)), ArrayBuffer.isView([]), ArrayBuffer.isView());
r.push(Number.isInteger(3), Number.isInteger(3.5), Number.isInteger('3'), Number.isInteger(-0), Number.isInteger(Infinity), Number.isInteger(1e300));
r.push(Number.isNaN(NaN), Number.isNaN('NaN'), Number.isFinite(1), Number.isFinite(Infinity), Number.isFinite('1'));
r.push(Number.isSafeInteger(2 ** 53), Number.isSafeInteger(2 ** 53 - 1), Number.isSafeInteger(-5), Number.isSafeInteger(5.5));
r.push(Object.is(NaN, NaN), Object.is(0, -0), Object.is('ab', 'a' + 'b'), Object.is({}, {}), Object.is(), Object.is(1n, 1n), Object.is(Symbol.iterator, Symbol.iterator));
// Called through a different receiver or with call: same answers.
var isArray = Array.isArray;
r.push(isArray([1]), Array.isArray.call(null, [1]), Reflect.apply(Number.isInteger, null, [2]));
// String primitive entries: string and non-string receivers, plain and odd arguments.
var s = 'Content-Type';
r.push(s.indexOf('T'), s.slice(1, 4), s.startsWith('Con'), s.endsWith('pe'), s.includes('-'), s.substring(3), s.at(-1), s.lastIndexOf('t'));
r.push(s.indexOf({ toString() { return 'n' } }), s.slice({ valueOf() { return 2 } }), String.prototype.slice.call(12345, 1, 3));
try { String.prototype.indexOf.call(null, 'x'); } catch (e) { r.push(e.constructor.name); }
// Lean calls: answers, errors with the builtin's own message, and stacks.
r.push(Object.keys({ a: 1, b: 2 }).join('|'), Object.getPrototypeOf([]) === Array.prototype, [1, 2, 3].indexOf(2), 'AbC'.toLowerCase());
try { Object.defineProperty(1, 'x', {}); } catch (e) { r.push(e.constructor.name); }
function strictCaller() { 'use strict'; var o = Object.freeze({ a: 1 }); try { Object.assign(o, { a: 2 }); return 'no throw'; } catch (e) { return e.constructor.name; } }
r.push(strictCaller());
function thrower() { return JSON.parse('{'); }
try { thrower(); } catch (e) { r.push(e.constructor.name, /thrower/.test(e.stack)); }
var n = 0; for (var i = 0; i < 20000; i++) { if (Array.isArray(r) && Number.isInteger(i) && s.indexOf('-') === 7) n++; } r.push(n);
const got = r.join();
const expected = 'true,false,true,false,false,false,TypeError,true,true,false,false,false,true,false,false,true,false,true,true,false,true,false,false,false,true,true,false,true,false,true,false,true,true,true,true,true,true,8,ont,true,true,true,tent-Type,e,6,2,ntent-Type,23,TypeError,a|b,true,1,abc,TypeError,TypeError,SyntaxError,true,20000';
console.log(got === expected ? 'PASS native call kinds' : 'FAIL ' + got);
if (got !== expected) throw new Error('native call kind regressions');
