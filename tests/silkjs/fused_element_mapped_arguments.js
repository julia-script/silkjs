// get_loc_el8 / get_arg_el8 on objects their fast path does not serve (a
// mapped arguments object, a string, a Map-like object with a getter): the
// slow path pushes both operands, which must fit the frame's stack.
function mapped(x) { var a = arguments; var i = 1; return a[i]; }
function mappedArg(x, a) { var i = 0; return a[i]; }
function text(s) { var i = 2; return s[i]; }
function getter(o) { var k = 0; return o[k]; }
var o = { get 0() { return "g"; } };
var out = [];
for (var n = 0; n < 3; n++) {
  out.push(mapped(1, 2), mapped(1, 2, 3, 4, 5), mappedArg(0, (function (y) { return arguments; })(7)), text("abcd"), getter(o));
}
var expected = "2,2,7,c,g,2,2,7,c,g,2,2,7,c,g";
if (out.join(",") !== expected) throw new Error("got " + out.join(",") + ", expected " + expected);
console.log("ok");
