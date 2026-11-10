// Array building, higher-order methods and numeric sort.
let seed = 12345;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; }
const a = [];
for (let i = 0; i < 50000; i++) a.push(rnd() % 100000);
const b = a.map((x) => x * 2).filter((x) => x % 3 !== 0);
const s = b.reduce((p, x) => (p + x) | 0, 0);
const sorted = a.slice().sort((x, y) => x - y);
console.log(b.length, s, sorted[0], sorted[sorted.length - 1], sorted[25000]);
