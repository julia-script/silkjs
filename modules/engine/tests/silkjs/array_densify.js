// SilkJS regression test for js_array_storage.densify: an Array filled from the
// top down goes slow at its first hole and turns fast again once its own
// properties are exactly length and 0..length-1. Expected values come from C QuickJS.
var out = [];
function show(a) { return a.length + ':' + Object.keys(a).join(',') + ':' + a.map(function (v) { return typeof v === 'object' ? 'o' + v.k : String(v); }).join(','); }
var a = []; for (var i = 5; --i >= 0;) a[i] = i * 2;
out.push(show(a), 3 in a, 9 in a, a[4], a[7]);
a[a.length] = 'x'; a.push('y'); a[1] = 'z'; out.push(show(a), a.indexOf('y'), a.join('-'));
delete a[2]; out.push(show(a), 2 in a, a.length);
var b = []; b.foo = 1; for (var i = 4; --i >= 0;) b[i] = i; out.push(show(b), b.foo, Object.keys(b).length);
var c = []; for (var i = 4; --i >= 1;) c[i] = i; out.push(show(c), 0 in c, c.length);
c[0] = 'zero'; out.push(show(c));
var d = []; Object.defineProperty(d, 'length', { writable: false, value: 3 });
for (var i = 3; --i >= 0;) { try { d[i] = i; } catch (e) { out.push('E' + i); } }
d[3] = 9; out.push(show(d), d[3]);
var e = []; e[2] = 'c'; Object.defineProperty(e, 1, { value: 'b', enumerable: false, writable: true, configurable: true }); e[0] = 'a';
out.push(show(e), Object.keys(e).join(), JSON.stringify(Object.getOwnPropertyDescriptor(e, 1)));
var f = []; f[2] = 'c'; Object.defineProperty(f, 1, { get: function () { return 'g'; }, configurable: true, enumerable: true }); f[0] = 'a';
out.push(show(f), f[1]);
class Sub extends Array {} var s = new Sub(); for (var i = 3; --i >= 0;) s[i] = i; out.push(show(s), s instanceof Sub, Object.getPrototypeOf(s) === Sub.prototype);
var g = []; for (var i = 3; --i >= 0;) g[i] = { k: i }; g.length = 2; out.push(show(g)); g.length = 4; out.push(show(g), 3 in g);
var h = []; for (var i = 6; --i >= 0;) h[i] = 6 - i; h.sort(); h.reverse(); out.push(show(h), h.slice(1, 3).join(), h.concat([7]).length);
var j = []; for (var i = 3; --i >= 0;) j[i] = i; Object.freeze(j); try { 'use strict'; j[0] = 5; } catch (x) {} out.push(show(j), Object.isFrozen(j));
var k = []; Object.preventExtensions(k); k.length = 3; out.push(show(k));
var m = []; for (var i = 4; --i >= 0;) m[i] = i; m.length = 0; m[1] = 1; m[0] = 0; out.push(show(m));
var p = []; for (var r = 0; r < 3; r++) { for (var i = 50; --i >= 0;) p[i] = i + r; } var t = 0; for (var i = 0; i < p.length; i++) t += p[i]; out.push(t, p.length);
var q = [1, 2, 3]; q[10] = 10; for (var i = 10; --i >= 3;) q[i] = i; out.push(show(q));
var u = []; u[3] = 3; u[1] = 1; u[2] = 2; u[0] = 0; out.push(show(u), u.lastIndexOf(3));
var w = []; for (var i = 3; --i >= 0;) w[i] = i; Object.defineProperty(w, 'length', { writable: false }); try { w.push(1); } catch (x) { out.push('push threw'); } out.push(show(w));
const got = out.join('|');
const expected = '5:0,1,2,3,4:0,2,4,6,8|true|false|8||7:0,1,2,3,4,5,6:0,z,4,6,8,x,y|6|0-z-4-6-8-x-y|7:0,1,3,4,5,6:0,z,,6,8,x,y|false|7|4:0,1,2,3,foo:0,1,2,3|1|5|4:1,2,3:,1,2,3|false|4|4:0,1,2,3:zero,1,2,3|3:0,1,2:0,1,2||3:0,2:a,b,c|0,2|{"value":"b","writable":true,"enumerable":false,"configurable":true}|3:0,1,2:a,g,c|g|3:0,1,2:0,1,2|true|true|2:0,1:o0,o1|4:0,1:o0,o1,,|false|6:0,1,2,3,4,5:6,5,4,3,2,1|5,4|7|3:0,1,2:0,1,2|true|3::,,|2:0,1:0,1|1325|50|11:0,1,2,3,4,5,6,7,8,9,10:1,2,3,3,4,5,6,7,8,9,10|4:0,1,2,3:0,1,2,3|3|push threw|3:0,1,2:0,1,2';
console.log(got === expected ? 'PASS array densify' : 'FAIL ' + got);
if (got !== expected) throw new Error('array densify regressions');
