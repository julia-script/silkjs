// SilkJS regression test for the third round of benchmark fast paths. Results must match QuickJS.
// Dense Array iteration to the end, iterator lookups and global variable fast paths.
var gv = 0, gc = 0;
function round3() {
  const r = [];
  const a = [1, 2, 3];
  const seen = [];
  for (const x of a) { seen.push(x); if (x === 2) a.push(9); }
  r.push(seen.join());
  const it = [5][Symbol.iterator]();
  r.push(JSON.stringify([it.next(), it.next(), it.next()]));
  const [p, q, ...rest] = [1, 2, 3, 4];
  const [e1, ...e2] = [];
  r.push(p, q, rest.join(), String(e1), e2.length);
  const holes = [1, , 3]; holes.length = 5;
  r.push(JSON.stringify([...holes]));
  const proto = Object.getPrototypeOf([][Symbol.iterator]());
  const savedNext = proto.next;
  proto.next = function () { const s = savedNext.call(this); return s.done ? s : { value: s.value * 10, done: false }; };
  const [m1, m2] = [1, 2];
  proto.next = savedNext;
  r.push(m1, m2);
  const getterObj = { get [Symbol.iterator]() { gc++; return Array.prototype[Symbol.iterator].bind([7, 8]); } };
  const [g1, g2] = getterObj;
  r.push(g1, g2, gc);
  for (let i = 0; i < 5; i++) gv = gv + i;
  r.push(gv);
  return r;
}
const got = JSON.stringify(round3());
const expected = "[\"1,2,3,9\",\"[{\\\"value\\\":5,\\\"done\\\":false},{\\\"done\\\":true},{\\\"done\\\":true}]\",1,2,\"3,4\",\"undefined\",0,\"[1,null,3,null,null]\",10,20,7,8,1,10]";
console.log(got === expected ? 'PASS perf fast paths 3' : 'FAIL ' + got);
if (got !== expected) throw new Error('perf fast path regressions');
