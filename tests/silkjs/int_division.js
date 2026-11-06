// Int / Int in the div arm: exact quotients stay Int, the rest follow IEEE.
function div(a, b) { return a / b; }
const cases = [[6, 3], [7, 2], [0, 5], [0, -5], [-6, 3], [5, 0], [-5, 0], [0, 0], [-2147483648, -1], [2147483647, 1], [1, 3], [-9, -3]];
const got = cases.map(([a, b]) => { const q = div(a, b); return Object.is(q, -0) ? "-0" : String(q); }).join(",");
const expected = "2,3.5,0,-0,-2,Infinity,-Infinity,NaN,2147483648,2147483647,0.3333333333333333,3";
if (got !== expected) throw new Error("got " + got + ", expected " + expected);
let s = 0;
for (let i = 1; i < 1000; i++) s = (s + ((i * 7) / 7 | 0)) | 0;
if (s !== 499500) throw new Error("loop " + s);
console.log("ok");
