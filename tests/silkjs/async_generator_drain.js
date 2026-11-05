// SilkJS regression test (not in QuickJS, which settles only one request after
// the generator completes and leaves the rest pending forever).
// ECMA-262 AsyncGeneratorDrainQueue: once an async generator is completed, every
// queued next/throw settles in order, and a queued return awaits its value and
// then keeps draining.
if (typeof print !== 'function') globalThis.print = (...a) => console.log(...a);

const cases = [
  ['yield then return', async function* () { yield 1; return 3; }, '0:1/false 1:3/true 2:undefined/true 3:9/true'],
  ['immediate return', async function* () { return 3; }, '0:3/true 1:undefined/true 2:undefined/true 3:9/true'],
];
const mixed = async function* () { return 1; };
let pending = cases.length + 1, failed = 0;
function check(name, got, expected) {
  const ok = got === expected;
  if (!ok) failed++;
  print((ok ? 'PASS ' : 'FAIL ') + name + ' -> ' + got + (ok ? '' : '   (expected ' + expected + ')'));
  if (--pending === 0) {
    print((cases.length + 1 - failed) + '/' + (cases.length + 1) + ' passed');
    if (failed) throw new Error('async generator drain regressions');
  }
}
function record(name, requests, expected) {
  const log = [];
  Promise.all(requests.map((p, i) => p.then(
    r => log.push(i + ':' + r.value + '/' + r.done),
    e => log.push(i + ':E ' + e.message)))).then(() => check(name, log.join(' '), expected));
}
for (const [name, body, expected] of cases) {
  const it = body();
  record(name, [it.next(), it.next(), it.next(), it.return(9)], expected);
}
const it = mixed();
record('mixed after completion',
  [it.next(), it.return(2), it.next(), it.throw(new Error('t')), it.return(Promise.resolve(3)), it.next()],
  '0:1/true 1:2/true 2:undefined/true 3:E t 4:3/true 5:undefined/true');
// Requests that never settle leave nothing to report, so fail after the queue
// has had ample microtask turns to drain.
(async () => {
  for (let i = 0; i < 1000; i++) await null;
  if (pending) { print('FAIL ' + pending + ' case(s) never settled'); throw new Error('async generator requests left pending'); }
})();
