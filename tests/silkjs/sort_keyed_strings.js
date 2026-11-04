// SilkJS regression test for default sort over flat Latin-1 strings ordered by
// an eight-byte prefix key (NUL units, Latin-1 high units, long shared
// prefixes, wide fallback) and the in-place write-back into fast arrays
// (frozen and sealed receivers, holes). Expected values come from C QuickJS.
var out=[];
var a=["a\0b","a","a\0","\0","","a\0\0","ab","\xff","\xe9t","\xe9","zz\0"]; out.push(JSON.stringify(a.slice().sort()));
var b=[]; for (var i=0;i<300;i++) b.push("prefix__"+((i*7919)%300)); b.sort(); out.push(b.slice(0,5).join(),b.slice(-3).join());
var c=[]; for (var i=0;i<200;i++) c.push(String.fromCharCode(65+(i*13)%26)+"\xe9"+(i%3)); c.sort(); out.push(c.slice(0,6).join(),c.slice(-4).join());
var d=["b","a","c"]; Object.freeze(d); try { d.sort(); out.push("no throw"); } catch (e) { out.push(e.constructor.name); } out.push(d.join());
var e=["c","b","a"]; Object.seal(e); e.sort(); out.push(e.join());
var f=["ā","b","a"]; f.sort(); out.push(f.join());
var g=[]; for (var i=0;i<50;i++) g.push(i%2?"same":"same"+""); g.sort(); out.push(g.length, g[0], g[49]);
var h=new Array(5); h[0]="e"; h[1]="d"; h[3]="b"; h.sort(); out.push(JSON.stringify(h), h.length);
const got = out.join('\n');
const expected = "[\"\",\"\\u0000\",\"a\",\"a\\u0000\",\"a\\u0000\\u0000\",\"a\\u0000b\",\"ab\",\"zz\\u0000\",\"é\",\"ét\",\"ÿ\"]\nprefix__0,prefix__1,prefix__10,prefix__100,prefix__101\nprefix__97,prefix__98,prefix__99\nAé0,Aé0,Aé0,Aé0,Aé0,Aé0\nNé2,Né2,Né2,Né2\nTypeError\nb,a,c\na,b,c\na,b,ā\n50\nsame\nsame\n[\"b\",\"d\",\"e\",null,null]\n5";
console.log(got === expected ? 'PASS sort keyed strings' : 'FAIL ' + got);
if (got !== expected) throw new Error('sort keyed string regressions');
