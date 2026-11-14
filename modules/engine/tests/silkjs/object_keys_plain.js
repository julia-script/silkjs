// Object.keys on ordinary objects and fast arrays takes enumerable string keys from the
// shape and fills a fast array; exotic objects keep the per-key descriptor path.
function assertEq(actual, expected, message) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error((message || "") + ": expected " + e + ", got " + a);
}
const symbol = Symbol("s");
const object = { b: 1, a: 2, 2: 3, 1: 4, [symbol]: 5 };
Object.defineProperty(object, "hidden", { value: 1, enumerable: false });
assertEq(Object.keys(object), ["1", "2", "b", "a"], "order, symbols and non-enumerable keys");
delete object.b;
object.b = 6;
assertEq(Object.keys(object), ["1", "2", "a", "b"], "re-added key goes last");
assertEq(Object.keys([5, 6, 7]), ["0", "1", "2"], "fast array");
const array = [1, 2];
array.x = 3;
assertEq(Object.keys(array), ["0", "1", "x"], "fast array with a named property");
assertEq(Object.keys("ab"), ["0", "1"], "string primitive");
assertEq(Object.keys(new Proxy({ q: 1, r: 2 }, {})), ["q", "r"], "proxy");
const traps = [];
const proxy = new Proxy({ q: 1 }, {
  ownKeys(target) { traps.push("ownKeys"); return Reflect.ownKeys(target); },
  getOwnPropertyDescriptor(target, key) { traps.push("gopd " + String(key)); return Reflect.getOwnPropertyDescriptor(target, key); },
});
assertEq(Object.keys(proxy), ["q"], "proxy with traps");
assertEq(traps, ["ownKeys", "gopd q"], "proxy trap order");
const empty = Object.keys({});
assertEq([empty.length, Array.isArray(empty)], [0, true], "empty");
const big = {};
for (let i = 0; i < 40; i++) big["k" + i] = i;
const keys = Object.keys(big);
assertEq([keys.length, keys[0], keys[39]], [40, "k0", "k39"], "more keys than an array cell holds");
keys.push("z");
keys[0] = "first";
assertEq([keys.length, keys[0], keys[40]], [41, "first", "z"], "result is an ordinary array");
class C { constructor() { this.y = 1; } get g() { return 1; } }
assertEq(Object.keys(new C()), ["y"], "class instance");
assertEq(Object.keys(Object.create({ inherited: 1 }, { own: { value: 1, enumerable: true } })), ["own"], "own only");
assertEq(Object.keys(new Uint8Array(2)), ["0", "1"], "typed array");
assertEq(Object.keys((function () { return arguments; })(1, 2)), ["0", "1"], "arguments");
