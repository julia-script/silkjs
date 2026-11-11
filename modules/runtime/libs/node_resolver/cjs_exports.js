'use strict';

// A conservative lexical scanner: it never evaluates a CommonJS module while
// constructing its ESM namespace. Dynamic/computed export names are not inferred.
function tokens(source) {
  const result = [];
  let i = 0;
  let previous = '';
  const simpleEscapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' };
  const regexPrefix = new Set(['', '=', '(', '[', '{', ',', ':', ';', '!', '?', '&&', '||', 'return', 'throw', 'case', '=>']);
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && source[i + 1] === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      let value = '';
      let valid = true;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') {
          i++;
          const escaped = source[i++];
          if (escaped === undefined) valid = false;
          else if (Object.hasOwn(simpleEscapes, escaped)) value += simpleEscapes[escaped];
          else if (escaped === 'x' || escaped === 'u') {
            // \xHH, \uHHHH and \u{H...}, as the string literal itself means them.
            let digits;
            if (escaped === 'u' && source[i] === '{') {
              const close = source.indexOf('}', i);
              digits = close < 0 ? '' : source.slice(i + 1, close);
              i = close < 0 ? source.length : close + 1;
            } else {
              digits = source.slice(i, i + (escaped === 'x' ? 2 : 4));
              i += digits.length;
              if (digits.length !== (escaped === 'x' ? 2 : 4)) digits = '';
            }
            const code = /^[0-9a-fA-F]+$/.test(digits) ? parseInt(digits, 16) : NaN;
            if (code <= 0x10ffff) value += String.fromCodePoint(code); else valid = false;
          } else if (escaped === '0' && !/[0-9]/.test(source[i] || '')) value += '\0';
          else if (/[0-9]/.test(escaped)) valid = false;
          else if (escaped === '\r') { if (source[i] === '\n') i++; }
          else if (escaped !== '\n' && escaped !== '\u2028' && escaped !== '\u2029') value += escaped;
        } else value += source[i++];
      }
      i++;
      // Like cjs-module-lexer, a name that is not well-formed UTF-16 is no export.
      result.push({ text: '<string>', value: valid && value.isWellFormed() ? value : undefined });
      previous = '<string>';
      continue;
    }
    if (c === '`') {
      // Template expressions are deliberately not scanned for export assignments.
      i++;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i++] === '`') break;
      }
      result.push({ text: '<template>' });
      previous = '<template>';
      continue;
    }
    if (c === '/' && regexPrefix.has(previous)) {
      i++;
      let characterClass = false;
      while (i < source.length) {
        const ch = source[i++];
        if (ch === '\\') { i++; continue; }
        if (ch === '[') characterClass = true;
        else if (ch === ']') characterClass = false;
        else if (ch === '/' && !characterClass) break;
        else if (ch === '\n') break;
      }
      while (i < source.length && /[a-z]/i.test(source[i])) i++;
      previous = '<regex>';
      result.push({ text: previous });
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const start = i++;
      while (i < source.length && /[A-Za-z0-9_$]/.test(source[i])) i++;
      previous = source.slice(start, i);
    } else {
      const pair = source.slice(i, i + 2);
      if (['=>', '==', '!=', '+=', '-=', '&&', '||', '??', '?.'].includes(pair)) {
        previous = pair;
        i += 2;
      } else { previous = c; i++; }
    }
    result.push({ text: previous });
  }
  return result;
}

function analyzeExports(source) {
  const list = tokens(source);
  const names = new Set();
  const reexports = new Set();
  const text = (i) => list[i] && list[i].text;
  const name = (i) => list[i] && (list[i].value === undefined ? (/^[A-Za-z_$][\w$]*$/.test(list[i].text) ? list[i].text : undefined) : list[i].value);
  function exportEnd(i) {
    if (text(i - 1) === '.' || text(i - 1) === '?.') return -1;
    if (text(i) === 'exports') return i + 1;
    if (text(i) === 'module' && text(i + 1) === '.' && text(i + 2) === 'exports') return i + 3;
    return -1;
  }
  for (let i = 0; i < list.length; i++) {
    let end = exportEnd(i);
    if (end !== -1) {
      if (text(end) === '.' && text(end + 2) === '=' && name(end + 1) !== undefined) names.add(name(end + 1));
      if (text(end) === '[' && text(end + 1) === '<string>' && text(end + 2) === ']' && text(end + 3) === '=' && name(end + 1) !== undefined) names.add(name(end + 1));
      if (text(i) === 'module' && text(end) === '=' && text(end + 1) === 'require' && text(end + 2) === '(' && text(end + 3) === '<string>' && text(end + 4) === ')' && name(end + 3) !== undefined) reexports.add(name(end + 3));
      if (text(i) === 'module' && text(end) === '=' && text(end + 1) === '{') {
        let depth = 0;
        let atKey = true;
        for (let j = end + 2; j < list.length; j++) {
          const t = text(j);
          if (depth === 0 && t === '}') break;
          if (depth === 0 && atKey) {
            if (name(j) !== undefined && [':', ',', '}', '('].includes(text(j + 1))) names.add(name(j));
            atKey = false;
          }
          if (['{', '[', '('].includes(t)) depth++;
          else if (['}', ']', ')'].includes(t)) depth--;
          else if (t === ',' && depth === 0) atKey = true;
        }
      }
    }
    if (text(i) === 'Object' && text(i + 1) === '.' && text(i + 2) === 'defineProperty' && text(i + 3) === '(') {
      end = exportEnd(i + 4);
      if (end !== -1 && text(end) === ',' && text(end + 1) === '<string>' && name(end + 1) !== undefined) names.add(name(end + 1));
    }
  }
  names.delete('default');
  names.delete('module.exports');
  return { names: Array.from(names), reexports: Array.from(reexports) };
}

module.exports = { analyzeExports };
