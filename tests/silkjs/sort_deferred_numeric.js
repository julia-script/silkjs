// Fresh subtraction comparators must be finished before numeric recognition.
// Non-numbers still run the comparator and its observable coercions.
const out = [];
function ascending() { return (a, b) => a - b; }
function descending() { return (a, b) => b - a; }
out.push([5, -3, 2, 2, 0].sort(ascending()).join(','));
out.push([5, -3, 2, 2, 0].sort(descending()).join(','));
out.push([Infinity, 1.5, -Infinity, -2.5, 0].sort(ascending()).join(','));
const zero = [-0, 0, -0, 0].sort(descending());
out.push(zero.map(x => Object.is(x, -0) ? '-0' : '0').join(','));
out.push([7, 3, 4].toSorted(ascending()).join(','));
let calls = 0;
const items = [3, 1, 2].map(value => ({ valueOf() { calls++; return value; } }));
out.push(items.sort(ascending()).map(Number).join(','), calls > 3);
let threw = false;
try { [1, { valueOf() { throw new Error('coercion'); } }].sort(ascending()); }
catch (error) { threw = error.message === 'coercion'; }
out.push(threw);
out.push([3n, 1n, 2n].sort((a, b) => Number(a - b)).join(','));
const got = out.join('\n');
const expected = '-3,0,2,2,5\n5,2,2,0,-3\n-Infinity,-2.5,0,1.5,Infinity\n-0,0,-0,0\n3,4,7\n1,2,3\ntrue\ntrue\n1,2,3';
if (got !== expected) throw new Error(got);
console.log('PASS deferred numeric sort');
