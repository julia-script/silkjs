// Reserved words are recognized from their spelling; near misses stay identifiers.
const words = ['null', 'false', 'true', 'if', 'else', 'return', 'var', 'this', 'delete', 'void', 'typeof', 'new', 'in',
  'instanceof', 'do', 'while', 'for', 'break', 'continue', 'switch', 'case', 'default', 'throw', 'try', 'catch',
  'finally', 'function', 'debugger', 'with', 'class', 'const', 'enum', 'export', 'extends', 'import', 'super'];
const bad = [];
for (const w of words) {
  try { new Function('var ' + w + ' = 1;'); bad.push(w); } catch (e) { if (!(e instanceof SyntaxError)) bad.push(w + ':' + e); }
  const o = {}; o[w] = 1;
  if (new Function('o', 'return o.' + w)(o) !== 1) bad.push('prop ' + w);
}
const near = ['iff', 'i', 'iF', 'In', 'fo', 'forr', 'lett', 'le', 'nul', 'nulls', 'thiss', 'tru', 'truE', 'trUe', 'els', 'elsa',
  'enun', 'cass', 'voi', 'witH', 'cons', 'catcH', 'clas', 'classs', 'falsy', 'whilE', 'breaK', 'throws', 'supe', 'returns',
  'typeOf', 'delet', 'switcH', 'exports', 'imports', 'defaults', 'finall', 'functio', 'functions', 'continu', 'debugge',
  'instanceOf', 'instanceo', 'dO', 'tri', 'nev', 'vars', 'letx', 'xlet', 'xif'];
let sum = 0;
for (const w of near) {
  try { sum += new Function('var ' + w + ' = 2; return ' + w + ';')(); } catch (e) { bad.push('near ' + w + ':' + e); }
}
let let1 = 0; var let = 3; let1 = let;
if (bad.length || sum !== 2 * near.length || let1 !== 3) throw new Error('keyword spellings: ' + bad.join() + ' ' + sum);
console.log('ok');
