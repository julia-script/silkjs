// Lazy arguments objects (js_bytecode.lazyArgumentsSite) whose element index is
// an expression: arguments[arguments.length - 1], arguments[n - 1] and the like.
// Expected values come from node.
var r=[];
function last() { if (arguments.length === 0) return null; var res = arguments[arguments.length - 1]; for (var i = arguments.length - 2; i >= 0; i--) res = res + arguments[i]; return res; }
r.push(last(1, 2, 3), last(), last('a', 'b'), last.apply(null, [9, 8]));
function counted() { var n = arguments.length; return arguments[n - 1] + arguments[n - 2 + 1] * 2 + arguments[0]; } r.push(counted(1, 2, 3), counted(5));
function self() { return arguments[arguments[0]]; } r.push(self(1, 'x'), self(0));
function copy() { var a = arguments; return a[a.length - 1]; } r.push(copy(4, 5, 6));
function chain() { return arguments[1 + arguments.length * 0 - 1 + arguments.length - 1]; } r.push(chain(7, 8, 9));
var calls = 0; var two = { valueOf: function () { calls++; return 2; } };
function viaObject() { var o = two; return arguments[o - 1] + arguments[o * 1]; } r.push(viaObject(1, 2, 3), calls);
function strictLast() { "use strict"; return arguments[arguments.length - 1]; } r.push(strictLast(3, 4));
function outOfRange() { var n = arguments.length; return arguments[n + 1]; } r.push(outOfRange(1));
function incremented() { var i = 0; i++; return arguments[i + 1]; } r.push(incremented(1, 2, 3));
const got = r.join();
const expected = '6,,ba,17,10,20,x,0,6,9,5,2,4,,3';
console.log(got === expected ? 'PASS lazy arguments index expressions' : 'FAIL ' + got);
if (got !== expected) throw new Error('lazy arguments index regressions');
