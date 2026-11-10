// parseInt / parseFloat of an Int argument skip the text round trip only when
// the radix still means 10.
const got = [parseInt(5), parseInt(-1), parseInt(0), parseInt(2147483647), parseInt(-2147483648),
  parseInt(12, 10), parseInt(12, 0), parseInt(12, undefined), parseInt(12, 16), parseInt(12, 2), parseInt(12, 1),
  parseFloat(7), parseFloat(-3), Number.parseInt(42), parseInt(-0), parseInt(1e21), parseInt(12, "16")].join(",");
const expected = "5,-1,0,2147483647,-2147483648,12,12,12,18,1,NaN,7,-3,42,0,1,18";
if (got !== expected) throw new Error("got " + got + ", expected " + expected);
console.log("ok");
