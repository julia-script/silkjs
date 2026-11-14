// SilkJS regression test for the heap-free head fast arrays remember for
// indexOf/includes of objects and symbols: a queue that clears its head with
// undefined (postgres.js), then every way to put a cell back below that head
// (stores, splice, unshift, reverse, sort, copyWithin, fill, length cuts,
// shift, setters on the prototype, defineProperty). Expected values from Node.
var r = [];
var a = {}, b = {}, s = Symbol('s');
function queue() { var xs = []; for (var i = 0; i < 40; i++) xs.push({ i: i }); for (var i = 0; i < 30; i++) xs[i] = undefined; return xs; }
var q = queue(); var live = q[35];
r.push(q.indexOf(live), q.indexOf(live), q.includes(a));
q[3] = a; r.push(q.indexOf(a), q.indexOf(live));
q = queue(); q.indexOf(live); q[29] = s; r.push(q.indexOf(s), q.includes(s, 30));
q = queue(); q.indexOf(a); q.splice(2, 0, a); r.push(q.indexOf(a), q.length);
q = queue(); q.indexOf(a); q.splice(5, 3, b, a); r.push(q.indexOf(a), q.indexOf(b));
q = queue(); q.indexOf(a); q.unshift(a); r.push(q.indexOf(a));
q = queue(); q.indexOf(a); q.reverse(); r.push(q.indexOf(q[0]), q.indexOf(q[9]));
q = queue(); q[39] = a; q.indexOf(b); q.reverse(); r.push(q.indexOf(a));
q = queue(); q.indexOf(a); q.sort(function (x, y) { return x === undefined ? 1 : y === undefined ? -1 : 0; }); r.push(q.indexOf(q[0]), q.includes(q[5]));
q = queue(); q.indexOf(a); q.copyWithin(0, 30, 35); r.push(q.indexOf(q[0]), q.indexOf(q[4]));
q = queue(); q.indexOf(a); q.fill(a, 1, 2); r.push(q.indexOf(a));
q = queue(); q.indexOf(a); q.length = 10; q.push(a); r.push(q.indexOf(a), q.length);
q = queue(); q.indexOf(a); q.length = 0; q.push(b); q.push(a); r.push(q.indexOf(a));
q = queue(); q.indexOf(a); q.shift(); r.push(q.indexOf(live));
q = [a, b]; q.indexOf(s); q.shift(); q[0] = undefined; q.indexOf(s); q.unshift(s); r.push(q.indexOf(s));
q = queue(); q.indexOf(a); Object.defineProperty(q, 4, { value: a, writable: true, enumerable: true, configurable: true }); r.push(q.indexOf(a));
q = queue(); q.indexOf(a); q.splice(0, 30); r.push(q.indexOf(live), q.indexOf(q[0]));
q = queue(); q.indexOf(a); var c = q.concat([a]); r.push(c.indexOf(a)); var sl = q.slice(25); r.push(sl.indexOf(live));
q = queue(); q.indexOf(a); q[0] = a; q[0] = undefined; q[1] = b; r.push(q.indexOf(b), q.indexOf(a));
// The postgres.js Queue: push to the tail, shift by clearing the head, remove by splice.
var xs = [], index = 0, items = [];
for (var i = 0; i < 20; i++) items.push({ n: i });
var trace = 0;
for (var round = 0; round < 3000; round++) {
  var it = items[round % 20];
  xs.push(it);
  if (round % 3 === 0) { var out = xs[index++]; if (index === xs.length) { index = 0; xs = []; } else xs[index - 1] = undefined; trace += out ? out.n : 0; }
  if (round % 5 === 0) { var at = xs.indexOf(items[(round + 7) % 20]); if (at !== -1) { xs.splice(at, 1); trace += at; } }
}
r.push(trace, xs.length, xs.indexOf(items[3]), xs.lastIndexOf(items[3]));
const got = r.join();
const expected = '35,35,false,3,35,29,false,2,41,6,5,0,0,9,0,0,true,0,4,1,10,11,1,-1,0,4,-1,0,40,-1,1,-1,722269,2403,1010,2386';
console.log(got === expected ? 'PASS array indexOf clear head' : 'FAIL ' + got);
if (got !== expected) throw new Error('indexOf clear head regressions');
