// SilkJS regression test for the fifth round of benchmark fast paths. Results must match QuickJS.
// Frameless Array pop/push, cached for-in index keys, reused small value lists (arguments, exec results).
function round5() {
  const r = [];
  const a = [1, 'two', { three: 3 }];
  r.push(a.pop().three, a.pop(), a.pop(), a.pop(), a.length, [].pop());
  const frozen = Object.freeze([1, 2]);
  try { frozen.pop(); } catch (e) { r.push(e.name); }
  try { frozen.push(3); } catch (e) { r.push(e.name); }
  const sealed = Object.seal([1, 2]);
  try { sealed.pop(); } catch (e) { r.push(e.name); }
  const holey = [1, , 3]; r.push(holey.pop(), holey.pop(), holey.length);
  const ro = [1, 2, 3]; Object.defineProperty(ro, 'length', { writable: false });
  try { ro.pop(); } catch (e) { r.push(e.name, ro.length); }
  try { ro.push(9); } catch (e) { r.push(e.name, ro.length); }
  const ne = [1]; Object.preventExtensions(ne);
  try { ne.push(2); } catch (e) { r.push(e.name, ne.length); }
  const p = []; for (let i = 0; i < 20; i++) r.push(p.push(i % 3 ? i : { i }));
  r.push(JSON.stringify(p), Array.prototype.pop.call({ length: 2, 1: 'x' }));
  const keys = []; const big = []; for (let i = 0; i < 300; i++) big[i] = i;
  for (const k in big) if (+k % 37 === 0) keys.push(typeof k, k, big[k]);
  const sparse = [5, 6]; sparse[260] = 7; for (const k in sparse) keys.push(k);
  r.push(keys.join(','));
  function strict() { 'use strict'; return arguments.length + arguments[0] + (arguments[arguments.length - 1] || 0); }
  function sloppy(x) { arguments[0] = 10; return x + arguments.length; }
  let s = 0; for (let i = 0; i < 50; i++) s += strict(i, i, i) + strict() + strict(1, 2, 3, 4, 5, 6, 7, 8, 9) + sloppy(i, 2);
  r.push(s);
  const m = []; for (let i = 0; i < 30; i++) { const x = /(\d)(\d)?/.exec('a' + i); m.push(x.length, x[0], x[2], x.index); }
  r.push(m.join('|'));
  const kept = []; for (let i = 0; i < 20; i++) { const t = [i, [i]]; kept.push(t); [].concat(t); }
  r.push(JSON.stringify(kept.slice(15)));
  return r;
}
const got = JSON.stringify(round5());
const expected = "[3,\"two\",1,null,0,null,\"TypeError\",\"TypeError\",\"TypeError\",3,null,1,\"TypeError\",3,\"TypeError\",3,\"TypeError\",1,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,\"[{\\\"i\\\":0},1,2,{\\\"i\\\":3},4,5,{\\\"i\\\":6},7,8,{\\\"i\\\":9},10,11,{\\\"i\\\":12},13,14,{\\\"i\\\":15},16,17,{\\\"i\\\":18},19]\",\"x\",\"string,0,0,string,37,37,string,74,74,string,111,111,string,148,148,string,185,185,string,222,222,string,259,259,string,296,296,0,1,260\",null,\"3|0||1|3|1||1|3|2||1|3|3||1|3|4||1|3|5||1|3|6||1|3|7||1|3|8||1|3|9||1|3|10|0|1|3|11|1|1|3|12|2|1|3|13|3|1|3|14|4|1|3|15|5|1|3|16|6|1|3|17|7|1|3|18|8|1|3|19|9|1|3|20|0|1|3|21|1|1|3|22|2|1|3|23|3|1|3|24|4|1|3|25|5|1|3|26|6|1|3|27|7|1|3|28|8|1|3|29|9|1\",\"[[15,[15]],[16,[16]],[17,[17]],[18,[18]],[19,[19]]]\"]";
console.log(got === expected ? 'PASS perf fast paths 5' : 'FAIL ' + got);
if (got !== expected) throw new Error('perf fast path regressions');
