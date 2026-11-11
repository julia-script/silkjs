// SilkJS regression test for the byte-level bracket lookahead (Lexer.bracketAhead):
// arrow heads and destructuring assignments told apart from parenthesized
// expressions and literals across strings, templates, comments, regular
// expressions, divisions and nested spans. Expected values come from C QuickJS.
var r=[];
var f1=(a,b)=>a+b; r.push(f1(1,2));
var f2=(a=(1,2), b=`x${(3)}y`)=>a+b; r.push(f2());
var f3=(a=/re\)/.source)=>a; r.push(f3());
var x=1, y=2, g=1; r.push((x)/y/g);
var f4=(a = "))" , b = ')' ) => a + b; r.push(f4());
var f5=(a /* ) */, b // )
) => a*b; r.push(f5(3,4));
var f6 = (a = {b: [1, (2)]}) => a.b[1]; r.push(f6());
r.push((x, y));
var f7 = (a = `${`${')'}`}`) => a; r.push(f7());
var f8 = (q = 1e+3) => q; r.push(f8());
var f9 = (q = x++ / 2) => q; r.push(f9());
r.push((x = 5) / 2);
var f10 = (q = typeof /x/) => q; r.push(f10());
try { eval("(a)\n=> 1") } catch (e) { r.push(e.name) }
var f11 = (a) /* c */ => a; r.push(f11(9));
r.push((function(){ return (x) })());
const got1 = r.join();
r=[]; var a, b, c; x=1; y=2; g=1;
[a, b] = [1, 2]; r.push(a + b);
var o = {p: 5, q: [6]}; var z = {p: a, q: [b]} = o; r.push(a, b, z === o);
r.push(JSON.stringify({k: {m: [1, {n: "}]"}], s: `}${'{'}`}}));
var big = {a: function(){ return "x".replace(/\}/g, '') }, b: [1, 2, 3].map(function(v){ return v / 2 / 1 }), c: (x) => x * 2};
r.push(big.a(), big.b.join('/'), big.c(4));
[c = 3, ...a] = [undefined, 7, 8]; r.push(c, a.join('+'));
var nest = {l1: {l2: {l3: {l4: [[[{deep: 'yes', pad: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}]]]}}}};
r.push(nest.l1.l2.l3.l4[0][0][0].deep);
var arr = [x / y, x++ / 2, /=/.source, `a${[1, 2]}b`] ; r.push(arr.join('|'));
var w = [ (q) => q + 1 ][0]; r.push(w(1));
function f({a = 1, b: [c2] = [2]} = {}) { return a + c2; } r.push(f());
var h = (a = {x: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]}) => a.x.length; r.push(h());
r.push((function(){ return [1, 2] })().length);
var s1 = { "aé": 1, b: 'é' }; r.push(s1.b);
var o2 = {}; ({ a: o2.x, b: o2.y } = { a: 1, b: 2 }); r.push(o2.x + o2.y);
const got = got1 + ';' + r.join();
const expected = '3,2x3y,re\\),0.5,))),12,2,2,),1000,0.5,2.5,object,SyntaxError,9,5;3,5,6,true,{"k":{"m":[1,{"n":"}]"}],"s":"}{"}},x,0.5/1/1.5,8,3,7+8,yes,0.5|0.5|=|a1,2b,2,3,22,2,é,3';
console.log(got === expected ? 'PASS bracket lookahead' : 'FAIL ' + got);
if (got !== expected) throw new Error('bracket lookahead regressions');
// Object literals whose property values end in a function body: the scan may
// stop at such a property only when no `=` precedes it and `,` or `}` follows.
var t = [], fx = {}, d1, d2;
({a: d1 = function(){ return 4 }, b: d2 = () => {}} = {b: 1}); t.push(d1(), d2);
({a: function(){}.x, b: fx.y} = {a: 5, b: 6}); Function.prototype.x = undefined; t.push(fx.y);
({p: function(){ return fx }
  ().w} = {p: 7}); t.push(fx.w);
delete Function.prototype.x;
var lit = {m() { return 1 }, get g() { return 2 }, f: function () { return 3 }, n: 4}; t.push(lit.m() + lit.g + lit.f() + lit.n);
var lit2 = {f: function () {}, x: 1} ; t.push(lit2.x);
try { eval("({m(){}} = {})") } catch (e) { t.push(e.name) }
try { eval("({a: function(){}} = {})") } catch (e) { t.push(e.name) }
try { eval("({a: function(){}, b} = {})") } catch (e) { t.push(e.name) }
const got2 = t.join();
const expected2 = '4,1,6,7,10,1,SyntaxError,SyntaxError,SyntaxError';
console.log(got2 === expected2 ? 'PASS bracket lookahead bodies' : 'FAIL ' + got2);
if (got2 !== expected2) throw new Error('bracket lookahead body regressions');
