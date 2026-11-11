// Spread calls f(...x) whose argument list is the one spread: plain arrays are passed as is, anything else (own or prototype @@iterator, patched Array Iterator next, holes, strings, Sets, constructors) iterates as before.
function g(...a) { return a.join(','); }
function k(a, b, c) { return [a, b, c, arguments.length].join('|'); }
var log = [];
log.push(g(...[1,2,3]), k(...[1]), k(...'xy'), k(...new Set([7,8])), k(...[1,,3]));
var o = { m(...a) { return this === o ? a.length : -1; } };
log.push(o.m(...[1,2]));
try { k(...undefined); } catch (e) { log.push(e.constructor.name); }
try { k(...5); } catch (e) { log.push(e.constructor.name); }
var arr = [4,5]; arr[Symbol.iterator] = function* () { yield 9; };
log.push(k(...arr));
var saved = Array.prototype[Symbol.iterator];
Array.prototype[Symbol.iterator] = function* () { yield 'p'; };
log.push(k(...[1,2]));
Array.prototype[Symbol.iterator] = saved;
var n = 0; var it = Object.getPrototypeOf([][Symbol.iterator]()); var nx = it.next;
it.next = function () { n++; return nx.call(this); }; log.push(k(...[1,2]), n); it.next = nx;
class A { constructor(...a) { this.a = a; } } class B extends A { constructor(...a) { super(...a); } }
log.push(new A(...[1,2]).a.length, new B(...[3]).a[0]);
log.push(Math.max(...[1,5,3]), k(...[1], 2), k(1, ...[2]), String.fromCharCode(...[104,105]));
function deep(n) { return n == 0 ? 0 : 1 + deep(...[n - 1]); } log.push(deep(1000));
log.push(((...a) => a.length)(...new Array(20).fill(0)));
var __result = log.join(' ');
var __expected = "1,2,3 1|||1 x|y||2 7|8||2 1||3|3 2 TypeError TypeError 9|||1 p|||1 1|2||2 3 2 3 5 1|2||2 1|2||2 hi 1000 20";
if (__result !== __expected) throw new Error("expected " + __expected + ", got " + __result);
