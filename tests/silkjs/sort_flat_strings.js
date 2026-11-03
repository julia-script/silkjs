// SilkJS regression test for default Array.prototype.sort over flat strings,
// which caches each text up front and compares bytes directly. Mixed, rope,
// wide, object and hole inputs must keep the general order. Expected values
// come from C QuickJS.
var out=[];
var a=["b","a","c","ab","","aé","Āx","aa","b"]; out.push(a.slice().sort().join("|"));
var r="x"; for (var i=0;i<3;i++) r+=i; var b=["x1",r,"x01","x012a","x"]; out.push(b.sort().join("|"));
var c=["10","9","1",{toString(){out.push("ts");return "5"}},"2"]; out.push(c.sort().map(String).join("|"));
var d=["b",undefined,"a",,"c"]; d.sort(); out.push(JSON.stringify(d), d.length);
var e=["abcdefghij1","abcdefghij0","abcdefghi","abcdefghijk","abcdefgh"]; out.push(e.sort().join("|"));
var f=[3,"3",2,"10",1]; out.push(f.sort().join("|"));
var g=[]; for (var i=0;i<100;i++) g.push(String((i*37)%100)); g.sort(); out.push(g.join(","));
var h=["b","a"]; h.sort(undefined); out.push(h.join());
var st=[{k:"b",i:0},{k:"a",i:1},{k:"b",i:2},{k:"a",i:3}].map(o=>o.k); out.push(st.sort().join());
const got = out.join('\n');
const expected = "|a|aa|ab|a\u00e9|b|b|c|\u0100x\nx|x01|x012|x012a|x1\nts\nts\n1|10|2|5|9\n[\"a\",\"b\",\"c\",null,null]\n5\nabcdefgh|abcdefghi|abcdefghij0|abcdefghij1|abcdefghijk\n1|10|2|3|3\n0,1,10,11,12,13,14,15,16,17,18,19,2,20,21,22,23,24,25,26,27,28,29,3,30,31,32,33,34,35,36,37,38,39,4,40,41,42,43,44,45,46,47,48,49,5,50,51,52,53,54,55,56,57,58,59,6,60,61,62,63,64,65,66,67,68,69,7,70,71,72,73,74,75,76,77,78,79,8,80,81,82,83,84,85,86,87,88,89,9,90,91,92,93,94,95,96,97,98,99\na,b\na,a,b,b";
console.log(got === expected ? 'PASS sort flat strings' : 'FAIL ' + got);
if (got !== expected) throw new Error('sort flat string regressions');
