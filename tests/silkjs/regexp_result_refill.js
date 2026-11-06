function check(c, m) { if (!c) throw new Error("fail: " + m); }
function run() {
  var r, t, s = "xxabcxx", u = "yyabcyyyy";
  var seen = [];
  for (var i = 0; i < 4; i++) {
    r = /a(b)?c/.exec(i & 1 ? u : s);
    seen.push(r);
  }
  check(seen[0] !== seen[1] && seen[0].index === 2 && seen[1].input === u, "aliases keep their own results");
  for (var i = 0; i < 4; i++) {
    t = r;
    r = /a(b)?c/.exec(i & 1 ? u : s);
    check(t !== r, "held result not reused");
  }
  r = /a(b)?c/.exec(s); r.extra = 1;
  r = /a(b)?c/.exec(u);
  check(r.extra === undefined && r.index === 2 && r.input === u && r[0] === "abc" && r[1] === "b", "decorated result replaced");
  r = /a(b)?c/.exec(s); r.length = 0;
  r = /a(b)?c/.exec(s);
  check(r.length === 2 && r[0] === "abc", "length restored");
  r = /a(b)?c/.exec(s); r[1] = 5;
  r = /a(b)?c/.exec("ac");
  check(r[1] === undefined && r.index === 0 && r[0] === "ac", "unset capture");
  r = /a(b)?c/.exec(s);
  r = /zz/.exec(s);
  check(r === null, "no match");
  r = /a(b)?c/.exec(s);
  var w = new WeakRef(r);
  r = /a(b)?c/.exec(u);
  check(w.deref() !== r || w.deref() === undefined, "weakly held result not reused");
  var m = new WeakMap(); r = /a(b)?c/.exec(s); m.set(r, 1);
  r = /a(b)?c/.exec(u);
  check(!m.has(r), "weak map key not reused");
  r = /a(b)?c/.exec(s); Object.freeze(r);
  r = /a(b)?c/.exec(u);
  check(!Object.isFrozen(r) && r.input === u, "frozen result replaced");
}
run();
console.log("PASS regexp result refill");
