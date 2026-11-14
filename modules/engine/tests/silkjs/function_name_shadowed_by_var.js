// SilkJS regression test: a named function expression's own name is shadowed by
// a parameter or body var of the same name, also when eval adds every binding up
// front (the debugger path, used under an inspector session, does the same).
// Express's `proto.route = function route(path) { var route = new Route(path) }`
// threw "Assignment to constant variable." there. Expected values come from V8.
var r = [];
var f = function route(p) { var route = { d: 1 }; eval(''); return route.d; };
r.push(f());
var g = function route(route) { eval(''); return typeof route; };
r.push(g(3));
var h = function route() { var route; eval(''); return typeof route; };
r.push(h());
var k = function route() { 'use strict'; var route = 2; eval(''); route = 3; return route; };
r.push(k());
var m = function route() { eval(''); return typeof route; };
r.push(m());
var n = function route() { return (function () { eval(''); return typeof route; })(); };
r.push(n());
const got = JSON.stringify(r);
const expected = '[1,"number","undefined",3,"function","function"]';
console.log(got === expected ? 'PASS function name shadowed by var' : 'FAIL ' + got);
if (got !== expected) throw new Error('function name shadowing regressions');
