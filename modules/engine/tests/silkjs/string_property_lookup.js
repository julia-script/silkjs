// SilkJS regression test for get_field / get_field2 on primitive strings, which
// start named lookups at String.prototype on a fast path. length, indexes,
// accessors, a patched or detached prototype must match the generic lookup.
// Expected output matches QuickJS.
const s = "hello", r = "ab" + "cd".repeat(3) + String(Math.random() > 2);
const out = [];
out.push(s.length, r.length, s[1], r[3], s.charCodeAt(1), r.toUpperCase(), typeof s.constructor, s.constructor === String);
out.push(s.__proto__ === String.prototype, s.hasOwnProperty("length"), s.hasOwnProperty("foo"), s.valueOf());
String.prototype.myMethod = function () { return typeof this + ":" + this; };
out.push(s.myMethod(), r.myMethod());
Object.defineProperty(String.prototype, "getterProp", { get() { "use strict"; return typeof this + "/" + this.length; }, configurable: true });
out.push(s.getterProp, r.getterProp);
out.push(s.missing, r.nothere, s.toString === String.prototype.toString);
Object.prototype.fromObjectProto = 42;
out.push(s.fromObjectProto, r.fromObjectProto);
String.prototype.charCodeAt = function (i) { return -i; };
out.push(s.charCodeAt(3));
delete String.prototype.myMethod;
try { s.myMethod(); } catch (e) { out.push(e.constructor.name); }
out.push(s[10], s["1"], s[-1]);
const sym = Symbol.iterator; out.push(typeof s[sym]);
Object.setPrototypeOf(String.prototype, null);
out.push(s.fromObjectProto, typeof s.hasOwnProperty);
const got = JSON.stringify(out);
const expected = '[5,13,"e","d",101,"ABCDCDCDFALSE","function",true,true,true,false,"hello","object:hello","object:abcdcdcdfalse","string/5","string/13",null,null,true,42,42,-3,"TypeError",null,"e",null,"function",null,"undefined"]';
console.log(got === expected ? 'PASS string property lookup' : 'FAIL ' + got);
if (got !== expected) throw new Error('string property lookup regressions');
