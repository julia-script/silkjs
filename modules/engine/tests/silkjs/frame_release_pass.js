// SilkJS regression test for returning inline frames, which release their
// padded arguments, locals and leftover operands in one pass over the frame:
// calls with fewer arguments than declared (objects and strings in the copies),
// locals that hold objects, returns from inside loops and switch statements
// with operands still pushed, throws through such frames, methods, and
// recursion. Expected values come from V8.
var r = [];
function pad(a, b, c, d) { var o = { a: a, n: 1 }; var s = 'x' + a; o.n = (b === undefined) + (c === undefined) + (d === undefined); return o.n + s.length + (o.a ? o.a.k : 0); }
for (var i = 0; i < 300; i++) { var t = pad({ k: i }); if (i % 100 === 0) r.push(t); }
r.push(pad(), pad(null, 1), pad({ k: 9 }, 2, 3, 4));
function inLoop(list) { var acc = []; for (var i = 0; i < list.length; i++) { var it = { v: list[i] }; acc.push(it); if (it.v === 3) return acc.length + ':' + it.v; } return 'none'; }
r.push(inLoop([1, 2, 3, 4]), inLoop([]), inLoop([5]));
function sw(k) { var o = [k]; for (var x of [1, 2, 3]) { switch (k) { case 1: return 'one' + o[0] + x; case 2: if (x === 2) return 'two' + x; break; default: break; } } return 'end' + o.length; }
r.push(sw(1), sw(2), sw(7));
function thrower(a, b) { var keep = { a: a }; if (b) throw new Error('t' + keep.a); return keep.a; }
function catcher(n) { var s = 0; for (var i = 0; i < n; i++) { try { s += thrower(i, i % 3 === 0); } catch (e) { s += e.message.length; } } return s; }
r.push(catcher(50));
function Node(v, next) { this.v = v; this.next = next; }
Node.prototype.sum = function (extra) { var here = { v: this.v }; return here.v + (this.next ? this.next.sum() : (extra || 0)); };
var list = null; for (var i = 1; i <= 50; i++) list = new Node(i, list);
r.push(list.sum(), list.sum(100));
function depth(n, tag) { var box = { n: n, tag: tag }; if (n === 0) return box.tag; return depth(n - 1, tag + (n % 10)); }
r.push(depth(25, '').length, depth(3));
var got = r.join();
var expected = '19,119,219,13,7,25,3:3,none,none,one11,two2,end1,864,1275,1275,25,NaN';
console.log(got === expected ? 'PASS frame release pass' : 'FAIL ' + got);
if (got !== expected) throw new Error('frame release regressions');
