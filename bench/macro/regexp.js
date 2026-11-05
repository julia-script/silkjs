// RegExp compilation and matching, including global replace and captures.
let text = "";
for (let i = 0; i < 2000; i++) text += "user" + i + "@example" + (i % 13) + ".com, ";
const email = /([a-z]+)(\d+)@([a-z]+\d*)\.com/g;
let m, n = 0, digits = 0;
while ((m = email.exec(text)) !== null) { n++; digits += m[2].length; }
const replaced = text.replace(/example(\d+)/g, (_, d) => "ex" + (d * 2));
const words = text.split(/[,@.\s]+/).length;
console.log(n, digits, replaced.length, words);
