// a[k] with a local array and a for-in key takes the index-string fast path;
// every key that is not a dense element must still read through the slow path.
const r = [];
function sum(a) { var s = 0; for (var k in a) s += a[k]; return s; }
r.push(sum([1, 2, 3, 4]));
var holes = [1, , 3]; holes[10] = 5;
r.push(sum(holes));
var named = [1, 2]; named.extra = 10;
r.push(sum(named));
function Proto() {} Proto.prototype[1] = 'p';
var inherited = new Proto(); inherited[0] = 'o';
function join(a) { var s = ''; for (var k in a) s += a[k]; return s; }
r.push(join(inherited));
var getter = [1, 2]; Object.defineProperty(getter, '1', { get() { return 40; }, enumerable: true });
r.push(sum(getter));
function keys(a) { var s = []; var k = '01'; s.push(a[k]); k = '1'; s.push(a[k]); k = '4294967295'; s.push(a[k]); return s.join(','); }
var big = [7, 8]; big['01'] = 'z'; big['4294967295'] = 'm';
r.push(keys(big));
function mutate(a) { var s = ''; for (var k in a) { s += a[k]; a.length = 1; } return s; }
r.push(mutate(['a', 'b', 'c']));
r.push(join('str'));
r.push(sum(new Int8Array([3, 4])));
const got = r.join('|');
const expected = '10|9|13|op|41|z,8,m|a|str|7';
console.log(got === expected ? 'PASS for-in local element' : 'FAIL ' + got);
if (got !== expected) throw new Error('for-in local element regressions');
