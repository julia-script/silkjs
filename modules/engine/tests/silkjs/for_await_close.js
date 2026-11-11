// SilkJS regression test (not in QuickJS, which fails cases 1-2 and 4-8, 10-12, 18-19).
// for-await early exit must run AsyncIteratorClose (ECMA-262 ForIn/OfBodyEvaluation
// step "If iteratorKind is async, return ? AsyncIteratorClose(iteratorRecord, status)").
// AsyncIteratorClose awaits return()'s result, and if the completion is normal
// (break / return), a throw from return(), a rejection, or a non-object result
// must reject the enclosing async function.
if (typeof print !== 'function') globalThis.print = (...a) => console.log(...a);

const log = [];
const tests = [];
function test(name, expected, fn) { tests.push({ name, expected, fn }); }

function syncIter(ret) {
  return { [Symbol.iterator]() { return { next() { return { value: 1, done: false }; }, return: ret }; } };
}
function asyncIter(ret) {
  return { [Symbol.asyncIterator]() { return { next() { return Promise.resolve({ value: 1, done: false }); }, return: ret }; } };
}

// 1. sync iterable, return() throws synchronously, `break`
test('1 sync iterable, return() throws, break', 'rejected: ret', async () => {
  for await (const x of syncIter(() => { throw new Error('ret'); })) break;
});
// 2. same with `return` statement
test('2 sync iterable, return() throws, return stmt', 'rejected: ret', async () => {
  for await (const x of syncIter(() => { throw new Error('ret'); })) return 'done';
});
// 3. async iterable, return() throws synchronously, break
test('3 async iterable, return() throws, break', 'rejected: ret', async () => {
  for await (const x of asyncIter(() => { throw new Error('ret'); })) break;
});
// 4. async iterable, return() returns a rejected promise, break
test('4 async iterable, return() rejects, break', 'rejected: ret', async () => {
  for await (const x of asyncIter(() => Promise.reject(new Error('ret')))) break;
});
// 5. async iterable, return() returns a rejected promise, return stmt
test('5 async iterable, return() rejects, return stmt', 'rejected: ret', async () => {
  for await (const x of asyncIter(() => Promise.reject(new Error('ret')))) return 'done';
});
// 6. async iterable, return() resolves to a non-object -> TypeError
test('6 async iterable, return() resolves non-object, break', 'rejected: TypeError', async () => {
  for await (const x of asyncIter(() => Promise.resolve(42))) break;
});
// 7. sync iterable, return() returns a non-object -> TypeError
test('7 sync iterable, return() returns non-object, break', 'rejected: TypeError', async () => {
  for await (const x of syncIter(() => 42)) break;
});
// 8. return() promise must be awaited before code after the loop runs
test('8 async iterable, return() is awaited before continuing', 'resolved: closed,after', async () => {
  const order = [];
  const slow = async () => { for (let i = 0; i < 5; i++) await null; order.push('closed'); return {}; };
  for await (const x of asyncIter(slow)) break;
  order.push('after');
  return order.join(',');
});
// 9. throw completion: the body's error wins over return()'s rejection
// (The rejection is pre-handled: SilkJS does not yet await return() on a throw completion.)
test('9 async iterable, body throws, return() rejects', 'rejected: body', async () => {
  const rejected = () => { const p = Promise.reject(new Error('ret')); p.catch(() => {}); return p; };
  for await (const x of asyncIter(rejected)) throw new Error('body');
});
// 10. break to an outer label through for-await
test('10 labeled break through for-await, return() rejects', 'rejected: ret', async () => {
  outer: for (;;) { for await (const x of asyncIter(() => Promise.reject(new Error('ret')))) break outer; }
});

// 11. normal exhaustion must not call return()
test('11 exhausted async iterable is not closed', 'resolved: 0,1', async () => {
  let n = 0; const seen = [];
  const it = { [Symbol.asyncIterator]() { return { next() { return Promise.resolve({ value: n, done: n++ >= 2 }); }, return() { seen.push('closed'); return Promise.resolve({}); } }; } };
  for await (const x of it) seen.push(x);
  return seen.join(',');
});
// 12. exhausted sync iterable is not closed either
test('12 exhausted sync iterable is not closed', 'resolved: 1,2', async () => {
  const seen = [];
  const it = { [Symbol.iterator]() { let i = 0; return { next() { return { value: ++i, done: i > 2 }; }, return() { seen.push('closed'); return {}; } }; } };
  for await (const x of it) seen.push(x);
  return seen.join(',');
});
// 13. break closes exactly once, and the loop result value is undefined
test('13 break calls return() once', 'resolved: 1', async () => {
  let calls = 0;
  for await (const x of asyncIter(() => { calls++; return Promise.resolve({}); })) break;
  return calls;
});
// 14. return value survives an awaited close
test('14 return value survives close', 'resolved: kept', async () => {
  for await (const x of asyncIter(() => Promise.resolve({}))) return 'kept';
});
// 15. return through two nested for-await loops closes inner then outer
test('15 nested for-await return closes inner then outer', 'resolved: inner,outer', async () => {
  const order = [];
  try {
    for await (const a of asyncIter(() => { order.push('outer'); return Promise.resolve({}); }))
      for await (const b of asyncIter(() => { order.push('inner'); return Promise.resolve({}); })) return 'x';
  } finally { return order.join(','); }
});
// 16. continue an outer loop through for-await
test('16 continue through for-await, return() rejects', 'rejected: ret', async () => {
  outer: for (let i = 0; i < 2; i++) { for await (const x of asyncIter(() => Promise.reject(new Error('ret')))) continue outer; }
});
// 17. return() missing: break completes normally
test('17 return() missing', 'resolved: ok', async () => {
  for await (const x of asyncIter(undefined)) break;
  return 'ok';
});
// 18. async generator: return statement through for-await checks the awaited value
test('18 async generator return stmt, return() resolves 42', 'rejected: TypeError', async () => {
  async function* g() { for await (const x of asyncIter(() => Promise.resolve(42))) return 'r'; }
  return JSON.stringify(await g().next());
});
// 19. async generator: break through for-await
test('19 async generator break, return() rejects', 'rejected: ret', async () => {
  async function* g() { for await (const x of asyncIter(() => Promise.reject(new Error('ret')))) break; }
  return JSON.stringify(await g().next());
});
// 20. async generator: a sync for-of closes synchronously
test('20 async generator sync for-of return', 'resolved: {"value":"r","done":true}', async () => {
  async function* g() { for (const x of [1, 2]) return 'r'; }
  return JSON.stringify(await g().next());
});

(async () => {
  let pass = 0;
  for (const t of tests) {
    let got;
    try {
      const v = await t.fn();
      got = 'resolved: ' + v;
    } catch (e) {
      got = 'rejected: ' + (e instanceof TypeError ? 'TypeError' : e && e.message);
    }
    const ok = got === t.expected;
    if (ok) pass++;
    print((ok ? 'PASS ' : 'FAIL ') + t.name + ' -> ' + got + (ok ? '' : '   (expected ' + t.expected + ')'));
  }
  print(pass + '/' + tests.length + ' passed');
  if (pass !== tests.length) throw new Error('for-await close regressions');
})();
