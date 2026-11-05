// new W(...) where W's body is this.initialize.apply(this, arguments).
function wrap() { return function () { this.initialize.apply(this, arguments); }; }
function check(cond, what) { if (!cond) throw new Error("failed: " + what); }

var P = wrap();
P.prototype = { x: 0, initialize: function (a, b) { this.x = a ? a : 1; this.y = b; this.n = arguments.length; } };
var p = new P(5, 6, 7);
check(p.x === 5 && p.y === 6 && p.n === 3, "basic");
check(p instanceof P && Object.getPrototypeOf(p) === P.prototype, "prototype");
p = new P();
check(p.x === 1 && p.y === undefined && p.n === 0, "no arguments");

// initialize returning an object: the wrapper discards it.
var R = wrap();
R.prototype.initialize = function () { this.k = 1; return { other: true }; };
var r = new R();
check(r.k === 1 && r.other === undefined && r instanceof R, "returned object ignored");

// new.target inside initialize is undefined (called, not constructed).
var T = wrap(); var seen = "unset";
T.prototype.initialize = function () { seen = new.target; };
new T();
check(seen === undefined, "new.target");

// An own apply override is called instead.
var A = wrap(); var applied = 0;
A.prototype.initialize = function () { this.v = 1; };
A.prototype.initialize.apply = function (self, args) { applied++; self.v = 2; };
var a = new A();
check(applied === 1 && a.v === 2, "apply override");

// A getter for initialize runs once.
var G = wrap(); var gets = 0;
Object.defineProperty(G.prototype, "initialize", { get: function () { gets++; return function () { this.g = 3; }; } });
var g = new G();
check(gets === 1 && g.g === 3, "getter");

// A class constructor as initialize throws.
var C = wrap();
C.prototype.initialize = class { constructor() { this.c = 1; } };
var threw = false;
try { new C(); } catch (e) { threw = e instanceof TypeError; }
check(threw, "class constructor throws");

// Missing initialize throws TypeError.
var M = wrap(); threw = false;
try { new M(); } catch (e) { threw = e instanceof TypeError; }
check(threw, "missing initialize");

// An exception from initialize propagates, and the loop keeps working.
var E = wrap();
E.prototype.initialize = function (t) { if (t) throw new RangeError("boom"); this.ok = true; };
threw = false;
try { new E(true); } catch (e) { threw = e instanceof RangeError; }
check(threw && new E(false).ok === true, "exception");

// this inside initialize is the new object; arguments is its own.
var S = wrap(); var inner;
S.prototype.initialize = function (q) { inner = this; arguments[0] = 9; this.q = q; };
var s = new S(4);
check(inner === s && s.q === 9, "this and arguments");

// Many constructions of the same wrapper.
var V = wrap();
V.prototype.initialize = function (x, y, z) { this.x = x; this.y = y; this.z = z; };
var sum = 0;
for (var i = 0; i < 1000; i++) { var v = new V(i, 1, 2); sum += v.x + v.y + v.z; }
check(sum === 499500 + 3000, "loop");
console.log("ok");
