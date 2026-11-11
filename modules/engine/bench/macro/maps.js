// Map and Set with string and integer keys: hashing, insertion, lookup, deletion.
const m = new Map();
for (let i = 0; i < 50000; i++) m.set("k" + i, i);
let s = 0;
for (let i = 0; i < 50000; i += 3) s += m.get("k" + i);
for (let i = 0; i < 50000; i += 2) m.delete("k" + i);
const set = new Set();
for (let i = 0; i < 50000; i++) set.add(i * 7 % 10007);
console.log(m.size, s, set.size);
