// SilkJS regression test for BigInt * and - taken straight from the arithmetic
// arms (bigOperands): short and heap results, 64-bit edges, signs, and the
// mixed-type TypeError left to the generic path. Expected values come from C QuickJS.
var out=[]; var s=0n, a=1n<<20n;
for (var i=0;i<50;i++){ s+=a*a; a+=1n; } out.push(String(s));
var b=(1n<<70n); for (var i=0;i<5;i++){ b=b*b-3n; } out.push(String(b).length, String(b%1000n));
out.push(String(-5n*7n), String(9007199254740993n+1n), String((1n<<63n)-1n+1n), String(-(1n<<63n)-1n));
try { 1n+1; } catch(e) { out.push(e instanceof TypeError); }
out.push(String(2n-5n), typeof (3n*4n), String(0n*-1n));
const got = out.join(',');
const expected = '54978150440425,675,473,-35,9007199254740994,9223372036854775808,-9223372036854775809,true,-3,bigint,0';
console.log(got === expected ? 'PASS bigint arithmetic arms' : 'FAIL ' + got);
if (got !== expected) throw new Error('bigint arithmetic arm regressions');
