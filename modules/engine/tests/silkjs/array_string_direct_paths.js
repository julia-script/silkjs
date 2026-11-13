// Direct paths for library-style array and string code: spread, Array.from/of,
// new Array(n), split, concat, slice of arguments, join, String concat and
// template literals, replace with a string, short parseInt/parseFloat. Each case
// also runs where the shortcut must not apply (observable hooks, odd receivers).
var out = [];
function show(v) { return Array.isArray(v) ? '[' + v.map(show).join(',') + ']' : typeof v === 'string' ? JSON.stringify(v) : String(v); }
var a = [1, 'x', null];
out.push(show([...a]), show([0, ...a, ...a, 9]), show(Array.from(a)), show(Array.of(1, 'y')), show(Array.from({ length: 2, 0: 'p' })), show(Array.from('ab')));
var holes = [1, , 3]; out.push(show([...holes]), show(Array.from(holes)), String(1 in [...holes]));
var n = new Array(3); out.push(n.length, String(0 in n)); n[0] = 1; n[1] = 2; n[2] = 3; out.push(show(n));
out.push(show(new Array(2, 3)), show(new Array('x')), Array(4).length, new Array(0).length, show(Array(1, 2)));
try { new Array(-1); } catch (e) { out.push(e.constructor.name); }
class Sub extends Array {} out.push(String(Sub.from([1]) instanceof Sub), String(Sub.of(1) instanceof Sub), String(new Sub(2).length));
out.push(show('a;b;;c'.split(';')), show('abc'.split('')), show('a b'.split(' ', 1)), show(''.split('')), show('x'.split()));
function sa() { return Array.prototype.slice.call(arguments, 1); }
function sm(p) { p = 'changed'; return [].slice.call(arguments); }
out.push(show(sa(1, 2, 3)), show(sa()), show((function () { 'use strict'; return [].slice.call(arguments); })(4, 5)), show(sm(6, 7)));
out.push(show([1, 2].concat([3], 4, 'x', [[5]])), show([].concat()), show([1].concat(null, undefined)), show([1].concat({ length: 1, 0: 'o' }).length));
var sp = [9]; sp[Symbol.isConcatSpreadable] = false; out.push(show([1].concat(sp)));
var like = { length: 2, 0: 'l', 1: 'm' }; like[Symbol.isConcatSpreadable] = true; out.push(show([1].concat(like)));
out.push(['a', 'b', 3, null, undefined, 'é'].join('-'), ['x'].join(), [1, 2, 3].join(''), ['中', 'a'].join('ü'), [[1, 2], 3].join(';'), [-2147483648, 5].join(), [].join());
var i = 7, s = 'Q';
out.push(`${s}: ${i}\r\n`.length, `a${s}b${i}c${null}d${undefined}`, 'a'.concat(1, 2, 'é'), `${'中'}x${s}`, ''.concat(), `${{ toString() { return 'T'; } }}`);
try { `${Symbol()}`; } catch (e) { out.push(e.constructor.name); }
out.push('a'.concat(1, 2, 3, 4, 5, 6, 7, 8, 9));
out.push('text/html'.replace('html', 'json'), 'aaa'.replace('a', '$&$&'), 'abc'.replace('z', 'y'), 'abc'.replaceAll('b', '中'), 'abc'.replace('', '-'), 'a-b'.replace('-', () => '+'));
out.push(parseInt('1234'), parseInt('-7', 10), parseInt('12px'), parseInt('0x1f'), parseInt('0x1f', 10), Object.is(parseInt('-0'), -0), parseInt(' 5'), parseInt('1234567890123'), parseInt('9', 8), parseInt('123456789'), parseInt('1234567890'));
out.push(parseFloat('12'), parseFloat('12.5'), parseFloat('3e2'), parseFloat('-4x'), Object.is(parseFloat('-0'), -0));
// Observable hooks turn the shortcuts off.
Object.defineProperty(Array.prototype, Symbol.isConcatSpreadable, { get() { return false; }, configurable: true });
out.push([1].concat([2]).length);
delete Array.prototype[Symbol.isConcatSpreadable];
Array.prototype[Symbol.iterator] = function* () { yield 42; };
out.push(show([...a]), show(Array.from(a)));
var __result = out.join(' ');
var __expected = "[1,\"x\",null] [0,1,\"x\",null,1,\"x\",null,9] [1,\"x\",null] [1,\"y\"] [\"p\",undefined] [\"a\",\"b\"] [1,undefined,3] [1,undefined,3] true 3 false [1,2,3] [2,3] [\"x\"] 4 0 [1,2] RangeError true true 2 [\"a\",\"b\",\"\",\"c\"] [\"a\",\"b\",\"c\"] [\"a\"] [] [\"x\"] [2,3] [] [4,5] [\"changed\",7] [1,2,3,4,\"x\",[5]] [] [1,null,undefined] 2 [1,[9]] [1,\"l\",\"m\"] a-b-3---é x 123 中üa 1,2;3 -2147483648,5  6 aQb7cnulldundefined a12é 中xQ  T TypeError a123456789 text/json aaaa abc a中c -abc a+b 1234 -7 12 31 0 true 5 1234567890123 NaN 123456789 1234567890 12 12.5 300 -4 true 2 [42] [42]";
if (__result !== __expected) throw new Error("expected " + __expected + ", got " + __result);
