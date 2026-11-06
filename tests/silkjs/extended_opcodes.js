// Opcodes final bytecode writes behind the OP_extended prefix, and the
// call_native_method fusion of get_field2 with plain argument reads.
var out = [];
class Point {
  #x; #y = 2; static #count = 0;
  constructor(x) { this.#x = x; Point.#count++; }
  #sum() { return this.#x + this.#y; }
  get sum() { return this.#sum(); }
  move(d) { this.#x += d; this.#y -= d; return this; }
  static has(o) { return #x in o; }
  static count() { return Point.#count; }
}
var p = new Point(5); p.move(3);
out.push(p.sum, Point.has(p), Point.has({}), Point.count());
try { Point.prototype.move.call({}, 1); out.push('no'); } catch (e) { out.push(e.constructor.name); }
class Base { hello() { return 'base'; } get v() { return this._v || 1; } set v(x) { this._v = x * 10; } }
var name = 'dyn';
class Derived extends Base {
  hello() { return 'derived+' + super.hello(); }
  bump() { super.v = 3; super.v += 1; return super.v; }
  [name + 'Method']() { return 'computed'; }
  static [name]() { return 'static computed'; }
}
var d = new Derived();
out.push(d.hello(), d.bump(), d.dynMethod(), Derived.dyn(), Derived.prototype.dynMethod.name);
var proto = { greet() { return 'proto'; } };
var lit = { __proto__: proto, greet() { return 'lit+' + super.greet(); }, ['k' + 1]: 7 };
out.push(lit.greet(), lit.k1, Object.getPrototypeOf(lit) === proto);
var withScope = { a: 1, b: 2 };
with (withScope) { a += 10; b = a + b; }
out.push(withScope.a, withScope.b);
undeclaredGlobal = 4; undeclaredGlobal++; out.push(undeclaredGlobal);
var arr = [1, 2, 3]; var i = 0;
arr[i++] += 5; [arr[1], arr[2]] = [arr[2], arr[1]];
var o5 = { m: { n: 1 } }; o5.m.n ??= 9; o5.m.z ??= 8;
out.push(arr.join(), o5.m.n, o5.m.z);
class Sup { static s = 1; }
class Sub extends Sup { static t() { super.s += 2; return Sub.s; } }
out.push(Sub.t());
var asyncOut = [];
async function iterate() {
  async function* gen() { yield 1; yield 2; }
  for await (var v of gen()) asyncOut.push(v);
  for await (var w of [Promise.resolve(3), 4]) asyncOut.push(w);
}
var done = iterate();
// call_native_method: native methods with plain argument reads.
var m = new Map(); var s = new Set(); var wm = new WeakMap(); var a = []; var key = {};
for (var j = 0; j < 20; j++) { m.set(j, j * 2); s.add(j % 5); a.push(j); wm.set(key, j); }
var big = 0; for (var j = 0; j < 20; j++) { big = Math.max(big, j); }
out.push(m.get(7), m.has(19), m.delete(3), m.size, s.size, s.has(4), a.length, wm.get(key), big, Math.min(-1, 1), Math.abs(-7));
function viaArgs(x, y) { var mm = new Map(); mm.set(x, y); return mm.get(x) + mm.get(arguments[0]); }
out.push(viaArgs('q', 3));
var jsMethods = { add(x, y) { return x + y; }, one(x) { return x * 2; } };
var lx = 2, ly = 5;
out.push(jsMethods.add(lx, ly), jsMethods.one(lx), jsMethods.add(-3, 7));
var saved = Map.prototype.set;
Map.prototype.set = function (k, v) { return saved.call(this, k, 'patched:' + v); };
var pm = new Map(); pm.set(lx, ly); out.push(pm.get(2));
Map.prototype.set = saved;
var captured = 1;
var cm = new Map(); cm.set(captured, captured); (function () { captured = 2; })(); cm.set(captured, 3); out.push(cm.get(1), cm.get(2));
try { var nm = null; nm.set(1, 2); } catch (e) { out.push(e.constructor.name); }
try { Map.prototype.get.call({}, 1); } catch (e) { out.push(e.constructor.name); }
try { new WeakMap().set(lx, 1); } catch (e) { out.push(e.constructor.name); }
var frozenArr = Object.freeze([1]); try { frozenArr.push(lx); } catch (e) { out.push(e.constructor.name); }
done.then(function () {
  out.push(asyncOut.join());
  var got = out.join('|');
  const expected = '7|true|false|1|TypeError|derived+base|310|computed|static computed|dynMethod|lit+proto|7|true|11|13|5|6,3,2|1|8|3|14|true|true|19|5|true|20|19|19|-1|7|6|7|4|4|patched:5|1|3|TypeError|TypeError|TypeError|TypeError|1,2,3,4';
  console.log(got === expected ? 'PASS extended opcodes' : 'FAIL ' + got);
  if (got !== expected) throw new Error('extended opcode regressions');
});
