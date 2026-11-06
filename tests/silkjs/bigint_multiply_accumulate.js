// SilkJS regression test for BigInt results written into an operand's own cell:
// s += a * b and s -= a * b fused at the multiply (no temporary product), and
// x += y with a short y carried in place. Covers copies that must keep the old
// value, aliasing, sign changes, carries through every limb, growth past the
// inline limbs and shrinking back to a short value. Expected values from Node.
// In a function, so the operands are locals (put_loc) rather than globals.
function run() {
  var out=[];
  // s += a * b and s -= a * b written into s's cell; a copy of s keeps its value.
  var s=(1n<<100n)+7n, a=(1n<<90n)+3n, b=(1n<<80n)-5n, t;
  for (var i=0;i<20;i++){ s+=a*b; a+=1n; } out.push(String(s%1000000007n));
  t=s; s+=a*b; out.push(String(t%1000003n), String(s%1000003n));
  s=(1n<<100n); for (var i=0;i<4;i++){ s-=a*b; } out.push(String(s));
  s=(1n<<70n)+1n; s+=s*s; out.push(String(s));
  s=(1n<<70n)+1n; s+=a*a*a; out.push(String(s%999983n));
  // A sum that outgrows the inline limbs, and a negative operand.
  s=(1n<<300n); for (var i=0;i<3;i++){ s+=a*(-b); } out.push(String(s%1000000007n));
  s=(1n<<310n); s+=(1n<<300n)*(1n<<200n); out.push(String(s%1000000007n));
  // x += short in place: carries through every limb, sign changes, shrink to short.
  var x=(1n<<128n)-1n; x+=1n; out.push(x.toString(16));
  x=-(1n<<128n); x-=1n; x+=1n; x+=1n; out.push(x.toString(16));
  x=(1n<<64n); x-=(1n<<63n); x-=(1n<<63n); out.push(String(x));
  x=(1n<<95n); var y=x; x+=5n; out.push(String(y), String(x));
  x=(1n<<95n); x-=(1n<<62n); x-=(1n<<62n); out.push(String(x));
  x=-(1n<<96n)+1n; x+=-1n; x+=-9223372036854775808n; out.push(x.toString(16));
  return out.join(',');
}
const got = run();
const expected = '425120292,191871,258742,-5986310706507378352961000776626056716049589083307572,1393796574908163946349524166902674828034050,652822,260542765,170457913,100000000000000000000000000000000,-ffffffffffffffffffffffffffffffff,0,39614081257132168796771975168,39614081257132168796771975173,39614081247908796759917199360,-1000000008000000000000000';
console.log(got === expected ? 'PASS bigint multiply accumulate' : 'FAIL ' + got);
if (got !== expected) throw new Error('bigint in-place regressions');
