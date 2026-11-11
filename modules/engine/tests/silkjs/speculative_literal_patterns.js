// SilkJS regression test for literals parsed before knowing whether they are
// assignment patterns (js_parser_expressions.parseSpeculativeLiteral): a
// pattern rewinds and parses again, and the errors only a pattern allows are
// reported when no `=` follows.
var r = [], a, b, c, p, f;
[a, b] = [1, 2]; r.push(a, b);
({a, b = 5} = {a: 3}); r.push(a, b);
({__proto__: p, __proto__: c} = {}); r.push(typeof p, typeof c);
[{a = 7}] = [{}]; r.push(a);
[{a: {b = 8}}] = [{a: {}}]; r.push(b);
[a = function () { return 9 }] = []; r.push(a());
[f = class { m() { return 10 } }] = []; r.push(new f().m());
[a] = [11], r.push(a);
r.push([1, {c: 12}][1].c, ({}).toString === Object.prototype.toString);
var o = {}; [o.x, o["y"]] = [13, 14]; r.push(o.x + o.y);
function g() { var q; [q = arguments.length] = []; return q } r.push(g(1, 2));
const errors = [];
for (const text of ["({a = 1})", "[{a = 1}]", "f({a = 1}.x)", "({__proto__: 1, __proto__: 2})",
  "[f({a = 1})] = []", "({a: {b = 1}.c} = {})", "x = [{b = 2}]"]) {
  try { eval(text); errors.push("none") } catch (e) { errors.push(e.name + ":" + e.message) }
}
const got = r.join() + "|" + errors.join();
const expected = "1,2,3,5,object,object,7,8,9,10,11,12,true,27,2|" +
  "SyntaxError:expecting '}',SyntaxError:expecting '}',SyntaxError:expecting '}'," +
  "SyntaxError:duplicate __proto__ property name,SyntaxError:expecting '}',SyntaxError:expecting '}',SyntaxError:expecting '}'";
console.log(got === expected ? "PASS speculative literal patterns" : "FAIL " + got);
if (got !== expected) throw new Error("speculative literal pattern regressions");
