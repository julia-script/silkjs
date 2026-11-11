// A throw out of a for await body closes the iterator by awaiting return() before
// the exception propagates (AsyncIteratorClose); failures in return() are dropped.
const log = [];
const later = (v) => Promise.resolve().then(() => 0).then(() => 0).then(() => { log.push('settled'); return v; });
const make = (ret) => ({ [Symbol.asyncIterator]() { return { next: () => Promise.resolve({ value: 1, done: false }), return: ret }; } });
async function* gen() { try { yield 1; } finally { log.push('finally'); } }
async function run(name, iterable, body) {
  try { for await (const x of iterable) body(x); log.push(name + ':done'); } catch (e) { log.push(name + ':' + e); }
}
(async () => {
  await run('gen', gen(), () => { throw 1; });
  await run('slow', make(() => later({ done: true })), () => { throw 2; });
  await run('throws', make(() => { throw 'r'; }), () => { throw 3; });
  await run('rejects', make(() => Promise.reject('rj')), () => { throw 4; });
  await run('primitive', make(() => 5), () => { throw 5; });
  await run('missing', make(undefined), () => { throw 6; });
  const getter = { [Symbol.asyncIterator]() { return { next: () => Promise.resolve({ value: 1, done: false }), get return() { throw 'g'; } }; } };
  await run('getter', getter, () => { throw 7; });
  const rejectsNext = { [Symbol.asyncIterator]() { return { next: () => Promise.reject('n'), return() { log.push('BAD'); return {}; } }; } };
  await run('next', rejectsNext, () => {});
  await run('inner', make(() => later({ done: true })), () => { try { throw 9; } finally { log.push('innerFinally'); } });
  const out = [];
  outer: for await (const a of [1, 2]) { for await (const b of [3, 4]) { out.push(a * b); if (b === 3) continue outer; } }
  log.push('nested:' + out.join());
  for await (const x of gen()) break;
  log.push('broke');
  async function* delegate() { yield* gen(); yield 2; }
  const values = []; for await (const v of delegate()) values.push(v);
  log.push('delegate:' + values.join());
  const d = delegate(); await d.next(); log.push('return:' + JSON.stringify(await d.return(7)));
  const got = log.join(' ');
  const expected = 'finally gen:1 settled slow:2 throws:3 rejects:4 primitive:5 missing:6 getter:7 next:n innerFinally settled inner:9 nested:3,6 finally broke finally delegate:1,2 finally return:{"value":7,"done":true}';
  if (got !== expected) throw new Error('expected ' + expected + ', got ' + got);
  print('for await throw close ok');
})();
