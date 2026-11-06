// SilkJS regression test: when Iterator helpers close iterators (current
// ECMA-262 / test262; Bellard QuickJS differs on every case below).
if (typeof print !== 'function') globalThis.print = (...a) => console.log(...a);
let failed = 0;
function check(name, got, expected) {
  const ok = got === expected;
  if (!ok) failed++;
  print((ok ? 'PASS ' : 'FAIL ') + name + ' -> ' + got + (ok ? '' : '   (expected ' + expected + ')'));
}
function counted(next, extra) {
  const calls = { next: 0, ret: 0 };
  const it = Object.assign({
    next() { calls.next++; return next(); },
    return() { calls.ret++; return {}; },
  }, extra);
  Object.setPrototypeOf(it, Iterator.prototype);
  return { it, calls };
}

// reduce without an initial value on an exhausted iterator throws without closing it.
{
  const { it, calls } = counted(() => ({ done: true, value: undefined }));
  let thrown = '';
  try { it.reduce(() => {}); } catch (e) { thrown = e.name; }
  check('reduce empty', thrown + ' ret=' + calls.ret, 'TypeError ret=0');
}
// flatMap closes only the outer iterator when the inner step throws, and never
// closes an exhausted inner iterator.
{
  const outer = counted(() => ({ done: false, value: 1 }));
  const inner = counted(() => { throw new Error('inner'); });
  const helper = outer.it.flatMap(() => inner.it);
  try { helper.next(); } catch (e) {}
  check('flatMap inner throws', 'outer=' + outer.calls.ret + ' inner=' + inner.calls.ret, 'outer=1 inner=0');
}
{
  let n = 0;
  const outer = counted(() => ({ done: n++ > 0, value: 1 }));
  const inner = counted(() => ({ done: true, value: undefined }));
  const helper = outer.it.flatMap(() => inner.it);
  const r = helper.next();
  check('flatMap inner exhausted', r.done + ' inner=' + inner.calls.ret, 'true inner=0');
}
// Iterator.concat return() closes the open iterator, returns a fresh done result,
// skips a missing return method, rejects a non-object result, and completes
// even when closing throws or a step throws.
{
  const src = counted(() => ({ done: false, value: 1 }), { return() { src.calls.ret++; throw new Error('ret'); } });
  const c = Iterator.concat({ [Symbol.iterator]() { return src.it; } });
  c.next();
  let thrown = '';
  try { c.return(); } catch (e) { thrown = e.message; }
  const after = c.next();
  check('concat return throws', thrown + ' ret=' + src.calls.ret + ' done=' + after.done, 'ret ret=1 done=true');
}
{
  const c = Iterator.concat({ [Symbol.iterator]() { return { next() { return { done: false, value: 1 }; } }; } });
  c.next();
  const r = c.return();
  check('concat no return method', r.done + ' ' + r.value, 'true undefined');
}
{
  const c = Iterator.concat({ [Symbol.iterator]() { return { next() { return { done: false, value: 1 }; }, return() { return 1; } }; } });
  c.next();
  let thrown = '';
  try { c.return(); } catch (e) { thrown = e.name; }
  check('concat non-object return', thrown, 'TypeError');
}
{
  const inner = { done: false, value: 7 };
  const c = Iterator.concat({ [Symbol.iterator]() { return { next() { return { done: false, value: 1 }; }, return() { return inner; } }; } });
  c.next();
  const r = c.return();
  check('concat fresh result', (r !== inner) + ' ' + r.done + ' ' + r.value, 'true true undefined');
}
{
  let opened = 0;
  const src = counted(() => { throw new Error('step'); });
  const c = Iterator.concat({ [Symbol.iterator]() { return src.it; } }, { [Symbol.iterator]() { opened++; return [1][Symbol.iterator](); } });
  try { c.next(); } catch (e) {}
  const r = c.next();
  const ret = c.return();
  check('concat completed after throw', r.done + ' opened=' + opened + ' next=' + src.calls.next + ' ret=' + src.calls.ret + ' ' + ret.done, 'true opened=0 next=1 ret=0 true');
}
print(failed ? failed + ' failed' : 'all passed');
if (failed) throw new Error('iterator helper close regressions');
