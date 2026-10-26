// Parser and bytecode compiler throughput: compile a large generated program without running much of it.
let src = "";
for (let i = 0; i < 1500; i++) {
  src += "function f" + i + "(a, b) { let x = a + " + i + "; if (x > b) { const o = { k: 'v" + i + "', x: x }; return o.x + b; } else { for (let j = 0; j < b; j++) x += j; return x; } }\n";
}
let total = 0;
for (let r = 0; r < 3; r++) { const f = new Function(src + "return f" + (r * 7) + "(1, 2);"); total += f(); }
console.log(src.length, total);
