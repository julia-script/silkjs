// SilkJS regression test for BigInt +, - and * on operands and results of machine
// words (js_binary_operators.wordArithmetic): every pair of values around the
// ShortBigInt, 64-bit and 128-bit edges through the fresh, in-place and
// multiply-accumulate paths, and sums that grow and shrink across limb counts in
// their own cell. Expected values come from V8.
var out=[];
var edges=[0n,1n,-1n,(1n<<46n),(1n<<47n)-1n,(1n<<47n),-(1n<<47n),-(1n<<47n)-1n,(1n<<62n),(1n<<63n)-1n,(1n<<63n),-(1n<<63n),-(1n<<63n)-1n,(1n<<64n),(1n<<126n),(1n<<127n)-1n,(1n<<127n),-(1n<<127n),-(1n<<127n)-1n,(1n<<128n)+5n,-(1n<<200n)];
var h=0n, n=0;
for (var i=0;i<edges.length;i++) for (var j=0;j<edges.length;j++) {
  var a=edges[i], b=edges[j];
  var s=a+0n; s+=a*b; var t=b+0n; t-=a*b; var u=a+0n; u=u+b; var w=a+0n; w=w-b; var x=a+0n; x=x*b; var y=a+0n; y+=b;
  if (u!==a+b||w!==a-b||x!==a*b||y!==a+b||s!==a+a*b||t!==b-a*b) out.push('bad'+i+'/'+j);
  h=(h*1000003n+s*3n+t*5n+u*7n+w*11n+x*13n+y)%((1n<<255n)-19n); n++;
}
out.push(String(h), n);
// a sum that walks from the short range through two, three and four limbs in place
var sum=0n, k=(1n<<31n)+12345n; for (var i=0;i<3000;i++){ sum+=k*k; k+=(1n<<28n); } out.push(String(sum));
var down=(1n<<70n); for (var i=0;i<40;i++){ down-=(1n<<65n)+(1n<<40n); } out.push(String(down));
var p=3n; for (var i=0;i<6;i++){ p=p*p; } out.push(String(p));
var q=(1n<<60n); var keep=q; q+=q; q+=q; out.push(String(q), String(keep));
const got = out.join(',');
const expected = "57569024204641573954826357856527499438354992808808026432616622604109615162409,441,653394405617151353308691000,-295147949159817936896,3433683820292512484657849089281,4611686018427387904,1152921504606846976";
console.log(got === expected ? 'PASS bigint word arithmetic' : 'FAIL ' + got);
if (got !== expected) throw new Error('bigint word arithmetic regressions');
