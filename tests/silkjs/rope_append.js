// SilkJS regression test for in-place rope appends (`s += piece` on a rope
// nobody else holds) and charCodeAt/charAt on flattened ropes. Aliased ropes
// must keep their old contents; results must match QuickJS.
const out = [];
let s = "", t = "";
for (let i = 0; i < 3000; i++) {
  s += String.fromCharCode(97 + (i % 26)) + i;
  if (i === 1500) t = s;          // alias: s must stop growing t's leaf
  if (i === 2000) out.push(s.charCodeAt(7999), s.charAt(8001), s.length);
}
const u = t;
t += "TAIL";                      // t was aliased by u
out.push(s.length, t.length, u.length, u.endsWith("1500"), t.endsWith("1500TAIL"));
let sum = 0;
for (let i = 0; i < s.length; i += 13) sum = (sum * 31 + s.charCodeAt(i)) % 1000003;
out.push(sum, s.slice(-12), s.slice(6000, 6020), s.charAt(s.length - 1), s.charCodeAt(s.length), s.charAt(-1));
let w = "x".repeat(9000);
for (let i = 0; i < 50; i++) w += "é" + i;   // Latin-1 but not ASCII
for (let i = 0; i < 5; i++) w += "中" + i;   // wide piece: full path
out.push(w.length, w.slice(-14), w.charCodeAt(9001), w.indexOf("é49"));
const keep = [];
let r = "y".repeat(9000);
for (let i = 0; i < 400; i++) { r += "p" + i; if (i % 97 === 0) keep.push(r); }
out.push(keep.map(k => k.length + ":" + k.slice(-5)).join(","), r.length);
function local(n, alias) {
  let s = "", t = "", keep = [];
  for (let i = 0; i < n; i++) {
    s += String.fromCharCode(97 + (i % 26)) + i;
    if (i === alias) t = s;
    if (i % 611 === 0) keep.push(s);
    s += "";
    s += "é";
  }
  t += "!";
  let w = "q".repeat(9000);
  for (let i = 0; i < 20; i++) { w += "中"; w += "z" + i; }
  return [s.length, s.slice(-9), t.length, t.slice(-6), keep.map(k => k.length + k.slice(-3)).join(), w.length, w.slice(-8), s.charCodeAt(5000)];
}
out.push(local(3000, 1500), local(300, 10));
const got = JSON.stringify(out);
const expected = '[49,"1",8895,13890,6399,6395,true,true,499884,"97i2998j2999","s1422t1423u1424v1425","9",null,"",9150,"8é49中0中1中2中3中4",48,9137,"9002:yyyp0,9284:96p97,9670:3p194,10058:0p291,10446:7p388",10490,[16890,"98éj2999é",7896,"s1500!","2a0,2949611,6227222,9893833,13559444",9070,"中z18中z19",48],[1390,"298én299é",34,"9ék10!","2a0",9070,"中z18中z19",null]]';
console.log(got === expected ? 'PASS rope append' : 'FAIL ' + got);
if (got !== expected) throw new Error('rope append regressions');
