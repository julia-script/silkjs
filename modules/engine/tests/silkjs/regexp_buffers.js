// SilkJS regression test for the regexp undo log and register file: the first
// 32 words live inline and the rest on the heap, so these cases cross that
// boundary (deep backtracking, many captures, lookahead compaction) in both
// Latin-1 and UTF-16 subjects.
const out = [];
const wide = (s) => s.replace(/a/g, "ā");
for (const w of [false, true]) {
  const t = w ? wide : (s) => s;
  const re = (src, flags) => new RegExp(t(src), flags);
  out.push(JSON.stringify(re("^(a|ab)*c$").exec(t("ab".repeat(300) + "c")).index));
  out.push(JSON.stringify(re("^(?:(a)|b)*?x").exec(t("ab".repeat(200) + "x"))));
  let many = ""; for (let i = 0; i < 40; i++) many += "(.)";
  out.push(JSON.stringify(re(many).exec(t("a".repeat(20) + "b".repeat(30))).slice(35)));
  out.push(JSON.stringify(re("(?=((a+)(b+)))\\1d").exec(t("aaabbbd"))));
  out.push(JSON.stringify(re("^(?:(?=(a))a)*(b)").exec(t("a".repeat(100) + "b")).slice(1)));
  out.push(JSON.stringify(re("(a)(?!(a)(b))\\2?", "g")[Symbol.match](t("aab".repeat(30))).length));
  out.push(JSON.stringify(re("((a)|(b))+?c").exec(t("ab".repeat(50) + "c")).slice(2)));
  out.push(JSON.stringify(re("(\\w+?)(\\d+)?$").exec(t("a".repeat(80) + "12"))));
}
const got = out.join(";");
const expected = '0;["ababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababx",null];["b","b","b","b","b","b"];["aaabbbd","aaabbb","aaa","bbb"];["a","b"];30;[null,"b"];["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa12","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","12"];0;["ābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābābx",null];["b","b","b","b","b","b"];["āāābbbd","āāābbb","āāā","bbb"];["ā","b"];30;[null,"b"];["12","1","2"]';
console.log(got === expected ? 'PASS regexp buffers' : 'FAIL ' + got);
if (got !== expected) throw new Error('regexp buffer regressions');
