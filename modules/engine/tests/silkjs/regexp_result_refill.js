// `r = /re/.exec(s)` may reuse the result r already holds when nothing else
// references it. Whatever was done to that result, the new one must look fresh.
function check(c, m) { if (!c) throw new Error("fail: " + m); }
function run() {
  var r, t, s = "xxabcxx", u = "yyabcyyyy";
  var seen = [];
  for (var i = 0; i < 4; i++) {
    r = /a(b)?c/.exec(i & 1 ? u : s);
    seen.push(r);
  }
  check(seen[0] !== seen[1] && seen[0].index === 2 && seen[1].input === u && seen[2].input === s, "aliases keep their own results");
  for (var i = 0; i < 4; i++) {
    t = r;
    r = /a(b)?c/.exec(i & 1 ? u : s);
    check(t !== r && t.input !== r.input, "held result not reused");
  }
  t = null;
  for (var i = 0; i < 200; i++) {
    var text = i & 1 ? u : i % 3 ? s : "ac" + i;
    r = /a(b)?c/.exec(text);
    check(r.length === 2 && r[0] === (text === s || text === u ? "abc" : "ac") && r.input === text, "loop contents " + i);
    check(r.index === text.indexOf("a") && r.groups === undefined, "loop index " + i);
    check(r[1] === (r[0] === "abc" ? "b" : undefined), "loop capture " + i);
  }
  r = /a(b)?c/.exec(s); r.extra = 1;
  r = /a(b)?c/.exec(u);
  check(r.extra === undefined && r.index === 2 && r.input === u && r[0] === "abc" && r[1] === "b", "decorated result replaced");
  r = /a(b)?c/.exec(s); r.length = 0;
  r = /a(b)?c/.exec(s);
  check(r.length === 2 && r[0] === "abc", "length restored");
  r = /a(b)?c/.exec(s); r.length = 5;
  r = /a(b)?c/.exec(s);
  check(r.length === 2 && !(2 in r), "grown result replaced");
  r = /a(b)?c/.exec(s); r[1] = {held: 1}; r[0] = 7; r.index = {x: 1}; r.input = [1, 2]; r.groups = {g: 1};
  r = /a(b)?c/.exec("ac");
  check(r[1] === undefined && r.index === 0 && r[0] === "ac" && r.input === "ac" && r.groups === undefined, "overwritten fields restored");
  r = /a(b)?c/.exec(s);
  r = /(a)(b)(c)/.exec(s);
  check(r.length === 4 && r[3] === "c", "other capture count");
  r = /zz/.exec(s);
  check(r === null, "no match");
  r = /a(b)?c/.exec(s);
  var w = new WeakRef(r);
  r = /a(b)?c/.exec(u);
  check(w.deref() !== r, "weakly held result not reused");
  var m = new WeakMap(); r = /a(b)?c/.exec(s); m.set(r, 1);
  r = /a(b)?c/.exec(u);
  check(!m.has(r), "weak map key not reused");
  r = /a(b)?c/.exec(s); Object.freeze(r);
  r = /a(b)?c/.exec(u);
  check(!Object.isFrozen(r) && r.input === u, "frozen result replaced");
  r = /a(b)?c/.exec(s); Object.preventExtensions(r);
  r = /a(b)?c/.exec(u);
  check(Object.isExtensible(r), "sealed result replaced");
  r = /a(b)?c/.exec(s); Object.setPrototypeOf(r, null);
  r = /a(b)?c/.exec(u);
  check(Object.getPrototypeOf(r) === Array.prototype, "prototype restored");
  r = /a(b)?c/.exec(s); Object.defineProperty(r, "index", {get: function() { return 99; }});
  r = /a(b)?c/.exec(u);
  check(r.index === 2, "accessor index replaced");
  r = /a(b)?c/.exec(s); Object.defineProperty(r, 0, {value: "q", writable: false});
  r = /a(b)?c/.exec(u);
  check(r[0] === "abc", "read-only element replaced");
  r = /a(b)?c/.exec(s); delete r[0];
  r = /a(b)?c/.exec(u);
  check(r[0] === "abc" && r.length === 2, "hole replaced");
  // Wide inputs and wide captures.
  var wide = "ᴠᴡ the ᶠᵒˣ jumps";
  for (var i = 0; i < 6; i++) {
    r = /the (ᶠᵒˣ)/.exec(wide);
    check(r[0] === "the ᶠᵒˣ" && r[1] === "ᶠᵒˣ" && r.index === 3 && r.input === wide, "wide " + i);
    r = /(j)umps/.exec(i & 1 ? wide : "it jumps");
    check(r[1] === "j" && r[0] === "jumps", "narrow piece of wide " + i);
  }
  // A captured local is written through its scope, never reused under a reader.
  var c; var get = function() { return c; };
  c = /a(b)?c/.exec(s); var first = get();
  c = /a(b)?c/.exec(u);
  check(first.input === s && get().input === u && first !== get(), "captured local");
}
run();
// Globals and properties are not locals: each call gets its own result.
var g = /a(b)?c/.exec("abc"); var g0 = g;
g = /a(b)?c/.exec("xabc");
check(g0.index === 0 && g.index === 1, "global results");
console.log("PASS regexp result refill");
