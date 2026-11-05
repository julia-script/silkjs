// Closure-variable lookups in functions that capture many outer names.
// The compiler indexes a function's closure variables once it has 32 or more.
function assert(actual, expected, message) {
  if (actual !== expected)
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

// Many captured outer vars, read and written from an inner function.
function outer() {
  var a0 = 0, a1 = 1, a2 = 2, a3 = 3, a4 = 4, a5 = 5, a6 = 6, a7 = 7, a8 = 8, a9 = 9;
  var b0 = 10, b1 = 11, b2 = 12, b3 = 13, b4 = 14, b5 = 15, b6 = 16, b7 = 17, b8 = 18, b9 = 19;
  var c0 = 20, c1 = 21, c2 = 22, c3 = 23, c4 = 24, c5 = 25, c6 = 26, c7 = 27, c8 = 28, c9 = 29;
  let d0 = 30, d1 = 31, d2 = 32, d3 = 33, d4 = 34, d5 = 35, d6 = 36, d7 = 37, d8 = 38, d9 = 39;
  function inner() {
    var sum = a0 + a1 + a2 + a3 + a4 + a5 + a6 + a7 + a8 + a9;
    sum += b0 + b1 + b2 + b3 + b4 + b5 + b6 + b7 + b8 + b9;
    sum += c0 + c1 + c2 + c3 + c4 + c5 + c6 + c7 + c8 + c9;
    sum += d0 + d1 + d2 + d3 + d4 + d5 + d6 + d7 + d8 + d9;
    // Second reads of the same names reuse the existing closure slots.
    sum += a0 + b5 + c9 + d9;
    d9 = 100;
    a0 = 50;
    return sum;
  }
  var first = inner();
  assert(d9, 100, "write through closure (let)");
  assert(a0, 50, "write through closure (var)");
  return first;
}
assert(outer(), 780 + 0 + 15 + 29 + 39, "sum of 40 captured names");

// Nested capture: the middle function forwards closure vars it does not use itself.
function nest() {
  var x0 = 1, x1 = 2, x2 = 3, x3 = 4, x4 = 5, x5 = 6, x6 = 7, x7 = 8, x8 = 9, x9 = 10;
  var y0 = 11, y1 = 12, y2 = 13, y3 = 14, y4 = 15, y5 = 16, y6 = 17, y7 = 18, y8 = 19, y9 = 20;
  var z0 = 21, z1 = 22, z2 = 23, z3 = 24, z4 = 25, z5 = 26, z6 = 27, z7 = 28, z8 = 29, z9 = 30;
  var w0 = 31, w1 = 32, w2 = 33, w3 = 34, w4 = 35, w5 = 36, w6 = 37, w7 = 38, w8 = 39, w9 = 40;
  return function middle() {
    return function leaf() {
      return x0 + x9 + y0 + y9 + z0 + z9 + w0 + w9 + x1 + x2 + x3 + x4 + x5 + x6 + x7 + x8
        + y1 + y2 + y3 + y4 + y5 + y6 + y7 + y8 + z1 + z2 + z3 + z4 + z5 + z6 + z7 + z8
        + w1 + w2 + w3 + w4 + w5 + w6 + w7 + w8;
    };
  };
}
assert(nest()()(), 820, "nested forwarding of 40 names");

// Shadowing: an inner declaration must win over a captured name of the same spelling.
function shadow() {
  var s0 = 0, s1 = 1, s2 = 2, s3 = 3, s4 = 4, s5 = 5, s6 = 6, s7 = 7, s8 = 8, s9 = 9;
  var t0 = 0, t1 = 1, t2 = 2, t3 = 3, t4 = 4, t5 = 5, t6 = 6, t7 = 7, t8 = 8, t9 = 9;
  var u0 = 0, u1 = 1, u2 = 2, u3 = 3, u4 = 4, u5 = 5, u6 = 6, u7 = 7, u8 = 8, u9 = 9;
  var v0 = 0, v1 = 1, v2 = 2, v3 = 3, v4 = 4, v5 = 5, v6 = 6, v7 = 7, v8 = 8, v9 = 9;
  return function () {
    var base = s0 + s1 + s2 + s3 + s4 + s5 + s6 + s7 + s8 + s9 + t0 + t1 + t2 + t3 + t4
      + t5 + t6 + t7 + t8 + t9 + u0 + u1 + u2 + u3 + u4 + u5 + u6 + u7 + u8 + u9 + v0
      + v1 + v2 + v3 + v4 + v5 + v6 + v7 + v8 + v9;
    { let s5 = 1000; base += s5; }
    return base + s5;
  };
}
assert(shadow()(), 180 + 1000 + 5, "block shadowing of a captured name");

// Captured names inside `with` and eval still resolve dynamically.
function dynamic() {
  var e0 = 0, e1 = 1, e2 = 2, e3 = 3, e4 = 4, e5 = 5, e6 = 6, e7 = 7, e8 = 8, e9 = 9;
  var f0 = 0, f1 = 1, f2 = 2, f3 = 3, f4 = 4, f5 = 5, f6 = 6, f7 = 7, f8 = 8, f9 = 9;
  var g0 = 0, g1 = 1, g2 = 2, g3 = 3, g4 = 4, g5 = 5, g6 = 6, g7 = 7, g8 = 8, g9 = 9;
  var h0 = 0, h1 = 1, h2 = 2, h3 = 3, h4 = 4, h5 = 5, h6 = 6, h7 = 7, h8 = 8, h9 = 9;
  return function () {
    var r = e0 + e9 + f0 + f9 + g0 + g9 + h0 + h9 + e1 + e2 + e3 + e4 + e5 + e6 + e7 + e8
      + f1 + f2 + f3 + f4 + f5 + f6 + f7 + f8 + g1 + g2 + g3 + g4 + g5 + g6 + g7 + g8
      + h1 + h2 + h3 + h4 + h5 + h6 + h7 + h8;
    with ({ h9: 900 }) r += h9;
    r += eval("g9 + e0");
    return r;
  };
}
assert(dynamic()(), 180 + 900 + 9, "with and eval over captured names");

// Many sloppy globals referenced from a function.
var src = "";
for (var i = 0; i < 64; i++) src += `var gl${i} = ${i};\n`;
src += "(function () { var s = 0;";
for (var i = 0; i < 64; i++) src += ` s += gl${i};`;
src += " gl63 = -1; return s; })()";
assert((0, eval)(src), 2016, "64 sloppy globals");
assert(globalThis.gl63, -1, "global write");

console.log("closure_index ok");
