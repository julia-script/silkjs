function check(ok, message) { if (!ok) throw new Error(message); }
function make(n) {
  var base = { get value() { return this.n + 1; }, method(x) { return this.n + x; } };
  var home = {
    __proto__: base, n: n,
    method(x) { return super.method(x) + n; },
    arrow() { return () => super.value + n; },
    *gen() { yield super.value + n; }
  };
  return home;
}
var keep = [];
for (var i = 0; i < 300; i++) {
  var home = make(i), arrow = home.arrow();
  check(home.method(3) === 2 * i + 3, 'home plus captured scope');
  check(arrow() === 2 * i + 1, 'arrow home');
  check(home.gen().next().value === 2 * i + 1, 'generator home');
  var receiver = { n: 100 };
  check(home.method.call(receiver, 3) === i + 103, 'borrowed method home');
  if (i % 30 === 0) keep.push([home, arrow]);
  if (typeof gc === 'function' && i % 20 === 0) gc();
}
if (typeof gc === 'function') gc();
for (var i = 0; i < keep.length; i++) {
  check(keep[i][0].method(3) === i * 60 + 3, 'kept method');
  check(keep[i][1]() === i * 60 + 1, 'kept arrow');
}
console.log('PASS compact closure home');
