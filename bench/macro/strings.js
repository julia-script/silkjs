// String concatenation (ropes), slicing, searching and number formatting.
let s = "";
for (let i = 0; i < 20000; i++) s += String.fromCharCode(97 + (i % 26)) + i;
let count = 0;
for (let i = 0; i < s.length; i += 7) if (s.charCodeAt(i) > 100) count++;
const parts = s.split("a");
const joined = parts.join("-");
let idx = 0, hits = 0;
while ((idx = joined.indexOf("z1", idx)) !== -1) { hits++; idx++; }
console.log(s.length, count, parts.length, hits, joined.slice(100, 120).toUpperCase());
