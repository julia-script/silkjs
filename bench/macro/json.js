// JSON.stringify and JSON.parse round trips over nested objects and arrays.
const items = [];
for (let i = 0; i < 2000; i++) items.push({ id: i, name: "item" + i, tags: ["a", "b", "c"], score: i / 7, ok: i % 2 === 0 });
let total = 0;
for (let r = 0; r < 10; r++) {
  const text = JSON.stringify({ items: items, round: r });
  const back = JSON.parse(text);
  total += back.items.length + text.length;
}
console.log(total);
