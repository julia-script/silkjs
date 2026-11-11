// `a[i] = v;` on locals, arguments and small constants runs under a fusion
// prefix that stores from the slots. Every shape and every receiver the fast
// path declines must agree with the plain reads and put_array_el.
const r = [];
function shapes(arr, val) {
  var a = [0, 0, 0, 0, 0, 0], i = 2, v = "x", o = { k: 1 }, n = 0;
  a[0] = v; a[1] = 7; a[i] = v; a[i] = 63; a[3] = o; a[3] = o; a[4] = val; a[i] = val;
  arr[0] = v; arr[1] = 9; arr[i] = o; arr[i] = val; arr[3] = 64; arr[4] = -1; arr[5] = 1.5;
  for (n = 0; n < 3; n++) { a[5] = n; arr[n] = n; }
  return JSON.stringify(a) + JSON.stringify(arr) + JSON.stringify(o);
}
r.push(shapes([1, 2, 3, 4, 5, 6], "arg"));
// Past the end, holes, and receivers that are no fast Array.
function receivers(val) {
  var a = [1], i = 1, s = "str", o = {}, u, f = Object.freeze([1, 2]), t = new Int32Array(3), g = new Uint8Array(2), d = new Float64Array(2), n = null;
  a[i] = val; i = 5; a[i] = 2; a[3] = 3;
  s[0] = val; o[0] = val; o[i] = 4; f[0] = 9; f[5] = 9;
  t[0] = 5; t[1] = val; i = 2; t[i] = 300; t[7] = 1; g[0] = 300; g[1] = val; d[0] = 5; d[1] = val;
  var e = [];
  try { u[0] = 1; } catch (x) { e.push(x.name); }
  try { n[i] = val; } catch (x) { e.push(x.name); }
  i = -1; a[i] = "neg"; i = 1.5; a[i] = "frac"; i = "2"; a[i] = "text"; i = 0; a[i] = "zero";
  return [JSON.stringify(a), a.length, a[-1], a[1.5], s, JSON.stringify(o), JSON.stringify(f), Array.from(t), Array.from(g), Array.from(d), e].join("|");
}
r.push(receivers(2.5), receivers(7));
// Setters, proxies and array subclasses see the store.
function observed(v) {
  var log = [], p = new Proxy([0, 0], { set(t, k, x) { log.push("set " + String(k) + "=" + x); t[k] = x; return true; } });
  var q = [0, 0]; Object.defineProperty(q, 1, { set(x) { log.push("setter " + x); }, get() { return "g"; } });
  class Sub extends Array {} var b = new Sub(3), i = 1;
  p[0] = v; p[i] = 5; q[1] = v; q[i] = 6; q[0] = v; b[0] = v; b[i] = 8;
  var proto = [1, 2, 3]; Object.defineProperty(Array.prototype, 7, { set(x) { log.push("proto " + x); }, configurable: true });
  i = 7; proto[i] = v; proto[7] = 2; delete Array.prototype[7];
  return log.join(",") + "|" + q[0] + q[1] + "|" + b.length + b[0] + b[1] + "|" + proto.length;
}
r.push(observed("v"));
// Stored objects are counted: overwritten values die, kept ones stay.
function owned(n) {
  var a = [null, null, null], i = 1, o = { id: 0 }, keep = [], j;
  for (j = 0; j < n; j++) { o = { id: j }; a[0] = o; a[i] = o; a[2] = o; if (j % 100 == 0) keep.push(a[0]); }
  a[0] = 1; a[i] = 2;
  return keep.map((x) => x.id).join(",") + "|" + a[2].id + "|" + o.id + "|" + JSON.stringify(a);
}
r.push(owned(450));
// Arguments as arrays and values, a mapped arguments object, the array local itself.
function args(a, i, v) { a[0] = v; a[i] = v; a[1] = 5; arguments[2] = "changed"; a[2] = v; var b = a; b[3] = b; b[3] = 0; a = [9]; a[0] = v; return JSON.stringify(b) + JSON.stringify(a) + i; }
r.push(args([0, 0, 0, 0], 1, "v"));
function many() {
  var l0, l1, l2, l3, l4, l5, l6, l7, l8, l9, m0, m1, m2, m3, m4, m5, m6, m7, m8, m9, n0, n1, n2, n3, n4, n5, n6, n7, n8, n9, p0, p1, p2, p3, p4, p5, p6, p7, p8, p9;
  var q0, q1, q2, q3, q4, q5, q6, q7, q8, q9, s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, t0, t1, t2, t3, t4, t5, t6, t7, t8, t9, far = [0, 0], at = 1, what = "w";
  far[at] = what; far[0] = what; far[at] = 3; l0 = [0]; l0[0] = what;
  return JSON.stringify(far) + l0;
}
r.push(many());
function scoped(n) { var out = []; for (let i = 0; i < n; i++) { let a = [0, 0], v = i * 2; { let w = v + 1; a[0] = w; } a[1] = v; out.push(a.join("")); } return out.join(","); }
r.push(scoped(3));
// Short forward branches around many prefixed stores and loop tests keep
// their reach (a prefix never makes the code longer than it was before).
function reach() {
  var decl = "var l0=0,l1=0,l2=0,l3=0,a=[0,0,0],i=1,v=5,p=0,q=3,c=0;";
  var sum = 0;
  for (var k = 1; k <= 40; k++) {
    var stores = new Function("x", decl + "if (x) {" + "a[i]=v;".repeat(k) + "} else { c = 7; } return a[1] + c;");
    var loops = new Function("x", decl + "if (x) {" + "p=0;while(p<q)p++;c+=p;".repeat(k) + "} else { c = -1; } return c;");
    var mixed = new Function("x", "a", decl.replace("a=[0,0,0],", "") + "do { if (x) break;" + "a[0]=v;a[i]=1;".repeat(k) + "} while (++c < 2); return a[0] + a[1] + c;");
    sum += stores(1) + stores(0) + loops(1) + loops(0) + mixed(0, [0, 0]) + mixed(1, [3, 4]);
  }
  return sum;
}
r.push(reach());
const got = r.join(";");
const expected = "[\"x\",7,\"arg\",{\"k\":1},\"arg\",2][0,1,2,64,-1,1.5]{\"k\":1};[\"zero\",2.5,\"text\",3,null,2]|6|neg|frac|str|{\"0\":2.5,\"5\":4}|[1,2]|5,2,300|44,2|5,2.5|TypeError,TypeError;[\"zero\",7,\"text\",3,null,2]|6|neg|frac|str|{\"0\":7,\"5\":4}|[1,2]|5,7,300|44,7|5,7|TypeError,TypeError;set 0=v,set 1=5,setter v,setter 6,proto v,proto 2|vg|3v8|3;0,100,200,300,400|449|449|[1,2,{\"id\":449}];[\"v\",5,\"changed\",0][\"changed\"]1;[\"w\",3]w;10,32,54;3500";
console.log(got === expected ? 'PASS slot store fusion' : 'FAIL ' + got);
if (got !== expected) throw new Error('slot store fusion regressions');
