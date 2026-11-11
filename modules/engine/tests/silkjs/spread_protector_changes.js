// Changes after a plain spread was remembered (Array Iterator next turned accessor, deleted, restored; @@iterator replaced) must be seen by the next spread.
function k(a, b) { return [a, b].join('|'); }
var out = [];
out.push(k(...[1, 2]));
var AIP = Object.getPrototypeOf([][Symbol.iterator]()); var nx = AIP.next;
Object.defineProperty(AIP, 'next', { get() { out.push('get'); return nx; }, configurable: true });
out.push(k(...[3, 4]));
Object.defineProperty(AIP, 'next', { value: nx, writable: true, configurable: true });
out.push(k(...[5, 6]));
delete AIP.next; AIP.foo = nx;
try { out.push(k(...[7, 8])); } catch (e) { out.push(e.constructor.name); }
AIP.next = nx; delete AIP.foo;
out.push(k(...[9, 10]));
var a = [1, 2]; Object.defineProperty(a, Symbol.iterator, { value: function* () { yield 'own'; } });
out.push(k(...a));
var b = [1, 2]; Object.setPrototypeOf(b, { [Symbol.iterator]: function* () { yield 'proto'; } });
out.push(k(...b));
var c = [1, 2]; c.length = 3; out.push(k(...c));
Array.prototype[Symbol.iterator] = Array.prototype.keys; out.push(k(...['x', 'y']));
var __result = out.join(' ');
var __expected = "1|2 get 3|4 5|6 TypeError 9|10 own| proto| 1|2 0|1";
if (__result !== __expected) throw new Error("expected " + __expected + ", got " + __result);
