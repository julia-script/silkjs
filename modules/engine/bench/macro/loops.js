// Tight numeric loops: opcode dispatch, local variables, int and float arithmetic.
let acc = 0;
for (let i = 0; i < 2000000; i++) acc = (acc + i * 7) | 0;
let f = 0.5;
for (let i = 0; i < 500000; i++) f = f * 1.000001 + 0.25;
console.log(acc, f.toFixed(3));
