// Closure creation and captured-variable access, plus GC churn from short-lived functions.
function counter() { let n = 0; return () => ++n; }
let total = 0;
for (let i = 0; i < 20000; i++) {
  const c = counter();
  for (let j = 0; j < 10; j++) total += c();
}
const adders = [];
for (let i = 0; i < 1000; i++) adders.push((x) => x + i);
for (let k = 0; k < 50; k++) for (const a of adders) total = (total + a(k)) | 0;
console.log(total);
