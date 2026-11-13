// SilkJS regression test (not in QuickJS). Internal promise capabilities are direct:
// then, Promise.resolve, async functions and reaction jobs resolve the derived
// promise without resolving function objects when the constructor is the realm's
// own %Promise%. Nothing observable may change: job order, thenable adoption,
// species and constructor lookups (own, inherited, replaced and restored on the
// intrinsics), subclass results and self resolution. The expected log is Node 24's.
if (typeof print !== 'function') globalThis.print = (...a) => console.log(...a);
const expected = [
  "c0",
  "m is MyP true",
  "species read",
  "d is MyP false true",
  "Sub derived true",
  "custom ctor",
  "custom derived false 1",
  "ctor getter",
  "proto swap true",
  "identity true false",
  "a 1",
  "b 2",
  "c1",
  "thenable.then",
  "caught e1",
  "async rej TypeError",
  "after getter 1",
  "thenable.then",
  "await caught aw",
  "afin",
  "c2",
  "thenable.then",
  "async thenable T",
  "fin",
  "rej RangeError",
  "self TypeError",
  "allSettled rejected,fulfilled",
  "race r",
  "any any",
  "ret 5",
  "adopted T",
  "async promise AP",
  "all 1,2,T",
  "async ret rej rr",
  "adoptedP P",
  "patched species",
  "patched derived true",
  "restored derived false",
  "proto ctor derived true",
  "proto ctor restored false",
  "no constructor true false",
  "proto ctor getter",
  "accessor constructor true",
  "data constructor again false",
  "then calls 1",
];
function finish() {
  let failed = 0;
  const n = Math.max(log.length, expected.length);
  for (let i = 0; i < n; i++) if (log[i] !== expected[i]) { failed++; print('FAIL ' + i + ': got ' + log[i] + ', expected ' + expected[i]); }
  print((n - failed) + '/' + n + ' passed');
  if (failed) throw new Error('promise direct capability regressions');
}
const log = [];
const L = (...a) => log.push(a.join(' '));
Promise.resolve(1).then(v => L('a', v)); Promise.resolve(2).then(v => L('b', v));
(async () => { L('c0'); await null; L('c1'); await Promise.resolve(); L('c2'); })();
const thenable = { then(r) { L('thenable.then'); r('T'); } };
Promise.resolve(1).then(() => thenable).then(v => L('adopted', v));
Promise.resolve(1).then(() => Promise.resolve('P')).then(v => L('adoptedP', v));
(async () => thenable)().then(v => L('async thenable', v));
(async () => Promise.resolve('AP'))().then(v => L('async promise', v));
Promise.reject(new Error('e1')).catch(e => L('caught', e.message)).finally(() => L('fin'));
Promise.resolve(3).then(() => { throw new RangeError('thrown'); }).then(null, e => L('rej', e.name));
(async () => { throw new TypeError('at'); })().catch(e => L('async rej', e.name));
{ const p = Promise.resolve().then(() => p); p.catch(e => L('self', e.constructor.name)); }
class MyP extends Promise { static get [Symbol.species]() { L('species read'); return Promise; } }
{ const m = MyP.resolve(1); L('m is MyP', m instanceof MyP); const d = m.then(v => v); L('d is MyP', d instanceof MyP, d instanceof Promise); }
class Sub extends Promise {}
{ const d = Sub.resolve(1).then(v => v); L('Sub derived', d instanceof Sub); }
{ const p = Promise.resolve(1); let ex = 0; p.constructor = function (e) { ex++; L('custom ctor'); e(() => {}, () => {}); }; p.constructor[Symbol.species] = p.constructor; const d = p.then(); L('custom derived', d instanceof Promise, ex); }
{ const p = Promise.resolve(1); Object.defineProperty(p, 'constructor', { get() { L('ctor getter'); return Promise; } }); p.then(v => L('after getter', v)); }
{ const p = Promise.resolve(8); Object.setPrototypeOf(p, { constructor: { [Symbol.species]: Sub } }); const d = Promise.prototype.then.call(p, v => v); L('proto swap', d instanceof Sub); }
{ const p = Promise.resolve(1); L('identity', Promise.resolve(p) === p, Sub.resolve(p) === p); }
Promise.all([1, Promise.resolve(2), thenable]).then(v => L('all', v.join()));
Promise.allSettled([Promise.reject(1), 2]).then(v => L('allSettled', v.map(x => x.status).join()));
Promise.race([new Promise(() => {}), Promise.resolve('r')]).then(v => L('race', v));
Promise.any([Promise.reject(1), Promise.resolve('any')]).then(v => L('any', v));
(async () => { try { await Promise.reject(new Error('aw')); } catch (e) { L('await caught', e.message); } finally { L('afin'); } return 5; })().then(v => L('ret', v));
(async () => Promise.reject(new Error('rr')))().catch(e => L('async ret rej', e.message));
// Second phase, after the first drains: the species and constructor are replaced
// and restored on the intrinsics themselves, which the remembered slots must see.
let ticks = 0;
(function later() {
  if (++ticks < 12) return Promise.resolve().then(later);
  const orig = Object.getOwnPropertyDescriptor(Promise, Symbol.species);
  Object.defineProperty(Promise, Symbol.species, { get() { L('patched species'); return Sub; }, configurable: true });
  const d = Promise.resolve(1).then(v => v); L('patched derived', d instanceof Sub);
  Object.defineProperty(Promise, Symbol.species, orig);
  const d2 = Promise.resolve(1).then(v => v); L('restored derived', d2 instanceof Sub);
  const oc = Promise.prototype.constructor; Promise.prototype.constructor = Sub;
  const d3 = Promise.resolve(1).then(v => v); L('proto ctor derived', d3 instanceof Sub);
  Promise.prototype.constructor = oc;
  const d4 = Promise.resolve(1).then(v => v); L('proto ctor restored', d4 instanceof Sub);
  delete Promise.prototype.constructor;
  const d5 = Promise.resolve(1).then(v => v); L('no constructor', d5 instanceof Promise, d5 instanceof Sub);
  Object.defineProperty(Promise.prototype, 'constructor', { get() { L('proto ctor getter'); return Sub; }, configurable: true });
  const d6 = Promise.resolve(1).then(v => v); L('accessor constructor', d6 instanceof Sub);
  Object.defineProperty(Promise.prototype, 'constructor', { value: oc, writable: true, configurable: true, enumerable: false });
  const d7 = Promise.resolve(1).then(v => v); L('data constructor again', d7 instanceof Sub);
  const origThen = Promise.prototype.then; let calls = 0;
  Promise.prototype.then = function (...a) { calls++; return origThen.apply(this, a); };
  (async () => { await Promise.resolve(1); await 2; return 3; })().then(() => { Promise.prototype.then = origThen; L('then calls', calls); finish(); });
})();
