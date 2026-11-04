// SilkJS regression test for string.charCodeAt(index) answered in the dispatch
// loop: flat and rope receivers, wide strings, out-of-range and non-integer
// indices, other receivers and a replaced method. Expected values come from C QuickJS.
var r = [];
var s = 'hello', wide = 'hé中😀', rope = s + wide + s;
var sum = 0;
for (var i = 0; i < s.length; i++) sum += s.charCodeAt(i);
r.push(sum);
for (var i = 0; i < wide.length; i++) r.push(wide.charCodeAt(i));
r.push(rope.charCodeAt(7), rope.charCodeAt(rope.length - 1));
r.push(s.charCodeAt(-1), s.charCodeAt(5), s.charCodeAt(1.5), s.charCodeAt('2'), s.charCodeAt());
r.push(String.prototype.charCodeAt.call(12345, 2), String.prototype.charCodeAt.call(true, 0));
var boxed = new String('abc'); r.push(boxed.charCodeAt(1));
var o = { charCodeAt: String.prototype.charCodeAt, toString: function () { return 'xyz' } }; r.push(o.charCodeAt(2));
try { String.prototype.charCodeAt.call(null, 0) } catch (e) { r.push(e.constructor.name) }
var saved = String.prototype.charCodeAt;
String.prototype.charCodeAt = function (i) { return 'own' + i };
r.push(s.charCodeAt(1));
String.prototype.charCodeAt = saved;
r.push(s.charCodeAt(1));
var arr = []; r.push(arr.push(7), arr.push('x'), arr.length);
const got = r.join();
const expected = '532,104,233,20013,55357,56832,20013,111,NaN,NaN,101,108,104,51,116,98,122,TypeError,own1,101,1,2,2';
if (got !== expected) throw new Error('charCodeAt: got ' + got);
print('ok');
